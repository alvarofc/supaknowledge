import { createServerFn } from "@tanstack/react-start";
import { atLeast } from "@/lib/roles";
import { getNavigation, getSpaceContext } from "@/server/space.server";
import { getSupabase } from "@/server/supabase.server";

export type SpaceParams = { workspace: string; space: string };

/** Validates the { workspace, space } slugs every space page sends. */
export function spaceParams<T extends object = object>(input: SpaceParams & T): SpaceParams & T {
  if (typeof input.workspace !== "string" || typeof input.space !== "string") throw new Error("Bad request");
  return input;
}

/** The space shell: where am I, what may I do, the switcher, and the pending-proposal count. */
export const loadSpaceShell = createServerFn({ method: "GET" })
  .validator((d: SpaceParams) => spaceParams(d))
  .handler(async ({ data }) => {
    const [ctx, nav] = await Promise.all([getSpaceContext(data.workspace, data.space), getNavigation()]);
    let inboxCount: number | undefined;
    if (atLeast(ctx.role, "editor")) {
      const { count } = await getSupabase()
        .from("proposals")
        .select("id", { count: "exact", head: true })
        .eq("space_id", ctx.space.id)
        .eq("status", "pending");
      inboxCount = count ?? undefined;
    }
    return { ctx, nav, inboxCount };
  });
