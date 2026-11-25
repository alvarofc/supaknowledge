// Outbound URL guard for connectors (SSRF defence). Source configs come from space admins, and fetched
// content ends up in source_documents, so every outbound request must be limited to the public internet:
//   * only http(s); https is mandatory whenever credentials (Authorization / Cookie) are attached
//   * no loopback / private / CGNAT / link-local / metadata / multicast / reserved IPs (v4 and v6, including
//     IPv4-mapped, SIIT, NAT64 (well-known and local-use), 6to4, Teredo, ORCHID and benchmarking ranges), no
//     internal hostnames (single-label names such as `kong` or `db`, localhost, *.internal, *.local, *.svc,
//     *.home.arpa ...; trailing dots are ignored and empty labels are refused)
//   * hostnames are resolved (Deno.resolveDns, A + AAAA) and rejected when any address is non-public. The
//     check FAILS CLOSED: no resolver, a lookup error or an empty answer refuses the request (as a transient
//     DnsResolutionError, so a DNS hiccup is retried instead of failing the source permanently)
//   * DNS rebinding: Deno's fetch resolves the name again and cannot be pinned to the checked address, so the
//     name is re-resolved after the response headers arrive and the response is discarded when it now points
//     at a non-public address. That narrows but cannot close the window (the request itself was already
//     sent); production deployments should route connector traffic through an egress proxy that enforces
//     the same policy on the address it actually connects to: KF_CONNECTORS_EGRESS_PROXY=http://proxy:port
//     (e.g. Smokescreen), used for every connector request via Deno.createHttpClient({ proxy })
//   * redirects are followed manually (max 5 hops); every hop is re-validated and credentials are dropped
//     when a hop changes origin
// Escape hatch for self-hosted / dev setups that sync intranet sites: KF_CONNECTORS_ALLOW_PRIVATE_NETWORK=true.
import { ConfigError, type FetchLike, UpstreamError } from "./types.ts";

/** A URL the guard refuses to contact. A ConfigError: retrying cannot help until the config changes. */
export class BlockedUrlError extends ConfigError {
  override name = "BlockedUrlError";
}

/**
 * The destination's addresses could not be checked (lookup failed or returned nothing). The request is
 * refused (fail closed), but as a transient upstream error: the next attempt / run tries again.
 */
export class DnsResolutionError extends UpstreamError {
  override name = "DnsResolutionError";
  constructor(message: string) {
    super(0, message);
  }
}

/** Resolve a host name to its addresses. Throw (or return []) when it cannot be resolved: both refuse it. */
export type Resolver = (host: string) => Promise<string[]>;

