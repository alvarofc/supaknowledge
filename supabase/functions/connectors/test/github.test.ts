import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { github, globToRegExp, makeMatcher } from "../lib/github.ts";
import { ConfigError } from "../lib/types.ts";
import { collect, fakeFetch, fixture, lastCursor, makeCtx, upserts } from "./helpers.ts";

const R = "https://api.github.com/repos/acme/handbook";
const OLD = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
// deno-lint-ignore no-explicit-any
type Fx = any;

async function api(opts: { compare?: (fx: Fx) => Response | unknown } = {}) {
  const fx: Fx = await fixture("github.json");
  const f = fakeFetch([
    [`GET ${R}/commits/main`, () => fx.head],
    [`GET ${R}/compare/`, () => (opts.compare ? opts.compare(fx) : fx.compare)],
    [`GET ${R}/git/trees/`, () => fx.tree],
    [`GET ${R}/git/blobs/`, ({ url }) => {
      const sha = url.pathname.split("/").pop()!;
      const body = fx.blobs[sha];
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
    }],
    [`GET ${R}/teams`, () => fx.teams],
    [`GET ${R}/issues/41/comments`, () => fx.comments_41],
    [`GET ${R}/issues`, ({ url }) => {
      const since = url.searchParams.get("since");
      return new Response(JSON.stringify(fx.issues.filter((i: { updated_at: string }) => !since || i.updated_at >= since)), { headers: { "content-type": "application/json" } });
    }],
    [`GET ${R}`, () => fx.repo],
  ]);
  return { f, fx };
}

Deno.test("github: globs", () => {
  const m = makeMatcher(["**/*.md", "docs/**"]);
  assert(m("README.md") && m("a/b/c.md") && m("docs/x/y.sql"));
  assert(!m("src/index.ts") && !m("docs.txt"));
  assert(globToRegExp("*.{md,mdx}").test("deep/x.mdx"));
  assert(globToRegExp("handbook/*.md").test("handbook/a.md") && !globToRegExp("handbook/*.md").test("handbook/x/a.md"));
});

Deno.test("github: first sync lists the tree, filters globs, skips binaries, snapshots and maps teams", async () => {
  const { f } = await api();
  const changes = await collect(github, makeCtx(github, { repo: "acme/handbook" }, { fetch: f, full: true }));
  const docs = upserts(changes);
  assertEquals(docs.map((d) => d.externalId), ["file:docs/guide.md", "file:docs/schema.sql", "file:docs/setup.html", "file:README.md"]);
  const guide = docs[0]!;
  assertEquals(guide.title, "Support guide");
  assertEquals(guide.version, "aaa0000000000000000000000000000000000002");
  assertEquals(guide.url, "https://github.com/acme/handbook/blob/main/docs/guide.md");
  assertEquals(docs[2]!.content, "# Setup\n\nRun `make`.");
  assertStringIncludes(docs[1]!.content, "```sql\ncreate table refunds (id int);\n```");
  assertEquals(guide.acl, {
    restricted: true,
    refs: [{ github_repo: "acme/handbook" }, { github_team: "acme/support" }, { github_team: "acme/docs-owners" }],
  });
  const snap = changes.find((c) => c.type === "snapshot");
  assertEquals(snap?.type === "snapshot" && snap.externalIds.sort(), ["file:README.md", "file:docs/guide.md", "file:docs/schema.sql", "file:docs/setup.html"]);
  assertEquals(lastCursor(changes)?.cursor, { sha: "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2", ref: "main" });
  assert(!f.calls.some((c) => c.url.includes("aaa0000000000000000000000000000000000004")), "png never fetched");
  assertEquals(f.calls[0]!.headers.get("authorization"), "Bearer test-token");
});

