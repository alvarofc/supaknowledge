import { createServerFn } from "@tanstack/react-start";
import type { SpaceRole } from "@/lib/roles";
import { spaceParams } from "@/server/shell.functions";
import type { SpaceParams } from "@/server/shell.functions";
import { getProfiles, getSpaceContext } from "@/server/space.server";
import { getSupabase } from "@/server/supabase.server";

/** Headless agents of the workspace, with their direct role in this space. */
export const loadAgents = createServerFn({ method: "GET" })
  .validator((d: SpaceParams) => spaceParams(d))
  .handler(async ({ data }) => {
    const ctx = await getSpaceContext(data.workspace, data.space);
    const supabase = getSupabase();
    const { data: agents } = await supabase
      .from("agents")
      .select("id, name, description, key_prefix, last_seen_at, created_at, created_by")
      .eq("workspace_id", ctx.workspace.id)
      .order("name");
    const list = agents ?? [];
    const ids = list.map((a) => a.id);
    const [{ data: memberships }, profiles] = await Promise.all([
      ids.length
        ? supabase.from("space_members").select("user_id, role").eq("space_id", ctx.space.id).in("user_id", ids)
        : Promise.resolve({ data: [] as { user_id: string; role: SpaceRole }[] }),
      getProfiles(list.map((a) => a.created_by)),
    ]);
    const roleHere: Record<string, SpaceRole> = Object.fromEntries((memberships ?? []).map((m) => [m.user_id, m.role]));
    return { agents: list, roleHere, profiles };
  });
