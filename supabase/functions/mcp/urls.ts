// Pure helpers for the MCP function (unit tested in mcp/test/urls.test.ts).

// Hosts that only exist inside a Docker / Kubernetes network: never advertise them to MCP clients.
const INTERNAL_HOST = /^(kong|supabase[-_a-z0-9]*|localhost\.internal|host\.docker\.internal|[a-z0-9-]+\.(svc|cluster\.local|internal))(:\d+)?$/i;

/** "https://host[:port]" from an env value, or null when unset / not an absolute http(s) origin. */
function originOf(v: string | undefined): string | null {
  if (!v?.trim()) return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$|^\[[0-9a-f:.]+\](?::\d{1,5})?$/i;

/**
 * Public base URL (scheme + host) as clients see it, and whether it came from configuration.
 *   1. KF_PUBLIC_URL (set this in production, e.g. https://<ref>.supabase.co)
 *   2. SUPABASE_PUBLIC_URL, or SUPABASE_URL unless it is an internal Docker host (locally it is http://kong:8000)
 *   3. request headers, strictly validated; such responses must not be cached for other hosts.
 */
export function publicBase(req: Request): { base: string; fromHeaders: boolean } {
  const configured = originOf(Deno.env.get("KF_PUBLIC_URL")) ?? originOf(Deno.env.get("SUPABASE_PUBLIC_URL"));
  if (configured) return { base: configured, fromHeaders: false };
  const sb = originOf(Deno.env.get("SUPABASE_URL"));
  if (sb && !INTERNAL_HOST.test(new URL(sb).host)) return { base: sb, fromHeaders: false };

  const url = new URL(req.url);
  const first = (v: string | null | undefined) => v?.split(",")[0]?.trim() || undefined;
  const fwdProto = first(req.headers.get("x-forwarded-proto"))?.toLowerCase();
  const proto = fwdProto === "https" || fwdProto === "http" ? fwdProto : url.protocol === "https:" ? "https" : "http";
  let host = (first(req.headers.get("x-forwarded-host")) ?? first(req.headers.get("host")) ?? url.host).toLowerCase();
  if (!HOST_RE.test(host) || host.length > 255) host = url.host.toLowerCase();
  const port = first(req.headers.get("x-forwarded-port"));
  if (port && /^\d{1,5}$/.test(port) && !/:\d+$/.test(host) && !((proto === "https" && port === "443") || (proto === "http" && port === "80"))) {
    host = `${host}:${port}`;
  }
  return { base: `${proto}://${host}`, fromHeaders: true };
}

/** Cache headers for anything derived from publicBase(): never share a header-derived answer across hosts. */
export function baseCacheHeaders(req: Request): Record<string, string> {
  return publicBase(req).fromHeaders
    ? { "Cache-Control": "no-store", Vary: "Host, X-Forwarded-Host, X-Forwarded-Proto, X-Forwarded-Port" }
    : { "Cache-Control": "public, max-age=300" };
}

/**
 * Concept path as agents write it -> stored path: strips leading "/", a trailing "/SKILL.md" or "/SKILL"
 * (skills are stored by directory) and ".md". Root-relative links ("/finance/board-pack.md") are what
 * docs/okf.md recommends, so flags must resolve them to the same concept (and its audience).
 */
export function normalizeConceptPath(p: string | null | undefined): string | null {
  if (!p) return null;
  const n = p.trim().replace(/^\.?\/+/, "").replace(/\/SKILL\.md$/i, "").replace(/\.md$/i, "").replace(/\/SKILL$/i, "").replace(/\/+$/, "");
  return n || null;
}

/** Escape LIKE wildcards for a PostgREST `like` filter value. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_*]/g, (c) => `\\${c}`);
}
