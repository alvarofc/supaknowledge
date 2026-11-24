import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parseRobots, parseSitemap, robotsAllows, web } from "../lib/web.ts";
import { collect, fakeFetch, fixtureText, lastCursor, makeCtx, upserts } from "./helpers.ts";

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
