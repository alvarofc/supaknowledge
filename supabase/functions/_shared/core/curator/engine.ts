// The curator: a queue-driven state machine. Each task is small enough for one Edge Function invocation.
//
//   gather  mine correction lessons from new traces (continues itself until done), then triage:
//           collect open flags + changed documents, cluster them, enqueue one `draft` per cluster
//   sweep   find concepts past stale_after and enqueue a re-validation `draft` for each
//   draft   research one cluster, write a changeset, self-review it, persist a proposal, and apply it
//           when the space policy allows (never for access escalations)
//
// When the last task of a run finishes, the run is closed with its stats.
import { narrowestSafeAudience } from "../access.ts";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { GenerateRequest, GenerateResult, LLM, Usage } from "../llm.ts";
import { lintConcept } from "../okf.ts";
import { decideAutoApply, type SpaceSettings } from "../settings.ts";
import type { Audience, Citation, Concept, ConceptDraft, Flag, ProposalDraft, ProposalOp, SourceDocument, Trace } from "../types.ts";
import { extractLessons, lessonsToFlags, renderTrace, scoreTrace } from "./corrections.ts";
import { CLUSTER_SYSTEM, DRAFT_SYSTEM, REVIEW_SYSTEM, withHouseRules } from "./prompts.ts";
import { ClusterSchema, DraftSchema, ReviewSchema, type DraftOutput, type ReviewOutput } from "./schemas.ts";
import type { ConceptHit, CuratorStore, CuratorTask, SourceHit } from "./store.ts";

export interface CuratorDeps {
  store: CuratorStore;
  llm: LLM;
  /** wall-clock budget per task (Edge Functions: keep well under the platform limit) */
  budgetMs?: number;
  now?: () => Date;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface ClusterInput {
  topic: string;
  flag_ids: string[];
  document_ids: string[];
  concept_paths: string[];
  research_query: string;
  priority: "high" | "medium" | "low";
  stale?: boolean;
}

const MAX_ATTEMPTS = 3;

/** Counts tokens of every model call a task makes (pi-style cost accounting, stored in run stats). */
class MeteredLLM implements LLM {
  usage: Usage & { calls: number } = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, calls: 0 };
  private inner: LLM;
  constructor(inner: LLM) {
    this.inner = inner;
  }
  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const res = await this.inner.generate(req);
    this.usage.calls++;
    this.usage.input_tokens += res.usage.input_tokens;
    this.usage.output_tokens += res.usage.output_tokens;
    this.usage.cached_input_tokens! += res.usage.cached_input_tokens ?? 0;
    return res;
  }
}

export async function runTask(deps: CuratorDeps, task: CuratorTask): Promise<Record<string, unknown>> {
  const metered = new MeteredLLM(deps.llm);
  deps = { ...deps, llm: metered };
  const { store } = deps;
  const log = deps.log ?? (() => {});
  const recordUsage = async () => {
    const u = metered.usage;
    if (u.calls) {
      await store.addRunStats(task.run_id, { model_calls: u.calls, input_tokens: u.input_tokens, output_tokens: u.output_tokens, cached_input_tokens: u.cached_input_tokens ?? 0 });
    }
  };
  try {
    let output: Record<string, unknown>;
    if (task.step === "gather") output = await gather(deps, task);
    else if (task.step === "sweep") output = await sweep(deps, task);
    else if (task.step === "draft") output = await draft(deps, task);
    else throw new Error(`unknown curator step "${task.step}"`);
    await recordUsage();
    await store.finishTask(task.id, output);
    await maybeFinishRun(deps, task.run_id);
    return output;
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    log("curator task failed", { task: task.id, step: task.step, error: msg, attempts: task.attempts });
    await recordUsage().catch(() => {});
    await store.failTask(task.id, msg);
    if (task.attempts + 1 >= MAX_ATTEMPTS) await maybeFinishRun(deps, task.run_id, msg);
    throw e;
  }
}

