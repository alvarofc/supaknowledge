import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { SOURCE_COLUMNS, SOURCE_PAGE_SIZE } from "@/components/sources/connectors";
import { atLeast } from "@/lib/roles";
import { spaceParams } from "@/server/shell.functions";
import type { SpaceParams } from "@/server/shell.functions";
import { getProfiles, getSpaceContext } from "@/server/space.server";
import { getSupabase } from "@/server/supabase.server";

/** Sources list with live document counts (editors and up; readers get an explanation instead). */
export const loadSources = createServerFn({ method: "GET" })
  .validator((d: SpaceParams) => spaceParams(d))
  .handler(async ({ data }) => {
    const ctx = await getSpaceContext(data.workspace, data.space);
    if (!atLeast(ctx.role, "editor")) return { sources: [], docCount: {} };
    const supabase = getSupabase();
    const { data: sources } = await supabase.from("sources").select(SOURCE_COLUMNS).eq("space_id", ctx.space.id).order("created_at");
    const list = sources ?? [];
    const counts = await Promise.all(
      list.map(async (s) => {
        const { count } = await supabase
          .from("source_documents")
          .select("id", { count: "exact", head: true })
          .eq("source_id", s.id)
          .is("deleted_at", null);
        return [s.id, count ?? 0] as const;
      }),
    );
    return { sources: list, docCount: Object.fromEntries(counts) };
  });

/** One source: details and a page of its documents. */
export const loadSource = createServerFn({ method: "GET" })
  .validator((d: SpaceParams & { id: string; page: number; showDeleted: boolean }) => spaceParams(d))
  .handler(async ({ data }) => {
    const ctx = await getSpaceContext(data.workspace, data.space);
    if (!atLeast(ctx.role, "editor")) throw notFound();
    const supabase = getSupabase();

    const { data: source } = await supabase.from("sources").select(SOURCE_COLUMNS).eq("id", data.id).eq("space_id", ctx.space.id).maybeSingle();
    if (!source) throw notFound();

    const page = Math.max(0, Number(data.page) || 0);
    let docsQuery = supabase
      .from("source_documents")
      .select("id, title, url, external_id, mime_type, changed_at, synced_at, deleted_at, audience", { count: "exact" })
      .eq("source_id", source.id)
      .order("changed_at", { ascending: false })
      .range(page * SOURCE_PAGE_SIZE, page * SOURCE_PAGE_SIZE + SOURCE_PAGE_SIZE - 1);
    if (!data.showDeleted) docsQuery = docsQuery.is("deleted_at", null);
    const [{ data: docs, count }, profiles] = await Promise.all([docsQuery, getProfiles([source.created_by])]);
    return { source, docs: docs ?? [], total: count ?? 0, page, profiles };
  });

/** One source document (RLS: editors+ in the document's audience; anyone else gets a 404). */
export const loadSourceDocument = createServerFn({ method: "GET" })
  .validator((d: SpaceParams & { id: string }) => spaceParams(d))
  .handler(async ({ data }) => {
    const ctx = await getSpaceContext(data.workspace, data.space);
    const supabase = getSupabase();
    // we never confirm that a hidden document exists
    const { data: doc } = await supabase
      .from("source_documents")
      .select(
        "id, source_id, external_id, title, url, mime_type, content, audience, author, metadata, external_updated_at, synced_at, changed_at, deleted_at, storage_path",
      )
      .eq("id", data.id)
      .eq("space_id", ctx.space.id)
      .maybeSingle();
    if (!doc) throw notFound();
    const { data: source } = await supabase.from("sources").select(SOURCE_COLUMNS).eq("id", doc.source_id).maybeSingle();
    return { doc, source };
  });
