// Web connector: fetch a list of pages (and/or a sitemap), extract the main content as markdown.
//   config: { urls: string[], sitemap?: string, max_pages?: number (default 50, max 1000),
//             same_origin_only?: boolean (default true), follow_links?: boolean (default false),
//             include?: string[] / exclude?: string[] (URL substrings or /regex/), user_agent?: string }
//   token:  none
//   cursor: { pages: { [url]: { etag?, last_modified?, links? } }, crawl?: { done: string[] } }
// robots.txt is honoured per origin (RFC 9309: Allow/Disallow, * and $ wildcards, longest match wins;
// unreachable robots.txt (5xx) = disallow all, missing (4xx) = allow all; Crawl-delay is respected up to 10 s).
// Unchanged pages are detected with If-None-Match / If-Modified-Since; a 304 re-uses the links stored for the
// page so crawled subpages stay in the target set. A capped run records the pages it already handled
// (cursor.crawl.done) and the next run continues after them. Only a completed cycle reconciles with a
// snapshot, so pages removed from the config/sitemap, gone (404/410) or now disallowed are marked deleted.
// Redirects are followed by hand and must stay in scope; all requests go through the outbound guard.
import { bytesToText, maxBodyBytes, readBody, readText, redact, request, TooLargeError } from "./http.ts";
import { htmlToMarkdown } from "./markdown.ts";
import { assertPublicUrl } from "./net-guard.ts";
import { extractPdfText } from "./pdf.ts";
import { asObject, type Connector, ConfigError, type DocumentChange, optBool, optNumber, optString, stringList, type SyncContext } from "./types.ts";

export interface WebConfig {
  urls: string[];
  sitemap?: string;
  max_pages: number;
  same_origin_only: boolean;
  follow_links: boolean;
  include: string[];
  exclude: string[];
  user_agent: string;
}

export const DEFAULT_UA = "Supaknowledge-Connector/1.0";

// ---------------------------------------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------------------------------------
export interface RobotsRules {
  rules: { allow: boolean; pattern: string; re: RegExp }[];
  crawlDelay: number | null;
  sitemaps: string[];
}

