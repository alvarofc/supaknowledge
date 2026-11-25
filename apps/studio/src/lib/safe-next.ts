// Redirect helpers shared by the auth server routes and the guest pages. Kept free of framework imports so they
// can be unit tested (test/safe-next.test.ts).

const DUMMY_ORIGIN = "https://studio.invalid";

/**
 * Only allow same-origin relative redirects (prevents open redirects through ?next=). The value is resolved the
 * way a browser would resolve it (WHATWG URL parsing strips tabs/newlines and treats `\` as `/`), and only a
 * result on the same origin is accepted. Returns the normalized path + search + hash.
 */
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  if (typeof next !== "string" || !next.startsWith("/")) return fallback;
  // control characters (incl. tab/CR/LF, which URL parsing silently drops) and backslashes never belong in a path
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return fallback;
  let url: URL;
  try {
    url = new URL(next, DUMMY_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== DUMMY_ORIGIN) return fallback;
  const out = `${url.pathname}${url.search}${url.hash}`;
  // belt and braces: a protocol-relative result would leave the origin once it is used as a Location
  if (!out.startsWith("/") || out.startsWith("//")) return fallback;
  return out;
}

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

function firstValue(v: string | null): string | null {
  const first = v?.split(",")[0]?.trim();
  return first ? first : null;
}

function validHost(v: string | null): string | null {
  return v && HOST_RE.test(v) ? v.toLowerCase() : null;
}

function originOf(v: string | undefined): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

export interface OriginEnv {
  /** Studio's public URL (e.g. https://studio.example.com). When set it is always used. */
  SITE_URL?: string;
  /** "1"/"true": trust X-Forwarded-Host / X-Forwarded-Proto (only behind a proxy that overwrites them). */
  TRUST_PROXY?: string;
}

function serverEnv(): OriginEnv {
  const env = typeof process !== "undefined" ? process.env : {};
  return { SITE_URL: env.SITE_URL, TRUST_PROXY: env.TRUST_PROXY };
}

/**
 * The origin the browser used, so server routes redirect back to the host the session cookies live on
 * (`new URL(request.url).origin` can differ, e.g. localhost vs 127.0.0.1 in dev).
 *
 * Order: `SITE_URL` when configured; X-Forwarded-Host/-Proto only when `TRUST_PROXY` is set (first value of a
 * comma list, validated); otherwise the validated Host header with the request's own protocol; otherwise the
 * request URL's origin.
 */
export function requestOrigin(request: Request, env: OriginEnv = serverEnv()): string {
  const fallback = new URL(request.url);
  const site = originOf(env.SITE_URL);
  if (site) return site;
  const h = request.headers;
  const trustProxy = env.TRUST_PROXY === "1" || env.TRUST_PROXY?.toLowerCase() === "true";
  // Behind a trusted TLS proxy the scheme comes from X-Forwarded-Proto even when the proxy keeps the Host header
  // and sends no X-Forwarded-Host (ALB, Fly, Render, Caddy, nginx `proxy_set_header Host $host`).
  const fwdProto = trustProxy ? firstValue(h.get("x-forwarded-proto"))?.toLowerCase() : null;
  const proto = fwdProto === "http" || fwdProto === "https" ? fwdProto : fallback.protocol.replace(":", "");
  const fwdHost = trustProxy ? validHost(firstValue(h.get("x-forwarded-host"))) : null;
  for (const host of [fwdHost, validHost(h.get("host"))]) {
    // originOf validates the port / IPv6 literal and normalizes default ports (:443 / :80)
    const origin = host ? originOf(`${proto}://${host}`) : null;
    if (origin) return origin;
  }
  return fallback.origin;
}

/** A redirect Response back to `path` on the host the browser used (where the session cookies live). */
export function redirectTo(request: Request, path: string, status = 302, env?: OriginEnv): Response {
  return new Response(null, {
    status,
    headers: { Location: new URL(safeNext(path), requestOrigin(request, env)).toString() },
  });
}

/**
 * CSRF guard for state-changing form POSTs (e.g. /auth/signout): accept only same-origin requests. Browsers send
 * `Sec-Fetch-Site` (and `Origin` on POST); a cross-site form or fetch is rejected. Requests that carry neither
 * header (non-browser clients) are allowed, since they cannot ride on a victim's cookies.
 */
export function isSameOriginRequest(request: Request, env?: OriginEnv): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (origin) {
    if (origin === "null") return false;
    const allowed = new Set([requestOrigin(request, env), new URL(request.url).origin]);
    if (!allowed.has(originOf(origin) ?? "")) return false;
  }
  return true;
}