async function maybeFinishRun(deps: CuratorDeps, runId: string, error?: string) {
  if ((await deps.store.outstandingTasks(runId)) > 0) return;
  await deps.store.finishRun(runId, error ? "failed" : "succeeded", {}, error);
}

function deadline(deps: CuratorDeps): () => boolean {
  const start = Date.now();
  const budget = deps.budgetMs ?? 100_000;
  return () => Date.now() - start > budget;
}

// ---------------------------------------------------------------------------------------------------------
// gather
// ---------------------------------------------------------------------------------------------------------

async function gather(deps: CuratorDeps, task: CuratorTask): Promise<Record<string, unknown>> {
  const { store, llm } = deps;
  const run = await store.getRun(task.run_id);
  if (task.input.continued !== true) await store.startRun(run.id);
  const settings = await store.getSettings(run.space_id);
  const overBudget = deadline(deps);

  // 1. mine traces, a slice at a time
  const traces = await store.listUncuratedTraces(run.space_id, Math.min(settings.curator.max_traces_per_run, 50));
  let mined = 0;
  let lessons = 0;
  const done: string[] = [];
  for (const trace of traces) {
    if (overBudget()) break;
    const { score } = scoreTrace(trace);
    if (score >= 2) {
      const out = await extractLessons(llm, trace, { instructions: settings.curator.instructions });
      const flags = lessonsToFlags(trace, out);
      if (flags.length) await store.createSyntheticFlags(flags);
      lessons += flags.length;
      mined++;
    }
    done.push(trace.id);
  }
  if (done.length) await store.markTracesCurated(done);
  await store.addRunStats(run.id, { traces_scanned: done.length, traces_mined: mined, lessons });

  if (done.length < traces.length || traces.length === 50) {
    // more traces left: continue in a fresh task (fresh time budget)
    await store.enqueueTask(run.id, "gather", { continued: true });
    return { traces_scanned: done.length, continued: true };
  }

  // 2. triage
  return await triage(deps, run.id, run.space_id, run.since, run.until, settings);
}

interface Signal {
  id: string; // "f:<flag>" | "d:<doc>"
  text: string;
  conceptPath: string | null;
}

