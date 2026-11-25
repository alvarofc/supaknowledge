// The curator: a queue-driven state machine. Each task is small enough for one Edge Function invocation.
//
//   gather  mine correction lessons from new traces (continues itself until done or max_traces_per_run),
//           then triage (inline when there is time left, else as its own task)
//   triage  collect open flags + changed documents, cluster them, enqueue one `draft` per cluster
//   sweep   find concepts past stale_after and enqueue a re-validation `draft` for each
//   draft   research one cluster, write a changeset, self-review it, persist a proposal, and apply it
//           when the space policy allows (never for access escalations)
//
// Every task runs against a wall-clock budget (each model call gets an AbortSignal for what is left) and the
// run against a token budget. Tasks are idempotent: retries never duplicate flags, tasks or dismissals.
// When the last task of a run finishes, the database closes the run (failed if any task failed).
import { isEscalation, narrowestSafeAudience } from "../access.ts";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { type GenerateRequest, type GenerateResult, type LLM, LLMBudgetError, LLMConfigError, type Usage, usageOf } from "../llm.ts";
import { lintConcept } from "../okf.ts";
import { decideAutoApply, type SpaceSettings } from "../settings.ts";
import type { Audience, Citation, CitationKind, Concept, ConceptDraft, Flag, ProposalDraft, ProposalOp, SourceDocument, Trace } from "../types.ts";
import { extractLessons, lessonsToFlags, renderTrace, scoreTrace } from "./corrections.ts";
import { stableHash } from "./hash.ts";
import { CLUSTER_SYSTEM, DRAFT_SYSTEM, REVIEW_SYSTEM, UNTRUSTED_DATA_RULE, untrusted, withHouseRules } from "./prompts.ts";
import { ClusterSchema, DraftSchema, ReviewSchema, type DraftOutput, type ReviewOutput } from "./schemas.ts";
import type { ConceptHit, CuratorRun, CuratorStore, CuratorTask, DocCursor, RejectedProposal, SearchOptions, SourceHit } from "./store.ts";

export interface CuratorDeps {
  store: CuratorStore;
  llm: LLM;
  /** wall-clock budget per task (Edge Functions: keep well under the platform limit) */
  budgetMs?: number;
  now?: () => Date;
  log?: (msg: string, data?: Record<string, unknown>) => void;
  /**
   * Operator ceiling on model tokens per run (env KF_LLM_MAX_TOKENS_PER_RUN). The space setting
   * curator.max_tokens_per_run can lower it, never raise it; 0/undefined = no ceiling.
   */
  maxTokensPerRun?: number;
}

export interface ClusterInput {
  topic: string;
  flag_ids: string[];
  document_ids: string[];
  concept_paths: string[];
  research_query: string;
  priority: "high" | "medium" | "low";
  stale?: boolean;
  /**
   * Restricted audiences of the triage pass(es) whose model output (topic, research query, paths) shaped this
   * cluster. The draft treats them as consulted evidence, so the topic cannot carry restricted details into a
   * wider concept without escalating.
   */
  audiences?: Audience[];
}

/** A task ran out of wall-clock budget; a retry gets a fresh budget. */
export class TaskTimeoutError extends Error {}

const DEFAULT_BUDGET_MS = 100_000;
/** time kept back after the last model call to persist results */
const RESERVE_MS = 8_000;
/** never start a model call with less time than this */
const MIN_CALL_MS = 10_000;
/** skip the repair round when less than this is left (the proposal keeps its problems -> no auto-apply) */
const MIN_REPAIR_MS = 40_000;
/** skip the self-review when less than this is left (recorded as a problem -> no auto-apply) */
const MIN_REVIEW_MS = 20_000;
/** traces per gather task */
const TRACE_BATCH = 50;
/** changed documents per triage task (later pages continue in another triage task of the run) */
const TRIAGE_DOC_PAGE = 100;
/** loose signals per triage model call */
const TRIAGE_SIGNALS_PER_PASS = 120;
/** triage model calls (audience passes) per task; the rest continue in another triage task */
const MAX_TRIAGE_PASSES = 6;
/** start another triage pass only with this much time left on top of the reserve and a minimal call */
const TRIAGE_PASS_MARGIN_MS = 20_000;
/** candidate-concept searches per triage task that may embed their query (the rest are keyword-only) */
const TRIAGE_EMBEDDED_SEARCHES = 4;
/**
 * Pre-fetched source excerpts must match the research query by keyword or have at least this cosine
 * similarity (gte-small): a nearest neighbour that is merely "the closest thing in the index" is not evidence.
 */
export const PREFETCH_MIN_SIMILARITY = 0.8;
/** flag dismissal reasons written by the model are clipped to this length */
const REASON_MAX = 300;
/** concurrency of triage's candidate-concept searches */
const SEARCH_CONCURRENCY = 4;

const tokensOf = (stats: Record<string, unknown> | undefined | void): number =>
  Number(stats?.input_tokens ?? 0) + Number(stats?.output_tokens ?? 0);

/**
 * Counts tokens of every model call a task makes (stored in run stats right after each call), enforces the
 * per-run token budget, and gives every call an AbortSignal for the task's remaining wall-clock budget.
 */
class MeteredLLM implements LLM {
  usage: Usage & { calls: number } = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, calls: 0 };
  private inner: LLM;
  private deadline: number;
  private tokenBudget: number;
  private runTokens: number;
  private record: (delta: Record<string, number>) => Promise<Record<string, unknown> | void>;

  constructor(inner: LLM, opts: { deadline: number; tokenBudget: number; runTokens: number; record: (delta: Record<string, number>) => Promise<Record<string, unknown> | void> }) {
    this.inner = inner;
    this.deadline = opts.deadline;
    this.tokenBudget = opts.tokenBudget;
    this.runTokens = opts.runTokens;
    this.record = opts.record;
  }

  remainingMs(): number {
    return this.deadline - Date.now();
  }

  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const left = this.remainingMs() - RESERVE_MS;
    if (left < MIN_CALL_MS) throw new TaskTimeoutError(`task time budget exhausted (${Math.max(0, Math.round(this.remainingMs() / 1000))}s left)`);
    if (this.tokenBudget > 0 && this.runTokens >= this.tokenBudget) {
      throw new LLMBudgetError(`run token budget exhausted (${this.runTokens} of curator.max_tokens_per_run=${this.tokenBudget} tokens used)`);
    }
    const timeout = AbortSignal.timeout(left);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let res: GenerateResult<T>;
    try {
      res = await this.inner.generate({ ...req, signal });
    } catch (e) {
      // tokens spent before the failure (e.g. a research phase whose answer phase failed) still count
      const spent = usageOf(e);
      if (spent) await this.account(spent);
      if (timeout.aborted) throw new TaskTimeoutError(`model call aborted: task time budget exhausted (${(e as Error).message})`);
      throw e;
    }
    await this.account(res.usage);
    return res;
  }

  private async account(usage: Usage) {
    const delta = {
      model_calls: 1,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cached_input_tokens: usage.cached_input_tokens ?? 0,
    };
    this.usage.calls++;
    this.usage.input_tokens += delta.input_tokens;
    this.usage.output_tokens += delta.output_tokens;
    this.usage.cached_input_tokens! += delta.cached_input_tokens;
    // record right away: a task killed by the platform later still accounts for what it spent
    const stats = await this.record(delta).catch(() => undefined);
    this.runTokens = stats ? Math.max(tokensOf(stats), this.runTokens + delta.input_tokens + delta.output_tokens) : this.runTokens + delta.input_tokens + delta.output_tokens;
  }
}

