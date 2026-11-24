// Outbound URL guard for connectors (SSRF defence). Source configs come from space admins, and fetched
// content ends up in source_documents, so every outbound request must be limited to the public internet:
//   * only http(s); https is mandatory whenever credentials (Authorization / Cookie) are attached
//   * no loopback / private / CGNAT / link-local / metadata / multicast / reserved IPs (v4 and v6, including
//     IPv4-mapped and NAT64/6to4 embeddings), no internal hostnames (single-label names such as `kong` or
//     `db`, localhost, *.internal, *.local, *.svc, *.home.arpa ...)
//   * hostnames are resolved (Deno.resolveDns, A + AAAA) and rejected when any address is non-public; when
//     the runtime cannot resolve (no permission / API missing) the hostname checks alone apply
//   * redirects are followed manually (max 5 hops); every hop is re-validated and credentials are dropped
//     when a hop changes origin
// Escape hatch for self-hosted / dev setups that sync intranet sites: KF_CONNECTORS_ALLOW_PRIVATE_NETWORK=true.
import { ConfigError, type FetchLike } from "./types.ts";

/** A URL the guard refuses to contact. A ConfigError: retrying cannot help until the config changes. */
export class BlockedUrlError extends ConfigError {
  override name = "BlockedUrlError";
}

export type Resolver = (host: string) => Promise<string[]>;

export interface GuardOptions {
  /** underlying fetch (default: globalThis.fetch) */
  fetch?: FetchLike;
  /** DNS resolver (default: Deno.resolveDns A + AAAA); return [] when the name cannot be checked */
  resolve?: Resolver;
  /** skip the private-network checks (default: env KF_CONNECTORS_ALLOW_PRIVATE_NETWORK === "true") */
  allowPrivate?: boolean;
  maxRedirects?: number;
}