async function triage(
  deps: CuratorDeps,
  runId: string,
  spaceId: string,
  since: string | null,
  until: string | null,
  settings: SpaceSettings,
): Promise<Record<string, unknown>> {
  const { store, llm } = deps;
  const flags = await store.listOpenFlags(spaceId, 200);
  const docs = await store.listChangedDocuments(spaceId, since, until, 100);

  const clusters: ClusterInput[] = [];
  const byConcept = new Map<string, ClusterInput>();
  const loose: Signal[] = [];

  const clusterFor = (path: string): ClusterInput => {
    let c = byConcept.get(path);
    if (!c) {
      c = { topic: `Fix ${path}`, flag_ids: [], document_ids: [], concept_paths: [path], research_query: path.split("/").pop()!.replace(/[-_]/g, " "), priority: "medium" };
      byConcept.set(path, c);
    }
    return c;
  };

  // deterministic grouping first: flags already attached to a concept
  for (const f of flags) {
    if (f.concept_id && f.concept_path) {
      const c = clusterFor(f.concept_path);
      c.flag_ids.push(f.id);
      if (f.kind === "incorrect" || f.kind === "outdated") c.priority = "high";
    } else {
      loose.push({ id: `f:${f.id}`, conceptPath: f.concept_path, text: `[flag ${f.kind}${f.synthetic ? ", from trace correction" : ""}] ${f.concept_path ? `about "${f.concept_path}": ` : ""}${f.observation}${f.suggested_fix ? ` | suggested: ${f.suggested_fix}` : ""}${f.query ? ` | was looking for: ${f.query}` : ""}` });
    }
  }
  // documents cited by concepts go to those concepts
  for (const d of docs) {
    const citing = await store.conceptsCitingDocument(spaceId, d.id);
    if (citing.length) {
      for (const p of citing) clusterFor(p).document_ids.push(d.id);
    } else {
      loose.push({ id: `d:${d.id}`, conceptPath: null, text: `[document changed] "${d.title ?? d.external_id}" ${d.url ?? ""}\n${d.content.slice(0, 600)}` });
    }
  }

  let ignored = 0;
  if (loose.length) {
    // candidate concepts for the model to anchor on
    const candidates = new Map<string, ConceptHit>();
    for (const s of loose.slice(0, 60)) {
      for (const h of await store.searchConcepts(spaceId, s.text.slice(0, 300), 3)) candidates.set(h.path, h);
    }
    const input = [
      "Existing concepts that may be relevant:\n" +
        ([...candidates.values()].map((h) => `- ${h.path} (${h.kind}, ${h.type}): ${h.title} — ${h.description}`).join("\n") || "(none)"),
      "Signals:\n" + loose.slice(0, 120).map((s) => `${s.id}: ${s.text}`).join("\n\n"),
    ];
    const res = await llm.generate({
      system: withHouseRules(CLUSTER_SYSTEM, settings.curator.instructions),
      input,
      schema: ClusterSchema,
      maxTokens: 8000,
    });
    const known = new Set(loose.map((s) => s.id));
    for (const c of res.output.clusters) {
      const ids = c.signal_ids.filter((id) => known.has(id));
      if (!ids.length) continue;
      clusters.push({
        topic: c.topic,
        flag_ids: ids.filter((i) => i.startsWith("f:")).map((i) => i.slice(2)),
        document_ids: ids.filter((i) => i.startsWith("d:")).map((i) => i.slice(2)),
        concept_paths: c.concept_paths,
        research_query: c.research_query,
        priority: c.priority,
      });
    }
    const dismiss = res.output.ignored.filter((i) => i.signal_id.startsWith("f:") && known.has(i.signal_id));
    for (const i of dismiss) await store.dismissFlags([i.signal_id.slice(2)], `curator triage: ${i.reason}`);
    ignored = res.output.ignored.length;
  }

  clusters.unshift(...byConcept.values());
  const order = { high: 0, medium: 1, low: 2 } as const;
  clusters.sort((a, b) => order[a.priority] - order[b.priority]);
  const selected = clusters.slice(0, settings.curator.max_clusters_per_run);
  for (const c of selected) await store.enqueueTask(runId, "draft", c as unknown as Record<string, unknown>);
  await store.addRunStats(runId, { flags: flags.length, documents: docs.length, clusters: selected.length, ignored });
  return { flags: flags.length, documents: docs.length, clusters: selected.length, deferred: clusters.length - selected.length, ignored };
}

// ---------------------------------------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------------------------------------

async function sweep(deps: CuratorDeps, task: CuratorTask): Promise<Record<string, unknown>> {
  const { store } = deps;
  const run = await store.getRun(task.run_id);
  await store.startRun(run.id);
  const settings = await store.getSettings(run.space_id);
  const stale = await store.listStaleConcepts(run.space_id, settings.curator.max_clusters_per_run);
  for (const c of stale) {
    const input: ClusterInput = {
      topic: `Re-validate stale concept ${c.path}`,
      flag_ids: [],
      document_ids: [],
      concept_paths: [c.path],
      research_query: `${c.title} ${c.description}`.slice(0, 200),
      priority: "medium",
      stale: true,
    };
    await store.enqueueTask(run.id, "draft", input as unknown as Record<string, unknown>);
  }
  await store.addRunStats(run.id, { stale: stale.length });
  return { stale: stale.length };
}

// ---------------------------------------------------------------------------------------------------------
// draft
// ---------------------------------------------------------------------------------------------------------

interface Evidence {
  flags: Map<string, Flag>;
  traces: Map<string, Trace>;
  documents: Map<string, SourceDocument>;
  sourceHits: SourceHit[];
  targets: Map<string, Concept>;
  related: ConceptHit[];
}

function clip(s: string, n: number) {
  return s.length <= n ? s : s.slice(0, n) + `\n…[truncated ${s.length - n} chars]`;
}