interface TaskContext {
  store: CuratorStore;
  llm: MeteredLLM;
  run: CuratorRun;
  settings: SpaceSettings;
  now: () => Date;
  log: (msg: string, data?: Record<string, unknown>) => void;
  budgetMs: number;
  remainingMs: () => number;
}

/**
 * Run one task. On success the task is finished and the run closed when it was the last one. A failure that
 * can be retried is recorded and rethrown (the queue redelivers the task); a final failure (no attempts left,
 * token budget exhausted, configuration error) is recorded and returned as `{ failed: true }`.
 */
export async function runTask(deps: CuratorDeps, task: CuratorTask): Promise<Record<string, unknown>> {
  const { store } = deps;
  const log = deps.log ?? (() => {});
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  try {
    const run = await store.getRun(task.run_id);
    const settings = await store.getSettings(run.space_id);
    const ceiling = Math.max(0, Math.floor(deps.maxTokensPerRun ?? 0));
    const spaceBudget = settings.curator.max_tokens_per_run;
    const llm = new MeteredLLM(deps.llm, {
      deadline,
      tokenBudget: ceiling > 0 ? (spaceBudget > 0 ? Math.min(spaceBudget, ceiling) : ceiling) : spaceBudget,
      runTokens: tokensOf(run.stats),
      record: (delta) => store.addRunStats(run.id, delta),
    });
    const ctx: TaskContext = { store, llm, run, settings, log, budgetMs, now: deps.now ?? (() => new Date()), remainingMs: () => deadline - Date.now() };

    let output: Record<string, unknown>;
    if (task.step === "gather") output = await gather(ctx, task);
    else if (task.step === "triage") output = await triage(ctx, task);
    else if (task.step === "sweep") output = await sweep(ctx);
    else if (task.step === "draft") output = await draft(ctx, task);
    else throw new LLMConfigError(`unknown curator step "${task.step}"`);
    await store.finishTask(task.id, output);
    await store.maybeFinishRun(task.run_id);
    return output;
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    const permanent = e instanceof LLMBudgetError || e instanceof LLMConfigError;
    log("curator task failed", { task: task.id, step: task.step, error: msg, attempts: task.attempts, permanent });
    const { final } = await store.failTask(task.id, msg, { permanent });
    if (!final) throw e;
    await store.maybeFinishRun(task.run_id);
    return { failed: true, error: msg };
  }
}

// ---------------------------------------------------------------------------------------------------------
// gather
// ---------------------------------------------------------------------------------------------------------

async function gather(ctx: TaskContext, task: CuratorTask): Promise<Record<string, unknown>> {
  const { store, llm, run, settings } = ctx;
  if (task.input.continued !== true) await store.startRun(run.id);

  // 1. mine traces, a slice at a time, never more than max_traces_per_run across continuations
  const scannedBefore = Number(task.input.scanned ?? 0) || 0;
  const batch = Math.max(0, Math.min(TRACE_BATCH, settings.curator.max_traces_per_run - scannedBefore));
  const traces = batch > 0 ? await store.listUncuratedTraces(run.space_id, batch) : [];
  let mined = 0;
  let lessons = 0;
  let done = 0;
  for (const trace of traces) {
    if (ctx.remainingMs() < RESERVE_MS + MIN_CALL_MS + 5_000) break;
    const { score } = scoreTrace(trace);
    if (score >= 2) {
      const out = await extractLessons(llm, trace, { instructions: settings.curator.instructions });
      const flags = lessonsToFlags(trace, out);
      // idempotent (dedupe key per trace + lesson), then the trace is marked right away: a failure on the
      // next trace never re-mines this one
      if (flags.length) await store.createSyntheticFlags(flags);
      lessons += flags.length;
      mined++;
    }
    await store.markTracesCurated([trace.id]);
    done++;
  }
  if (traces.length) await store.addRunStats(run.id, { traces_scanned: done, traces_mined: mined, lessons });
  const scanned = scannedBefore + done;

  const more = done < traces.length || (traces.length === batch && batch > 0 && scanned < settings.curator.max_traces_per_run);
  if (more) {
    // more traces left: continue in a fresh task (fresh time budget). Keyed by this task so a retry of this
    // task does not enqueue a second continuation.
    await store.enqueueTask(run.id, "gather", { continued: true, scanned }, { dedupeKey: `gather-after:${task.id}` });
    return { traces_scanned: done, continued: true };
  }

  // 2. triage: inline when at least half the budget is left, else in its own task (fresh budget)
  if (ctx.remainingMs() < ctx.budgetMs / 2) {
    await store.enqueueTask(run.id, "triage", {}, { dedupeKey: "triage" });
    return { traces_scanned: done, triage: "queued" };
  }
  return { traces_scanned: done, ...(await triage(ctx, task)) };
}

// ---------------------------------------------------------------------------------------------------------
// triage
// ---------------------------------------------------------------------------------------------------------

interface Signal {
  id: string; // "f:<flag>" | "d:<doc>"
  text: string;
  conceptPath: string | null;
  audience: Audience;
}

/** "/skills/foo/SKILL.md" -> "skills/foo"; "metrics/arr.md" -> "metrics/arr" (mirrors private.normalize_concept_path) */
export function normalizeConceptPath(p: string): string {
  return p.trim().replace(/^(\.\/|\/)+/, "").replace(/\/SKILL\.md$/i, "").replace(/\.md$/i, "").replace(/\/SKILL$/i, "").replace(/\/+$/, "");
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
    }),
  );
  return out;
}

const PRIORITY = { high: 0, medium: 1, low: 2 } as const;

/** Canonical key of an audience ("" = unrestricted). */
export const audienceKey = (a: Audience): string => [...new Set(a)].sort().join(",");

function uniqueAudiences(list: Audience[]): Audience[] {
  const out = new Map<string, Audience>();
  for (const a of list) if (a.length) out.set(audienceKey(a), [...new Set(a)].sort());
  return [...out.values()];
}

/** Clusters that touch the same concept are one draft (two drafts on one concept would conflict). */
export function mergeClusters(list: ClusterInput[]): ClusterInput[] {
  const out: ClusterInput[] = [];
  const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  for (const c of list) {
    const copy: ClusterInput = { ...c, flag_ids: [...c.flag_ids], document_ids: [...c.document_ids], concept_paths: [...new Set(c.concept_paths)], audiences: uniqueAudiences(c.audiences ?? []) };
    const overlapping = out.filter((o) => o.concept_paths.some((p) => copy.concept_paths.includes(p)));
    if (!overlapping.length) {
      out.push(copy);
      continue;
    }
    const target = overlapping[0]!;
    for (const o of [...overlapping.slice(1), copy]) {
      target.flag_ids = union(target.flag_ids, o.flag_ids);
      target.document_ids = union(target.document_ids, o.document_ids);
      target.concept_paths = union(target.concept_paths, o.concept_paths);
      // the merged draft carries the taint of every triage pass that shaped it
      target.audiences = uniqueAudiences([...(target.audiences ?? []), ...(o.audiences ?? [])]);
      if (o.topic && !target.topic.includes(o.topic)) target.topic = `${target.topic}; ${o.topic}`.slice(0, 300);
      if (o.research_query && !target.research_query.includes(o.research_query)) target.research_query = `${target.research_query} ${o.research_query}`.trim().slice(0, 300);
      if (PRIORITY[o.priority] < PRIORITY[target.priority]) target.priority = o.priority;
      if (o.stale) target.stale = true;
      if (o !== copy) out.splice(out.indexOf(o), 1);
    }
  }
  return out;
}

