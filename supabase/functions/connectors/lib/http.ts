// HTTP helpers shared by connectors: retries on 429 / 5xx honouring Retry-After (and GitHub's
// x-ratelimit-reset), per-request timeouts, and uniform error classes.
import { AuthError, RateLimitError, type SyncContext, UpstreamError } from "./types.ts";

export interface HttpOptions {
  retries?: number;
  /** longest Retry-After we sleep through inside one invocation; longer waits throw RateLimitError */
  maxWaitMs?: number;
  timeoutMs?: number;
}

type Ctx = Pick<SyncContext, "fetch" | "sleep" | "log" | "now">;

/** Parse Retry-After (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const s = Number(value);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt);
}

/** How long the server wants us to wait, or null when the response is not a throttle. */
function throttleWait(res: Response, now: number): number | null {
  const retryAfter = parseRetryAfter(res.headers.get("retry-after"), now);
  if (res.status === 429) return retryAfter ?? 5_000;
  // GitHub primary/secondary rate limits come back as 403
  if (res.status === 403) {
    if (retryAfter !== null) return retryAfter;
    if (res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      return Number.isFinite(reset) ? Math.max(1000, reset * 1000 - now) : 60_000;
    }
  }
  return null;
}

/** fetch with retries. Returns the final response (never throws for HTTP status codes). */
export async function request(ctx: Ctx, url: string | URL, init: RequestInit = {}, opts: HttpOptions = {}): Promise<Response> {
  const retries = opts.retries ?? 4;
  const maxWait = opts.maxWaitMs ?? 30_000;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await ctx.fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
    } catch (e) {
      if (attempt >= retries) throw new UpstreamError(0, `network error for ${redact(url)}: ${e instanceof Error ? e.message : e}`);
      await ctx.sleep(backoffMs(attempt));
      continue;
    }
    const now = ctx.now().getTime();
    const throttle = throttleWait(res, now);
    const serverError = res.status >= 500 && res.status !== 501;
    if (throttle === null && !serverError) return res;
    if (attempt >= retries) {
      if (throttle !== null) {
        await res.body?.cancel();
        throw new RateLimitError(throttle);
      }
      return res;
    }
    const wait = throttle ?? backoffMs(attempt);
    await res.body?.cancel();
    if (wait > maxWait) throw new RateLimitError(wait);
    ctx.log(`throttled by upstream (${res.status}); waiting ${Math.ceil(wait / 1000)}s`, { url: redact(url) });
    await ctx.sleep(wait);
  }
}

/** Strip query strings (tokens sometimes travel there) from URLs that end up in logs / last_error. */
export function redact(url: string | URL): string {
  const u = new URL(String(url));
  return `${u.origin}${u.pathname}`;
}

export async function ensureOk(res: Response, what: string): Promise<Response> {
  if (res.ok) return res;
  const body = (await res.text().catch(() => "")).slice(0, 300);
  if (res.status === 401) throw new AuthError(`${what}: upstream rejected the credentials (401) ${body}`);
  throw new UpstreamError(res.status, `${what}: HTTP ${res.status} ${body}`);
}

export async function getJson<T>(ctx: Ctx, url: string | URL, init: RequestInit = {}, opts?: HttpOptions): Promise<T> {
  const res = await ensureOk(await request(ctx, url, init, opts), `GET ${redact(url)}`);
  return (await res.json()) as T;
}

export async function postJson<T>(ctx: Ctx, url: string | URL, body: unknown, init: RequestInit = {}, opts?: HttpOptions): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  const res = await ensureOk(
    await request(ctx, url, { ...init, method: "POST", headers, body: JSON.stringify(body) }, opts),
    `POST ${redact(url)}`,
  );
  return (await res.json()) as T;
}

/** Parse an RFC 5988 Link header and return the rel="next" URL. */
export function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim());
    if (m) return m[1]!;
  }
  return null;
}

export function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}