Deno.test("github: incremental sync uses compare and only fetches changed files", async () => {
  const { f } = await api();
  const ctx = makeCtx(github, { repo: "acme/handbook" }, {
    fetch: f,
    cursor: { sha: OLD, ref: "main" },
    previous: { "file:docs/old.md": {}, "file:docs/invoices.md": {}, "file:docs/billing.md": { version: "bbb0000000000000000000000000000000000007" } },
  });
  const changes = await collect(github, ctx);
  assert(f.calls.some((c) => c.url.startsWith(`${R}/compare/${OLD}...c2c2`)));
  assert(!f.calls.some((c) => c.url.includes("/git/trees/")), "no tree listing");
  const deletes = changes.flatMap((c) => (c.type === "delete" ? [c.externalId] : []));
  assertEquals(deletes.sort(), ["file:docs/invoices.md", "file:docs/old.md"]);
  // billing.md (renamed) already has that blob sha -> not refetched; src/new.ts is outside the globs
  assertEquals(upserts(changes).map((d) => [d.externalId, d.content]), [["file:docs/guide.md", "# Support guide\n\nEscalate P1s to on-call within 10 minutes.\n"]]);
  assertEquals(changes.some((c) => c.type === "snapshot"), false);
  assertEquals((lastCursor(changes)?.cursor as { sha: string }).sha, "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2");
});

Deno.test("github: diverged history or a missing base falls back to the tree", async () => {
  for (const compare of [() => ({ status: "diverged", files: [] }), () => new Response("{}", { status: 404 })]) {
    const { f } = await api({ compare });
    const changes = await collect(github, makeCtx(github, { repo: "acme/handbook" }, { fetch: f, cursor: { sha: OLD, ref: "main" } }));
    assert(f.calls.some((c) => c.url.includes("/git/trees/")));
    assert(changes.some((c) => c.type === "snapshot"));
  }
});

Deno.test("github: closed issues/PRs with labels become documents; label filter + since cursor", async () => {
  const { f } = await api();
  const ctx = makeCtx(github, { repo: "acme/handbook", paths: ["nothing/**"], include_issues: true }, { fetch: f, full: true, token: null, env: { GITHUB_TOKEN: "env-token" } });
  const changes = await collect(github, ctx);
  const docs = upserts(changes);
  assertEquals(docs.map((d) => d.externalId), ["issue:41", "pr:42"]);
  assertEquals(
    docs[0]!.content,
    "# Refunds for annual plans (issue #41)\n\n- **State:** closed (completed)\n- **Labels:** policy, billing\n- **Author:** @dana\n- **Opened:** 2026-11-01T10:00:00Z · **Closed:** 2026-11-10T10:00:00Z\n\nHow do we prorate?\n\n## Comments\n\n**@finn** (2026-11-09T10:00:00Z):\n\nProrate by remaining full months.",
  );
  assertStringIncludes(docs[1]!.content, "closed (merged)");
  assertEquals((lastCursor(changes)?.cursor as { issues_since: string }).issues_since, "2026-11-11T10:00:00Z");
  assertEquals(f.calls[0]!.headers.get("authorization"), "Bearer env-token");
  const q = new URL(f.calls.find((c) => c.url.startsWith(`${R}/issues?`))!.url).searchParams;
  assertEquals([q.get("state"), q.get("sort"), q.get("direction")], ["closed", "updated", "asc"]);

  const { f: f2 } = await api();
  const filtered = upserts(await collect(github, makeCtx(github, { repo: "acme/handbook", paths: ["nothing/**"], include_issues: true, issue_labels: ["policy"] }, { fetch: f2, cursor: { issues_since: "2026-11-05T00:00:00Z", sha: "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2", ref: "main" } })));
  assertEquals(filtered.map((d) => d.externalId), ["issue:41"]);
});

Deno.test("github: per-run cap keeps the old sha so the next run resumes", async () => {
  const { f } = await api();
  const changes = await collect(github, makeCtx(github, { repo: "acme/handbook" }, { fetch: f, full: true, limit: 2 }));
  assertEquals(upserts(changes).length, 2);
  const last = lastCursor(changes)!;
  assertEquals([last.more, (last.cursor as { sha?: string }).sha], [true, undefined]);
});

