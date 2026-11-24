// In-memory CuratorStore for tests and offline demos. Mirrors the database semantics that matter to the
// curator: task bookkeeping, flag states, proposal escalation and apply.
import { isEscalation } from "../src/access.ts";
import { parseSettings, type SpaceSettings } from "../src/settings.ts";
import type { Concept, Flag, ProposalDraft, SourceDocument, Trace } from "../src/types.ts";
import type { ConceptHit, CuratorRun, CuratorStore, CuratorTask, NewSyntheticFlag, PersistedProposal, RejectedProposal, SourceHit } from "../src/curator/store.ts";

export interface StoredProposal extends ProposalDraft {
  id: string;
  author: string;
  status: string;
  escalation: boolean;
}

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

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

  constructor(settings: unknown = {}) {
    this.settings = parseSettings(settings);
  }

  createRun(spaceId: string): CuratorTask {
    const run = { id: id("run"), space_id: spaceId, trigger: "manual", since: null, until: null, status: "queued", stats: {} };
    this.runs.set(run.id, run);
    const t = { id: id("task"), run_id: run.id, space_id: spaceId, step: "gather", input: {}, attempts: 0, status: "queued" };
    this.tasks.set(t.id, t);
    this.queue.push(t);
    return t;
  }

  async getRun(runId: string) { return this.runs.get(runId)!; }
  async startRun(runId: string) { this.runs.get(runId)!.status = "running"; }
  async finishTask(taskId: string, output: Record<string, unknown>) { const t = this.tasks.get(taskId)!; t.status = "succeeded"; t.output = output; }
  async failTask(taskId: string) { const t = this.tasks.get(taskId)!; t.attempts++; t.status = t.attempts >= 3 ? "failed" : "queued"; }
  async enqueueTask(runId: string, step: string, input: Record<string, unknown>) {
    const run = this.runs.get(runId)!;
    const t = { id: id("task"), run_id: runId, space_id: run.space_id, step, input, attempts: 0, status: "queued" };
    this.tasks.set(t.id, t);
    this.queue.push(t);
    return t.id;
  }
  async outstandingTasks(runId: string) { return [...this.tasks.values()].filter((t) => t.run_id === runId && (t.status === "queued" || t.status === "running")).length; }
  async finishRun(runId: string, status: string) { this.runs.get(runId)!.status = status; }
  async addRunStats(runId: string, delta: Record<string, number>) {
    const s = this.runs.get(runId)!.stats;
    for (const [k, v] of Object.entries(delta)) s[k] = (s[k] ?? 0) + v;
  }
  async getSettings() { return this.settings; }
  async listOpenFlags(_s: string, limit: number) { return this.flags.filter((f) => f.status === "open").slice(0, limit); }
  async getFlags(ids: string[]) { return this.flags.filter((f) => ids.includes(f.id)); }
  async listUncuratedTraces(_s: string, limit: number) { return this.traces.filter((t) => !t.curated).slice(0, limit); }
  async getTraces(ids: string[]) { return this.traces.filter((t) => ids.includes(t.id)); }
  async markTracesCurated(ids: string[]) { for (const t of this.traces) if (ids.includes(t.id)) t.curated = true; }
  async listChangedDocuments() { return this.docs; }
  async getDocuments(ids: string[]) { return this.docs.filter((d) => ids.includes(d.id)); }
  async createSyntheticFlags(flags: NewSyntheticFlag[]) {
    const created = flags.map((f) => {
      const c = this.concepts.find((x) => x.path === f.concept_path);
      return {
        id: id("flag"), space_id: f.space_id, created_by: null, trace_id: f.trace_id, kind: f.kind, concept_id: c?.id ?? null,
        concept_path: f.concept_path, query: f.query, observation: f.observation, suggested_fix: f.suggested_fix,
        evidence: f.evidence, audience: f.audience, status: "open" as const, synthetic: true, created_at: new Date().toISOString(),
      };
    });
    this.flags.push(...created);
    return created;
  }
  async getConcepts(_s: string, paths: string[]) { return this.concepts.filter((c) => paths.includes(c.path)); }
  async listStaleConcepts() { return this.concepts.filter((c) => c.stale_after && Date.parse(c.stale_after) < Date.now()); }
  async searchConcepts(_s: string, query: string, limit: number): Promise<ConceptHit[]> {
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    return this.concepts
      .map((c) => ({ c, score: words.filter((w) => `${c.path} ${c.title} ${c.body}`.toLowerCase().includes(w)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ c, score }) => ({ id: c.id, path: c.path, kind: c.kind, type: c.type, title: c.title, description: c.description, snippet: c.body.slice(0, 200), audience: c.audience, revision: c.revision, status: c.status, score }));
  }
  async searchSources(): Promise<SourceHit[]> { return []; }
  async conceptsCitingDocument() { return []; }
  async recentRejections(): Promise<RejectedProposal[]> { return []; }
  async createProposal(_s: string, _r: string, author: string, draft: ProposalDraft): Promise<PersistedProposal> {
    const escalation = draft.citations.some((c) =>
      draft.ops.some((o) => isEscalation(c.audience, o.after.audience ?? this.concepts.find((x) => x.path === o.path)?.audience ?? [])),
    );
    const p = { ...structuredClone(draft), id: id("prop"), author, status: "pending", escalation, risk: escalation ? ("high" as const) : draft.risk };
    this.proposals.push(p);
    return { id: p.id, escalation, risk: p.risk };
  }
  async applyProposal(proposalId: string, actor: string) {
    const p = this.proposals.find((x) => x.id === proposalId)!;
    if (p.escalation) throw new Error("escalations always require human approval");
    for (const o of p.ops) {
      const c = this.concepts.find((x) => x.path === o.path);
      if (o.op === "create") {
        this.concepts.push({
          id: id("concept"), space_id: "s", path: o.path, kind: o.after.kind!, type: o.after.type!, title: o.after.title!,
          description: o.after.description ?? "", body: o.after.body ?? "", frontmatter: o.after.frontmatter ?? {}, tags: o.after.tags ?? [],
          status: "stable", audience: o.after.audience ?? [], revision: 1, generated_by: actor, generated_at: "", created_at: "", updated_at: "",
        });
      } else if (c) {
        Object.assign(c, o.after, { revision: c.revision + 1, generated_by: actor });
      }
    }
    p.status = "applied";
    for (const f of this.flags) if (p.flag_ids.includes(f.id)) f.status = "resolved";
    return { status: "applied" };
  }
  async setFlagsInProposal(ids: string[]) { for (const f of this.flags) if (ids.includes(f.id) && f.status === "open") f.status = "in_proposal"; }
  async dismissFlags(ids: string[]) { for (const f of this.flags) if (ids.includes(f.id)) f.status = "dismissed"; }
}