function clusterKey(c: ClusterInput): string {
  return stableHash([[...c.flag_ids].sort().join(","), [...c.document_ids].sort().join(","), [...c.concept_paths].sort().join(","), c.stale ? "stale" : ""].join("|"));
}

const STOPWORDS = new Set("this that with from have were what when where which their there they them then than will would should could about into your more some only also been just like does done here http https".split(" "));

/** A keyword query that matches ANY salient term (websearch syntax), for searches without an embedding. */
export function keywordQuery(text: string, max = 12): string {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) ?? [];
  return [...new Set(words.filter((w) => !STOPWORDS.has(w)))].slice(0, max).join(" or ");
}

function parseCursor(v: unknown): DocCursor | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  return typeof c.changed_at === "string" && typeof c.id === "string" ? { changed_at: c.changed_at, id: c.id } : null;
}

function parseSignalIds(v: unknown): { flag_ids: string[]; document_ids: string[] } | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const ids = (x: unknown) => (Array.isArray(x) ? x.filter((i): i is string => typeof i === "string") : []);
  return { flag_ids: ids(o.flag_ids), document_ids: ids(o.document_ids) };
}

const clipText = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

interface TriagePassResult {
  clusters: ClusterInput[];
  dismiss: { flagId: string; reason: string }[];
  ignored: number;
}

/**
 * One triage model call over signals that all share ONE audience. The model only sees those signals and
 * candidate concepts every reader of that audience may read, so whatever it writes (topics, research queries,
 * dismissal reasons) is readable by that audience: the clusters carry it as taint into the draft.
 */
async function triagePass(ctx: TaskContext, audience: Audience, signals: Signal[], embedBudget: { left: number }): Promise<TriagePassResult> {
  const { store, llm, run, settings } = ctx;
  const queries = [...new Set(signals.slice(0, 60).map((s) => s.text.slice(0, 300)))];
  const candidates = new Map<string, ConceptHit>();
  const found = await mapLimit(queries, SEARCH_CONCURRENCY, (q) => {
    // a few semantic searches per task (embedding is CPU-heavy in an Edge Function), keywords for the rest
    const semantic = embedBudget.left-- > 0;
    const opts: SearchOptions = { visibleTo: audience, keywordOnly: !semantic };
    return store.searchConcepts(run.space_id, semantic ? q : keywordQuery(q) || q, 3, opts);
  });
  for (const hits of found) for (const h of hits) if (!isEscalation(h.audience, audience)) candidates.set(h.path, h);
  const input = [
    "Existing concepts that may be relevant:\n" +
      ([...candidates.values()].map((h) => `- ${h.path} (${h.kind}, ${h.type}): ${h.title} — ${h.description}`).join("\n") || "(none)"),
    "Signals:\n" + signals.map((s) => `${s.id}:\n${untrusted(s.id, s.text)}`).join("\n\n"),
  ];
  const res = await llm.generate({
    system: withHouseRules(CLUSTER_SYSTEM + UNTRUSTED_DATA_RULE, settings.curator.instructions),
    input,
    schema: ClusterSchema,
    maxTokens: 8000,
  });
  const known = new Set(signals.map((s) => s.id));
  const clusters: ClusterInput[] = [];
  for (const c of res.output.clusters) {
    const ids = [...new Set(c.signal_ids.filter((id) => known.has(id)))];
    if (!ids.length) continue;
    clusters.push({
      topic: clipText(c.topic, 300),
      flag_ids: ids.filter((i) => i.startsWith("f:")).map((i) => i.slice(2)),
      document_ids: ids.filter((i) => i.startsWith("d:")).map((i) => i.slice(2)),
      concept_paths: [...new Set(c.concept_paths.map(normalizeConceptPath).filter(Boolean))],
      research_query: clipText(c.research_query, 300),
      priority: c.priority,
      audiences: audience.length ? [audience] : [],
    });
  }
  const clustered = new Set(clusters.flatMap((c) => [...c.flag_ids.map((i) => `f:${i}`), ...c.document_ids.map((i) => `d:${i}`)]));
  // a flag the model both clusters and ignores stays open (it is handled by the cluster)
  const dismiss = res.output.ignored
    .filter((i) => i.signal_id.startsWith("f:") && known.has(i.signal_id) && !clustered.has(i.signal_id))
    .map((i) => ({ flagId: i.signal_id.slice(2), reason: clipText(i.reason, 300) }));
  return { clusters, dismiss, ignored: res.output.ignored.length };
}

/**
 * Triage. Signals already attached to a concept (flags on a concept, documents a concept cites) are grouped
 * deterministically. The rest ("loose" signals) are clustered by the model, one pass per audience: unrestricted
 * signals together, each distinct restricted audience on its own (see triagePass). Changed documents are read a
 * page at a time; later pages, and passes that do not fit this task, continue in further triage tasks of the run.
 */
