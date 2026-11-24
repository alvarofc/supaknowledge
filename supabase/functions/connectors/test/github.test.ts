import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { github, globToRegExp, makeMatcher } from "../lib/github.ts";
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
