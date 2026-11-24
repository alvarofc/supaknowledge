// In-memory CuratorStore for the offline demo, adapted from packages/core/test/memory-store.ts. It mirrors the
// database semantics the curator relies on: task bookkeeping, flag states, the escalation guard and the single
// apply path. The real store is SupabaseCuratorStore (packages/core/src/curator/supabase-store.ts).
import { isEscalation, parseSettings, type Concept, type Flag, type ProposalDraft, type SourceDocument, type SpaceSettings, type Trace } from "@supaknowledge/core";
import type {
  ConceptHit,
  CuratorRun,
  CuratorStore,
  CuratorTask,
  NewSyntheticFlag,
  PersistedProposal,
  RejectedProposal,
  SourceHit,
} from "@supaknowledge/core/curator";
import { syntheticFlagAudience } from "@supaknowledge/core/curator";

export interface StoredProposal extends ProposalDraft {
  id: string;
  run_id: string;
  author: string;
  status: "pending" | "applied" | "rejected";
  escalation: boolean;
  auto_applied: boolean;
}

export class MemoryStore implements CuratorStore {
  settings: SpaceSettings;
  runs = new Map<string, CuratorRun & { status: string; stats: Record<string, number> }>();
  tasks = new Map<string, CuratorTask & { status: string; output?: unknown }>();
  queue: CuratorTask[] = [];
  flags: Flag[] = [];
  traces: (Trace & { curated?: boolean })[] = [];
  docs: SourceDocument[] = [];
  concepts: Concept[] = [];
  proposals: StoredProposal[] = [];
  private seq = 0;

  constructor(settings: unknown = {}) {
    this.settings = parseSettings(settings);
  }

  id(prefix: string): string {
    return `${prefix}-${++this.seq}`;
  }

  /** What `request_curator_run()` does in the database: a run plus its first `gather` task on the queue. */
  createRun(spaceId: string): CuratorTask {
    const run = { id: this.id("run"), space_id: spaceId, trigger: "manual", since: null, until: null, status: "queued", stats: {} };
    this.runs.set(run.id, run);
    const t = { id: this.id("task"), run_id: run.id, space_id: spaceId, step: "gather", input: {}, attempts: 0, status: "queued" };
    this.tasks.set(t.id, t);
    this.queue.push(t);
    return t;
  }

  async getRun(runId: string) { return this.runs.get(runId)!; }
  async startRun(runId: string) { this.runs.get(runId)!.status = "running"; }
  async finishTask(taskId: string, output: Record<string, unknown>) {
    const t = this.tasks.get(taskId)!;
    t.status = "succeeded";
    t.output = output;
  }
  async failTask(taskId: string, _error: string, opts: { permanent?: boolean } = {}) {
    const t = this.tasks.get(taskId)!;
    t.attempts++;
    const final = opts.permanent === true || t.attempts >= 3;
    t.status = final ? "failed" : "queued";
    return { final };
  }
  async enqueueTask(runId: string, step: string, input: Record<string, unknown>, opts: { dedupeKey?: string } = {}) {
    if (opts.dedupeKey) {
      const existing = [...this.tasks.values()].find((t) => t.run_id === runId && t.step === step && t.input.dedupe_key === opts.dedupeKey);
      if (existing) return existing.id;
      input = { ...input, dedupe_key: opts.dedupeKey };
    }
    const run = this.runs.get(runId)!;
    const t = { id: this.id("task"), run_id: runId, space_id: run.space_id, step, input, attempts: 0, status: "queued" };
    this.tasks.set(t.id, t);
    this.queue.push(t);
    return t.id;
  }
  /** Like public.kf_maybe_finish_run(): failed if any task failed, succeeded when all succeeded. */
  async maybeFinishRun(runId: string) {
    const run = this.runs.get(runId)!;
    if (!["queued", "running"].includes(run.status)) return run.status;
    const tasks = [...this.tasks.values()].filter((t) => t.run_id === runId);
    if (tasks.some((t) => t.status === "queued" || t.status === "running")) return "running";
    run.status = tasks.some((t) => t.status === "failed") ? "failed" : "succeeded";
    return run.status;
  }
  async addRunStats(runId: string, delta: Record<string, number>) {
    const s = this.runs.get(runId)!.stats;
    for (const [k, v] of Object.entries(delta)) s[k] = (s[k] ?? 0) + v;
    return { ...s };
  }
  async getSettings() { return this.settings; }