async function triage(ctx: TaskContext, task: CuratorTask): Promise<Record<string, unknown>> {
  const { store, run, settings } = ctx;
  const spaceId = run.space_id;
  if (task.step === "triage") await store.startRun(run.id);
  const input = task.step === "triage" ? task.input : {};
  const cursor = parseCursor(input.doc_cursor);
  const deferred = parseSignalIds(input.signals);

  let flags: Flag[];
  let docs: SourceDocument[];
  let nextCursor: DocCursor | null = null;
  if (deferred) {
    // signals an earlier triage task of this run had no room for
    flags = (await store.getFlags(deferred.flag_ids)).filter((f) => f.space_id === spaceId && f.status === "open");
    docs = (await store.getDocuments(deferred.document_ids)).filter((d) => d.space_id === spaceId);
  } else {
    // open flags once per run (the first triage); changed documents one page per task
    flags = cursor ? [] : await store.listOpenFlags(spaceId, 200);
    docs = await store.listChangedDocuments(spaceId, run.since, run.until, TRIAGE_DOC_PAGE, cursor);
    const last = docs.at(-1);
    if (docs.length === TRIAGE_DOC_PAGE && last) nextCursor = { changed_at: last.changed_at, id: last.id };
  }

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
      const c = clusterFor(normalizeConceptPath(f.concept_path));
      c.flag_ids.push(f.id);
      if (f.kind === "incorrect" || f.kind === "outdated") c.priority = "high";
    } else {
      loose.push({ id: `f:${f.id}`, conceptPath: f.concept_path, audience: f.audience ?? [], text: `[flag ${f.kind}${f.synthetic ? ", from trace correction" : ""}] ${f.concept_path ? `about "${f.concept_path}": ` : ""}${f.observation}${f.suggested_fix ? ` | suggested: ${f.suggested_fix}` : ""}${f.query ? ` | was looking for: ${f.query}` : ""}` });
    }
  }
  // documents cited by concepts go to those concepts (one batched lookup)
  const citing = await store.conceptsCitingDocuments(spaceId, docs.map((d) => ({ id: d.id, url: d.url })));
  for (const d of docs) {
    const paths = citing.get(d.id) ?? [];
    if (paths.length) {
      for (const p of paths) clusterFor(p).document_ids.push(d.id);
    } else {
      loose.push({ id: `d:${d.id}`, conceptPath: null, audience: d.audience ?? [], text: `[document changed] "${d.title ?? d.external_id}" ${d.url ?? ""}\n${d.content.slice(0, 600)}` });
    }
  }

  // loose signals: one model pass per audience, unrestricted first, then the biggest groups
  const groups = new Map<string, { audience: Audience; signals: Signal[] }>();
  for (const s of loose) {
    const key = audienceKey(s.audience);
    const g = groups.get(key) ?? { audience: [...new Set(s.audience)].sort(), signals: [] };
    g.signals.push(s);
    groups.set(key, g);
  }
  const ordered = [...groups.values()].sort((a, b) => (a.audience.length === 0 ? -1 : b.audience.length === 0 ? 1 : b.signals.length - a.signals.length));
  const llmClusters: ClusterInput[] = [];
  const dismissals: { flagId: string; reason: string }[] = [];
  const leftover: Signal[] = [];
  const embedBudget = { left: TRIAGE_EMBEDDED_SEARCHES };
  let ignored = 0;
  let passes = 0;
  for (const g of ordered) {
    const roomForPass = passes === 0 || (passes < MAX_TRIAGE_PASSES && ctx.remainingMs() >= RESERVE_MS + MIN_CALL_MS + TRIAGE_PASS_MARGIN_MS);
    if (!roomForPass) {
      leftover.push(...g.signals);
      continue;
    }
    leftover.push(...g.signals.slice(TRIAGE_SIGNALS_PER_PASS));
    const r = await triagePass(ctx, g.audience, g.signals.slice(0, TRIAGE_SIGNALS_PER_PASS), embedBudget);
    passes++;
    llmClusters.push(...r.clusters);
    dismissals.push(...r.dismiss);
    ignored += r.ignored;
  }

  const clusters = mergeClusters([...byConcept.values(), ...llmClusters]);
  clusters.sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority]);
  // max_clusters_per_run counts every triage task of the run
  const room = Math.max(0, settings.curator.max_clusters_per_run - Number(run.stats?.clusters ?? 0));
  const selected = clusters.slice(0, room);
  // Clusters over the cap are not drafted. Their flags stay open for the next run; their changed documents do not
  // come back (the run's watermark moves past them) until they change again, so the run records how many.
  const selectedDocs = new Set(selected.flatMap((c) => c.document_ids));
  const docsOverCap = new Set(clusters.slice(room).flatMap((c) => c.document_ids).filter((id) => !selectedDocs.has(id))).size;
  if (docsOverCap) ctx.log("curator triage: max_clusters_per_run reached", { run: run.id, documents_over_cap: docsOverCap });
  // keyed by content: a retried triage never enqueues the same draft twice. Drafts are enqueued BEFORE any
  // dismissal, so a retry of a task that failed half-way sees the same open flags.
  for (const c of selected) await store.enqueueTask(run.id, "draft", c as unknown as Record<string, unknown>, { dedupeKey: `draft:${clusterKey(c)}` });
  if (nextCursor) {
    await store.enqueueTask(run.id, "triage", { doc_cursor: nextCursor }, { dedupeKey: `triage-docs:${nextCursor.changed_at}:${nextCursor.id}` });
  }
  if (leftover.length) {
    const rest = {
      flag_ids: leftover.filter((s) => s.id.startsWith("f:")).map((s) => s.id.slice(2)),
      document_ids: leftover.filter((s) => s.id.startsWith("d:")).map((s) => s.id.slice(2)),
    };
    await store.enqueueTask(run.id, "triage", { signals: rest }, { dedupeKey: `triage-rest:${stableHash([...rest.flag_ids, "|", ...rest.document_ids].join(","))}` });
  }
  let dismissed = 0;
  if (settings.curator.auto_dismiss_flags) {
    // the pass that dismissed a flag only saw material its readers may read, so its reason can be shown
    for (const d of dismissals) await store.dismissFlags([d.flagId], `curator triage: ${d.reason}`);
    dismissed = dismissals.length;
  }
  // deferred signals were counted by the task that deferred them
  await store.addRunStats(run.id, { flags: deferred ? 0 : flags.length, documents: deferred ? 0 : docs.length, clusters: selected.length, ignored, flags_dismissed: dismissed, triage_passes: passes, ...(docsOverCap ? { documents_over_cap: docsOverCap } : {}) });
  return {
    flags: flags.length,
    documents: docs.length,
    clusters: selected.length,
    deferred: clusters.length - selected.length,
    ...(docsOverCap ? { documents_over_cap: docsOverCap } : {}),
    passes,
    ignored,
    dismissed,
    ...(nextCursor ? { more_documents: true } : {}),
    ...(leftover.length ? { signals_continued: leftover.length } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------------------------------------

async function sweep(ctx: TaskContext): Promise<Record<string, unknown>> {
  const { store, run, settings } = ctx;
  await store.startRun(run.id);
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
    await store.enqueueTask(run.id, "draft", input as unknown as Record<string, unknown>, { dedupeKey: `stale:${c.path}` });
  }
  await store.addRunStats(run.id, { stale: stale.length });
  return { stale: stale.length };
}

// ---------------------------------------------------------------------------------------------------------
// draft
// ---------------------------------------------------------------------------------------------------------

/**
 * Restricted material the drafting model saw that is not a row the proposal can cite (the triage pass that
 * wrote the cluster's topic, a rejected proposal's review note). It becomes a consulted citation without a
 * ref_id: the database keeps the stated audience and counts it for escalation like any other evidence.
 */
export interface Taint {
  label: string;
  audience: Audience;
  note: string;
}

export interface Evidence {
  flags: Map<string, Flag>;
  traces: Map<string, Trace>;
  documents: Map<string, SourceDocument>;
  sourceHits: SourceHit[];
  targets: Map<string, Concept>;
  related: ConceptHit[];
  taint?: Taint[];
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

function renderFlag(f: Flag): string {
  return `### flag:${f.id}\n${untrusted(
    `flag:${f.id}`,
    `kind: ${f.kind}${f.synthetic ? " (mined from a trace correction)" : ""}${f.concept_path ? ` | about: ${f.concept_path}` : ""}\nobservation: ${f.observation}${f.query ? `\nlooking for: ${f.query}` : ""}${f.suggested_fix ? `\nsuggested fix: ${f.suggested_fix}` : ""}${f.evidence && Object.keys(f.evidence).length ? `\nevidence: ${JSON.stringify(f.evidence).slice(0, 1500)}` : ""}${f.trace_id ? `\ntrace: trace:${f.trace_id}` : ""}`,
  )}`;
}

function renderDocument(d: SourceDocument, max = 6000): string {
  return `### doc:${d.id}\ntitle: ${d.title ?? d.external_id}${d.url ? `\nurl: ${d.url}` : ""}${d.source_kind ? `\nsource: ${d.source_kind}` : ""}\nchanged: ${d.changed_at}\n${untrusted(`doc:${d.id}`, clip(d.content, max))}`;
}

export function renderEvidence(ev: Evidence, cluster: ClusterInput, rejections: { id?: string; title: string; review_note: string | null }[]): string[] {
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
  for (const f of ev.flags.values()) evidence.push(renderFlag(f));
  for (const t of ev.traces.values()) evidence.push(`### trace:${t.id}\n${untrusted(`trace:${t.id}`, renderTrace(t, 8000))}`);
  for (const d of ev.documents.values()) evidence.push(renderDocument(d));
  for (const h of ev.sourceHits) {
    if (ev.documents.has(h.document_id)) continue;
    evidence.push(`### doc:${h.document_id} (search excerpt)\ntitle: ${h.title ?? ""}${h.url ? `\nurl: ${h.url}` : ""}\n${untrusted(`doc:${h.document_id}`, clip(h.snippet, 1500))}`);
  }
  if (rejections.length) {
    evidence.push(
      "## Earlier proposals on these concepts that reviewers rejected (respect this feedback)\n" +
        rejections.map((r, i) => untrusted(`rejection:${r.id ?? i}`, `${r.title}: ${r.review_note ?? "(no note)"}`)).join("\n"),
    );
  }
  const taskText = [
    // the topic is model-written (triage) from untrusted signals: data, not instructions
    `## Task\nTopic from triage:\n${untrusted("topic", cluster.topic)}`,
    cluster.stale
      ? "This concept is past its stale_after date. Re-validate it against the evidence. If it is still correct, propose an update that only moves stale_after forward (risk low). If it is wrong, fix it."
      : "Decide whether the knowledge needs to change and, if so, write the changeset.",
    `Suggested concept paths: ${cluster.concept_paths.join(", ") || "(none)"}`,
  ].join("\n");
  return [...stable, evidence.join("\n\n"), taskText];
}

/**
 * Which audiences research may draw from. Material is "in scope" when publishing it into the concepts being
 * changed (or, for brand-new knowledge, next to the signals that asked for it) would not widen its access.
 * Out-of-scope material is never shown to the drafting model, so it cannot leak into the changeset.
 */
interface ResearchScope {
  allows(audience: Audience): boolean;
  /** the same rule as a search filter (SearchOptions.visibleTo); null = no filter */
  visibleTo: Audience | null;
}

function researchScope(settings: SpaceSettings, targets: Concept[], signals: Audience[]): ResearchScope {
  if (settings.curator.research_scope === "all") return { allows: () => true, visibleTo: null };
  const scope = targets.length ? targets.map((t) => t.audience) : signals.length ? signals : [[]];
  // allows(a) <=> a is unrestricted, or no scope audience is unrestricted and a contains every scope group
  const visibleTo = scope.some((a) => a.length === 0) ? [] : [...new Set(scope.flat())].sort();
  return { allows: (a) => scope.every((t) => !isEscalation(a, t)), visibleTo };
}

async function loadEvidence(ctx: TaskContext, cluster: ClusterInput): Promise<{ ev: Evidence; scope: ResearchScope }> {
  const { store, run, settings } = ctx;
  const spaceId = run.space_id;
  const flags = (await store.getFlags(cluster.flag_ids)).filter((f) => f.space_id === spaceId);
  const traceIds = [...new Set(flags.map((f) => f.trace_id).filter((x): x is string => !!x))].slice(0, 5);
  const paths = [...new Set([...cluster.concept_paths, ...flags.map((f) => f.concept_path).filter((p): p is string => !!p)].map(normalizeConceptPath))];
  const [traces, documents, targets] = await Promise.all([
    store.getTraces(traceIds),
    store.getDocuments(cluster.document_ids),
    store.getConcepts(spaceId, paths),
  ]);
  const docs = documents.filter((d) => d.space_id === spaceId);
  const triageAudiences = uniqueAudiences(Array.isArray(cluster.audiences) ? cluster.audiences.filter(Array.isArray) : []);
  const scope = researchScope(settings, targets, [...flags.map((f) => f.audience), ...docs.map((d) => d.audience), ...triageAudiences]);
  const untrustedKinds = new Set<string>(settings.auto_apply.untrusted_source_kinds);
  const [related, sourceHits] = await Promise.all([
    store.searchConcepts(spaceId, cluster.research_query, 8, { visibleTo: scope.visibleTo }),
    store.searchSources(spaceId, cluster.research_query, 8, { visibleTo: scope.visibleTo, minSimilarity: PREFETCH_MIN_SIMILARITY }),
  ]);
  return {
    ev: {
      flags: new Map(flags.map((f) => [f.id, f])),
      traces: new Map(traces.filter((t) => t.space_id === spaceId).map((t) => [t.id, t])),
      documents: new Map(docs.map((d) => [d.id, d])),
      // untrusted (third-party) sources are never pre-fetched: the model can still look them up deliberately
      // with search_sources, and then the changeset is not auto-applied (auto_apply.untrusted_source_kinds)
      sourceHits: sourceHits.filter((h) => scope.allows(h.audience) && !(h.source_kind && untrustedKinds.has(h.source_kind))),
      targets: new Map(targets.map((c) => [c.path, c])),
      related: related.filter((h) => scope.allows(h.audience)),
      taint: triageAudiences.map((audience) => ({ label: `triage:${audienceKey(audience)}`, audience, note: "restricted signals the triage step saw while writing this change's topic" })),
    },
    scope,
  };
}

function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().replace(/#.*$/, "").replace(/\/+$/, "");
  return norm(a) === norm(b);
}

type ResolvedCitation = Omit<Citation, "label" | "quote"> & { problem?: string };

/** Map a model citation ref ("doc:<id>", "trace:<id>", "flag:<id>", "concept:<path>", URL) to a stored citation. */
function resolveCitation(ref: string, ev: Evidence, relatedByPath: Map<string, ConceptHit>): ResolvedCitation | null {
  if (/^https?:\/\//i.test(ref)) {
    // A URL is only as good as the evidence it belongs to: resolve it to that document (and its audience).
    for (const d of ev.documents.values()) if (d.url && sameUrl(d.url, ref)) return { ref_kind: "source_document", ref_id: d.id, url: d.url, audience: d.audience };
    const h = ev.sourceHits.find((x) => x.url && sameUrl(x.url, ref));
    if (h) return { ref_kind: "source_document", ref_id: h.document_id, url: h.url, audience: h.audience };
    return { ref_kind: "url", url: ref, audience: [], problem: `cites the URL ${ref}, which is not part of the evidence; a human must check it` };
  }
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
    const p = normalizeConceptPath(id);
    const c = ev.targets.get(p);
    if (c) return { ref_kind: "concept", ref_id: c.id, audience: c.audience };
    const r = relatedByPath.get(p);
    if (r) return { ref_kind: "concept", ref_id: r.id, audience: r.audience };
    return null;
  }
  return null;
}

/** OKF `sources[]` entry. Source documents always carry their id, so changes route back here even with a URL. */
function okfSourceEntry(c: Citation, ev: Evidence): Record<string, unknown> {
  const doc = c.ref_kind === "source_document" && c.ref_id ? ev.documents.get(c.ref_id) : undefined;
  const resource =
    c.url ??
    (c.ref_kind === "source_document" ? `supaknowledge://documents/${c.ref_id}` : c.ref_kind === "trace" ? `supaknowledge://traces/${c.ref_id}` : c.ref_kind === "flag" ? `supaknowledge://flags/${c.ref_id}` : `supaknowledge://concepts/${c.ref_id}`);
  return {
    id: c.label,
    resource,
    ...(c.ref_kind === "source_document" && c.ref_id ? { "x-supaknowledge-document": c.ref_id } : {}),
    ...(doc?.title ? { title: doc.title } : {}),
    ...(doc?.author ? { author: doc.author } : {}),
    ...(doc?.changed_at ? { last_modified: doc.changed_at } : {}),
  };
}

export interface BuiltProposal {
  draft: ProposalDraft;
  problems: string[];
  /** problems the model can fix in a repair round (others need a human, e.g. disjoint audiences) */
  repairable: number;
  /** a repair round would need research tools (unresolved evidence ids) */
  needsResearch: boolean;
}

export function buildProposal(
  out: DraftOutput,
  ev: Evidence,
  relatedByPath: Map<string, ConceptHit>,
  settings: SpaceSettings,
  now: Date,
): BuiltProposal {
  const problems: string[] = [];
  let unrepairable = 0;
  let needsResearch = false;
  const citations: Citation[] = [];
  const labelSet = new Set<string>();
  for (const c of out.citations) {
    const resolved = resolveCitation(c.ref.trim(), ev, relatedByPath);
    if (!resolved) {
      problems.push(`citation "${c.label}" points at unknown evidence "${c.ref}" and was dropped`);
      needsResearch = true;
      continue;
    }
    if (labelSet.has(c.label)) continue;
    labelSet.add(c.label);
    const { problem, ...citation } = resolved;
    if (problem) problems.push(`citation "${c.label}" ${problem}`);
    citations.push({ label: c.label, quote: c.quote.slice(0, 1000), ...citation });
  }
  const citationByLabel = new Map(citations.map((c) => [c.label, c]));

  const ops: ProposalOp[] = [];
  out.ops.forEach((o) => {
    const path = normalizeConceptPath(o.path);
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
    const newPath = opKind === "move" && o.new_path ? normalizeConceptPath(o.new_path) : null;
    if (opKind === "move" && (!newPath || newPath === path)) {
      problems.push(`move of "${path}" has no new_path and was dropped`);
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
    if (o.superseded_by) after.superseded_by = normalizeConceptPath(o.superseded_by);
    const staleAt = o.stale_after ? Date.parse(o.stale_after) : Number.NaN;
    const replaced = !!o.stale_after && (Number.isNaN(staleAt) || staleAt <= now.getTime());
    if (!Number.isNaN(staleAt) && staleAt > now.getTime()) after.stale_after = new Date(staleAt).toISOString();
    else {
      // no usable date from the model: keep a future review date, otherwise (missing or already expired, as in
      // a staleness sweep) move it to the default so the concept is not stale on arrival
      const existingStale = existing?.stale_after ? Date.parse(existing.stale_after) : Number.NaN;
      const existingFuture = !Number.isNaN(existingStale) && existingStale > now.getTime();
      const kind = o.kind ?? existing?.kind;
      if (opKind !== "deprecate" && !existingFuture && (kind === "data_access" || !!existing?.stale_after) && settings.staleness.data_access_days > 0) {
        after.stale_after = new Date(now.getTime() + settings.staleness.data_access_days * 86_400_000).toISOString();
      }
      if (replaced) {
        // a review date that is invalid or already past would mark the concept stale on arrival
        problems.push(`${path}: stale_after "${o.stale_after}" is not a future date and was ${after.stale_after ? "replaced with the default" : "ignored (the current review date is kept)"}`);
      }
    }

    // OKF provenance: merge cited sources into frontmatter.sources (a label now cited replaces an older entry
    // with the same label: the body's footnote refers to the new evidence)
    if (opCitations.length && opKind !== "deprecate" && opKind !== "move") {
      const fm = { ...(existing?.frontmatter ?? {}) };
      const prev = Array.isArray(fm.sources) ? (fm.sources as Record<string, unknown>[]) : [];
      const fresh = opCitations.map((c) => okfSourceEntry(c, ev));
      const freshIds = new Set(fresh.map((s) => s.id));
      fm.sources = [...prev.filter((s) => !freshIds.has(s?.id)), ...fresh];
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
      if (safe === null) {
        problems.push(`"${path}" combines evidence from audiences that do not overlap; a space admin must decide who can read it`);
        unrepairable++;
      }
    }

    const lint = lintConcept({ ...(existing ?? {}), ...after, path: newPath ?? path } as ConceptDraft);
    if (lint.length) problems.push(...lint.map((p) => `${path}: ${p}`));

    ops.push({
      op: opKind,
      path,
      new_path: newPath,
      concept_id: existing?.id ?? null,
      base_revision: existing?.revision ?? null,
      after,
      rationale: o.rationale,
    });
    // citations stay proposal-wide (op_index unset): the database checks each one against every op's
    // target audience, which is the conservative choice for access escalation.
  });

  // Flags this proposal addresses: the ones the model listed (tolerating a "flag:" prefix) plus every flag it
  // cites as evidence. Models often cite the flag but leave resolves_flags empty, which would strand the flag open.
  const normalizeFlagId = (id: string) => id.trim().replace(/^flag:/, "");
  const flagIds = [
    ...new Set([
      ...out.resolves_flags.map(normalizeFlagId),
      ...citations.filter((c) => c.ref_kind === "flag" && !c.consulted && c.ref_id).map((c) => c.ref_id!),
    ]),
  ].filter((id) => ev.flags.has(id));
  return {
    draft: { title: out.title, rationale: out.rationale, risk: out.risk, ops, citations, flag_ids: flagIds },
    problems,
    repairable: problems.length - unrepairable,
    needsResearch,
  };
}

/**
 * Taint tracking: every restricted item the drafting model saw (pre-fetched or via research tools) and did
 * not cite is attached as `consulted` evidence. The database counts it for escalation and visibility exactly
 * like a citation, so nothing the model read can reach a wider audience without a space admin.
 */
export function consultedCitations(ev: Evidence, cited: Citation[]): Citation[] {
  const seen = new Set(cited.filter((c) => c.ref_id).map((c) => `${c.ref_kind}:${c.ref_id}`));
  const out: Citation[] = [];
  const add = (ref_kind: CitationKind, ref_id: string, audience: Audience, label: string) => {
    if (!audience.length || seen.has(`${ref_kind}:${ref_id}`)) return;
    seen.add(`${ref_kind}:${ref_id}`);
    out.push({ label: `consulted:${label}`, ref_kind, ref_id, audience, consulted: true });
  };
  for (const f of ev.flags.values()) add("flag", f.id, f.audience, `flag:${f.id}`);
  for (const t of ev.traces.values()) add("trace", t.id, t.audience, `trace:${t.id}`);
  for (const d of ev.documents.values()) add("source_document", d.id, d.audience, `doc:${d.id}`);
  for (const h of ev.sourceHits) add("source_document", h.document_id, h.audience, `doc:${h.document_id}`);
  for (const c of ev.targets.values()) add("concept", c.id, c.audience, `concept:${c.path}`);
  for (const r of ev.related) add("concept", r.id, r.audience, `concept:${r.path}`);
  // material without a row: one rowless consulted citation per audience no row above already carries
  const carried = new Set([...cited, ...out].filter((c) => c.audience.length).map((c) => audienceKey(c.audience)));
  for (const t of ev.taint ?? []) {
    const key = audienceKey(t.audience);
    if (!t.audience.length || carried.has(key)) continue;
    carried.add(key);
    out.push({ label: `consulted:${t.label}`, ref_kind: "url", ref_id: null, url: null, quote: t.note, audience: [...new Set(t.audience)].sort(), consulted: true });
  }
  return out;
}

/** Every audience the drafting model has seen so far (pre-fetched, researched, triage and rejection taint). */
function contextAudiences(ev: Evidence): Audience[] {
  return [
    ...[...ev.flags.values()].map((f) => f.audience),
    ...[...ev.traces.values()].map((t) => t.audience),
    ...[...ev.documents.values()].map((d) => d.audience),
    ...ev.sourceHits.map((h) => h.audience),
    ...[...ev.targets.values()].map((c) => c.audience),
    ...ev.related.map((r) => r.audience),
    ...(ev.taint ?? []).map((t) => t.audience),
  ];
}

/** Fixed resolution for a flag dismissed while the model's context held material its readers cannot see. */
export const RESTRICTED_DISMISSAL = "curator: dismissed (reason withheld: restricted_context)";

/**
 * The resolution text of a flag the drafting model dismissed. Flag readers (its audience and its author) see
 * it outside any proposal, so model text is only written when everything in the model's context is readable
 * by the flag's audience; otherwise a fixed reason code.
 */
export function dismissalResolution(ev: Evidence, flag: Flag, reason: string): string {
  if (contextAudiences(ev).some((a) => isEscalation(a, flag.audience ?? []))) return RESTRICTED_DISMISSAL;
  return `curator: ${clipText(reason, REASON_MAX)}`;
}

/**
 * Rejected proposals on the same concepts, as feedback for the model. A rejection is shown only when every
 * audience it touched is in the research scope, and those audiences taint the new proposal.
 */
function usableRejections(rejections: RejectedProposal[], scope: ResearchScope, ev: Evidence): RejectedProposal[] {
  const ok = rejections.filter((r) => Array.isArray(r.audiences) && r.audiences.every((a) => Array.isArray(a) && scope.allows(a)));
  for (const r of ok) {
    for (const a of uniqueAudiences(r.audiences)) {
      (ev.taint ??= []).push({ label: `rejected:${r.id}:${audienceKey(a)}`, audience: a, note: "restricted material behind an earlier rejected proposal's review note" });
    }
  }
  return ok;
}

/** Connector kinds of every document the model saw (for the untrusted-source auto-apply rule). */
function evidenceSourceKinds(ev: Evidence): string[] {
  const kinds = new Set<string>();
  for (const d of ev.documents.values()) if (d.source_kind) kinds.add(d.source_kind);
  for (const h of ev.sourceHits) if (h.source_kind) kinds.add(h.source_kind);
  return [...kinds];
}

const RESEARCH_GUIDE = `

You have research tools. The evidence above is a starting point: when a claim needs support you don't have yet,
search the knowledge base or the sources, open the documents or traces you need, then answer. Only cite evidence
ids you have actually seen (in the evidence above or in a tool result). Stop researching once you can decide.
Some material is outside the audience of the concepts you are changing and is not available to you; never try to
work around that.`;

/**
 * Tools the drafting model may call. Everything they return is added to the evidence maps, so citations to
 * material found during research resolve (and carry their audience) exactly like the pre-fetched evidence,
 * and everything read is tainted as consulted. Results outside the research scope are withheld.
 */
function researchTools(ctx: TaskContext, ev: Evidence, relatedByPath: Map<string, ConceptHit>, scope: ResearchScope) {
  const { store } = ctx;
  const spaceId = ctx.run.space_id;
  const withheld = { error: "not available: outside the audience of the knowledge being changed" };
  return {
    search_knowledge: createTool({
      id: "search_knowledge",
      description: "Search existing concepts in this knowledge base. Returns paths, titles and descriptions.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const hits = (await store.searchConcepts(spaceId, query, 8, { visibleTo: scope.visibleTo })).filter((h) => scope.allows(h.audience));
        for (const h of hits) if (!relatedByPath.has(h.path)) { relatedByPath.set(h.path, h); ev.related.push(h); }
        return { results: hits.map((h) => ({ ref: `concept:${h.path}`, kind: h.kind, type: h.type, title: h.title, description: h.description })) };
      },
    }),
    read_concept: createTool({
      id: "read_concept",
      description: "Read the full current body of an existing concept by path. Read a concept before updating it.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const [c] = await store.getConcepts(spaceId, [normalizeConceptPath(path)]);
        if (!c) return { error: `no concept at ${path}` };
        if (!ev.targets.has(c.path) && !scope.allows(c.audience)) return withheld;
        ev.targets.set(c.path, c);
        return { ref: `concept:${c.path}`, content: renderConcept(c) };
      },
    }),
    search_sources: createTool({
      id: "search_sources",
      description: "Search raw source documents (Notion, Slack, GitHub, Drive, web, uploads) for evidence.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const hits = (await store.searchSources(spaceId, query, 8, { visibleTo: scope.visibleTo })).filter((h) => scope.allows(h.audience));
        for (const h of hits) if (!ev.sourceHits.some((x) => x.document_id === h.document_id)) ev.sourceHits.push(h);
        return { results: hits.map((h) => ({ ref: `doc:${h.document_id}`, title: h.title, url: h.url, snippet: untrusted(`doc:${h.document_id}`, clip(h.snippet, 800)) })) };
      },
    }),
    read_document: createTool({
      id: "read_document",
      description: "Read a source document in full by its id (from search_sources or the evidence list, without the doc: prefix).",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const docId = id.replace(/^doc:/, "").trim();
        const [d] = await store.getDocuments([docId]);
        if (!d || d.space_id !== spaceId) return { error: "document not found" };
        if (!ev.documents.has(d.id) && !scope.allows(d.audience)) return withheld;
        ev.documents.set(d.id, d);
        return { ref: `doc:${d.id}`, title: d.title, url: d.url, content: untrusted(`doc:${d.id}`, clip(d.content, 12_000)) };
      },
    }),
    read_trace: createTool({
      id: "read_trace",
      description: "Read an agent trace (transcript) by id, e.g. one referenced by a flag.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const [t] = await store.getTraces([id.replace(/^trace:/, "").trim()]);
        if (!t || t.space_id !== spaceId) return { error: "trace not found" };
        if (!ev.traces.has(t.id) && !scope.allows(t.audience)) return withheld;
        ev.traces.set(t.id, t);
        return { ref: `trace:${t.id}`, transcript: untrusted(`trace:${t.id}`, renderTrace(t, 12_000)) };
      },
    }),
  };
}