export interface GuardOptions {
  /** underlying fetch (default: globalThis.fetch, through KF_CONNECTORS_EGRESS_PROXY when that is set) */
  fetch?: FetchLike;
  /** DNS resolver (default: Deno.resolveDns A + AAAA) */
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
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return embedded(g[6]!, g[7]!); // SIIT ::ffff:0:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return true; // IPv4-compatible (deprecated)
  if (g.slice(0, 4).every((x) => x === 0)) return true; // rest of ::/64 (unassigned; never a public host)
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // 64:ff9b:1::/48 local-use NAT64 (RFC 8215)
  if (g[0] === 0x64 && g[1] === 0xff9b) return embedded(g[6]!, g[7]!); // 64:ff9b::/96 well-known NAT64
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // 2001::/32 Teredo (embeds an obfuscated IPv4)
  if (g[0] === 0x2001 && g[1] === 2 && g[2] === 0) return true; // 2001:2::/48 benchmarking
  if (g[0] === 0x2001 && ((g[1]! & 0xfff0) === 0x10 || (g[1]! & 0xfff0) === 0x20)) return true; // ORCHID / ORCHIDv2
  if (g[0] === 0x3fff && (g[1]! & 0xf000) === 0) return true; // 3fff::/20 documentation (RFC 9637)
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

/** Lower-case, unbracket and strip every trailing dot (`localhost..` is still localhost). */
function normaliseHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa", ".corp", ".svc", ".cluster.local", ".consul"];

/** Hostname-only checks (no DNS). Returns a reason when blocked. */
export function hostnameProblem(hostname: string): string | null {
  const h = normaliseHost(hostname);
  if (!h) return "empty host";
  if (isIpLiteral(h)) return isPrivateIp(h) ? `non-public address ${h}` : null;
  if (h.startsWith(".") || h.includes("..")) return `hostname with an empty label ${h}`;
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

/**
 * Deno.resolveDns A + AAAA. A record type the name simply does not have (NotFound) contributes nothing; any
 * other failure (timeout, permission, missing API) throws, so the caller refuses the request.
 */
export const defaultResolver: Resolver = async (host) => {
  const resolveDns = (Deno as unknown as { resolveDns?: (h: string, t: "A" | "AAAA") => Promise<string[]> }).resolveDns;
  if (typeof resolveDns !== "function") throw new Error("DNS resolution is not available in this runtime");
  const results = await Promise.allSettled([resolveDns(host, "A"), resolveDns(host, "AAAA")]);
  const addrs: string[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") addrs.push(...r.value);
    else if (!(r.reason instanceof Deno.errors.NotFound)) throw r.reason;
  }
  return addrs;
};

/** Every address `host` resolves to; refuses (fail closed) when there is none or the lookup fails. */
async function resolvePublic(host: string, origin: string, resolve: Resolver): Promise<void> {
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch (e) {
    throw new DnsResolutionError(`refusing outbound request to ${origin}: could not resolve ${host} (${e instanceof Error ? e.message : e})`);
  }
  if (!addrs.length) throw new DnsResolutionError(`refusing outbound request to ${origin}: ${host} resolves to no address`);
  const bad = addrs.find((a) => !isIpLiteral(a) || isPrivateIp(a));
  if (bad) throw new BlockedUrlError(`blocked outbound request to ${origin}: resolves to non-public address ${bad}`);
}

/** Validate the URL and (unless it is an IP literal) the addresses its hostname resolves to. */
export async function assertPublicDestination(
  raw: string | URL,
  opts: { requireHttps?: boolean; allowPrivate?: boolean; resolve?: Resolver } = {},
): Promise<URL> {
  const allowPrivate = opts.allowPrivate ?? allowPrivateFromEnv();
  const u = assertPublicUrl(raw, { ...opts, allowPrivate });
  if (allowPrivate) return u;
  const host = normaliseHost(u.hostname);
  if (isIpLiteral(host)) return u;
  await resolvePublic(host, u.origin, opts.resolve ?? defaultResolver);
  return u;
}

// ---------------------------------------------------------------------------------------------------------
// egress proxy
// ---------------------------------------------------------------------------------------------------------
export function egressProxyFromEnv(): string | null {
  try {
    return Deno.env.get("KF_CONNECTORS_EGRESS_PROXY")?.trim() || null;
  } catch {
    return null;
  }
}

type CreateHttpClient = (opts: { proxy: { url: string; basicAuth?: { username: string; password: string } } }) => unknown;

/**
 * A fetch that sends every request through the HTTP(S) proxy at `proxyUrl` (CONNECT for https, absolute-form
 * for http). The proxy is the component that connects to the resolved address, so it is where DNS rebinding
 * is actually closed: it must refuse non-public destinations itself (e.g. Smokescreen's default policy).
 * Throws a ConfigError when the runtime has no Deno.createHttpClient: never silently bypass the proxy.
 */
export function proxiedFetch(
  proxyUrl: string,
  deps: { createHttpClient?: CreateHttpClient; fetch?: (i: string | URL | Request, init?: RequestInit) => Promise<Response> } = {},
): FetchLike {
  let client: unknown = null;
  const base = deps.fetch ?? ((i, init) => fetch(i, init));
  return (input, init = {}) => {
    if (!client) {
      const create = deps.createHttpClient ?? (Deno as unknown as { createHttpClient?: CreateHttpClient }).createHttpClient;
      if (typeof create !== "function") {
        return Promise.reject(new ConfigError("KF_CONNECTORS_EGRESS_PROXY is set but this runtime has no Deno.createHttpClient"));
      }
      let u: URL;
      try {
        u = new URL(proxyUrl);
      } catch {
        return Promise.reject(new ConfigError("KF_CONNECTORS_EGRESS_PROXY is not a valid URL"));
      }
      const basicAuth = u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : undefined;
      u.username = "";
      u.password = "";
      client = create({ proxy: { url: u.toString(), ...(basicAuth ? { basicAuth } : {}) } });
    }
    return base(input, { ...init, client } as RequestInit);
  };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/**
 * A fetch that enforces the guard on the first request and on every redirect hop. Callers that pass
 * `redirect: "manual"` get the 3xx response back (after the request itself was validated) and follow it
 * themselves; `redirect: "error"` throws on 3xx; the default follows up to `maxRedirects` hops.
 */
export function guardedFetch(opts: GuardOptions = {}): FetchLike {
  const proxy = opts.fetch ? null : egressProxyFromEnv();
  const inner = opts.fetch ?? (proxy ? proxiedFetch(proxy) : (i: string | URL | Request, init?: RequestInit) => fetch(i, init));
  const resolve = opts.resolve ?? defaultResolver;
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
      const current = await assertPublicDestination(url, { requireHttps: hasCreds && !allowPrivate, allowPrivate, resolve });
      const res = await inner(current.toString(), { ...init, method, headers, body, redirect: "manual" });
      // DNS rebinding: fetch resolved the name on its own. If it now points at a non-public address (or no
      // longer resolves), discard the response before anyone reads it.
      const host = normaliseHost(current.hostname);
      if (!allowPrivate && !isIpLiteral(host)) {
        try {
          await resolvePublic(host, current.origin, resolve);
        } catch (e) {
          await res.body?.cancel().catch(() => {});
          throw e;
        }
      }
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
