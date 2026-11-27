// Domain types shared by Edge Functions, CLI, SDK and Studio. They mirror supabase/migrations.

export const CONCEPT_KINDS = ["skill", "domain", "data_access"] as const;
export type ConceptKind = (typeof CONCEPT_KINDS)[number];

export const CONCEPT_STATUSES = ["draft", "stable", "deprecated"] as const;
export type ConceptStatus = (typeof CONCEPT_STATUSES)[number];

export type TrustTier = "unverified" | "machine_confirmed" | "human_reviewed";
export type SpaceRole = "reader" | "editor" | "reviewer" | "admin";
export type FlagKind = "missing" | "incorrect" | "outdated" | "conflicting" | "unclear";
export type FlagStatus = "open" | "in_proposal" | "resolved" | "dismissed";
export type ProposalStatus = "pending" | "approved" | "applied" | "rejected" | "conflicted" | "superseded";
export type ProposalRisk = "low" | "medium" | "high";
export type ProposalOpKind = "create" | "update" | "deprecate" | "move";
export type CitationKind = "source_document" | "trace" | "flag" | "concept" | "url";
export type ConnectorKind = "notion" | "slack" | "github" | "gdrive" | "web" | "upload" | "schema";
export type TraceRole = "system" | "user" | "assistant" | "tool" | "feedback";

/** A group id list. Empty = everyone who can read the space. */
export type Audience = string[];

/** The editable state of a concept (what proposals write). */
export interface ConceptDraft {
  path: string;
  kind: ConceptKind;
  type: string;
  title: string;
  description: string;
  body: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  status: ConceptStatus;
  superseded_by?: string | null;
  stale_after?: string | null;
  audience: Audience;
}

export interface Concept extends ConceptDraft {
  id: string;
  space_id: string;
  revision: number;
  generated_by: string | null;
  generated_at: string;
  created_at: string;
  updated_at: string;
  trust?: TrustTier;
}

export interface ConceptFile {
  path: string;
  /** utf-8 text or base64 for binary */
  content: string;
  encoding: "utf8" | "base64";
  content_type?: string;
}

export interface Flag {
  id: string;
  space_id: string;
  created_by: string | null;
  trace_id: string | null;
  kind: FlagKind;
  concept_id: string | null;
  concept_path: string | null;
  query: string | null;
  observation: string;
  suggested_fix: string | null;
  evidence: Record<string, unknown>;
  audience: Audience;
  status: FlagStatus;
  synthetic: boolean;
  created_at: string;
}

export interface TraceEvent {
  seq: number;
  role: TraceRole;
  content?: string | null;
  tool_name?: string | null;
  tool_input?: unknown;
  tool_output?: unknown;
  is_error?: boolean;
  at?: string;
}

export interface Trace {
  id: string;
  space_id: string;
  principal_id: string | null;
  name: string | null;
  outcome: "unknown" | "success" | "failure" | "corrected";
  audience: Audience;
  metadata: Record<string, unknown>;
  started_at: string;
  events: TraceEvent[];
}

export interface SourceDocument {
  id: string;
  source_id: string;
  space_id: string;
  external_id: string;
  title: string | null;
  url: string | null;
  content: string;
  audience: Audience;
  author: string | null;
  changed_at: string;
  /** connector kind of the document's source (notion, slack, web, ...) when known */
  source_kind?: string | null;
}

export interface ProposalOp {
  op: ProposalOpKind;
  path: string;
  new_path?: string | null;
  concept_id?: string | null;
  base_revision?: number | null;
  /** partial ConceptDraft for update, full for create */
  after: Partial<ConceptDraft>;
  rationale?: string;
}

export interface Citation {
  label: string;
  ref_kind: CitationKind;
  ref_id?: string | null;
  url?: string | null;
  quote?: string | null;
  audience: Audience;
  /** index into ops; undefined = applies to every op */
  op_index?: number;
  /**
   * Evidence the curator read while drafting but did not cite (taint tracking). The database treats it exactly
   * like a citation for escalation and visibility, so restricted material cannot slip into a wider concept.
   */
  consulted?: boolean;
}

export interface ProposalDraft {
  title: string;
  rationale: string;
  risk: ProposalRisk;
  ops: ProposalOp[];
  citations: Citation[];
  flag_ids: string[];
}