function renderConcept(c: Concept): string {
  return [
    `### concept:${c.path}`,
    `kind: ${c.kind} | type: ${c.type} | revision: ${c.revision} | status: ${c.status}${c.stale_after ? ` | stale_after: ${c.stale_after}` : ""}${c.audience.length ? " | RESTRICTED" : ""}`,
    `title: ${c.title}`,
    `description: ${c.description}`,
    "body:",
    clip(c.body, 12_000),
  ].join("\n");
}

function renderEvidence(ev: Evidence, cluster: ClusterInput, rejections: { title: string; review_note: string | null }[]): string[] {
  const stable: string[] = [];
  stable.push(
    "## Concepts this change may touch\n" + ([...ev.targets.values()].map(renderConcept).join("\n\n") || "(none of the suggested paths exist yet)"),
  );
  stable.push(
    "## Other related concepts (summaries)\n" +
      (ev.related
        .filter((r) => !ev.targets.has(r.path))
        .map((r) => `- concept:${r.path} (${r.kind}, ${r.type}): ${r.title} — ${r.description}`)
        .join("\n") || "(none)"),
  );
  const evidence: string[] = ["## Evidence"];
  for (const f of ev.flags.values()) {
    evidence.push(
      `### flag:${f.id}\nkind: ${f.kind}${f.synthetic ? " (mined from a trace correction)" : ""}${f.concept_path ? ` | about: ${f.concept_path}` : ""}\nobservation: ${f.observation}${f.query ? `\nlooking for: ${f.query}` : ""}${f.suggested_fix ? `\nsuggested fix: ${f.suggested_fix}` : ""}${f.evidence && Object.keys(f.evidence).length ? `\nevidence: ${JSON.stringify(f.evidence).slice(0, 1500)}` : ""}${f.trace_id ? `\ntrace: trace:${f.trace_id}` : ""}`,
    );
  }
  for (const t of ev.traces.values()) evidence.push(`### trace:${t.id}\n${renderTrace(t, 8000)}`);
  for (const d of ev.documents.values()) {
    evidence.push(`### doc:${d.id}\ntitle: ${d.title ?? d.external_id}${d.url ? `\nurl: ${d.url}` : ""}\nchanged: ${d.changed_at}\n${clip(d.content, 6000)}`);
  }
  for (const h of ev.sourceHits) {
    if (ev.documents.has(h.document_id)) continue;
    evidence.push(`### doc:${h.document_id} (search excerpt)\ntitle: ${h.title ?? ""}${h.url ? `\nurl: ${h.url}` : ""}\n${clip(h.snippet, 1500)}`);
  }
  if (rejections.length) {
    evidence.push(
      "## Earlier proposals on these concepts that reviewers rejected (respect this feedback)\n" +
        rejections.map((r) => `- ${r.title}: ${r.review_note ?? "(no note)"}`).join("\n"),
    );
  }
  const taskText = [
    `## Task\n${cluster.topic}`,
    cluster.stale
      ? "This concept is past its stale_after date. Re-validate it against the evidence. If it is still correct, propose an update that only moves stale_after forward (risk low). If it is wrong, fix it."
      : "Decide whether the knowledge needs to change and, if so, write the changeset.",
    `Suggested concept paths: ${cluster.concept_paths.join(", ") || "(none)"}`,
  ].join("\n");
  return [...stable, evidence.join("\n\n"), taskText];
}

async function loadEvidence(deps: CuratorDeps, spaceId: string, cluster: ClusterInput): Promise<Evidence> {
  const { store } = deps;
  const flags = await store.getFlags(cluster.flag_ids);
  const traceIds = [...new Set(flags.map((f) => f.trace_id).filter((x): x is string => !!x))].slice(0, 5);
  const [traces, documents, targets, related, sourceHits] = await Promise.all([
    store.getTraces(traceIds),
    store.getDocuments(cluster.document_ids),
    store.getConcepts(spaceId, [...new Set([...cluster.concept_paths, ...flags.map((f) => f.concept_path).filter((p): p is string => !!p)])]),
    store.searchConcepts(spaceId, cluster.research_query, 8),
    store.searchSources(spaceId, cluster.research_query, 8),
  ]);
  return {
    flags: new Map(flags.map((f) => [f.id, f])),
    traces: new Map(traces.map((t) => [t.id, t])),
    documents: new Map(documents.map((d) => [d.id, d])),
    sourceHits,
    targets: new Map(targets.map((c) => [c.path, c])),
    related,
  };
}

