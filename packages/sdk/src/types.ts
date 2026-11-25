// Public types of the Supaknowledge SDK. Kept dependency-free so the SDK runs anywhere `fetch` exists.

export type ConceptKind = "skill" | "domain" | "data_access";
export type ConceptStatus = "draft" | "stable" | "deprecated";
export type TrustTier = "unverified" | "machine_confirmed" | "human_reviewed";
export type FlagKind = "missing" | "incorrect" | "outdated" | "conflicting" | "unclear";
export type TraceOutcome = "unknown" | "success" | "failure" | "corrected";
export type TraceRole = "system" | "user" | "assistant" | "tool" | "feedback";

export const FLAG_KINDS: readonly FlagKind[] = ["missing", "incorrect", "outdated", "conflicting", "unclear"];
export const CONCEPT_KINDS: readonly ConceptKind[] = ["skill", "domain", "data_access"];

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type TokenSource = string | (() => string | Promise<string>);

export interface SupaknowledgeOptions {
  /** Supabase project URL, e.g. https://abc.supabase.co or http://127.0.0.1:54321 */
  url: string;
  /** Space to work in: "<workspace>/<space>" slug pair (or a space uuid with transport "rest"). */
  space: string;
  /** Agent API key (`skn_<agent>_<secret>`). Sent as `Authorization: Bearer`. */
  apiKey?: string;
  /** User access token (Supabase session JWT or OAuth token), or a function returning a fresh one. */
  accessToken?: TokenSource;
  /** Project publishable key. Sent as `apikey` on PostgREST calls (needed for transport "rest"). */
  publishableKey?: string;
  /**
   * How knowledge calls travel:
   *  - "mcp":  JSON-RPC to the `mcp` Edge Function (semantic + full-text search). Works with any credential.
   *  - "rest": PostgREST RPCs directly (full-text search only, no query embedding). Needs accessToken + publishableKey.
   *  - "auto": MCP first; falls back to REST when the mcp function is not deployed (404/501). Default.
   */
  transport?: "mcp" | "rest" | "auto";
  /** Custom fetch (tests, proxies, runtimes without a global fetch). */
  fetch?: FetchLike;
  /** Extra headers for every request. */
  headers?: Record<string, string>;
  /** Called for background errors (trace flushes). Defaults to console.warn. */
  onError?: (error: unknown) => void;
  /** Per-request timeout in ms. Default 30000. */
  timeoutMs?: number;
  /**
   * Retries when the server answers 429 Too Many Requests (e.g. after repeated failed agent-key sign-ins),
   * honouring Retry-After. Only idempotent requests are retried: reads (search, read, skills, read-only MCP
   * tools, REST reads). Writes (flags, traces) are not; their 429 surfaces as a SupaknowledgeError with
   * `status` 429 and `retryAfterMs`. Default and maximum: 2 retries, waiting at most 30 s for one (a longer
   * Retry-After fails right away). `false` turns retries off.
   */
  retry?: { retries?: number; maxWaitMs?: number } | false;
}

export interface SearchOptions {
  kinds?: ConceptKind[];
  limit?: number;
  /** Link the search to a trace (concept usage is attributed to it). */
  traceId?: string;
}

export interface ReadOptions {
  /** Link the read / skill load to a trace (concept usage is attributed to it). */
  traceId?: string;
}

export interface SearchResult {
  path: string;
  title: string;
  kind: ConceptKind;
  type?: string;
  description?: string;
  snippet?: string;
  trust?: TrustTier;
  stale?: boolean;
  status?: ConceptStatus;
  revision?: number;
  score?: number;
  [key: string]: unknown;
}

export interface ConceptLink {
  path: string;
  anchor?: string | null;
  exists?: boolean;
}

export interface Concept {
  path: string;
  kind: ConceptKind;
  type: string;
  title: string;
  description: string;
  body: string;
  frontmatter?: Record<string, unknown>;
  tags?: string[];
  status?: ConceptStatus;
  trust?: TrustTier;
  stale?: boolean;
  revision?: number;
  superseded_by?: string | null;
  links?: ConceptLink[];
  backlinks?: { path: string; title: string }[];
  files?: { path: string; content_type?: string | null; size_bytes?: number | null; content?: string }[];
  /** Model-ready rendering from the MCP server (what tool handlers return to the model), when available */
  markdown?: string;
  [key: string]: unknown;
}

export interface SkillSummary {
  name: string;
  path: string;
  title?: string;
  description: string;
  [key: string]: unknown;
}

export interface Skill extends Concept {
  name: string;
}

export interface FlagInput {
  kind: FlagKind;
  /** What you saw, e.g. "column revenue_usd does not exist; found revenue_usd_net". Required. */
  observation: string;
  /** Concept the flag is about (omit for "missing"). */
  conceptPath?: string;
  /** What you were trying to do or looked for. */
  query?: string;
  suggestedFix?: string;
  traceId?: string;
  /**
   * Structured details stored with the flag (e.g. the failing query and error). The mcp function caps it at
   * 16,000 characters of JSON and sets its own `via` / `client_id` keys.
   */
  evidence?: Record<string, unknown>;
}

export interface FlagResult {
  id: string | null;
  [key: string]: unknown;
}

export interface TraceEventInput {
  role: TraceRole;
  content?: string | null;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: unknown;
  is_error?: boolean;
  metadata?: Record<string, unknown>;
  /** ISO timestamp; set automatically when the event is recorded. */
  at?: string;
}