Deno.test("github: the deployment GITHUB_TOKEN is never sent to a custom api_url; api_url must be public https", async () => {
  const GHE = "https://ghe.acme.example/api/v3";
  const f = fakeFetch([
    [`GET ${GHE}/repos/acme/handbook/commits/main`, () => ({ sha: "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2" })],
    [`GET ${GHE}/repos/acme/handbook/git/trees/`, () => ({ tree: [], truncated: false })],
    [`GET ${GHE}/repos/acme/handbook`, () => ({ default_branch: "main", private: false, html_url: "https://ghe.acme.example/acme/handbook", owner: { login: "acme", type: "Organization" } })],
  ]);
  await collect(github, makeCtx(github, { repo: "acme/handbook", api_url: GHE }, { fetch: f, token: null, full: true, env: { GITHUB_TOKEN: "ghp_SERVER" } }));
  assert(f.calls.length > 0);
  assert(f.calls.every((c) => c.headers.get("authorization") === null), "env token must not leave for a custom host");

  for (const bad of ["http://ghe.acme.example/api/v3", "https://169.254.169.254/", "https://kong:8000/", "https://localhost/api", "ftp://x.example/"]) {
    assertThrows(() => github.parseConfig({ repo: "acme/handbook", api_url: bad }), ConfigError, undefined, bad);
  }
});

Deno.test("github: repo owner/name are restricted to GitHub's charset (no `.`/`..` path traversal)", () => {
  for (const bad of ["../handbook", "acme/..", "acme/.", "./x", "..git/x", "acme/...git", "a/b/c", "acme/hand book", "acme/hand%2fbook", "-acme/x", "ac.me/x", "acme/"]) {
    assertThrows(() => github.parseConfig({ repo: bad }), ConfigError, undefined, bad);
  }
  for (const [ok, owner, name] of [
    ["acme/handbook", "acme", "handbook"],
    ["acme/handbook.git", "acme", "handbook"],
    ["https://github.com/acme/hand_book.v2", "acme", "hand_book.v2"],
    ["octo-cat_emu/.github", "octo-cat_emu", ".github"],
    ["acme/.dotfiles", "acme", ".dotfiles"],
  ]) {
    const c = github.parseConfig({ repo: ok });
    assertEquals([c.owner, c.name], [owner, name], ok);
  }
});

Deno.test("github: invalid globs are config errors", () => {
  assertThrows(() => github.parseConfig({ repo: "acme/handbook", paths: ["docs/[z-a].md"] }), ConfigError, "invalid glob");
});

Deno.test("github: server-provided URLs outside the API origin are refused (no token leak via Link / comments_url)", async () => {
  const { fx } = await api();
  const evil = "https://attacker.example/steal";
  for (const variant of ["link", "comments"] as const) {
    const f = fakeFetch([
      [`GET ${R}/commits/main`, () => fx.head],
      [`GET ${R}/git/trees/`, () => ({ tree: [], truncated: false })],
      [`GET ${R}/teams`, () => fx.teams],
      [`GET ${R}/issues?`, () =>
        variant === "link"
          ? new Response("[]", { headers: { "content-type": "application/json", link: `<${evil}/issues?page=2>; rel="next"` } })
          : [{ ...fx.issues[0], comments_url: `${evil}/comments` }]],
      [`GET ${R}`, () => fx.repo],
      ["GET https://attacker.example/", () => new Response("[]")],
    ]);
    await assertRejects(
      () => collect(github, makeCtx(github, { repo: "acme/handbook", paths: ["nothing/**"], include_issues: true }, { fetch: f, full: true })),
      ConfigError,
      "outside",
    );
    assert(!f.calls.some((c) => c.url.startsWith("https://attacker.example")), `${variant}: attacker host never contacted`);
  }
});