/** Map a model citation ref ("doc:<id>", "trace:<id>", "flag:<id>", "concept:<path>", URL) to a stored citation. */
function resolveCitation(ref: string, ev: Evidence, relatedByPath: Map<string, ConceptHit>): Omit<Citation, "label" | "quote"> | null {
  const [kind, ...rest] = ref.split(":");
  const id = rest.join(":").trim();
  if (kind === "flag" && ev.flags.has(id)) return { ref_kind: "flag", ref_id: id, audience: ev.flags.get(id)!.audience };
  if (kind === "trace" && ev.traces.has(id)) return { ref_kind: "trace", ref_id: id, audience: ev.traces.get(id)!.audience };
  if (kind === "doc") {
    const d = ev.documents.get(id);
    if (d) return { ref_kind: "source_document", ref_id: id, url: d.url, audience: d.audience };
    const h = ev.sourceHits.find((x) => x.document_id === id);
    if (h) return { ref_kind: "source_document", ref_id: id, url: h.url, audience: h.audience };
    return null;
  }
  if (kind === "concept") {
    const c = ev.targets.get(id);
    if (c) return { ref_kind: "concept", ref_id: c.id, audience: c.audience };
    const r = relatedByPath.get(id);
    if (r) return { ref_kind: "concept", ref_id: r.id, audience: r.audience };
    return null;
  }
  if (/^https?:\/\//.test(ref)) return { ref_kind: "url", url: ref, audience: [] };
  return null;
}

function okfSourceEntry(c: Citation, ev: Evidence): Record<string, unknown> {
  const doc = c.ref_kind === "source_document" && c.ref_id ? ev.documents.get(c.ref_id) : undefined;
  const resource =
    c.url ??
    (c.ref_kind === "source_document" ? `supaknowledge://documents/${c.ref_id}` : c.ref_kind === "trace" ? `supaknowledge://traces/${c.ref_id}` : c.ref_kind === "flag" ? `supaknowledge://flags/${c.ref_id}` : `supaknowledge://concepts/${c.ref_id}`);
  return {
    id: c.label,
    resource,
    ...(doc?.title ? { title: doc.title } : {}),
    ...(doc?.author ? { author: doc.author } : {}),
    ...(doc?.changed_at ? { last_modified: doc.changed_at } : {}),
  };
}

export function buildProposal(
  out: DraftOutput,
  ev: Evidence,
  relatedByPath: Map<string, ConceptHit>,
  settings: SpaceSettings,
  now: Date,
): { draft: ProposalDraft; problems: string[] } {
  const problems: string[] = [];
  const citations: Citation[] = [];
  const labelSet = new Set<string>();
  for (const c of out.citations) {
    const resolved = resolveCitation(c.ref.trim(), ev, relatedByPath);
    if (!resolved) {
      problems.push(`citation "${c.label}" points at unknown evidence "${c.ref}" and was dropped`);
      continue;
    }
    if (labelSet.has(c.label)) continue;
    labelSet.add(c.label);
    citations.push({ label: c.label, quote: c.quote.slice(0, 1000), ...resolved });
  }
  const citationByLabel = new Map(citations.map((c) => [c.label, c]));

  const ops: ProposalOp[] = [];
  out.ops.forEach((o) => {
    const path = o.path.replace(/^\/+/, "").replace(/\.md$/, "").replace(/\/SKILL$/, "");
    const existing = ev.targets.get(path);
    let opKind = o.op;
    if (opKind === "create" && existing) opKind = "update";
    if (opKind === "update" && !existing) {
      if (o.kind && o.type && o.title && o.body) opKind = "create";
      else {
        problems.push(`update of unknown concept "${path}" dropped (no full content to create it)`);
        return;
      }
    }
    if ((opKind === "deprecate" || opKind === "move") && !existing) {
      problems.push(`${opKind} of unknown concept "${path}" dropped`);
      return;
    }

    const opCitations = o.citation_labels.map((l) => citationByLabel.get(l)).filter((c): c is Citation => !!c);
    const after: Partial<ConceptDraft> = {};
    if (o.kind) after.kind = o.kind;
    if (o.type) after.type = o.type;
    if (o.title) after.title = o.title;
    if (o.description !== null) after.description = o.description;
    if (o.body !== null) after.body = o.body.trim() + "\n";
    if (o.tags) after.tags = o.tags;
    if (o.superseded_by) after.superseded_by = o.superseded_by;
    const staleAt = o.stale_after ? Date.parse(o.stale_after) : Number.NaN;
    if (o.stale_after && (Number.isNaN(staleAt) || staleAt <= now.getTime())) {
      // a review date that is invalid or already past would mark the concept stale on arrival
      problems.push(`${path}: stale_after "${o.stale_after}" is not a future date and was replaced with the default`);
    }
    if (!Number.isNaN(staleAt) && staleAt > now.getTime()) after.stale_after = new Date(staleAt).toISOString();
    else if ((o.kind ?? existing?.kind) === "data_access" && opKind !== "deprecate" && settings.staleness.data_access_days > 0 && !existing?.stale_after) {
      after.stale_after = new Date(now.getTime() + settings.staleness.data_access_days * 86_400_000).toISOString();
    }

    // OKF provenance: merge cited sources into frontmatter.sources
    if (opCitations.length && opKind !== "deprecate" && opKind !== "move") {
      const fm = { ...(existing?.frontmatter ?? {}) };
      const prev = Array.isArray(fm.sources) ? (fm.sources as Record<string, unknown>[]) : [];
      const ids = new Set(prev.map((s) => s.id));
      fm.sources = [...prev, ...opCitations.filter((c) => !ids.has(c.label)).map((c) => okfSourceEntry(c, ev))];
      after.frontmatter = fm;
    }

    if (opKind === "create") {
      if (!after.kind || !after.type || !after.title) {
        problems.push(`create "${path}" is missing kind/type/title and was dropped`);
        return;
      }
      after.status = "stable";
      // the widest audience that does not leak any cited material
      const safe = narrowestSafeAudience(opCitations.map((c) => c.audience));
      after.audience = safe ?? (opCitations.find((c) => c.audience.length)?.audience as Audience) ?? [];
      if (safe === null) problems.push(`"${path}" combines evidence from audiences that do not overlap; a space admin must decide who can read it`);
    }

    const lint = lintConcept({ ...(existing ?? {}), ...after, path: opKind === "move" ? o.new_path ?? path : path } as ConceptDraft);
    if (lint.length) problems.push(...lint.map((p) => `${path}: ${p}`));

    ops.push({
      op: opKind,
      path,
      new_path: opKind === "move" ? o.new_path : null,
      concept_id: existing?.id ?? null,
      base_revision: existing?.revision ?? null,
      after,
      rationale: o.rationale,
    });
    // citations stay proposal-wide (op_id null): the database checks each one against every op's
    // target audience, which is the conservative choice for access escalation.
  });

  const flagIds = out.resolves_flags.filter((id) => ev.flags.has(id));
  return {
    draft: { title: out.title, rationale: out.rationale, risk: out.risk, ops, citations, flag_ids: flagIds },
    problems,
  };
}

const RESEARCH_GUIDE = `

You have research tools. The evidence above is a starting point: when a claim needs support you don't have yet,
search the knowledge base or the sources, open the documents or traces you need, then answer. Only cite evidence
ids you have actually seen (in the evidence above or in a tool result). Stop researching once you can decide.`;

/**
 * Tools the drafting model may call. Everything they return is added to the evidence maps, so citations to
 * material found during research resolve (and carry their audience) exactly like the pre-fetched evidence.
 */
function researchTools(deps: CuratorDeps, spaceId: string, ev: Evidence, relatedByPath: Map<string, ConceptHit>) {
  const { store } = deps;
  return {
    search_knowledge: createTool({
      id: "search_knowledge",
      description: "Search existing concepts in this knowledge base. Returns paths, titles and descriptions.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const hits = await store.searchConcepts(spaceId, query, 8);
        for (const h of hits) if (!relatedByPath.has(h.path)) { relatedByPath.set(h.path, h); ev.related.push(h); }
        return { results: hits.map((h) => ({ ref: `concept:${h.path}`, kind: h.kind, type: h.type, title: h.title, description: h.description })) };
      },
    }),
    read_concept: createTool({
      id: "read_concept",
      description: "Read the full current body of an existing concept by path. Read a concept before updating it.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const [c] = await store.getConcepts(spaceId, [path]);
        if (!c) return { error: `no concept at ${path}` };
        ev.targets.set(c.path, c);
        return { ref: `concept:${c.path}`, content: renderConcept(c) };
      },
    }),
    search_sources: createTool({
      id: "search_sources",
      description: "Search raw source documents (Notion, Slack, GitHub, Drive, web, uploads) for evidence.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const hits = await store.searchSources(spaceId, query, 8);
        for (const h of hits) if (!ev.sourceHits.some((x) => x.document_id === h.document_id)) ev.sourceHits.push(h);
        return { results: hits.map((h) => ({ ref: `doc:${h.document_id}`, title: h.title, url: h.url, snippet: clip(h.snippet, 800) })) };
      },
    }),
    read_document: createTool({
      id: "read_document",
      description: "Read a source document in full by its id (from search_sources or the evidence list, without the doc: prefix).",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const [d] = await store.getDocuments([id.replace(/^doc:/, "")]);
        if (!d || d.space_id !== spaceId) return { error: "document not found" };
        ev.documents.set(d.id, d);
        return { ref: `doc:${d.id}`, title: d.title, url: d.url, content: clip(d.content, 12_000) };
      },
    }),
    read_trace: createTool({
      id: "read_trace",
      description: "Read an agent trace (transcript) by id, e.g. one referenced by a flag.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const [t] = await store.getTraces([id.replace(/^trace:/, "")]);
        if (!t || t.space_id !== spaceId) return { error: "trace not found" };
        ev.traces.set(t.id, t);
        return { ref: `trace:${t.id}`, transcript: renderTrace(t, 12_000) };
      },
    }),
  };
}

