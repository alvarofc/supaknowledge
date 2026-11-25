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
    const [{ data: concepts, error }, results, kindRows] = await Promise.all([
      query,
      q ? supabase.rpc("search_knowledge", { p_space: ctx.space.id, p_query: q, p_limit: 30, p_kinds: kind ? [kind] : undefined }) : Promise.resolve(null),
      // counts per kind: from the tree itself unless it is filtered to one kind
      kind ? supabase.from("concepts").select("kind").eq("space_id", ctx.space.id).then((r) => r.data ?? []) : Promise.resolve(null),
    ]);
    const all = (concepts ?? []) as TreeConcept[];

    const counts = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number>;
    const rows = kindRows ?? all;
    for (const r of rows) counts[r.kind]++;
    const total = rows.length;

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
