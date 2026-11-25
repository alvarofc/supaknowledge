import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { runSync } from "../lib/engine.ts";
import { BlockedUrlError, guardedFetch } from "../lib/net-guard.ts";
import { ConfigError } from "../lib/types.ts";
import { parseRobots, parseSitemap, robotsAllows, web } from "../lib/web.ts";
import { collect, fakeFetch, fixtureText, lastCursor, makeCtx, MemoryStore, upserts } from "./helpers.ts";

const BASE = "https://docs.acme.example";

Deno.test("web: robots.txt parsing (groups, allow/disallow precedence, wildcards, crawl-delay)", async () => {
  const txt = await fixtureText("robots.txt");
  const r = parseRobots(txt, "Supaknowledge-Connector/1.0");
  assertEquals(r.crawlDelay, 1);
  assertEquals(r.sitemaps, ["https://docs.acme.example/sitemap.xml"]);
  assert(robotsAllows(r, `${BASE}/refunds`));
  assert(!robotsAllows(r, `${BASE}/private/secret`));
  assert(robotsAllows(r, `${BASE}/private/public-note`)); // longer allow wins
  assert(!robotsAllows(r, `${BASE}/api/data.json`));
  assert(robotsAllows(r, `${BASE}/api/data.json?x=1`)); // $ anchors the end
  const bad = parseRobots(txt, "BadBot/2.0");
  assert(!robotsAllows(bad, `${BASE}/refunds`));
});

Deno.test("web: sitemap parsing", async () => {
  const { urls } = parseSitemap(await fixtureText("sitemap.xml"));
  assertEquals(urls.length, 5);
  assertEquals(urls[4], "https://docs.acme.example/notes.txt?a=1&b=2");
});

async function site() {
  const article = await fixtureText("web-article.html");
  const robots = await fixtureText("robots.txt");
  const sitemap = await fixtureText("sitemap.xml");
  return fakeFetch([
    [`GET ${BASE}/robots.txt`, () => new Response(robots)],
    [`GET ${BASE}/sitemap.xml`, () => new Response(sitemap, { headers: { "content-type": "application/xml" } })],
    [`GET ${BASE}/refunds`, ({ headers }) => {
      if (headers.get("if-none-match") === '"v1"') return new Response(null, { status: 304 });
      return new Response(article, { headers: { "content-type": "text/html; charset=utf-8", etag: '"v1"', "last-modified": "Thu, 20 Nov 2026 10:00:00 GMT" } });
    }],
    [`GET ${BASE}/gone`, () => new Response("nope", { status: 404 })],
    [`GET ${BASE}/notes.txt`, () => new Response("# Notes\n\nplain text page", { headers: { "content-type": "text/plain" } })],
    [`GET ${BASE}/private/`, () => {
      throw new Error("robots-disallowed page must not be fetched");
    }],
    ["GET https://other.example/", () => {
      throw new Error("off-origin page must not be fetched");
    }],
  ]);
}

Deno.test("web: sync extracts main content, respects robots + same-origin, records validators, deletes 404s", async () => {
  const f = await site();
  const ctx = makeCtx(web, { urls: [`${BASE}/refunds`], sitemap: `${BASE}/sitemap.xml` }, { fetch: f, token: null, full: true, previous: { [`${BASE}/gone`]: {}, [`${BASE}/old-page`]: {} } });
  const changes = await collect(web, ctx);
  const docs = upserts(changes);
  assertEquals(docs.map((d) => d.externalId), [`${BASE}/refunds`, `${BASE}/notes.txt?a=1&b=2`]);
  const page = docs[0]!;
  assertEquals(page.title, "Refund policy — Acme Docs");
  assert(page.content.startsWith("# Refund policy"));
  assertStringIncludes(page.content, "[billing guide](https://docs.acme.example/docs/billing)");
  assert(!page.content.includes("Pricing"));
  assertEquals(page.updatedAt, "2026-11-20T10:00:00.000Z");
  assertEquals(page.version, '"v1"');
  assertEquals(page.raw?.ext, "html");
  assertEquals(docs[1]!.title, "Notes");
  assert(changes.some((c) => c.type === "delete" && c.externalId === `${BASE}/gone`));
  const snap = changes.find((c) => c.type === "snapshot");
  // /old-page is no longer listed anywhere -> not in the snapshot -> engine marks it deleted
  assertEquals(snap?.type === "snapshot" && snap.externalIds.sort(), [`${BASE}/notes.txt?a=1&b=2`, `${BASE}/refunds`]);
  assertEquals((lastCursor(changes)?.cursor as { pages: Record<string, unknown> }).pages[`${BASE}/refunds`], {
    etag: '"v1"',
    last_modified: "Thu, 20 Nov 2026 10:00:00 GMT",
  });
  assertEquals(f.calls.find((c) => c.url.endsWith("/refunds"))!.headers.get("user-agent"), "Supaknowledge-Connector/1.0");
});

