import type { FetchLike } from "./types.ts";

export class SupaknowledgeError extends Error {
  /** HTTP status, when the error came from an HTTP response */
  status?: number;
  /** PostgREST / Postgres error code or JSON-RPC error code */
  code?: string | number;
  details?: unknown;
  /** how long the server asked us to wait before retrying (Retry-After), in ms, when it said */
  retryAfterMs?: number;
  constructor(message: string, init: { status?: number; code?: string | number; details?: unknown; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "SupaknowledgeError";
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
  }
}

/** Upper bounds of the 429 retry policy: at most 2 retries, never waiting longer than 30 s for one. */
export const MAX_RETRIES = 2;
export const MAX_RETRY_WAIT_MS = 30_000;

/**
 * Retries of idempotent requests answered with 429 Too Many Requests. `retries` 0 turns them off. A Retry-After
 * longer than `maxWaitMs` is not waited for: the 429 is thrown right away (with `retryAfterMs` set).
 */
export interface RetryPolicy {
  retries: number;
  maxWaitMs: number;
  /** test hook */
  sleep?: (ms: number) => Promise<void>;
}

/** Clamp user options to the bounds above (default: 2 retries, 30 s). `false` disables retries. */
export function retryPolicy(opts?: { retries?: number; maxWaitMs?: number } | false): RetryPolicy {
  if (opts === false) return { retries: 0, maxWaitMs: 0 };
  const clamp = (v: number | undefined, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.floor(v))) : max);
  return { retries: clamp(opts?.retries, MAX_RETRIES), maxWaitMs: clamp(opts?.maxWaitMs, MAX_RETRY_WAIT_MS) };
}

/** Parse Retry-After (delay in seconds or an HTTP date) into milliseconds; undefined when absent or invalid. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `attempt` and retry it while it fails with HTTP 429, honouring Retry-After (else 1 s, 2 s backoff).
 * Only for idempotent requests: the caller decides.
 */
export async function withRetry<T>(attempt: () => Promise<T>, policy: RetryPolicy | undefined): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (e) {
      if (!policy || i >= policy.retries || !(e instanceof SupaknowledgeError) || e.status !== 429) throw e;
      const wait = e.retryAfterMs ?? 1000 * 2 ** i;
      if (wait > policy.maxWaitMs) throw e;
      await (policy.sleep ?? defaultSleep)(wait);
    }
  }
}

/** True when an Edge Function route is missing or still a placeholder (not deployed yet). */
export function isNotDeployed(e: unknown): boolean {
  return e instanceof SupaknowledgeError && (e.status === 404 || e.status === 501);
}

export function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** raw body (already serialized); wins over `body` */
  rawBody?: BodyInit;
  timeoutMs?: number;
  /** retry on 429 (idempotent requests only; `rawBody` must be re-sendable, e.g. a string) */
  retry?: RetryPolicy;
}

function withTimeout(ms: number | undefined): { signal?: AbortSignal; done: () => void } {
  if (!ms || typeof AbortController === "undefined") return { done: () => {} };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new SupaknowledgeError(`request timed out after ${ms}ms`)), ms);
  return { signal: ctl.signal, done: () => clearTimeout(t) };
}

async function errorFrom(res: Response): Promise<SupaknowledgeError> {
  const text = await res.text().catch(() => "");
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  const msg =
    (parsed && (parsed.message ?? parsed.error_description ?? parsed.error ?? parsed.msg)) ||
    text ||
    `${res.status} ${res.statusText}`;
  return new SupaknowledgeError(String(msg), {
    status: res.status,
    code: (parsed?.code as string | undefined) ?? undefined,
    details: parsed ?? text,
    retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
  });
}

/** fetch + JSON in/out + uniform errors. Returns `undefined` for empty bodies. */
export async function requestJson<T>(fetchFn: FetchLike, url: string, opts: RequestOptions = {}): Promise<T> {
  return withRetry(() => requestOnce<T>(fetchFn, url, opts), opts.retry);
}

async function requestOnce<T>(fetchFn: FetchLike, url: string, opts: RequestOptions): Promise<T> {
  const t = withTimeout(opts.timeoutMs);
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  let body: BodyInit | undefined = opts.rawBody;
  if (body === undefined && opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["Content-Type"] ??= "application/json";
  }
  let res: Response;
  try {
    res = await fetchFn(url, { method: opts.method ?? (body ? "POST" : "GET"), headers, body, signal: t.signal });
  } catch (e) {
    t.done();
    if (e instanceof SupaknowledgeError) throw e;
    throw new SupaknowledgeError(`network error calling ${url}: ${(e as Error)?.message ?? e}`, { details: e });
  }
  try {
    if (!res.ok) throw await errorFrom(res);
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  } finally {
    t.done();
  }
}

export { errorFrom };
