// The contract every connector implements. Connectors are pure: they talk to the upstream API through
// the injected `fetch`, read their incremental state from `cursor`, and yield DocumentChanges. They never
// touch the database; lib/engine.ts turns the changes into source_documents rows, Storage objects and
// audiences. That keeps them unit-testable against recorded fixtures with a fake fetch.
import type { ConnectorKind } from "../../_shared/core/types.ts";

export type { ConnectorKind };

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type Cursor = Record<string, unknown>;

export interface Logger {
  (message: string, extra?: Record<string, unknown>): void;
}

/**
 * Upstream access information. `refs` are matched against `groups.external_ref` (a group matches when its
 * external_ref contains every key/value of one ref, e.g. {"slack_channel": "C123"}). Matched groups narrow
 * the document audience; they can never widen it beyond the source audience (see lib/acl.ts).
 */
export interface AclHint {
  /** the upstream object is not visible to everyone (private channel, private repo, unshared file...) */
  restricted: boolean;
  refs: Array<Record<string, string>>;
}

export interface RawExport {
  body: Uint8Array | string;
  /** file extension without the dot, used for the Storage object name */
  ext: string;
  contentType: string;
}

export interface SyncedDocument {
  /** stable upstream id, unique per source */
  externalId: string;
  title?: string | null;
  url?: string | null;
  /** markdown / plain text that gets chunked and embedded */
  content: string;
  /** mime type of the original */
  mimeType?: string | null;
  /** original bytes / export, stored in the `sources` bucket */
  raw?: RawExport | null;
  author?: string | null;
  /** upstream last-modified timestamp (ISO) */
  updatedAt?: string | null;
  /** cheap upstream version marker (blob sha, last_edited_time, etag...) used to skip refetching */
  version?: string | null;
  metadata?: Record<string, unknown>;
  acl?: AclHint;
}

export type DocumentChange =
  | { type: "upsert"; doc: SyncedDocument }
  /** the document no longer exists upstream (or left the synced scope) */
  | { type: "delete"; externalId: string; reason?: string }
  /** the COMPLETE set of live upstream ids; every other known document is marked deleted */
  | { type: "snapshot"; externalIds: string[] }
  /**
   * checkpoint: everything yielded before this point is durable once processed. `more` = the connector
   * stopped early (per-run cap) and wants to be re-run soon to continue from this cursor.
   */
  | { type: "cursor"; cursor: Cursor; more?: boolean };

/** What the store already has for an external id (lets connectors skip unchanged upstream objects). */
export interface PreviousDoc {
  contentHash: string;
  version: string | null;
  deleted: boolean;
  /** connector-specific child ids remembered in metadata.children (e.g. Notion child pages) */
  children: string[];
}

export interface SyncContext<C = Record<string, unknown>> {
  config: C;
  /** decrypted connector secret (token, service-account JSON...) or null */
  token: string | null;
  /** sources.cursor; `{}` on the first run */
  cursor: Cursor;
  /** ignore the cursor and re-list everything (manual "sync now", first run) */
  full: boolean;
  fetch: FetchLike;
  log: Logger;
  /** max documents to fetch/emit this run; stop with `more: true` when reached */
  limit: number;
  previous(externalId: string): PreviousDoc | undefined;
  /** every external id the store knows for this source (including deleted ones) */
  known(): string[];
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** environment lookups (e.g. GITHUB_TOKEN fallback); injectable for tests */
  env(name: string): string | undefined;
}

export interface Connector<C = Record<string, unknown>> {
  kind: ConnectorKind;
  /** validate + normalise sources.config; throw ConfigError on bad input */
  parseConfig(raw: unknown): C;
  sync(ctx: SyncContext<C>): AsyncIterable<DocumentChange>;
}

/** Permanent misconfiguration: the source goes to status 'error' immediately, no retries. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Upstream rejected the credentials (401/403 auth). Permanent until someone fixes the secret. */
export class AuthError extends Error {
  override name = "AuthError";
}

/** Upstream asked us to back off longer than we are willing to wait inside one invocation. */
export class RateLimitError extends Error {
  override name = "RateLimitError";
  constructor(public retryAfterMs: number, message?: string) {
    super(message ?? `rate limited; retry after ${Math.ceil(retryAfterMs / 1000)}s`);
  }
}

export class UpstreamError extends Error {
  override name = "UpstreamError";
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------------------
// tiny config helpers (no zod needed for these shapes, and errors read well in sources.last_error)
// ---------------------------------------------------------------------------------------------------------
export function asObject(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("config must be a JSON object");
  return raw as Record<string, unknown>;
}

export function stringList(o: Record<string, unknown>, key: string, opts: { required?: boolean } = {}): string[] {
  const v = o[key];
  if (v === undefined || v === null) {
    if (opts.required) throw new ConfigError(`config.${key} is required`);
    return [];
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim())) {
    throw new ConfigError(`config.${key} must be an array of non-empty strings`);
  }
  const list = (v as string[]).map((x) => x.trim());
  if (opts.required && list.length === 0) throw new ConfigError(`config.${key} must not be empty`);
  return list;
}

export function optString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new ConfigError(`config.${key} must be a string`);
  return v.trim();
}

export function optBool(o: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = o[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") throw new ConfigError(`config.${key} must be a boolean`);
  return v;
}

export function optNumber(o: Record<string, unknown>, key: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const v = o[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw new ConfigError(`config.${key} must be a number between ${min} and ${max}`);
  }
  return v;
}