Deno.test("github: blobs larger than max_file_bytes are skipped while streaming", async () => {
  const { fx } = await api();
  const big = "x".repeat(5000);
  const f = fakeFetch([
    [`GET ${R}/commits/main`, () => fx.head],
    [`GET ${R}/git/trees/`, () => ({ tree: [{ path: "docs/big.md", type: "blob", sha: "b1" }, { path: "docs/small.md", type: "blob", sha: "b2" }], truncated: false })],
    [`GET ${R}/git/blobs/b1`, () => new Response(big)],
    [`GET ${R}/git/blobs/b2`, () => new Response("# Small")],
    [`GET ${R}/teams`, () => fx.teams],
    [`GET ${R}`, () => fx.repo],
  ]);
  const changes = await collect(github, makeCtx(github, { repo: "acme/handbook", max_file_bytes: 1000 }, { fetch: f, full: true }));
  assertEquals(upserts(changes).map((d) => d.externalId), ["file:docs/small.md"]);
  const snap = changes.find((c) => c.type === "snapshot");
  assertEquals(snap?.type === "snapshot" && snap.externalIds, ["file:docs/small.md"]);
});

Deno.test("github: discussions are processed page by page and a capped scan resumes where it stopped", async () => {
  const { fx } = await api();
  // newest first, 2 per page: d5 d4 | d3 d2 | d1
  const all = [5, 4, 3, 2, 1].map((n) => ({
    number: n, title: `D${n}`, url: `https://github.com/acme/handbook/discussions/${n}`, body: `body ${n}`,
    updatedAt: `2026-11-1${n}T00:00:00Z`, createdAt: "2026-11-01T00:00:00Z", author: { login: "a" }, category: { name: "Q&A" }, answer: null,
    comments: { nodes: [] },
  }));
  const pagesServed: (string | null)[] = [];
  const mk = () =>
    fakeFetch([
      [`GET ${R}/commits/main`, () => fx.head],
      [`GET ${R}/git/trees/`, () => ({ tree: [], truncated: false })],
      [`GET ${R}/teams`, () => fx.teams],
      [`GET ${R}`, () => fx.repo],
      ["POST https://api.github.com/graphql", ({ body }) => {
        const after = JSON.parse(body!).variables.after as string | null;
        pagesServed.push(after);
        const start = after ? Number(after) : 0;
        const nodes = all.slice(start, start + 2);
        return { data: { repository: { discussions: { pageInfo: { hasNextPage: start + 2 < all.length, endCursor: String(start + 2) }, nodes } } } };
      }],
    ]);
  const prev: Record<string, { version: string }> = {};
  const run = async (cursor: Record<string, unknown>) => {
    const changes = await collect(github, makeCtx(github, { repo: "acme/handbook", paths: ["nothing/**"], include_discussions: true }, {
      fetch: mk(), cursor, limit: 3, previous: prev,
    }));
    for (const d of upserts(changes)) prev[d.externalId] = { version: d.version! };
    return changes;
  };
  const base = { sha: "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2", ref: "main" };
  const r1 = await run(base);
  assertEquals(upserts(r1).map((d) => d.externalId), ["discussion:5", "discussion:4", "discussion:3"]);
  const c1 = lastCursor(r1)!;
  assertEquals(c1.more, true);
  assertEquals((c1.cursor as { discussions_scan?: unknown }).discussions_scan, { after: "2", since: null, top: "2026-11-15T00:00:00Z" });
  assertEquals((c1.cursor as { discussions_since?: string }).discussions_since, undefined);

  const r2 = await run(c1.cursor);
  assertEquals(upserts(r2).map((d) => d.externalId), ["discussion:2", "discussion:1"]);
  const c2 = lastCursor(r2)!;
  assertEquals(c2.more, false);
  assertEquals((c2.cursor as { discussions_since?: string }).discussions_since, "2026-11-15T00:00:00Z");
  assertEquals((c2.cursor as { discussions_scan?: unknown }).discussions_scan, undefined);

  // nothing new: the scan stops at the first page
  pagesServed.length = 0;
  const r3 = await run(c2.cursor);
  assertEquals(upserts(r3).length, 0);
  assertEquals(pagesServed, [null]);
});
