// CuratorStore backed by Supabase (service role). Used by the `curator` Edge Function and `kf curate`.
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseSettings, type SpaceSettings } from "../settings.ts";
import type { Audience, Concept, Flag, ProposalDraft, SourceDocument, Trace, TraceEvent } from "../types.ts";
import {
  type ConceptHit,
  type CuratorRun,
  type CuratorStore,
  MAX_TASK_ATTEMPTS,
  type NewSyntheticFlag,
  type PersistedProposal,
  type RejectedProposal,
  type SourceHit,
} from "./store.ts";

/**
 * Attach a synthetic flag (audience `flag`) to a concept (audience `concept`) only when that cannot reveal the
 * concept to anyone outside its audience. Returns the flag's audience, or null when the concept must not be
 * attached (the two audiences share no group: the concept stays invisible to the flag's readers).
 */
export function syntheticFlagAudience(flag: Audience, concept: Audience): Audience | null {
  if (!concept.length) return flag;
  if (!flag.length) return concept;
  const both = flag.filter((g) => concept.includes(g));
  return both.length ? both : null;
}

export type Embedder = (text: string) => Promise<number[]>;

function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as T;
}

const CONCEPT_COLS =
  "id, space_id, path, kind, type, title, description, body, frontmatter, tags, status, superseded_by, stale_after, audience, revision, generated_by, generated_at, created_at, updated_at";
const DOC_COLS = "id, source_id, space_id, external_id, title, url, content, audience, author, changed_at, sources(connector)";
/** PostgREST caps every response at api.max_rows (1000 by default): page anything that can be longer. */
const PAGE = 1000;
/** traces per kf_trace_events call */
const TRACE_BATCH = 10;