Deno.test("web: conditional GET -> 304 keeps the page without re-emitting it", async () => {
  const f = await site();
  const ctx = makeCtx(web, { urls: [`${BASE}/refunds`] }, {
    fetch: f, token: null,
    cursor: { pages: { [`${BASE}/refunds`]: { etag: '"v1"' } } },
    previous: { [`${BASE}/refunds`]: { version: '"v1"' } },
  });
  const changes = await collect(web, ctx);
  assertEquals(upserts(changes).length, 0);
  const snap = changes.find((c) => c.type === "snapshot");
  assertEquals(snap?.type === "snapshot" && snap.externalIds, [`${BASE}/refunds`]);
});

Deno.test("web: unreachable robots.txt (5xx) means disallow all", async () => {
  const f = fakeFetch([[`GET ${BASE}/robots.txt`, () => new Response("down", { status: 503 })]]);
  const changes = await collect(web, makeCtx(web, { urls: [`${BASE}/refunds`] }, { fetch: f, token: null }));
  assertEquals(upserts(changes).length, 0);
  assert(!f.calls.some((c) => c.url.endsWith("/refunds")));
});

Deno.test("web: follow_links discovers same-origin pages up to max_pages", async () => {
  const f = fakeFetch([
    [`GET ${BASE}/robots.txt`, () => new Response("", { status: 404 })],
    [`GET ${BASE}/start`, () => new Response(`<main><p>See <a href="/a">A</a>, <a href="b">B</a>, <a href="https://x.example/c">C</a>, <a href="/d">D</a></p></main>`, { headers: { "content-type": "text/html" } })],
    [`GET ${BASE}/a`, () => new Response("<main><p>A page</p></main>", { headers: { "content-type": "text/html" } })],
    [`GET ${BASE}/b`, () => new Response("<main><p>B page</p></main>", { headers: { "content-type": "text/html" } })],
  ]);
  const docs = upserts(await collect(web, makeCtx(web, { urls: [`${BASE}/start`], follow_links: true, max_pages: 3 }, { fetch: f, token: null })));
  assertEquals(docs.map((d) => d.externalId), [`${BASE}/start`, `${BASE}/a`, `${BASE}/b`]);
});

const html = (body: string, headers: Record<string, string> = {}) => () => new Response(`<main>${body}</main>`, { headers: { "content-type": "text/html", ...headers } });

Deno.test("web: a 304 on the seed keeps crawled subpages alive (follow_links)", async () => {
  const site304 = () =>
    fakeFetch([
      [`GET ${BASE}/robots.txt`, () => new Response("", { status: 404 })],
      [`GET ${BASE}/start`, ({ headers }) =>
        headers.get("if-none-match") === '"s1"' ? new Response(null, { status: 304 }) : html(`<p>See <a href="/sub">sub</a></p>`, { etag: '"s1"' })()],
      [`GET ${BASE}/sub`, ({ headers }) =>
        headers.get("if-none-match") === '"u1"' ? new Response(null, { status: 304 }) : html(`<p>Sub page</p>`, { etag: '"u1"' })()],
    ]);
  const store = new MemoryStore();
  const source = { id: "s", space_id: "sp", connector: "web" as const, config: { urls: [`${BASE}/start`], follow_links: true }, audience: [], cursor: {}, status: "active" as const };
  const r1 = await runSync({ source, connector: web as never, store, groups: [], token: null, full: true, fetch: site304(), log: () => {}, sleep: async () => {} });
  assertEquals(store.live(), [`${BASE}/start`, `${BASE}/sub`]);
  const f2 = site304();
  await runSync({ source: { ...source, cursor: r1.cursor }, connector: web as never, store, groups: [], token: null, full: false, fetch: f2, log: () => {}, sleep: async () => {} });
  assertEquals(store.live(), [`${BASE}/start`, `${BASE}/sub`], "the subpage must survive the incremental run");
  assert(f2.calls.some((c) => c.url === `${BASE}/sub` && c.headers.get("if-none-match") === '"u1"'), "subpage is still revalidated");
});

