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
}

export interface RejectedProposal {
  id: string;
  title: string;
  paths: string[];
  review_note: string | null;
  reviewed_at: string | null;
}

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
  finishTask(taskId: string, output: Record<string, unknown>): Promise<void>;
  failTask(taskId: string, error: string): Promise<void>;
  enqueueTask(runId: string, step: string, input: Record<string, unknown>): Promise<string>;
  /** count tasks of the run not yet succeeded/failed */
  outstandingTasks(runId: string): Promise<number>;
  finishRun(runId: string, status: "succeeded" | "failed", stats: Record<string, unknown>, error?: string): Promise<void>;
  addRunStats(runId: string, delta: Record<string, number>): Promise<void>;

  // space
  getSettings(spaceId: string): Promise<SpaceSettings>;

  // evidence
  listOpenFlags(spaceId: string, limit: number): Promise<Flag[]>;
  getFlags(ids: string[]): Promise<Flag[]>;
  listUncuratedTraces(spaceId: string, limit: number): Promise<Trace[]>;
  getTraces(ids: string[]): Promise<Trace[]>;
  markTracesCurated(ids: string[]): Promise<void>;
  listChangedDocuments(spaceId: string, since: string | null, until: string | null, limit: number): Promise<SourceDocument[]>;
  getDocuments(ids: string[]): Promise<SourceDocument[]>;
  createSyntheticFlags(flags: NewSyntheticFlag[]): Promise<Flag[]>;

  // knowledge
  getConcepts(spaceId: string, paths: string[]): Promise<Concept[]>;
  listStaleConcepts(spaceId: string, limit: number): Promise<Concept[]>;
  searchConcepts(spaceId: string, query: string, limit: number): Promise<ConceptHit[]>;
  searchSources(spaceId: string, query: string, limit: number): Promise<SourceHit[]>;
  /** documents a concept cites (frontmatter sources -> source_documents) */
  conceptsCitingDocument(spaceId: string, documentId: string): Promise<string[]>;
  recentRejections(spaceId: string, paths: string[], limit: number): Promise<RejectedProposal[]>;

  // output
  createProposal(spaceId: string, runId: string, author: string, draft: ProposalDraft): Promise<PersistedProposal>;
  applyProposal(proposalId: string, actor: string): Promise<{ status: string }>;
  setFlagsInProposal(flagIds: string[], proposalId: string): Promise<void>;
  dismissFlags(flagIds: string[], reason: string): Promise<void>;
}