export function allowPrivateFromEnv(): boolean {
  try {
    return (Deno.env.get("KF_CONNECTORS_ALLOW_PRIVATE_NETWORK") ?? "").toLowerCase() === "true";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------
// IP classification
// ---------------------------------------------------------------------------------------------------------
function parseV4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : null;
}

function v4Blocked([a, b, c]: number[]): boolean {
  return (
    a === 0 || a === 10 || a === 127 || // "this" network, private, loopback
    (a === 100 && b! >= 64 && b! <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || // TEST-NET-2/3
    a! >= 224 // multicast, reserved, broadcast
  );
}

/** Expand an IPv6 literal into 8 16-bit groups (handles :: and a trailing dotted IPv4). */
function parseV6(s: string): number[] | null {
  let str = s.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!str.includes(":")) return null;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(str);
  if (tail) {
    const v4 = parseV4(tail[1]!);
    if (!v4) return null;
    str = str.slice(0, -tail[1]!.length) + `${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function v6Blocked(g: number[]): boolean {
  const embedded = (hi: number, lo: number) => v4Blocked([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded(g[6]!, g[7]!); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return true; // IPv4-compatible (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b) return embedded(g[6]!, g[7]!); // NAT64
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!); // 6to4
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard prefix
  return false;
}

/** true when `ip` is an IP literal that is not a public unicast address. */
export function isPrivateIp(ip: string): boolean {
  const v4 = parseV4(ip);
  if (v4) return v4Blocked(v4);
  const v6 = parseV6(ip);
  if (v6) return v6Blocked(v6);
  return false;
}

export function isIpLiteral(host: string): boolean {
  return !!parseV4(host) || !!parseV6(host);
}

const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa", ".corp", ".svc", ".cluster.local", ".consul"];

/** Hostname-only checks (no DNS). Returns a reason when blocked. */
export function hostnameProblem(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return "empty host";
  if (isIpLiteral(h)) return isPrivateIp(h) ? `non-public address ${h}` : null;
  if (h === "localhost" || INTERNAL_SUFFIXES.some((s) => h.endsWith(s))) return `internal hostname ${h}`;
  if (!h.includes(".")) return `single-label (internal) hostname ${h}`;
  return null;
}

/**
 * Synchronous URL check used by parseConfig (and by every hop of the guarded fetch).
 * Throws BlockedUrlError; returns the parsed URL.
 */
export function assertPublicUrl(
  raw: string | URL,
  opts: { requireHttps?: boolean; allowPrivate?: boolean } = {},
): URL {
  let u: URL;
  try {
    u = new URL(String(raw));
  } catch {
    throw new BlockedUrlError(`invalid URL`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new BlockedUrlError(`blocked URL scheme ${u.protocol}`);
  if (opts.requireHttps && u.protocol !== "https:") throw new BlockedUrlError(`https is required for ${u.origin} (credentials attached)`);
  if (u.username || u.password) throw new BlockedUrlError("URLs with embedded credentials are not allowed");
  const allowPrivate = opts.allowPrivate ?? allowPrivateFromEnv();
  if (!allowPrivate) {
    const problem = hostnameProblem(u.hostname);
    if (problem) throw new BlockedUrlError(`blocked outbound request to ${u.origin}: ${problem}`);
  }
  return u;
}

export const defaultResolver: Resolver = async (host) => {
  const resolveDns = (Deno as unknown as { resolveDns?: (h: string, t: "A" | "AAAA") => Promise<string[]> }).resolveDns;
  if (typeof resolveDns !== "function") return [];
  const results = await Promise.allSettled([resolveDns(host, "A"), resolveDns(host, "AAAA")]);
  // NotFound / permission / unsupported: nothing to check here (the fetch fails by itself when the name is bogus)
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
};

/** Validate the URL and (unless it is an IP literal) the addresses its hostname resolves to. */
export async function assertPublicDestination(
  raw: string | URL,
  opts: { requireHttps?: boolean; allowPrivate?: boolean; resolve?: Resolver } = {},
): Promise<URL> {
  const allowPrivate = opts.allowPrivate ?? allowPrivateFromEnv();
  const u = assertPublicUrl(raw, { ...opts, allowPrivate });
  if (allowPrivate) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIpLiteral(host)) return u;
  let addrs: string[] = [];
  try {
    addrs = await (opts.resolve ?? defaultResolver)(host);
  } catch {
    addrs = [];
  }
  const bad = addrs.find((a) => isPrivateIp(a));
  if (bad) throw new BlockedUrlError(`blocked outbound request to ${u.origin}: resolves to non-public address ${bad}`);
  return u;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/**
 * A fetch that enforces the guard on the first request and on every redirect hop. Callers that pass
 * `redirect: "manual"` get the 3xx response back (after the request itself was validated) and follow it
 * themselves; `redirect: "error"` throws on 3xx; the default follows up to `maxRedirects` hops.
 */
export function guardedFetch(opts: GuardOptions = {}): FetchLike {
  const inner = opts.fetch ?? ((i: string | URL | Request, init?: RequestInit) => fetch(i, init));
  const maxRedirects = opts.maxRedirects ?? 5;
  return async (input, init = {}) => {
    const allowPrivate = opts.allowPrivate ?? allowPrivateFromEnv();
    let url = input instanceof Request ? input.url : String(input);
    let method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    let body = init.body;
    const mode = init.redirect ?? "follow";
    for (let hop = 0; ; hop++) {
      const hasCreds = CREDENTIAL_HEADERS.some((h) => headers.has(h));
      const current = await assertPublicDestination(url, { requireHttps: hasCreds && !allowPrivate, allowPrivate, resolve: opts.resolve });
      const res = await inner(current.toString(), { ...init, method, headers, body, redirect: "manual" });
      if (!REDIRECTS.has(res.status) || mode === "manual") return res;
      const location = res.headers.get("location");
      if (!location) return res;
      await res.body?.cancel();
      if (mode === "error") throw new TypeError(`redirect to ${location} not allowed`);
      if (hop >= maxRedirects) throw new TypeError(`too many redirects (> ${maxRedirects})`);
      const next = new URL(location, current);
      if (next.origin !== current.origin) for (const h of CREDENTIAL_HEADERS) headers.delete(h);
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        if (method !== "HEAD") method = "GET";
        body = undefined;
        headers.delete("content-type");
        headers.delete("content-length");
      }
      url = next.toString();
    }
  };
}
