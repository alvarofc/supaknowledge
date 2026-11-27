import { createServerFn } from "@tanstack/react-start";
import { normalizeMonth } from "@/lib/recap";
import type { Recap } from "@/lib/recap";
import { spaceParams } from "@/server/shell.functions";
import type { SpaceParams } from "@/server/shell.functions";
import { getSpaceContext } from "@/server/space.server";
import { getSupabase } from "@/server/supabase.server";

export type RecapScope = "space" | "workspace";

/**
 * rpc knowledge_recap for one UTC calendar month, for this space or every space of its workspace the person can
 * read. Security invoker: only knowledge, flags and proposals the person can see are counted.
 */
export const loadRecap = createServerFn({ method: "GET" })
  .validator((d: SpaceParams & { month?: string; scope?: string }) => spaceParams(d))
  .handler(async ({ data }) => {
    const month = normalizeMonth(data.month);
    const scope: RecapScope = data.scope === "workspace" ? "workspace" : "space";
    const ctx = await getSpaceContext(data.workspace, data.space);
    const { data: recap, error } = await getSupabase().rpc(
      "knowledge_recap",
      scope === "workspace" ? { p_month: `${month}-01`, p_workspace: ctx.workspace.id } : { p_month: `${month}-01`, p_space: ctx.space.id },
    );
    return { month, scope, recap: (recap ?? null) as unknown as Recap | null, error: error?.message ?? null };
  });