type SourceRef = { connector: string } | { connector: string }[] | null | undefined;
const connectorOf = (s: SourceRef) => (Array.isArray(s) ? s[0]?.connector : s?.connector);
type DocRow = Omit<SourceDocument, "source_kind"> & { sources?: SourceRef };
function toDocument(r: DocRow): SourceDocument {
  const { sources, ...doc } = r;
  const kind = connectorOf(sources);
  return { ...doc, source_kind: kind ?? null };
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export class SupabaseCuratorStore implements CuratorStore {
  private db: SupabaseClient;
  private embed?: Embedder;

  constructor(db: SupabaseClient, embed?: Embedder) {
    this.db = db;
    this.embed = embed;
  }

  private vec(v: number[] | null) {
    return v ? `[${v.join(",")}]` : null;
  }

  async getRun(runId: string): Promise<CuratorRun> {
    return must(await this.db.from("curator_runs").select("id, space_id, trigger, since, until, stats").eq("id", runId).single(), "getRun");
  }

  async startRun(runId: string) {
    must(await this.db.from("curator_runs").update({ status: "running", started_at: new Date().toISOString() }).eq("id", runId).in("status", ["queued"]), "startRun");
  }

  async finishTask(taskId: string, output: Record<string, unknown>) {
    must(await this.db.rpc("kf_finish_task", { p_task: taskId, p_status: "succeeded", p_output: output, p_error: null }), "finishTask");
  }

  async failTask(taskId: string, error: string, opts: { permanent?: boolean } = {}) {
    const t = must(await this.db.from("curator_tasks").select("attempts").eq("id", taskId).single(), "failTask.read") as { attempts: number };
    const attempts = t.attempts + 1;
    const final = opts.permanent === true || attempts >= MAX_TASK_ATTEMPTS;
    must(await this.db.from("curator_tasks").update({ attempts, error, ...(final ? {} : { status: "queued", finished_at: null }) }).eq("id", taskId), "failTask");
    if (final) must(await this.db.rpc("kf_finish_task", { p_task: taskId, p_status: "failed", p_output: null, p_error: error }), "failTask.finish");
    return { final };
  }

  async enqueueTask(runId: string, step: string, input: Record<string, unknown>, opts: { dedupeKey?: string } = {}): Promise<string> {
    if (opts.dedupeKey) {
      const existing = must(
        await this.db.from("curator_tasks").select("id").eq("run_id", runId).eq("step", step).eq("input->>dedupe_key", opts.dedupeKey).limit(1),
        "enqueueTask.dedupe",
      ) as { id: string }[];
      if (existing[0]) return existing[0].id;
      input = { ...input, dedupe_key: opts.dedupeKey };
    }
    return must(await this.db.rpc("kf_enqueue_curator_task", { p_run: runId, p_step: step, p_input: input }), "enqueueTask") as string;
  }

  async maybeFinishRun(runId: string): Promise<string> {
    return must(await this.db.rpc("kf_maybe_finish_run", { p_run: runId }), "maybeFinishRun") as string;
  }

  async addRunStats(runId: string, delta: Record<string, number>) {
    // atomic in SQL: concurrent draft tasks of one run must not overwrite each other's counts
    return must(await this.db.rpc("kf_add_run_stats", { p_run: runId, p_delta: delta }), "addRunStats") as Record<string, unknown>;
  }

  async getSettings(spaceId: string): Promise<SpaceSettings> {
    const s = must(await this.db.from("spaces").select("settings").eq("id", spaceId).single(), "getSettings") as { settings: unknown };
    return parseSettings(s.settings, (w) => console.warn(`[curator] space ${spaceId} settings: ${w}`));
  }

  async listOpenFlags(spaceId: string, limit: number): Promise<Flag[]> {
    return must(await this.db.from("flags").select("*").eq("space_id", spaceId).eq("status", "open").order("created_at").limit(limit), "listOpenFlags") as Flag[];
  }

  async getFlags(ids: string[]): Promise<Flag[]> {
    if (!ids.length) return [];
    return must(await this.db.from("flags").select("*").in("id", ids), "getFlags") as Flag[];
  }

  /**
   * Every event of every trace (public.kf_trace_events returns ONE jsonb array, so PostgREST's max_rows cap
   * never truncates it; very long traces keep their first and last events).
   */
  private async withEvents(traces: Omit<Trace, "events">[]): Promise<Trace[]> {
    if (!traces.length) return [];
    const byTrace = new Map<string, TraceEvent[]>(traces.map((t) => [t.id, []]));
    for (const batch of chunks(traces.map((t) => t.id), TRACE_BATCH)) {
      const events = must(await this.db.rpc("kf_trace_events", { p_trace_ids: batch, p_max_per_trace: 2000 }), "trace_events") as
        | (TraceEvent & { trace_id: string; metadata?: unknown })[]
        | null;
      for (const { trace_id, metadata: _m, ...e } of events ?? []) byTrace.get(trace_id)?.push(e);
    }
    return traces.map((t) => ({ ...t, events: (byTrace.get(t.id) ?? []).sort((a, b) => a.seq - b.seq) }));
  }

  async listUncuratedTraces(spaceId: string, limit: number): Promise<Trace[]> {
    if (limit <= 0) return [];
    const rows = must(
      await this.db.from("traces").select("id, space_id, principal_id, name, outcome, audience, metadata, started_at").eq("space_id", spaceId).is("curated_at", null).order("created_at").limit(limit),
      "listUncuratedTraces",
    ) as Omit<Trace, "events">[];
    return this.withEvents(rows);
  }

  async getTraces(ids: string[]): Promise<Trace[]> {
    if (!ids.length) return [];
    const rows = must(await this.db.from("traces").select("id, space_id, principal_id, name, outcome, audience, metadata, started_at").in("id", ids), "getTraces") as Omit<Trace, "events">[];
    return this.withEvents(rows);
  }

  async markTracesCurated(ids: string[]) {
    if (!ids.length) return;
    must(await this.db.from("traces").update({ curated_at: new Date().toISOString() }).in("id", ids), "markTracesCurated");
  }

  async listChangedDocuments(spaceId: string, since: string | null, until: string | null, limit: number): Promise<SourceDocument[]> {
    let q = this.db.from("source_documents").select(DOC_COLS).eq("space_id", spaceId).is("deleted_at", null);
    if (since && since !== "-infinity") q = q.gt("changed_at", since);
    if (until) q = q.lte("changed_at", until);
    return (must(await q.order("changed_at").limit(limit), "listChangedDocuments") as unknown as DocRow[]).map(toDocument);
  }

  async getDocuments(ids: string[]): Promise<SourceDocument[]> {
    if (!ids.length) return [];
    return (must(await this.db.from("source_documents").select(DOC_COLS).in("id", ids), "getDocuments") as unknown as DocRow[]).map(toDocument);
  }

  async createSyntheticFlags(flags: NewSyntheticFlag[]): Promise<Flag[]> {
    if (!flags.length) return [];
    // idempotent: a retried gather must not mine the same lesson twice
    const traceIds = [...new Set(flags.map((f) => f.trace_id))];
    const existing = must(
      await this.db.from("flags").select("trace_id, key:evidence->>dedupe_key").in("trace_id", traceIds).eq("synthetic", true),
      "flags.dedupe",
    ) as { trace_id: string; key: string | null }[];
    const seen = new Set(existing.filter((e) => e.key).map((e) => `${e.trace_id}:${e.key}`));
    const fresh = flags.filter((f) => {
      const key = typeof f.evidence.dedupe_key === "string" ? `${f.trace_id}:${f.evidence.dedupe_key}` : null;
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!fresh.length) return [];

    // attach to an existing concept when the path guess is right (and attaching reveals nothing)
    const paths = [...new Set(fresh.map((f) => f.concept_path).filter((p): p is string => !!p))];
    const spaceId = fresh[0]!.space_id;
    const concepts = paths.length
      ? (must(await this.db.from("concepts").select("id, path, audience").eq("space_id", spaceId).in("path", paths), "flags.concepts") as { id: string; path: string; audience: string[] }[])
      : [];
    const byPath = new Map(concepts.map((c) => [c.path, c]));
    const rows = fresh.map((f) => {
      const c = f.concept_path ? byPath.get(f.concept_path) : undefined;
      // readable only by people who can see both the trace and the concept; never attach a concept the flag's
      // readers cannot see (that would confirm its existence and id)
      const audience = c ? syntheticFlagAudience(f.audience ?? [], c.audience ?? []) : null;
      return {
        space_id: f.space_id,
        created_by: null,
        trace_id: f.trace_id,
        kind: f.kind,
        concept_id: c && audience ? c.id : null,
        concept_path: f.concept_path,
        query: f.query,
        observation: f.observation,
        suggested_fix: f.suggested_fix,
        evidence: f.evidence,
        audience: audience ?? f.audience ?? [],
        synthetic: true,
      };
    });
    return must(await this.db.from("flags").insert(rows).select("*"), "createSyntheticFlags") as Flag[];
  }

  async getConcepts(spaceId: string, paths: string[]): Promise<Concept[]> {
    if (!paths.length) return [];
    return must(await this.db.from("concepts").select(CONCEPT_COLS).eq("space_id", spaceId).in("path", paths), "getConcepts") as Concept[];
  }

  async listStaleConcepts(spaceId: string, limit: number): Promise<Concept[]> {
    return must(
      await this.db.from("concepts").select(CONCEPT_COLS).eq("space_id", spaceId).eq("status", "stable").lt("stale_after", new Date().toISOString()).order("stale_after").limit(limit),
      "listStaleConcepts",
    ) as Concept[];
  }

  async searchConcepts(spaceId: string, query: string, limit: number): Promise<ConceptHit[]> {
    const embedding = this.embed ? await this.embed(query) : null;
    const hits = must(
      await this.db.rpc("search_knowledge", { p_space: spaceId, p_query: query, p_embedding: this.vec(embedding), p_limit: limit, p_include_deprecated: true }),
      "searchConcepts",
    ) as (Omit<ConceptHit, "id" | "audience"> & { concept_id: string })[];
    if (!hits.length) return [];
    const aud = must(await this.db.from("concepts").select("id, audience").in("id", hits.map((h) => h.concept_id)), "searchConcepts.audience") as { id: string; audience: string[] }[];
    const byId = new Map(aud.map((a) => [a.id, a.audience]));
    // a hit whose audience cannot be read back is treated as unknown -> skipped, never as public
    return hits.filter((h) => byId.has(h.concept_id)).map((h) => ({ ...h, id: h.concept_id, audience: byId.get(h.concept_id)! }));
  }

  async searchSources(spaceId: string, query: string, limit: number): Promise<SourceHit[]> {
    const embedding = this.embed ? await this.embed(query) : null;
    const hits = must(
      await this.db.rpc("search_sources", { p_space: spaceId, p_query: query, p_embedding: this.vec(embedding), p_limit: limit }),
      "searchSources",
    ) as { document_id: string; title: string | null; url: string | null; snippet: string | null; changed_at: string }[];
    if (!hits.length) return [];
    const meta = must(
      await this.db.from("source_documents").select("id, audience, sources(connector)").in("id", hits.map((h) => h.document_id)),
      "searchSources.audience",
    ) as unknown as { id: string; audience: string[]; sources?: SourceRef }[];
    const byId = new Map(meta.map((m) => [m.id, { audience: m.audience, kind: connectorOf(m.sources) }]));
    return hits
      .filter((h) => byId.has(h.document_id))
      .map((h) => ({ ...h, snippet: h.snippet ?? "", audience: byId.get(h.document_id)!.audience, source_kind: byId.get(h.document_id)!.kind ?? null }));
  }

  async conceptsCitingDocuments(spaceId: string, docs: { id: string; url: string | null }[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!docs.length) return out;
    // one scan of the concepts that record sources (frontmatter.sources), matched in memory: far cheaper than
    // one JSON-containment query per changed document
    const byKey = new Map<string, string>();
    for (const d of docs) {
      byKey.set(`id:${d.id}`, d.id);
      byKey.set(`res:supaknowledge://documents/${d.id}`, d.id);
      if (d.url) byKey.set(`res:${d.url}`, d.id);
    }
    for (let from = 0; ; from += PAGE) {
      const rows = must(
        await this.db
          .from("concepts")
          .select("id, path, sources:frontmatter->sources")
          .eq("space_id", spaceId)
          .neq("status", "deprecated")
          .not("frontmatter->sources", "is", null)
          .order("id")
          .range(from, from + PAGE - 1),
        "conceptsCitingDocuments",
      ) as { id: string; path: string; sources: unknown }[];
      for (const r of rows) {
        if (!Array.isArray(r.sources)) continue;
        for (const s of r.sources as Record<string, unknown>[]) {
          if (!s || typeof s !== "object") continue;
          const keys = [
            typeof s["x-supaknowledge-document"] === "string" ? `id:${s["x-supaknowledge-document"]}` : null,
            typeof s.resource === "string" ? `res:${s.resource}` : null,
          ];
          for (const k of keys) {
            const docId = k ? byKey.get(k) : undefined;
            if (!docId) continue;
            const list = out.get(docId) ?? [];
            if (!list.includes(r.path)) list.push(r.path);
            out.set(docId, list);
          }
        }
      }
      if (rows.length < PAGE) break;
    }
    return out;
  }

  async recentRejections(spaceId: string, paths: string[], limit: number): Promise<RejectedProposal[]> {
    if (!paths.length) return [];
    const ops = must(
      await this.db.from("proposal_ops").select("proposal_id, path, proposals!inner(id, title, review_note, reviewed_at, status)").eq("space_id", spaceId).in("path", paths).eq("proposals.status", "rejected").limit(50),
      "recentRejections",
    ) as unknown as { proposal_id: string; path: string; proposals: { id: string; title: string; review_note: string | null; reviewed_at: string | null } }[];
    const byId = new Map<string, RejectedProposal>();
    for (const o of ops) {
      const p = byId.get(o.proposal_id) ?? { id: o.proposal_id, title: o.proposals.title, paths: [], review_note: o.proposals.review_note, reviewed_at: o.proposals.reviewed_at };
      p.paths.push(o.path);
      byId.set(o.proposal_id, p);
    }
    return [...byId.values()].sort((a, b) => (b.reviewed_at ?? "").localeCompare(a.reviewed_at ?? "")).slice(0, limit);
  }

  async createProposal(spaceId: string, runId: string, author: string, draft: ProposalDraft): Promise<PersistedProposal> {
    // One transaction (public.create_proposal): nothing is visible before ops + citations exist, and the
    // database re-reads every cited/consulted row's live audience to compute escalation.
    const row = must(
      await this.db.rpc("create_proposal", {
        p_space: spaceId,
        p_title: draft.title,
        p_rationale: draft.rationale,
        p_risk: draft.risk,
        p_ops: draft.ops.map((o) => ({
          op: o.op,
          path: o.path,
          new_path: o.new_path ?? null,
          concept_id: o.concept_id ?? null,
          base_revision: o.base_revision ?? null,
          after: o.after,
          rationale: o.rationale ?? null,
        })),
        p_citations: draft.citations.map((c) => ({
          label: c.label,
          ref_kind: c.ref_kind,
          ref_id: c.ref_id ?? null,
          url: c.url ?? null,
          quote: c.quote ?? null,
          op_index: c.op_index ?? null,
          consulted: c.consulted === true,
        })),
        p_run: runId,
        p_author: author,
      }),
      "createProposal",
    ) as { id: string; escalation: boolean; risk: PersistedProposal["risk"] } | { id: string; escalation: boolean; risk: PersistedProposal["risk"] }[];
    const p = Array.isArray(row) ? row[0]! : row;
    return { id: p.id, escalation: p.escalation, risk: p.risk };
  }

  async applyProposal(proposalId: string, actor: string) {
    const p = must(await this.db.rpc("apply_proposal", { p_proposal: proposalId, p_note: null, p_actor: actor }), "applyProposal") as { status: string };
    return { status: p.status };
  }

  async setFlagsInProposal(flagIds: string[], proposalId: string) {
    if (!flagIds.length) return;
    must(await this.db.from("flags").update({ status: "in_proposal", proposal_id: proposalId }).in("id", flagIds).eq("status", "open"), "setFlagsInProposal");
  }

  async dismissFlags(flagIds: string[], reason: string) {
    if (!flagIds.length) return;
    must(
      await this.db.from("flags").update({ status: "dismissed", resolution: reason, resolved_at: new Date().toISOString() }).in("id", flagIds).in("status", ["open", "in_proposal"]),
      "dismissFlags",
    );
  }
}
