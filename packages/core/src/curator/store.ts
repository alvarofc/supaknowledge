// What the curator needs from storage. The Edge Function implements this with supabase-js + the service
// role (packages/core/src/curator/supabase-store.ts); tests use an in-memory implementation.
//
// The curator runs with the service role, so it can see everything. It is responsible for keeping access
// intact: every piece of evidence carries its audience, and proposals record the audience of what they
// cite. The database then refuses to let a proposal widen access without a space admin.
import type {
  Audience,
  Concept,
  ConceptKind,
  Flag,
  FlagKind,
  ProposalDraft,
  SourceDocument,
  Trace,
} from "../types.ts";
import type { SpaceSettings } from "../settings.ts";

export interface CuratorRun {
  id: string;
  space_id: string;
  trigger: string;
  since: string | null;
  until: string | null;
  /** accumulated run stats (model_calls, input_tokens, ...); used for the per-run token budget */
  stats?: Record<string, unknown>;
}

export interface CuratorTask {
  id: string;
  run_id: string;
  space_id: string;
  step: "gather" | "draft" | "sweep" | string;
  input: Record<string, unknown>;
  attempts: number;
}

export interface ConceptHit {
  id: string;
  path: string;
  kind: ConceptKind;
  type: string;
  title: string;
  description: string;
  snippet: string;
  audience: Audience;
  revision: number;
  status: string;
  score: number;
}

export interface SourceHit {
  document_id: string;
  title: string | null;
  url: string | null;
  snippet: string;
  audience: Audience;
  changed_at: string;
  /** connector kind of the document's source (notion, slack, web, ...) */
  source_kind?: string | null;
}

export interface RejectedProposal {
  id: string;
  title: string;
  paths: string[];
  review_note: string | null;
  reviewed_at: string | null;
}

export const MAX_TASK_ATTEMPTS = 3;

export interface NewSyntheticFlag {
  space_id: string;
  trace_id: string;
  kind: FlagKind;
  concept_path: string | null;
  query: string | null;
  observation: string;
  suggested_fix: string | null;
  evidence: Record<string, unknown>;
  audience: Audience;
}

export interface PersistedProposal {
  id: string;
  escalation: boolean;
  risk: "low" | "medium" | "high";
}

export interface CuratorStore {
  // runs & tasks
  getRun(runId: string): Promise<CuratorRun>;
  startRun(runId: string): Promise<void>;
  /** mark the task succeeded (public.kf_finish_task) */
  finishTask(taskId: string, output: Record<string, unknown>): Promise<void>;
  /**
   * Record a failed attempt. The task goes back to `queued` for a retry until it has failed MAX_ATTEMPTS
   * times (or `permanent` is set), then it is `failed` for good. Returns whether it is now final.
   */
  failTask(taskId: string, error: string, opts?: { permanent?: boolean }): Promise<{ final: boolean }>;
  /**
   * Enqueue a task. With `dedupeKey`, a task of the same run+step+key that already exists is returned instead
   * (retries of a task that enqueues work must not enqueue it twice).
   */
  enqueueTask(runId: string, step: string, input: Record<string, unknown>, opts?: { dedupeKey?: string }): Promise<string>;
  /**
   * Close the run if no task is outstanding (public.kf_maybe_finish_run): `failed` when any task failed,
   * `succeeded` when all succeeded. Returns the run status ("running" while tasks remain).
   */
  maybeFinishRun(runId: string): Promise<string>;
  /** atomically add numeric stats; returns the run's new stats when the store can */
  addRunStats(runId: string, delta: Record<string, number>): Promise<Record<string, unknown> | void>;

  // space
  getSettings(spaceId: string): Promise<SpaceSettings>;

  // evidence
  listOpenFlags(spaceId: string, limit: number): Promise<Flag[]>;
  getFlags(ids: string[]): Promise<Flag[]>;
  /** traces not yet curated, oldest first, with ALL their events */
  listUncuratedTraces(spaceId: string, limit: number): Promise<Trace[]>;
  getTraces(ids: string[]): Promise<Trace[]>;
  markTracesCurated(ids: string[]): Promise<void>;
  listChangedDocuments(spaceId: string, since: string | null, until: string | null, limit: number): Promise<SourceDocument[]>;
  getDocuments(ids: string[]): Promise<SourceDocument[]>;
  /**
   * Insert flags mined from traces. Idempotent: a flag whose `evidence.dedupe_key` already exists for the same
   * trace is not inserted again. A flag is attached to an existing concept only when everyone who can read the
   * flag can also read that concept.
   */
  createSyntheticFlags(flags: NewSyntheticFlag[]): Promise<Flag[]>;

  // knowledge
  getConcepts(spaceId: string, paths: string[]): Promise<Concept[]>;
  listStaleConcepts(spaceId: string, limit: number): Promise<Concept[]>;
  searchConcepts(spaceId: string, query: string, limit: number): Promise<ConceptHit[]>;
  searchSources(spaceId: string, query: string, limit: number): Promise<SourceHit[]>;
  /**
   * Concepts citing each document (frontmatter `sources[]` entries with `x-supaknowledge-document: <id>`,
   * `resource: supaknowledge://documents/<id>`, or the document's URL). One batched lookup: doc id -> paths.
   */
  conceptsCitingDocuments(spaceId: string, docs: { id: string; url: string | null }[]): Promise<Map<string, string[]>>;
  recentRejections(spaceId: string, paths: string[], limit: number): Promise<RejectedProposal[]>;

  // output
  /** atomic (public.create_proposal): ops + citations (incl. consulted evidence) land in one transaction */
  createProposal(spaceId: string, runId: string, author: string, draft: ProposalDraft): Promise<PersistedProposal>;
  applyProposal(proposalId: string, actor: string): Promise<{ status: string }>;
  setFlagsInProposal(flagIds: string[], proposalId: string): Promise<void>;
  dismissFlags(flagIds: string[], reason: string): Promise<void>;
}
