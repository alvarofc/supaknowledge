import { createServerFn } from "@tanstack/react-start";
import type { TreeConcept } from "@/components/knowledge/tree";
import type { Database } from "@/lib/database.types";
import { spaceParams } from "@/server/shell.functions";
import type { SpaceParams } from "@/server/shell.functions";
import { getSpaceContext } from "@/server/space.server";
import { getSupabase } from "@/server/supabase.server";

type Kind = Database["public"]["Enums"]["concept_kind"];
export const KINDS: Kind[] = ["skill", "domain", "data_access"];

/** Knowledge browser: the concept tree (optionally one kind), counts per kind, and full-text search results. */
export const loadKnowledge = createServerFn({ method: "GET" })
  .validator((d: SpaceParams & { q?: string; kind?: string }) => spaceParams(d))
  .handler(async ({ data }) => {
    const ctx = await getSpaceContext(data.workspace, data.space);
    const supabase = getSupabase();
    const q = (data.q ?? "").trim();
    const kind = KINDS.includes(data.kind as Kind) ? (data.kind as Kind) : null;

    let query = supabase
      .from("concepts")
      .select("id, path, kind, type, title, description, status, audience, revision, updated_at, trust, is_stale")
      .eq("space_id", ctx.space.id)
      .order("path");
    if (kind) query = query.eq("kind", kind);
    const { data: concepts, error } = await query;
    const all = (concepts ?? []) as TreeConcept[];

    const results = q
      ? await supabase.rpc("search_knowledge", { p_space: ctx.space.id, p_query: q, p_limit: 30, p_kinds: kind ? [kind] : undefined })
      : null;

    const counts = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number>;
    const { data: kindRows } = await supabase.from("concepts").select("kind").eq("space_id", ctx.space.id);
    for (const r of kindRows ?? []) counts[r.kind]++;
    const total = kindRows?.length ?? 0;

    return {
      q,
      kind,
      all,
      error: error ? error.message : null,
      results: results ? { data: results.data ?? [], error: results.error ? results.error.message : null } : null,
      counts,
      total,
    };
  });