Deno.test("web: capped crawls without validators make progress across continuations", async () => {
  const urls = [0, 1, 2, 3, 4].map((i) => `${BASE}/p${i}`);
  const f = fakeFetch([
    [`GET ${BASE}/robots.txt`, () => new Response("", { status: 404 })],
    [`GET ${BASE}/p`, ({ url }) => html(`<p>${url.pathname}</p>`)()],
  ]);
  const store = new MemoryStore();
  let cursor = {};
  const order: string[] = [];
  for (let run = 0; run < 5; run++) {
    const before = f.calls.length;
    const r = await runSync({
      source: { id: "s", space_id: "sp", connector: "web", config: { urls }, audience: [], cursor, status: "active" },
      connector: web as never, store, groups: [], token: null, full: run === 0, fetch: f, log: () => {}, sleep: async () => {}, limit: 2,
    });
    order.push(...f.calls.slice(before).map((c) => new URL(c.url).pathname).filter((p) => p !== "/robots.txt"));
    cursor = r.cursor;
    if (!r.more) break;
  }
  assertEquals(order, ["/p0", "/p1", "/p2", "/p3", "/p4"]);
  assertEquals(store.live(), urls);
  assertEquals((cursor as { crawl?: unknown }).crawl, undefined, "a completed cycle clears the crawl state");
});

Deno.test("web: redirects must stay in scope; off-origin child sitemaps are ignored", async () => {
  const f = fakeFetch([
    [`GET ${BASE}/robots.txt`, () => new Response("", { status: 404 })],
    [`GET ${BASE}/sitemap.xml`, () => new Response(`<sitemapindex><sitemap><loc>http://169.254.169.254/latest/</loc></sitemap><sitemap><loc>https://other.example/s.xml</loc></sitemap><sitemap><loc>${BASE}/s2.xml</loc></sitemap></sitemapindex>`)],
    [`GET ${BASE}/s2.xml`, () => new Response(`<urlset><url><loc>${BASE}/moved</loc></url><url><loc>${BASE}/old</loc></url></urlset>`)],
    [`GET ${BASE}/moved`, () => new Response(null, { status: 301, headers: { location: "https://evil.example/landing" } })],
    [`GET ${BASE}/old`, () => new Response(null, { status: 302, headers: { location: "/new?token=abc" } })],
    [`GET ${BASE}/new`, html("<p>New home</p>")],
  ]);
  const logs: string[] = [];
  const ctx = makeCtx(web, { sitemap: `${BASE}/sitemap.xml` }, { fetch: f, token: null, full: true });
  ctx.log = (m) => logs.push(m);
  const changes = await collect(web, ctx);
  assert(!f.calls.some((c) => !c.url.startsWith(BASE)), "nothing outside the configured origin is fetched");
  assert(changes.some((c) => c.type === "delete" && c.externalId === `${BASE}/moved`));
  const doc = upserts(changes).find((d) => d.externalId === `${BASE}/old`)!;
  assertEquals(doc.metadata?.final_url, `${BASE}/new?token=abc`);
  assert(logs.length > 0 && logs.every((l) => !l.includes("token=abc")), "logged URLs carry no query strings");
});