function robotsPattern(p: string): RegExp {
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*") re += ".*";
    else if (c === "$" && i === p.length - 1) re += "$";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}`);
}

/** Parse robots.txt and keep the group that applies to `userAgent` (product token match, else "*"). */
export function parseRobots(txt: string, userAgent: string): RobotsRules {
  const product = userAgent.split("/")[0]!.toLowerCase();
  type Group = { agents: string[]; lines: [string, string][] };
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === "sitemap") {
      if (val) sitemaps.push(val);
      continue;
    }
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], lines: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (cur) cur.lines.push([key, val]);
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && product.includes(a.replace(/\/.*$/, ""))));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  const rules: RobotsRules["rules"] = [];
  let crawlDelay: number | null = null;
  for (const g of chosen) {
    for (const [k, v] of g.lines) {
      if ((k === "allow" || k === "disallow") && v) rules.push({ allow: k === "allow", pattern: v, re: robotsPattern(v) });
      if (k === "crawl-delay" && Number.isFinite(Number(v))) crawlDelay = Number(v);
    }
  }
  return { rules, crawlDelay, sitemaps };
}

export function robotsAllows(r: RobotsRules, url: string): boolean {
  const u = new URL(url);
  const path = u.pathname + u.search;
  let best: { allow: boolean; len: number } | null = null;
  for (const rule of r.rules) {
    if (!rule.re.test(path)) continue;
    const len = rule.pattern.length;
    if (!best || len > best.len || (len === best.len && rule.allow)) best = { allow: rule.allow, len };
  }
  return best ? best.allow : true;
}

// ---------------------------------------------------------------------------------------------------------
function matchesAny(url: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    const m = /^\/(.+)\/([a-z]*)$/.exec(p);
    if (m) {
      try {
        return new RegExp(m[1]!, m[2]).test(url);
      } catch {
        return false;
      }
    }
    return url.includes(p);
  });
}

export function normaliseUrl(u: string, base?: string): string | null {
  try {
    const url = new URL(u, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const locs = (block: string) => [...block.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1]!.trim().replace(/&amp;/g, "&"));
  const urls = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)].flatMap((m) => locs(m[1]!));
  const sitemaps = [...xml.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/gi)].flatMap((m) => locs(m[1]!));
  return { urls, sitemaps };
}

/** Per-page state kept in the cursor: HTTP validators + the in-scope links the page had (follow_links). */
interface PageState {
  etag?: string;
  last_modified?: string;
  links?: string[];
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 5;
const ROBOTS_MAX_BYTES = 512 * 1024;

export const web: Connector<WebConfig> = {
  kind: "web",
  parseConfig(raw) {
    const o = asObject(raw);
    const checked = (u: string, what: string) => {
      const n = normaliseUrl(u);
      if (!n) throw new ConfigError(`${what}: invalid http(s) URL ${u}`);
      try {
        assertPublicUrl(n);
      } catch (e) {
        throw new ConfigError(`${what}: ${e instanceof Error ? e.message : e}`);
      }
      return n;
    };
    const urls = stringList(o, "urls").map((u) => checked(u, "config.urls"));
    const sitemapRaw = optString(o, "sitemap");
    if (!urls.length && !sitemapRaw) throw new ConfigError("config needs urls and/or sitemap");
    const sitemap = sitemapRaw ? checked(sitemapRaw, "config.sitemap") : undefined;
    return {
      urls,
      sitemap,
      max_pages: optNumber(o, "max_pages", 50, 1, 1000),
      same_origin_only: optBool(o, "same_origin_only", true),
      follow_links: optBool(o, "follow_links", false),
      include: stringList(o, "include"),
      exclude: stringList(o, "exclude"),
      user_agent: optString(o, "user_agent") ?? DEFAULT_UA,
    };
  },

  async *sync(ctx: SyncContext<WebConfig>): AsyncGenerator<DocumentChange> {
    const { config } = ctx;
    const ua = config.user_agent;
    const pages: Record<string, PageState> = { ...((ctx.cursor.pages as Record<string, PageState>) ?? {}) };
    // pages already handled in the current crawl cycle (a capped run continues after them instead of
    // starting over at targets[0] - otherwise sites without validators never get past the first `limit` pages)
    const crawl = !ctx.full && ctx.cursor.crawl && Array.isArray((ctx.cursor.crawl as { done?: unknown }).done)
      ? (ctx.cursor.crawl as { done: string[] })
      : { done: [] as string[] };
    const done = new Set(crawl.done.filter((x) => typeof x === "string"));
    const origins = new Set([...config.urls, ...(config.sitemap ? [config.sitemap] : [])].map((u) => new URL(u).origin));
    const originOk = (u: string) => !config.same_origin_only || origins.has(new URL(u).origin);
    const inScope = (u: string) =>
      originOk(u) &&
      (!config.include.length || matchesAny(u, config.include)) &&
      !matchesAny(u, config.exclude);

    const robotsCache = new Map<string, RobotsRules | "deny">();
    const lastHit = new Map<string, number>();
    const robots = async (u: string): Promise<RobotsRules | "deny"> => {
      const origin = new URL(u).origin;
      if (!robotsCache.has(origin)) {
        let r: RobotsRules | "deny";
        try {
          const res = await request(ctx, `${origin}/robots.txt`, { headers: { "user-agent": ua } }, { retries: 1, timeoutMs: 10_000 });
          if (res.ok) r = parseRobots(await readText(res, ROBOTS_MAX_BYTES), ua);
          else {
            await res.body?.cancel();
            r = res.status >= 500 ? "deny" : { rules: [], crawlDelay: null, sitemaps: [] };
          }
        } catch {
          r = "deny";
        }
        robotsCache.set(origin, r);
      }
      return robotsCache.get(origin)!;
    };
    const allowed = async (u: string) => {
      const r = await robots(u);
      return r !== "deny" && robotsAllows(r, u);
    };
    const politeFetch = async (u: string, init: RequestInit) => {
      const r = await robots(u);
      const origin = new URL(u).origin;
      const delay = r !== "deny" && r.crawlDelay ? Math.min(10, r.crawlDelay) * 1000 : 0;
      const wait = (lastHit.get(origin) ?? 0) + delay - ctx.now().getTime();
      if (delay && wait > 0) await ctx.sleep(wait);
      lastHit.set(origin, ctx.now().getTime());
      return await request(ctx, u, init, { retries: 2, timeoutMs: 20_000 });
    };
    /**
     * GET with redirects followed by hand: every hop must stay in scope (same_origin_only) and be allowed by
     * robots.txt (the outbound guard additionally re-validates the destination of every hop).
     */
    const fetchPage = async (url: string, headers: Record<string, string>): Promise<{ res: Response; finalUrl: string } | { outOfScope: string }> => {
      let cur = url;
      let h = headers;
      for (let hop = 0; ; hop++) {
        const res = await politeFetch(cur, { headers: h, redirect: "manual" });
        const location = REDIRECTS.has(res.status) ? res.headers.get("location") : null;
        if (!location) return { res, finalUrl: cur };
        await res.body?.cancel();
        const next = normaliseUrl(location, cur);
        if (!next) return { outOfScope: "redirect to a non-http(s) URL" };
        if (!originOk(next)) return { outOfScope: `redirects to ${redact(next)}, outside the configured origins` };
        if (!(await allowed(next))) return { outOfScope: `redirects to ${redact(next)}, disallowed by robots.txt` };
        if (hop >= MAX_HOPS) throw new Error(`too many redirects`);
        // validators belong to the original URL
        h = Object.fromEntries(Object.entries(h).filter(([k]) => k !== "if-none-match" && k !== "if-modified-since"));
        cur = next;
      }
    };

    // ---- targets: configured urls + sitemap entries (+ links discovered while crawling)
    const targets: string[] = [];
    const targetSet = new Set<string>();
    const add = (u: string | null) => {
      if (u && !targetSet.has(u) && targets.length < config.max_pages && inScope(u)) {
        targets.push(u);
        targetSet.add(u);
      }
    };
    for (const u of config.urls) add(u);
    let sitemapComplete = true;
    if (config.sitemap) {
      const queue = [config.sitemap];
      const queued = new Set(queue);
      let fetchedMaps = 0;
      while (queue.length && fetchedMaps < 10) {
        const sm = queue.shift()!;
        fetchedMaps++;
        if (!(await allowed(sm)) && sm !== config.sitemap) continue;
        let text: string;
        try {
          const res = await politeFetch(sm, { headers: { "user-agent": ua } });
          if (!res.ok) {
            await res.body?.cancel();
            ctx.log(`web: sitemap ${redact(sm)} returned ${res.status}`);
            sitemapComplete = false;
            continue;
          }
          text = await readText(res);
        } catch (e) {
          if (sm === config.sitemap && e instanceof ConfigError) throw e;
          ctx.log(`web: sitemap ${redact(sm)} failed: ${e instanceof Error ? e.message : e}`);
          sitemapComplete = false;
          continue;
        }
        const parsed = parseSitemap(text);
        for (const child of parsed.sitemaps) {
          const n = normaliseUrl(child);
          // child sitemaps obey the same scope as pages (origin + exclude); never fetch arbitrary hosts
          if (!n || !originOk(n) || matchesAny(n, config.exclude)) {
            ctx.log(`web: ignoring out-of-scope child sitemap ${n ? redact(n) : child.slice(0, 100)}`);
            continue;
          }
          if (!queued.has(n)) {
            queued.add(n);
            queue.push(n);
          }
        }
        for (const u of parsed.urls) add(normaliseUrl(u));
      }
      if (queue.length) sitemapComplete = false;
    }

    const seen = new Set<string>();
    const keepLinks = (url: string) => {
      // the page was not re-parsed (304, done earlier this cycle, transient failure): keep its subpages alive
      if (config.follow_links) for (const l of pages[url]?.links ?? []) add(l);
    };
    const checkpoint = (): DocumentChange => ({ type: "cursor", cursor: { pages: { ...pages }, crawl: { done: [...done] } } });
    let fetched = 0;
    let capped = false;
    for (let i = 0; i < targets.length; i++) {
      const url = targets[i]!;
      if (done.has(url)) {
        seen.add(url);
        keepLinks(url);
        continue;
      }
      if (!(await allowed(url))) {
        ctx.log(`web: robots.txt disallows ${redact(url)}`);
        delete pages[url];
        done.add(url);
        continue;
      }
      if (fetched >= ctx.limit) {
        capped = true;
        break;
      }
      const prev = ctx.previous(url);
      const known = pages[url];
      const headers: Record<string, string> = { "user-agent": ua, accept: "text/html,application/xhtml+xml,text/plain,text/markdown,application/pdf;q=0.8,*/*;q=0.5" };
      if (!ctx.full && prev && !prev.deleted && known) {
        if (known.etag) headers["if-none-match"] = known.etag;
        if (known.last_modified) headers["if-modified-since"] = known.last_modified;
      }
      let got: Awaited<ReturnType<typeof fetchPage>>;
      try {
        got = await fetchPage(url, headers);
      } catch (e) {
        ctx.log(`web: ${redact(url)} failed: ${e instanceof Error ? e.message : e}`);
        seen.add(url); // transient: keep what we have
        keepLinks(url);
        done.add(url);
        continue;
      }
      done.add(url);
      if ("outOfScope" in got) {
        ctx.log(`web: ${redact(url)} ${got.outOfScope}; dropping it`);
        delete pages[url];
        yield { type: "delete", externalId: url, reason: got.outOfScope };
        continue;
      }
      const { res, finalUrl } = got;
      if (res.status === 304) {
        await res.body?.cancel();
        seen.add(url);
        keepLinks(url);
        continue;
      }
      if (res.status === 404 || res.status === 410) {
        await res.body?.cancel();
        delete pages[url];
        yield { type: "delete", externalId: url, reason: `HTTP ${res.status}` };
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        ctx.log(`web: ${redact(url)} returned HTTP ${res.status}`);
        seen.add(url);
        keepLinks(url);
        continue;
      }
      seen.add(url);
      fetched++; // only changed pages count toward the per-run cap (304s are cheap)
      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      let bytes: Uint8Array;
      try {
        bytes = await readBody(res, maxBodyBytes(), redact(url));
      } catch (e) {
        if (!(e instanceof TooLargeError)) throw e;
        ctx.log(`web: skipping ${redact(url)} (${e.message})`);
        keepLinks(url);
        continue;
      }
      let content = "";
      let title: string | null = null;
      let ext = "html";
      let links: string[] | undefined;
      const meta: Record<string, unknown> = { http_status: res.status, content_type: type };
      if (type === "text/html" || type === "application/xhtml+xml" || (!type && /<html/i.test(bytesToText(bytes.slice(0, 2000))))) {
        const conv = htmlToMarkdown(bytesToText(bytes), { mainContent: true, baseUrl: finalUrl });
        content = conv.markdown;
        title = conv.title;
        if (config.follow_links) {
          const found = new Set<string>();
          for (const l of conv.links) {
            const n = normaliseUrl(l);
            if (n && n !== url && inScope(n) && found.size < config.max_pages) found.add(n);
          }
          links = [...found];
          for (const n of links) add(n);
        }
      } else if (type.startsWith("text/")) {
        content = bytesToText(bytes);
        ext = type === "text/markdown" ? "md" : "txt";
        title = /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? null;
      } else if (type === "application/pdf") {
        const pdf = await extractPdfText(bytes);
        content = pdf.text;
        ext = "pdf";
        meta.pdf_pages = pdf.pages;
        if (pdf.error) meta.extraction_error = pdf.error;
      } else {
        ctx.log(`web: skipping ${redact(url)} (unsupported content-type ${type})`);
        continue;
      }
      const etag = res.headers.get("etag") ?? undefined;
      const lastModified = res.headers.get("last-modified") ?? undefined;
      pages[url] = { ...(etag ? { etag } : {}), ...(lastModified ? { last_modified: lastModified } : {}), ...(links?.length ? { links } : {}) };
      if (finalUrl !== url) meta.final_url = finalUrl;
      yield {
        type: "upsert",
        doc: {
          externalId: url,
          title: title ?? new URL(url).pathname,
          url,
          content,
          mimeType: type || "text/html",
          raw: { body: bytes, ext, contentType: type || "text/html" },
          updatedAt: lastModified && !Number.isNaN(Date.parse(lastModified)) ? new Date(lastModified).toISOString() : null,
          version: etag ?? lastModified ?? null,
          metadata: meta,
          // public web pages carry no upstream ACL: the source audience applies
        },
      };
      yield checkpoint();
    }
    if (capped) {
      // continue this cycle next run; nothing is reconciled until the whole target set was visited
      yield { ...checkpoint(), more: true } as DocumentChange;
      return;
    }
    if (sitemapComplete) {
      // forget validators of pages that left the target set, then reconcile
      for (const u of Object.keys(pages)) if (!targetSet.has(u)) delete pages[u];
      yield { type: "snapshot", externalIds: [...seen] };
    }
    yield { type: "cursor", cursor: { pages }, more: false };
  },
};
