import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { atLeast } from "@/lib/roles";
import { spaceParams } from "@/server/shell.functions";
import type { SpaceParams } from "@/server/shell.functions";
import { getSpaceContext } from "@/server/space.server";
import { getSupabase } from "@/server/supabase.server";

/** The concept to edit (when ?path= is given) for the suggest-an-edit editor. Editors and up only. */
export const loadSuggest = createServerFn({ method: "GET" })
  .validator((d: SpaceParams & { path?: string }) => spaceParams(d))
  .handler(async ({ data }) => {
    const ctx = await getSpaceContext(data.workspace, data.space);
    if (!atLeast(ctx.role, "editor") || !data.path) return { concept: null };
    const { data: concept } = await getSupabase()
      .from("concepts")
      .select("id, path, kind, type, title, description, body, frontmatter, tags, status, stale_after, audience, revision")
      .eq("space_id", ctx.space.id)
      .eq("path", data.path)
      .maybeSingle();
    if (!concept) throw notFound();
    return { concept };
  });