Deno.test("web: oversized responses are skipped, internal URLs are config errors", async () => {
  Deno.env.set("KF_CONNECTOR_MAX_BYTES", "1000");
  try {
    const f = fakeFetch([
      [`GET ${BASE}/robots.txt`, () => new Response("", { status: 404 })],
      [`GET ${BASE}/huge`, () => new Response("x".repeat(5000), { headers: { "content-type": "text/plain" } })],
      [`GET ${BASE}/small`, () => new Response("small", { headers: { "content-type": "text/plain" } })],
    ]);
    const docs = upserts(await collect(web, makeCtx(web, { urls: [`${BASE}/huge`, `${BASE}/small`] }, { fetch: f, token: null })));
    assertEquals(docs.map((d) => d.externalId), [`${BASE}/small`]);
  } finally {
    Deno.env.delete("KF_CONNECTOR_MAX_BYTES");
  }
  for (const u of ["http://169.254.169.254/latest/meta-data/", "http://localhost:54321/", "http://kong:8000/", "http://10.0.0.1/"]) {
    assertThrows(() => web.parseConfig({ urls: [u] }), ConfigError, undefined, u);
    assertThrows(() => web.parseConfig({ sitemap: u }), ConfigError, undefined, u);
  }
});

// a resolver where *.intranet.acme.example points at private space (e.g. split-horizon DNS)
const splitDns = async (h: string) => (h.endsWith("intranet.acme.example") ? ["10.0.0.5"] : ["93.184.216.34"]);

Deno.test("web: a configured URL the outbound guard refuses fails the run (config error), never a silent skip", async () => {
  const inner = fakeFetch([
    [`GET ${BASE}/robots.txt`, () => new Response("", { status: 404 })],
    [`GET ${BASE}/ok`, html("<p>fine</p>")],
  ]);
  const f = guardedFetch({ fetch: inner, resolve: splitDns, allowPrivate: false });
  const ctx = makeCtx(web, { urls: [`${BASE}/ok`, "https://wiki.intranet.acme.example/secret"] }, { fetch: f, token: null, full: true });
  const e = await assertRejects(() => collect(web, ctx), BlockedUrlError, "config.urls");
  assert(e instanceof ConfigError, "the engine treats it as permanent: the source goes to 'error'");
  assertStringIncludes(e.message, "10.0.0.5");
  assert(!inner.calls.some((c) => c.url.includes("intranet")), "the private host is never contacted");

  // through the engine: the run fails instead of finishing 'active' with nothing synced
  const store = new MemoryStore();
  const run = runSync({
    source: { id: "s", space_id: "sp", connector: "web", config: { urls: ["https://wiki.intranet.acme.example/secret"] }, audience: [], cursor: {}, status: "active" },
    connector: web,
    store,
    groups: [],
    token: null,
    full: true,
    fetch: f,
    log: () => {},
  });
  await assertRejects(() => run, ConfigError, "config.urls");

  // a configured sitemap on a refused host is a config error too
  await assertRejects(
    () => collect(web, makeCtx(web, { sitemap: "https://maps.intranet.acme.example/sitemap.xml" }, { fetch: f, token: null, full: true })),
    BlockedUrlError,
    "config.sitemap",
  );
});

Deno.test("web: discovered URLs the guard refuses are dropped, the run carries on", async () => {
  const inner = fakeFetch([
    [`GET ${BASE}/robots.txt`, () => new Response("", { status: 404 })],
    [`GET ${BASE}/sitemap.xml`, () => new Response(`<urlset><url><loc>${BASE}/a</loc></url><url><loc>https://wiki.intranet.acme.example/x</loc></url></urlset>`)],
    [`GET ${BASE}/a`, html("<p>A</p>")],
  ]);
  const f = guardedFetch({ fetch: inner, resolve: splitDns, allowPrivate: false });
  const changes = await collect(web, makeCtx(web, { sitemap: `${BASE}/sitemap.xml`, same_origin_only: false }, { fetch: f, token: null, full: true }));
  assertEquals(upserts(changes).map((d) => d.externalId), [`${BASE}/a`]);
  assert(changes.some((c) => c.type === "delete" && c.externalId === "https://wiki.intranet.acme.example/x"));
  assert(!inner.calls.some((c) => c.url.includes("intranet")));
});

