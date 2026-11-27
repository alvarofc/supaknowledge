import { createServerFn } from "@tanstack/react-start";
import type { GraphData } from "@/lib/graph";
import { spaceParams } from "@/server/shell.functions";
import type { SpaceParams } from "@/server/shell.functions";
import { getSpaceContext } from "@/server/space.server";
import { getSupabase } from "@/server/supabase.server";

/** Concepts the caller can read are capped here; the RPC reports `truncated` when there are more. */
export const GRAPH_LIMIT = 1000;

/** rpc knowledge_graph with the person's session: RLS decides which concepts, flags and citations appear. */
export const loadGraph = createServerFn({ method: "GET" })
  .validator((d: SpaceParams) => spaceParams(d))
  .handler(async ({ data }) => {
    const ctx = await getSpaceContext(data.workspace, data.space);
    const { data: graph, error } = await getSupabase().rpc("knowledge_graph", { p_space: ctx.space.id, p_limit: GRAPH_LIMIT });
    return { graph: (graph ?? null) as unknown as GraphData | null, error: error?.message ?? null };
  });