  async listOpenFlags(_space: string, limit: number) { return this.flags.filter((f) => f.status === "open").slice(0, limit); }
  async getFlags(ids: string[]) { return this.flags.filter((f) => ids.includes(f.id)); }
  async listUncuratedTraces(_space: string, limit: number) { return this.traces.filter((t) => !t.curated).slice(0, limit); }
  async getTraces(ids: string[]) { return this.traces.filter((t) => ids.includes(t.id)); }
  async markTracesCurated(ids: string[]) { for (const t of this.traces) if (ids.includes(t.id)) t.curated = true; }
  async listChangedDocuments(_space: string, _since: string | null, _until: string | null, limit: number) { return this.docs.slice(0, limit); }
  async getDocuments(ids: string[]) { return this.docs.filter((d) => ids.includes(d.id)); }
  async createSyntheticFlags(flags: NewSyntheticFlag[]) {
    // idempotent like the real store: one flag per trace + lesson (evidence.dedupe_key)
    const seen = new Set(this.flags.filter((f) => f.synthetic).map((f) => `${f.trace_id}:${String(f.evidence.dedupe_key)}`));
    flags = flags.filter((f) => {
      const key = `${f.trace_id}:${String(f.evidence.dedupe_key)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const created = flags.map((f): Flag => {
      const concept = this.concepts.find((x) => x.path === f.concept_path);
      // never attach a concept the flag's readers cannot see
      const audience = concept ? syntheticFlagAudience(f.audience, concept.audience) : null;
      return {
        id: this.id("flag"), space_id: f.space_id, created_by: null, trace_id: f.trace_id, kind: f.kind, concept_id: concept && audience ? concept.id : null,
        concept_path: f.concept_path, query: f.query, observation: f.observation, suggested_fix: f.suggested_fix,
        evidence: f.evidence, audience: audience ?? f.audience, status: "open", synthetic: true, created_at: new Date().toISOString(),
      };
    });
    this.flags.push(...created);
    return created;
  }

  async getConcepts(_space: string, paths: string[]) { return this.concepts.filter((c) => paths.includes(c.path)); }
  async listStaleConcepts() { return this.concepts.filter((c) => c.stale_after && Date.parse(c.stale_after) < Date.now()); }
  /** Keyword overlap instead of hybrid search. Like the real curator (service role), it sees every audience. */
  async searchConcepts(_space: string, query: string, limit: number): Promise<ConceptHit[]> {
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    return this.concepts
      .map((c) => ({ c, score: words.filter((w) => `${c.path} ${c.title} ${c.body}`.toLowerCase().includes(w)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ c, score }) => ({
        id: c.id, path: c.path, kind: c.kind, type: c.type, title: c.title, description: c.description,
        snippet: c.body.slice(0, 200), audience: c.audience, revision: c.revision, status: c.status, score,
      }));
  }
  async searchSources(): Promise<SourceHit[]> { return []; }
  async conceptsCitingDocuments() { return new Map<string, string[]>(); }
  async recentRejections(): Promise<RejectedProposal[]> { return []; }

  /** Escalation is computed like private.recompute_proposal_access(): restricted evidence into a wider target. */
  async createProposal(_space: string, runId: string, author: string, draft: ProposalDraft): Promise<PersistedProposal> {
    const escalation = draft.citations.some((cit) =>
      draft.ops.some((o) => isEscalation(cit.audience, o.after.audience ?? this.concepts.find((x) => x.path === o.path)?.audience ?? [])),
    );
    const p: StoredProposal = {
      ...structuredClone(draft), id: this.id("proposal"), run_id: runId, author, status: "pending", escalation,
      auto_applied: false, risk: escalation ? "high" : draft.risk,
    };
    this.proposals.push(p);
    return { id: p.id, escalation, risk: p.risk };
  }

  /** Like public.apply_proposal(): the only write path. `actor` "human:..." is a reviewer, anything else is policy. */
  async applyProposal(proposalId: string, actor: string) {
    const p = this.proposals.find((x) => x.id === proposalId)!;
    const human = actor.startsWith("human:");
    if (p.escalation && !human) throw new Error("escalations always require human approval");
    for (const o of p.ops) {
      const c = this.concepts.find((x) => x.path === o.path);
      if (o.op === "create") {
        this.concepts.push({
          id: this.id("concept"), space_id: "acme", path: o.path, kind: o.after.kind!, type: o.after.type!, title: o.after.title!,
          description: o.after.description ?? "", body: o.after.body ?? "", frontmatter: o.after.frontmatter ?? {}, tags: o.after.tags ?? [],
          status: "stable", audience: o.after.audience ?? [], revision: 1, generated_by: actor, generated_at: new Date().toISOString(),
          created_at: "", updated_at: "",
        });
      } else if (c) {
        Object.assign(c, o.after, { revision: c.revision + 1, generated_by: actor, generated_at: new Date().toISOString() });
      }
    }
    p.status = "applied";
    p.auto_applied = !human;
    for (const f of this.flags) if (p.flag_ids.includes(f.id)) f.status = "resolved";
    return { status: "applied" };
  }
  async setFlagsInProposal(ids: string[]) { for (const f of this.flags) if (ids.includes(f.id) && f.status === "open") f.status = "in_proposal"; }
  async dismissFlags(ids: string[]) { for (const f of this.flags) if (ids.includes(f.id)) f.status = "dismissed"; }
}
