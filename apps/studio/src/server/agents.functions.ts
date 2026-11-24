import { createServerFn } from "@tanstack/react-start";
import { FUNCTIONS_URL, SUPABASE_PUBLISHABLE_KEY } from "@/lib/env";
import type { SpaceRole } from "@/lib/roles";
import { spaceParams } from "@/server/shell.functions";
import type { SpaceParams } from "@/server/shell.functions";
import { getProfiles, getSpaceContext } from "@/server/space.server";
import { getSupabase } from "@/server/supabase.server";

export type AgentListItem = {
  id: string;
  name: string;
  description: string | null;
  key_prefix: string | null;
  last_seen_at: string | null;
  created_at: string;
  created_by: string | null;
  /** true = revoked (agents.revoked_at set), false = active, null = unknown (kept for older functions) */
  revoked: boolean | null;
};

/**
 * Agents through the `agents` Edge Function (revoked state, space grants).
 * Called with the signed-in user's token, so the function's RLS client sees exactly what the user sees.
 */
async function listFromFunction(workspaceId: string): Promise<AgentListItem[] | null> {
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  try {
    const res = await fetch(`${FUNCTIONS_URL}/agents?workspace_id=${encodeURIComponent(workspaceId)}`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_PUBLISHABLE_KEY },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { agents?: AgentListItem[] };
    return Array.isArray(body.agents) ? body.agents.map((a) => ({ ...a, revoked: a.revoked ?? null })) : null;
  } catch {
    return null;
  }
}

/** Headless agents of the workspace, with their revoked state and their direct role in this space. */
export const loadAgents = createServerFn({ method: "GET" })
  .validator((d: SpaceParams) => spaceParams(d))
  .handler(async ({ data }) => {
    const ctx = await getSpaceContext(data.workspace, data.space);
    const supabase = getSupabase();
    let list = await listFromFunction(ctx.workspace.id);
    if (!list) {
      // function not deployed / unreachable: the table has everything we show (agents.revoked_at included)
      const { data: agents } = await supabase
        .from("agents")
        .select("id, name, description, key_prefix, last_seen_at, created_at, created_by, revoked_at")
        .eq("workspace_id", ctx.workspace.id)
        .order("name");
      list = (agents ?? []).map(({ revoked_at, ...a }) => ({ ...a, revoked: revoked_at !== null && Date.parse(revoked_at) <= Date.now() }));
    }
    const statusKnown = list.every((a) => a.revoked !== null);
    const ids = list.map((a) => a.id);
    const [{ data: memberships }, profiles] = await Promise.all([
      ids.length
        ? supabase.from("space_members").select("user_id, role").eq("space_id", ctx.space.id).in("user_id", ids)
        : Promise.resolve({ data: [] as { user_id: string; role: SpaceRole }[] }),
      getProfiles(list.map((a) => a.created_by)),
    ]);
    const roleHere: Record<string, SpaceRole> = Object.fromEntries((memberships ?? []).map((m) => [m.user_id, m.role]));
    return { agents: list, roleHere, profiles, statusKnown };
  });