const RISK = { low: 0, medium: 1, high: 2 } as const;
const maxRisk = (...r: ("low" | "medium" | "high")[]) => r.reduce((a, b) => (RISK[b] > RISK[a] ? b : a), "low" as "low" | "medium" | "high");

async function draft(ctx: TaskContext, task: CuratorTask): Promise<Record<string, unknown>> {
  const { store, llm, run, settings, log } = ctx;
  const now = ctx.now();
  const cluster = task.input as unknown as ClusterInput;

  const { ev, scope } = await loadEvidence(ctx, cluster);
  const relatedByPath = new Map(ev.related.map((r) => [r.path, r]));
  const rejections = usableRejections(
    await store.recentRejections(run.space_id, [...new Set([...ev.targets.keys(), ...cluster.concept_paths.map(normalizeConceptPath)])], 5),
    scope,
    ev,
  );
  const input = renderEvidence(ev, cluster, rejections);

  // Deep-agent style: the drafting model starts from the evidence above and can pull more on demand.
  const tools = researchTools(ctx, ev, relatedByPath, scope);
  const system = withHouseRules(DRAFT_SYSTEM + UNTRUSTED_DATA_RULE + RESEARCH_GUIDE, settings.curator.instructions);
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

  const dismissable = (o: DraftOutput, keep: string[] = []) => {
    if (!settings.curator.auto_dismiss_flags) return [];
    const ids = new Set<string>();
    return o.dismiss_flags
      .map((d) => ({ ...d, flag_id: d.flag_id.trim().replace(/^flag:/, "") }))
      .filter((d) => ev.flags.has(d.flag_id) && !keep.includes(d.flag_id) && !ids.has(d.flag_id) && !!ids.add(d.flag_id));
  };
  const dismissFlag = (d: { flag_id: string; reason: string }) => store.dismissFlags([d.flag_id], dismissalResolution(ev, ev.flags.get(d.flag_id)!, d.reason));

  if (out.decision === "no_change" || out.ops.length === 0) {
    // the decision is final, so the model's dismissals can be applied now
    const dismiss = dismissable(out);
    for (const d of dismiss) await dismissFlag(d);
    await store.addRunStats(run.id, { no_change: 1, flags_dismissed: dismiss.length });
    return { decision: "no_change", rationale: out.rationale, dismissed: dismiss.length };
  }

  let built = buildProposal(out, ev, relatedByPath, settings, now);
  let { draft: proposal, problems } = built;

  // Repair round: show the model what failed validation and let it fix its own changeset once. Only when the
  // problems are fixable by the model, and with research tools only when evidence ids failed to resolve.
  if (built.repairable > 0) {
    if (ctx.remainingMs() < MIN_REPAIR_MS) {
      problems = [...problems, "repair round skipped: not enough time left in this task"];
    } else {
      try {
        const repaired = await llm.generate({
          system,
          input: [
            ...input,
            "## Your previous changeset\n" + JSON.stringify(out, null, 1),
            "## Validation problems (fix all of them and return the corrected changeset)\n" + problems.map((p) => `- ${p}`).join("\n"),
          ],
          schema: DraftSchema,
          ...(built.needsResearch ? { tools, maxSteps: Math.min(3, settings.curator.max_research_steps) } : {}),
          maxTokens: 32000,
        });
        const rebuilt = buildProposal(repaired.output, ev, relatedByPath, settings, now);
        if (repaired.output.decision === "propose" && rebuilt.draft.ops.length && rebuilt.problems.length < problems.length) {
          out = repaired.output;
          built = rebuilt;
          proposal = rebuilt.draft;
          problems = rebuilt.problems;
          await store.addRunStats(run.id, { repaired: 1 });
        }
      } catch (e) {
        if (e instanceof LLMBudgetError) throw e;
        problems = [...problems, `repair round failed: ${(e as Error).message}`];
      }
    }
  }
  if (proposal.ops.length === 0) {
    await store.addRunStats(run.id, { invalid_drafts: 1 });
    return { decision: "invalid", problems };
  }

  // second opinion against the same evidence (including what research found) and the same house rules
  let review: ReviewOutput = { ok: false, issues: [], risk: proposal.risk };
  let reviewed = false;
  if (ctx.remainingMs() < MIN_REVIEW_MS) {
    problems.push("self-review skipped: not enough time left in this task");
  } else {
    try {
      const evidence = renderEvidence(ev, cluster, rejections);
      const res = await llm.generate({
        system: withHouseRules(REVIEW_SYSTEM + UNTRUSTED_DATA_RULE, settings.curator.instructions),
        input: [
          ...evidence,
          "## Proposed changeset\n" +
            JSON.stringify({ title: proposal.title, rationale: proposal.rationale, ops: proposal.ops, citations: proposal.citations.map(({ label, ref_kind, ref_id, url, quote }) => ({ label, ref_kind, ref_id, url, quote })) }, null, 1),
        ],
        schema: ReviewSchema,
        maxTokens: 8000,
      });
      review = res.output;
      reviewed = true;
    } catch (e) {
      if (e instanceof LLMBudgetError) throw e;
      problems.push(`self-review failed: ${(e as Error).message}`);
    }
  }

  const blockers = review.issues.filter((i) => i.severity === "blocker");
  // a reviewer verdict of not-ok blocks auto-apply even when it listed no blocker issue
  const rejectedByReview = reviewed && !review.ok;
  proposal.risk = maxRisk(proposal.risk, review.risk, blockers.length ? "high" : rejectedByReview ? "medium" : "low", problems.length ? "medium" : "low");
  const notes = [
    ...(rejectedByReview && !blockers.length ? ["- the self-review did not approve this changeset"] : []),
    ...review.issues.map((i) => `- ${i.severity === "blocker" ? "**BLOCKER** " : ""}${i.kind}: ${i.detail}`),
    ...problems.map((p) => `- check: ${p}`),
  ];
  if (notes.length) proposal.rationale += `\n\n**Curator self-review**\n${notes.join("\n")}`;

  // taint: everything restricted the model saw travels with the proposal as consulted evidence
  const cited = proposal.citations;
  const consulted = consultedCitations(ev, cited);
  const persisted = await store.createProposal(run.space_id, run.id, author, { ...proposal, citations: [...cited, ...consulted] });

  // After this point the proposal exists: a failure must not make the task retry (that would duplicate it).
  const sourceKinds = evidenceSourceKinds(ev);
  const decision = decideAutoApply(settings, {
    risk: persisted.risk,
    escalation: persisted.escalation,
    opKinds: proposal.ops.map((o) => o.op),
    conceptKinds: proposal.ops.map((o) => (o.after.kind ?? ev.targets.get(o.path)?.kind ?? "domain")),
    citationKinds: cited.map((c) => c.ref_kind),
    sourceKinds,
  });
  let applied = false;
  let dismissed = 0;
  const followUp: string[] = [];
  try {
    if (proposal.flag_ids.length) await store.setFlagsInProposal(proposal.flag_ids, persisted.id);
    if (decision.autoApply && reviewed && review.ok && blockers.length === 0 && problems.length === 0) {
      const res = await store.applyProposal(persisted.id, author);
      applied = res.status === "applied";
    }
    // dismissals only once the proposal is persisted, from the final (post-repair) changeset
    const dismiss = dismissable(out, proposal.flag_ids);
    for (const d of dismiss) await dismissFlag(d);
    dismissed = dismiss.length;
  } catch (e) {
    followUp.push((e as Error).message);
    log("curator draft follow-up failed", { task: task.id, proposal: persisted.id, error: (e as Error).message });
  }

  await store.addRunStats(run.id, { proposals: 1, auto_applied: applied ? 1 : 0, escalations: persisted.escalation ? 1 : 0, flags_dismissed: dismissed });
  return {
    decision: "proposed",
    proposal_id: persisted.id,
    risk: persisted.risk,
    escalation: persisted.escalation,
    auto_applied: applied,
    policy: decision.reason,
    issues: notes.length,
    consulted: consulted.length,
    ...(followUp.length ? { follow_up_errors: followUp } : {}),
  };
}
