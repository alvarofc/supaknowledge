// Notion connector (REST API, Notion-Version 2022-06-28).
//   config: { database_ids?: string[], page_ids?: string[], include_child_pages?: boolean (default true),
//             max_depth?: number (default 3), acl_strict?: boolean }
//   token:  internal integration secret (share the databases/pages with the integration)
//   cursor: { databases: { [database_id]: "<last_edited_time high-water mark>" } }
// Databases are queried with a last_edited_time filter (ascending), pages are re-checked by
// last_edited_time (cheap GET) and only re-rendered when it moved. Blocks are fetched recursively.
// ACL: Notion's API does not expose page permissions, so documents inherit the source audience unless an
// admin maps a group with external_ref {"notion_database": "<id>"} or {"notion_page": "<root page id>"}.
import { getJson, postJson } from "./http.ts";
import { type NotionBlock, notionBlocksToMarkdown, notionPropertiesToMarkdown, notionRichText } from "./markdown.ts";
import { asObject, type Connector, ConfigError, type DocumentChange, optBool, optNumber, stringList, type SyncContext } from "./types.ts";

export interface NotionConfig {
  database_ids: string[];
  page_ids: string[];
  include_child_pages: boolean;
  max_depth: number;
}

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

/** Accept raw ids, dashed uuids or full notion.so URLs. */
export function normaliseNotionId(s: string): string {
  const m = /([0-9a-f]{32})(?:[?#].*)?$/i.exec(s.replace(/-/g, ""));
  if (!m) throw new ConfigError(`not a Notion id: ${s}`);
  const h = m[1]!.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// deno-lint-ignore no-explicit-any
type NotionPage = { id: string; url?: string; last_edited_time: string; created_time?: string; archived?: boolean; in_trash?: boolean; properties?: Record<string, any>; created_by?: { id: string }; parent?: Record<string, string> };

interface ListResponse<T> {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
}

function pageTitle(p: NotionPage): string {
  for (const prop of Object.values(p.properties ?? {})) {
    if (prop?.type === "title") return notionRichText(prop.title).replace(/[*_~`]/g, "").trim() || "Untitled";
  }
  return "Untitled";
}

export const notion: Connector<NotionConfig> = {
  kind: "notion",
  parseConfig(raw) {
    const o = asObject(raw);
    const database_ids = stringList(o, "database_ids").map(normaliseNotionId);
    const page_ids = stringList(o, "page_ids").map(normaliseNotionId);
    if (!database_ids.length && !page_ids.length) throw new ConfigError("config needs database_ids and/or page_ids");
    return {
      database_ids,
      page_ids,
      include_child_pages: optBool(o, "include_child_pages", true),
      max_depth: optNumber(o, "max_depth", 3, 0, 10),
    };
  },

  async *sync(ctx: SyncContext<NotionConfig>): AsyncGenerator<DocumentChange> {
    if (!ctx.token) throw new ConfigError("notion source has no token; call set_source_secret with the integration secret");
    const headers = { Authorization: `Bearer ${ctx.token}`, "Notion-Version": VERSION };
    const { config } = ctx;
    const dbCursor: Record<string, string> = { ...((ctx.cursor.databases as Record<string, string>) ?? {}) };
    const users = new Map<string, string | null>();
    let fetched = 0;
    let capped = false;
    const seen = new Set<string>();
    const visited = new Set<string>();

    const userName = async (id: string | undefined): Promise<string | null> => {
      if (!id) return null;
      if (!users.has(id)) {
        try {
          const u = await getJson<{ name?: string; person?: { email?: string } }>(ctx, `${API}/users/${id}`, { headers });
          users.set(id, u.name ?? u.person?.email ?? null);
        } catch {
          users.set(id, null); // needs the "read user information" capability; optional
        }
      }
      return users.get(id) ?? null;
    };

    const blocksOf = async (id: string, depth = 0): Promise<NotionBlock[]> => {
      const out: NotionBlock[] = [];
      let cursor: string | null = null;
      do {
        const url = new URL(`${API}/blocks/${id}/children`);
        url.searchParams.set("page_size", "100");
        if (cursor) url.searchParams.set("start_cursor", cursor);
        const r: ListResponse<NotionBlock> = await getJson(ctx, url, { headers });
        out.push(...r.results);
        cursor = r.has_more ? r.next_cursor : null;
      } while (cursor);
      for (const b of out) {
        // child pages/databases are their own documents; everything else is inlined
        if (b.has_children && b.type !== "child_page" && b.type !== "child_database" && depth < 20) {
          b.children = await blocksOf(b.id, depth + 1);
        }
      }
      return out;
    };

    // render + emit one page. Returns child page ids discovered (or remembered when unchanged).
    async function* emitPage(page: NotionPage, root: Record<string, string>): AsyncGenerator<DocumentChange, string[]> {
      seen.add(page.id);
      const prev = ctx.previous(page.id);
      if (prev && !prev.deleted && prev.version === page.last_edited_time) return prev.children;
      if (fetched >= ctx.limit) {
        capped = true;
        return prev?.children ?? [];
      }
      fetched++;
      const childPages: string[] = [];
      const blocks = await blocksOf(page.id);
      const body = notionBlocksToMarkdown(blocks, { onChildPage: (id) => childPages.push(id) });
      const title = pageTitle(page);
      const props = notionPropertiesToMarkdown(page.properties);
      const content = [`# ${title}`, props, body].filter((x) => x.trim()).join("\n\n");
      yield {
        type: "upsert",
        doc: {
          externalId: page.id,
          title,
          url: page.url ?? `https://www.notion.so/${page.id.replace(/-/g, "")}`,
          content,
          mimeType: "text/markdown",
          raw: { body: JSON.stringify({ page, blocks }, null, 2), ext: "json", contentType: "application/json" },
          author: await userName(page.created_by?.id),
          updatedAt: page.last_edited_time,
          version: page.last_edited_time,
          metadata: { notion_parent: page.parent ?? null, children: childPages, ...root },
          acl: { restricted: false, refs: Object.entries(root).map(([k, v]) => ({ [k]: v })) },
        },
      };
      return childPages;
    }

    // ---- databases: incremental by last_edited_time
    for (const db of config.database_ids) {
      if (capped) break;
      const since = ctx.full ? undefined : dbCursor[db];
      let start: string | null = null;
      do {
        const body: Record<string, unknown> = {
          page_size: 100,
          sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
        };
        if (since) body.filter = { timestamp: "last_edited_time", last_edited_time: { on_or_after: since } };
        if (start) body.start_cursor = start;
        const r: ListResponse<NotionPage> = await postJson(ctx, `${API}/databases/${db}/query`, body, { headers });
        for (const page of r.results) {
          if (page.archived || page.in_trash) {
            yield { type: "delete", externalId: page.id, reason: "archived" };
            continue;
          }
          const children: string[] = yield* emitPage(page, { notion_database: db });
          if (capped) break;
          if (config.include_child_pages) yield* walkChildren(children, { notion_database: db }, 1);
          if (capped) break;
          dbCursor[db] = page.last_edited_time;
          yield { type: "cursor", cursor: { databases: { ...dbCursor } } };
        }
        start = !capped && r.has_more ? r.next_cursor : null;
      } while (start);
    }

    // ---- explicit pages (+ child pages): cheap metadata check, re-render only when edited
    async function* walkChildren(ids: string[], root: Record<string, string>, depth: number): AsyncGenerator<DocumentChange> {
      if (depth > config.max_depth) return;
      for (const id of ids) {
        if (capped) return;
        if (visited.has(id)) continue;
        visited.add(id);
        yield* visitPage(id, root, depth);
      }
    }

    async function* visitPage(id: string, root: Record<string, string>, depth: number): AsyncGenerator<DocumentChange> {
      let page: NotionPage;
      try {
        page = await getJson<NotionPage>(ctx, `${API}/pages/${id}`, { headers });
      } catch (e) {
        if (e instanceof Error && "status" in e && (e as { status: number }).status === 404) {
          yield { type: "delete", externalId: id, reason: "not found or no longer shared" };
          return;
        }
        throw e;
      }
      if (page.archived || page.in_trash) {
        yield { type: "delete", externalId: page.id, reason: "archived" };
        return;
      }
      const children: string[] = yield* emitPage(page, root);
      if (config.include_child_pages && !capped) yield* walkChildren(children, root, depth + 1);
    }

    for (const pid of config.page_ids) {
      if (capped) break;
      if (visited.has(pid)) continue;
      visited.add(pid);
      yield* visitPage(pid, { notion_page: pid }, 0);
    }

    if (!capped && ctx.full) yield { type: "snapshot", externalIds: [...seen] };
    yield { type: "cursor", cursor: { databases: dbCursor }, more: capped };
  },
};