const RISK = { low: 0, medium: 1, high: 2 } as const;
const maxRisk = (...r: ("low" | "medium" | "high")[]) => r.reduce((a, b) => (RISK[b] > RISK[a] ? b : a), "low" as "low" | "medium" | "high");

async function draft(deps: CuratorDeps, task: CuratorTask): Promise<Record<string, unknown>> {
  const { store, llm } = deps;
  const now = deps.now?.() ?? new Date();
  const run = await store.getRun(task.run_id);
  const settings = await store.getSettings(run.space_id);
  const cluster = task.input as unknown as ClusterInput;

  const ev = await loadEvidence(deps, run.space_id, cluster);
  const relatedByPath = new Map(ev.related.map((r) => [r.path, r]));
  const rejections = await store.recentRejections(run.space_id, [...ev.targets.keys(), ...cluster.concept_paths], 5);
  const input = renderEvidence(ev, cluster, rejections);

  // Deep-agent style: the drafting model starts from the evidence above and can pull more on demand.
  const tools = researchTools(deps, run.space_id, ev, relatedByPath);
  const system = withHouseRules(DRAFT_SYSTEM + RESEARCH_GUIDE, settings.curator.instructions);
  const drafted = await llm.generate({
    system,
    input,
    schema: DraftSchema,
    tools,
    maxSteps: settings.curator.max_research_steps,
    maxTokens: 32000,
  });
  let out = drafted.output;
  const author = `curator/${drafted.model}`;

  const dismiss = out.dismiss_flags.filter((d) => ev.flags.has(d.flag_id));
  for (const d of dismiss) await store.dismissFlags([d.flag_id], `curator: ${d.reason}`);

  if (out.decision === "no_change" || out.ops.length === 0) {
    await store.addRunStats(run.id, { no_change: 1, flags_dismissed: dismiss.length });
    return { decision: "no_change", rationale: out.rationale, dismissed: dismiss.length };
  }

  let { draft: proposal, problems } = buildProposal(out, ev, relatedByPath, settings, now);

  // Repair round: show the model what failed validation and let it fix its own changeset once.
  if (problems.length) {
    try {
      const repaired = await llm.generate({
        system,
        input: [
          ...input,
          "## Your previous changeset\n" + JSON.stringify(out, null, 1),
          "## Validation problems (fix all of them and return the corrected changeset)\n" + problems.map((p) => `- ${p}`).join("\n"),
        ],
        schema: DraftSchema,
        tools,
        maxSteps: Math.min(3, settings.curator.max_research_steps),
        maxTokens: 32000,
      });
      const rebuilt = buildProposal(repaired.output, ev, relatedByPath, settings, now);
      if (repaired.output.decision === "propose" && rebuilt.draft.ops.length && rebuilt.problems.length < problems.length) {
        out = repaired.output;
        proposal = rebuilt.draft;
        problems = rebuilt.problems;
        await store.addRunStats(run.id, { repaired: 1 });
      }
    } catch (e) {
      problems.push(`repair round failed: ${(e as Error).message}`);
    }
  }
  if (proposal.ops.length === 0) {
    await store.addRunStats(run.id, { invalid_drafts: 1 });
    return { decision: "invalid", problems };
  }

  // second opinion: contradictions, unsupported claims, lost information
  let review: ReviewOutput = { ok: true, issues: [], risk: proposal.risk };
  try {
    const res = await llm.generate({
      system: REVIEW_SYSTEM,
      input: [
        input[0]!,
        input[1]!,
        "## Proposed changeset\n" + JSON.stringify({ title: proposal.title, rationale: proposal.rationale, ops: proposal.ops, citations: proposal.citations.map(({ label, ref_kind, ref_id, quote }) => ({ label, ref_kind, ref_id, quote })) }, null, 1),
      ],
      schema: ReviewSchema,
      maxTokens: 8000,
    });
    review = res.output;
  } catch (e) {
    problems.push(`self-review failed: ${(e as Error).message}`);
  }

  const blockers = review.issues.filter((i) => i.severity === "blocker");
  proposal.risk = maxRisk(proposal.risk, review.risk, blockers.length ? "high" : "low", problems.length ? "medium" : "low");
  const notes = [
    ...review.issues.map((i) => `- ${i.severity === "blocker" ? "**BLOCKER** " : ""}${i.kind}: ${i.detail}`),
    ...problems.map((p) => `- check: ${p}`),
  ];
  if (notes.length) proposal.rationale += `\n\n**Curator self-review**\n${notes.join("\n")}`;

  const persisted = await store.createProposal(run.space_id, run.id, author, proposal);
  if (proposal.flag_ids.length) await store.setFlagsInProposal(proposal.flag_ids, persisted.id);

  const decision = decideAutoApply(settings, {
    risk: persisted.risk,
    escalation: persisted.escalation,
    opKinds: proposal.ops.map((o) => o.op),
    conceptKinds: proposal.ops.map((o) => (o.after.kind ?? ev.targets.get(o.path)?.kind ?? "domain")),
    citationKinds: proposal.citations.map((c) => c.ref_kind),
  });
  let applied = false;
  if (decision.autoApply && blockers.length === 0 && problems.length === 0) {
    const res = await store.applyProposal(persisted.id, author);
    applied = res.status === "applied";
  }

  await store.addRunStats(run.id, { proposals: 1, auto_applied: applied ? 1 : 0, escalations: persisted.escalation ? 1 : 0, flags_dismissed: dismiss.length });
  return {
    decision: "proposed",
    proposal_id: persisted.id,
    risk: persisted.risk,
    escalation: persisted.escalation,
    auto_applied: applied,
    policy: decision.reason,
    issues: notes.length,
  };
}
