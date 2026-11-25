import { createServerFn } from "@tanstack/react-start";
import type { WorkspaceRole } from "@/lib/roles";
import { getSupabase } from "@/server/supabase.server";

export type MyInvitation = {
  id: string;
  workspace_id: string;
  workspace_slug: string;
  workspace_name: string;
  role: WorkspaceRole;
  invited_by_name: string | null;
  expires_at: string;
};

/** Open invitations for the signed-in user's verified e-mail (never fails the page: [] on error). */
export async function myInvitations(): Promise<MyInvitation[]> {
  const { data, error } = await getSupabase().rpc("list_my_invitations");
  if (error) return [];
  return (data ?? []).map((i) => ({
    id: i.id,
    workspace_id: i.workspace_id,
    workspace_slug: i.workspace_slug,
    workspace_name: i.workspace_name,
    role: i.role,
    invited_by_name: i.invited_by_name,
    expires_at: i.expires_at,
  }));
}

export const loadMyInvitations = createServerFn({ method: "GET" }).handler(() => myInvitations());