Deno.test("web: redirect hops must match include/exclude, not just the origin", async () => {
  const f = fakeFetch([
    [`GET ${BASE}/robots.txt`, () => new Response("", { status: 404 })],
    [`GET ${BASE}/docs/a`, () => new Response(null, { status: 302, headers: { location: "/admin/export" } })],
    [`GET ${BASE}/docs/b`, () => new Response(null, { status: 301, headers: { location: "/blog/post" } })],
    [`GET ${BASE}/docs/c/`, html("<p>C</p>")],
    [`GET ${BASE}/docs/c`, () => new Response(null, { status: 301, headers: { location: "/docs/c/" } })],
    [`GET ${BASE}/admin/`, () => {
      throw new Error("excluded page must not be fetched");
    }],
    [`GET ${BASE}/blog/`, () => {
      throw new Error("page outside include must not be fetched");
    }],
  ]);
  const logs: string[] = [];
  const ctx = makeCtx(web, { urls: [`${BASE}/docs/a`, `${BASE}/docs/b`, `${BASE}/docs/c`], include: ["example/docs/"], exclude: ["/admin/"] }, { fetch: f, token: null, full: true });
  ctx.log = (m) => logs.push(m);
  const changes = await collect(web, ctx);
  assertEquals(upserts(changes).map((d) => d.externalId), [`${BASE}/docs/c`]);
  assert(changes.some((c) => c.type === "delete" && c.externalId === `${BASE}/docs/a`));
  assert(changes.some((c) => c.type === "delete" && c.externalId === `${BASE}/docs/b`));
  assert(logs.some((l) => l.includes("excluded by config.include/exclude")));
});

Deno.test("web: sitemaps follow redirects by hand, only within origin + exclude", async () => {
  const f = fakeFetch([
    [`GET ${BASE}/robots.txt`, () => new Response("", { status: 404 })],
    [`GET ${BASE}/sitemap.xml`, () => new Response(null, { status: 301, headers: { location: "https://other.example/sitemap.xml" } })],
    [`GET ${BASE}/moved-map.xml`, () => new Response(null, { status: 302, headers: { location: "/maps/real.xml" } })],
    [`GET ${BASE}/maps/real.xml`, () => new Response(`<urlset><url><loc>${BASE}/p</loc></url></urlset>`)],
    [`GET ${BASE}/excl-map.xml`, () => new Response(null, { status: 302, headers: { location: "/private/map.xml" } })],
    [`GET ${BASE}/p`, html("<p>P</p>")],
    ["GET https://other.example/", () => {
      throw new Error("cross-origin sitemap redirect must not be followed");
    }],
    [`GET ${BASE}/private/`, () => {
      throw new Error("excluded sitemap must not be fetched");
    }],
  ]);
  const logs: string[] = [];
  const ctx = makeCtx(web, { sitemap: `${BASE}/sitemap.xml` }, { fetch: f, token: null, full: true });
  ctx.log = (m) => logs.push(m);
  const changes = await collect(web, ctx);
  assertEquals(upserts(changes).length, 0);
  assert(!changes.some((c) => c.type === "snapshot"), "an unreadable sitemap never reconciles (no mass delete)");
  assert(logs.some((l) => l.includes("outside the configured origins")));
  // same-origin redirect is followed; a redirect into an excluded path is not
  const ctx2 = makeCtx(web, { sitemap: `${BASE}/moved-map.xml` }, { fetch: f, token: null, full: true });
  assertEquals(upserts(await collect(web, ctx2)).map((d) => d.externalId), [`${BASE}/p`]);
  const ctx3 = makeCtx(web, { sitemap: `${BASE}/excl-map.xml`, exclude: ["/private/"] }, { fetch: f, token: null, full: true });
  assertEquals(upserts(await collect(web, ctx3)).length, 0);
  // every sitemap request is sent with redirect: manual (the guard never follows them on its own)
  assert(f.calls.every((c) => !c.url.startsWith("https://other.example")));
});
