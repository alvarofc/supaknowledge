import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { normaliseNotionId, notion } from "../lib/notion.ts";
import type { NotionBlock } from "../lib/markdown.ts";
import { collect, fakeFetch, fixture, lastCursor, makeCtx, upserts } from "./helpers.ts";

const DB = "11111111-2222-3333-4444-555555555555";
const PAGE = "2a1b3c4d-0000-4000-8000-000000000001";

async function api() {
  const fx = await fixture<{ page: Record<string, unknown>; blocks: NotionBlock[]; children: Record<string, NotionBlock[]> }>("notion-blocks.json");
  const archived = { ...fx.page, id: "2a1b3c4d-0000-4000-8000-0000000000aa", archived: true, last_edited_time: "2026-11-21T00:00:00.000Z" };
  const child = {
    object: "page", id: "b15", url: "https://www.notion.so/b15", last_edited_time: "2026-11-19T00:00:00.000Z", archived: false,
    created_by: { id: "u-1" }, parent: { type: "page_id", page_id: PAGE },
    properties: { title: { type: "title", title: [{ plain_text: "Escalation matrix" }] } },
  };
  const queries: unknown[] = [];
  const f = fakeFetch([
    [`POST https://api.notion.com/v1/databases/${DB}/query`, ({ body, calls }) => {
      if (calls === 1) return new Response("{}", { status: 429, headers: { "retry-after": "1" } }); // throttled once
      queries.push(JSON.parse(body!));
      return { object: "list", results: [fx.page, archived], has_more: false, next_cursor: null };
    }],
    ["GET https://api.notion.com/v1/blocks/b15/children", () => ({ results: [{ id: "c1", type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: "Page Tier 1 first." }] } }], has_more: false, next_cursor: null })],
    ["GET ^https://api\\.notion\\.com/v1/blocks/(b3|b12|b13)/children", ({ url }) => {
      const id = url.pathname.split("/")[3]!;
      return { results: fx.children[id], has_more: false, next_cursor: null };
    }],
    [`GET https://api.notion.com/v1/blocks/${PAGE}/children`, ({ url }) => {
      // paginated: first 10 blocks, then the rest
      const start = url.searchParams.get("start_cursor");
      return start
        ? { results: fx.blocks.slice(10), has_more: false, next_cursor: null }
        : { results: fx.blocks.slice(0, 10), has_more: true, next_cursor: "cur-2" };
    }],
    ["GET https://api.notion.com/v1/pages/b15", () => child],
    ["GET https://api.notion.com/v1/users/u-1", () => ({ object: "user", id: "u-1", name: "Dana Ops" })],
  ]);
  return { f, queries, fx };
}

Deno.test("notion: config accepts urls and dashed/undashed ids", () => {
  assertEquals(normaliseNotionId("https://www.notion.so/acme/Onboarding-2a1b3c4d000040008000000000000001?pvs=4"), PAGE);
  assertEquals(notion.parseConfig({ database_ids: [DB.replace(/-/g, "")] }).database_ids, [DB]);
});

Deno.test("notion: full sync renders pages + child pages, deletes archived, snapshots, sets cursor", async () => {
  const { f, queries } = await api();
  const changes = await collect(notion, makeCtx(notion, { database_ids: [DB] }, { fetch: f, full: true }));
  const docs = upserts(changes);
  assertEquals(docs.map((d) => d.externalId), [PAGE, "b15"]);
  const page = docs[0]!;
  assertEquals(page.title, "Onboarding checklist");
  assertEquals(page.author, "Dana Ops");
  assertEquals(page.version, "2026-11-20T10:00:00.000Z");
  assertStringIncludes(page.content, "# Onboarding checklist\n\n- **Team:** Support");
  assertStringIncludes(page.content, "- Accounts\n  - Google Workspace");
  assertStringIncludes(page.content, "| Gold | 1h \\| 24/7 |");
  assertEquals(page.metadata?.children, ["b15"]);
  assertEquals(page.acl, { restricted: false, refs: [{ notion_database: DB }] });
  assertEquals(docs[1]!.content, "# Escalation matrix\n\nPage Tier 1 first.");
  assert(changes.some((c) => c.type === "delete" && c.externalId.endsWith("aa")));
  const snap = changes.find((c) => c.type === "snapshot");
  assertEquals(snap?.type === "snapshot" && snap.externalIds.sort(), [PAGE, "b15"].sort());
  assertEquals(lastCursor(changes)?.cursor, { databases: { [DB]: "2026-11-20T10:00:00.000Z" } });
  assertEquals((queries[0] as { filter?: unknown }).filter, undefined);
});

Deno.test("notion: incremental sync filters by cursor and skips unchanged pages without fetching blocks", async () => {
  const { f, queries } = await api();
  const ctx = makeCtx(notion, { database_ids: [DB] }, {
    fetch: f,
    cursor: { databases: { [DB]: "2026-11-20T10:00:00.000Z" } },
    previous: {
      [PAGE]: { version: "2026-11-20T10:00:00.000Z", children: ["b15"] },
      b15: { version: "2026-11-19T00:00:00.000Z" },
    },
  });
  const changes = await collect(notion, ctx);
  assertEquals(upserts(changes).length, 0);
  assertEquals((queries[0] as { filter: unknown }).filter, { timestamp: "last_edited_time", last_edited_time: { on_or_after: "2026-11-20T10:00:00.000Z" } });
  assert(!f.calls.some((c) => c.url.includes("/blocks/")), "no block fetches for unchanged pages");
  assert(f.calls.some((c) => c.url.endsWith("/pages/b15")), "remembered child pages are still re-checked");
  assertEquals(f.calls[0]!.headers.get("notion-version"), "2022-06-28");
  assertEquals(changes.some((c) => c.type === "snapshot"), false);
});

Deno.test("notion: per-run cap stops early and asks for more", async () => {
  const { f } = await api();
  const changes = await collect(notion, makeCtx(notion, { database_ids: [DB] }, { fetch: f, full: true, limit: 1 }));
  assertEquals(upserts(changes).map((d) => d.externalId), [PAGE]);
  assertEquals(lastCursor(changes)?.more, true);
  assertEquals(changes.some((c) => c.type === "snapshot"), false);
});
