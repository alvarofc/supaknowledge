// CuratorStore backed by Supabase (service role). Used by the `curator` Edge Function and `kf curate`.
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseSettings, type SpaceSettings } from "../settings.ts";
import type { Concept, Flag, ProposalDraft, SourceDocument, Trace, TraceEvent } from "../types.ts";
import type {
  ConceptHit,
  CuratorRun,
  CuratorStore,
  NewSyntheticFlag,
  PersistedProposal,
  RejectedProposal,
  SourceHit,
} from "./store.ts";

/** Audience that is at least as restrictive as both inputs (intersection; falls back to the first if disjoint). */
function combineRestrictions(a: string[], b: string[]): string[] {
  if (!a.length) return b;
  if (!b.length) return a;
  const both = a.filter((g) => b.includes(g));
  return both.length ? both : a;
}

export type Embedder = (text: string) => Promise<number[]>;

function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as T;
}

const CONCEPT_COLS =
  "id, space_id, path, kind, type, title, description, body, frontmatter, tags, status, superseded_by, stale_after, audience, revision, generated_by, generated_at, created_at, updated_at";

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
    return must(await this.db.from("curator_runs").select("id, space_id, trigger, since, until").eq("id", runId).single(), "getRun");
  }

  async startRun(runId: string) {
    must(await this.db.from("curator_runs").update({ status: "running", started_at: new Date().toISOString() }).eq("id", runId).in("status", ["queued"]), "startRun");
  }

  async finishTask(taskId: string, output: Record<string, unknown>) {
    must(await this.db.from("curator_tasks").update({ status: "succeeded", output, error: null, finished_at: new Date().toISOString() }).eq("id", taskId), "finishTask");
  }

  async failTask(taskId: string, error: string) {
    const t = must(await this.db.from("curator_tasks").select("attempts").eq("id", taskId).single(), "failTask.read") as { attempts: number };
    const attempts = t.attempts + 1;
    must(
      await this.db
        .from("curator_tasks")
        .update({ attempts, error, status: attempts >= 3 ? "failed" : "queued", finished_at: attempts >= 3 ? new Date().toISOString() : null })
        .eq("id", taskId),
      "failTask",
    );
  }

  async enqueueTask(runId: string, step: string, input: Record<string, unknown>): Promise<string> {
    return must(await this.db.rpc("kf_enqueue_curator_task", { p_run: runId, p_step: step, p_input: input }), "enqueueTask") as string;
  }

  async outstandingTasks(runId: string): Promise<number> {
    const { count, error } = await this.db
      .from("curator_tasks")
      .select("id", { count: "exact", head: true })
      .eq("run_id", runId)
      .in("status", ["queued", "running"]);
    if (error) throw new Error(`outstandingTasks: ${error.message}`);
    return count ?? 0;
  }

  async finishRun(runId: string, status: "succeeded" | "failed", _stats: Record<string, unknown>, error?: string) {
    must(
      await this.db.from("curator_runs").update({ status, error: error ?? null, finished_at: new Date().toISOString() }).eq("id", runId).in("status", ["queued", "running"]),
      "finishRun",
    );
  }

  async addRunStats(runId: string, delta: Record<string, number>) {
    // atomic in SQL: concurrent draft tasks of one run must not overwrite each other's counts
    must(await this.db.rpc("kf_add_run_stats", { p_run: runId, p_delta: delta }), "addRunStats");
  }

  async getSettings(spaceId: string): Promise<SpaceSettings> {
    const s = must(await this.db.from("spaces").select("settings").eq("id", spaceId).single(), "getSettings") as { settings: unknown };
    return parseSettings(s.settings);
  }

  async listOpenFlags(spaceId: string, limit: number): Promise<Flag[]> {
    return must(await this.db.from("flags").select("*").eq("space_id", spaceId).eq("status", "open").order("created_at").limit(limit), "listOpenFlags") as Flag[];
  }

  async getFlags(ids: string[]): Promise<Flag[]> {
    if (!ids.length) return [];
    return must(await this.db.from("flags").select("*").in("id", ids), "getFlags") as Flag[];
  }

  private async withEvents(traces: Omit<Trace, "events">[]): Promise<Trace[]> {
    if (!traces.length) return [];
    const events = must(
      await this.db.from("trace_events").select("trace_id, seq, role, content, tool_name, tool_input, tool_output, is_error, at").in("trace_id", traces.map((t) => t.id)).order("seq").limit(5000),
      "trace_events",
    ) as (TraceEvent & { trace_id: string })[];
    return traces.map((t) => ({ ...t, events: events.filter((e) => e.trace_id === t.id) }));
  }

  async listUncuratedTraces(spaceId: string, limit: number): Promise<Trace[]> {
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
    let q = this.db.from("source_documents").select("id, source_id, space_id, external_id, title, url, content, audience, author, changed_at").eq("space_id", spaceId).is("deleted_at", null);
    if (since && since !== "-infinity") q = q.gt("changed_at", since);
    if (until) q = q.lte("changed_at", until);
    return must(await q.order("changed_at").limit(limit), "listChangedDocuments") as SourceDocument[];
  }

  async getDocuments(ids: string[]): Promise<SourceDocument[]> {
    if (!ids.length) return [];
    return must(await this.db.from("source_documents").select("id, source_id, space_id, external_id, title, url, content, audience, author, changed_at").in("id", ids), "getDocuments") as SourceDocument[];
  }

  async createSyntheticFlags(flags: NewSyntheticFlag[]): Promise<Flag[]> {
    if (!flags.length) return [];
    // attach to an existing concept when the path guess is right
    const paths = [...new Set(flags.map((f) => f.concept_path).filter((p): p is string => !!p))];
    const spaceId = flags[0]!.space_id;
    const concepts = paths.length
      ? (must(await this.db.from("concepts").select("id, path, audience").eq("space_id", spaceId).in("path", paths), "flags.concepts") as { id: string; path: string; audience: string[] }[])
      : [];
    const byPath = new Map(concepts.map((c) => [c.path, c]));
    const rows = flags.map((f) => {
      const c = f.concept_path ? byPath.get(f.concept_path) : undefined;
      return {
        space_id: f.space_id,
        created_by: null,
        trace_id: f.trace_id,
        kind: f.kind,
        concept_id: c?.id ?? null,
        concept_path: f.concept_path,
        query: f.query,
        observation: f.observation,
        suggested_fix: f.suggested_fix,
        evidence: f.evidence,
        // readable only by people who can see both the trace and the concept
        audience: combineRestrictions(f.audience ?? [], c?.audience ?? []),
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
    return hits.map((h) => ({ ...h, id: h.concept_id, audience: byId.get(h.concept_id) ?? [] }));
  }

  async searchSources(spaceId: string, query: string, limit: number): Promise<SourceHit[]> {
    const embedding = this.embed ? await this.embed(query) : null;
    const hits = must(
      await this.db.rpc("search_sources", { p_space: spaceId, p_query: query, p_embedding: this.vec(embedding), p_limit: limit }),
      "searchSources",
    ) as { document_id: string; title: string | null; url: string | null; snippet: string | null; changed_at: string }[];
    if (!hits.length) return [];
    const aud = must(await this.db.from("source_documents").select("id, audience").in("id", hits.map((h) => h.document_id)), "searchSources.audience") as { id: string; audience: string[] }[];
    const byId = new Map(aud.map((a) => [a.id, a.audience]));
    return hits.map((h) => ({ ...h, snippet: h.snippet ?? "", audience: byId.get(h.document_id) ?? [] }));
  }

  async conceptsCitingDocument(spaceId: string, documentId: string): Promise<string[]> {
    const rows = must(
      await this.db.from("concepts").select("path").eq("space_id", spaceId).neq("status", "deprecated").contains("frontmatter", { sources: [{ resource: `supaknowledge://documents/${documentId}` }] }),
      "conceptsCitingDocument",
    ) as { path: string }[];
    return rows.map((r) => r.path);
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
    const p = must(
      await this.db.from("proposals").insert({ space_id: spaceId, run_id: runId, author, created_by: null, title: draft.title, rationale: draft.rationale, risk: draft.risk }).select("id").single(),
      "createProposal",
    ) as { id: string };
    const opRows = draft.ops.map((o, i) => ({
      proposal_id: p.id,
      space_id: spaceId,
      ord: i,
      op: o.op,
      concept_id: o.concept_id ?? null,
      path: o.path,
      new_path: o.new_path ?? null,
      base_revision: o.base_revision ?? null,
      after: o.after,
      rationale: o.rationale ?? null,
    }));
    const ops = must(await this.db.from("proposal_ops").insert(opRows).select("id, ord"), "createProposal.ops") as { id: string; ord: number }[];
    if (draft.citations.length) {
      const opIdByOrd = new Map(ops.map((o) => [o.ord, o.id]));
      must(
        await this.db.from("proposal_citations").insert(
          draft.citations.map((c) => ({
            proposal_id: p.id,
            space_id: spaceId,
            op_id: c.op_index !== undefined ? (opIdByOrd.get(c.op_index) ?? null) : null,
            label: c.label,
            ref_kind: c.ref_kind,
            ref_id: c.ref_id ?? null,
            url: c.url ?? null,
            quote: c.quote ?? null,
            audience: c.audience,
          })),
        ),
        "createProposal.citations",
      );
    }
    // escalation/risk are computed by database triggers; read them back
    return must(await this.db.from("proposals").select("id, escalation, risk").eq("id", p.id).single(), "createProposal.read") as PersistedProposal;
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
