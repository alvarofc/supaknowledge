import type { FetchLike } from "./types.ts";

export class SupaknowledgeError extends Error {
  /** HTTP status, when the error came from an HTTP response */
  status?: number;
  /** PostgREST / Postgres error code or JSON-RPC error code */
  code?: string | number;
  details?: unknown;
  constructor(message: string, init: { status?: number; code?: string | number; details?: unknown } = {}) {
    super(message);
    this.name = "SupaknowledgeError";
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
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
  });
}

/** fetch + JSON in/out + uniform errors. Returns `undefined` for empty bodies. */
export async function requestJson<T>(fetchFn: FetchLike, url: string, opts: RequestOptions = {}): Promise<T> {
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
