import type { SpaceSettings } from "@supaknowledge/core";
import type { GroupRow } from "@/components/settings/groups";
import type { PendingInvitation } from "@/components/settings/people";
import { createServerFn } from "@tanstack/react-start";
import type { SpaceRole, WorkspaceRole } from "@/lib/roles";
import { spaceParams } from "@/server/shell.functions";
import type { SpaceParams } from "@/server/shell.functions";
import { readSettings, saveSettings } from "@/server/settings.server";
import type { SaveSettingsResult } from "@/server/settings.server";
import { getProfiles, getSpaceContext } from "@/server/space.server";
import type { SpaceContext } from "@/server/space.server";
import { getSupabase } from "@/server/supabase.server";

export type { SaveSettingsResult };

export const SETTINGS_TABS = ["general", "curator", "members", "groups", "access"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

type Kind = "human" | "agent";
type WsPerson = { user_id: string; role: WorkspaceRole; name: string; kind: Kind };

export type SettingsData =
  | { tab: "general" }
  | { tab: "curator"; settings: SpaceSettings }
  | {
      tab: "members";
      people: WsPerson[];
      members: { user_id: string; role: SpaceRole; name: string; kind: Kind }[];
      /** open invitations to the workspace (RLS: only workspace admins see them) */
      invitations: PendingInvitation[];
    }
  | {
      tab: "groups";
      people: WsPerson[];
      groups: GroupRow[];
    }
  | { tab: "access"; grants: { group_id: string; role: SpaceRole }[] };

/** People in the workspace, used by the members and groups tabs. */
async function workspacePeople(ctx: SpaceContext) {
  const { data } = await getSupabase().from("workspace_members").select("user_id, role").eq("workspace_id", ctx.workspace.id).order("created_at");
  const rows = data ?? [];
  const profiles = await getProfiles(rows.map((r) => r.user_id));
  const people: WsPerson[] = rows.map((r) => ({
    user_id: r.user_id,
    role: r.role,
    name: profiles[r.user_id]?.display_name ?? (r.user_id === ctx.user.id ? (ctx.user.email ?? "You") : `User ${r.user_id.slice(0, 8)}`),
    kind: profiles[r.user_id]?.kind ?? "human",
  }));
  return { people, profiles };
}

/** Settings: only the data the selected tab needs. */
export const loadSettings = createServerFn({ method: "GET" })
  .validator((d: SpaceParams & { tab: SettingsTab }) => spaceParams(d))
  .handler(async ({ data }): Promise<SettingsData> => {
    const ctx = await getSpaceContext(data.workspace, data.space);
    const supabase = getSupabase();
    const tab: SettingsTab = SETTINGS_TABS.includes(data.tab) ? data.tab : "general";

    if (tab === "curator") return { tab, settings: readSettings(ctx.space.settings) };

    if (tab === "members") {
      const [{ people, profiles }, { data: sm }, { data: inv }] = await Promise.all([
        workspacePeople(ctx),
        supabase.from("space_members").select("user_id, role").eq("space_id", ctx.space.id).order("created_at"),
        supabase
          .from("workspace_invitations")
          .select("id, email, role, created_at, expires_at, invited_by")
          .eq("workspace_id", ctx.workspace.id)
          .is("accepted_at", null)
          .is("declined_at", null)
          .order("created_at", { ascending: false })
          .limit(200),
      ]);
      const extra = await getProfiles(
        [...(sm ?? []).map((m) => m.user_id), ...(inv ?? []).flatMap((i) => (i.invited_by ? [i.invited_by] : []))].filter((id) => !profiles[id]),
      );
      const all = { ...profiles, ...extra };
      const members = (sm ?? []).map((m) => ({
        user_id: m.user_id,
        role: m.role,
        name: all[m.user_id]?.display_name ?? `User ${m.user_id.slice(0, 8)}`,
        kind: all[m.user_id]?.kind ?? "human",
      }));
      const invitations: PendingInvitation[] = (inv ?? []).map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        created_at: i.created_at,
        expires_at: i.expires_at,
        invited_by_name: i.invited_by ? (all[i.invited_by]?.display_name ?? null) : null,
      }));
      return { tab, people, members, invitations };
    }

    if (tab === "groups") {
      const [{ people }, { data: groupRows }] = await Promise.all([
        workspacePeople(ctx),
        supabase.from("groups").select("id, slug, name, description, external_ref").eq("workspace_id", ctx.workspace.id).order("name"),
      ]);
      const ids = (groupRows ?? []).map((g) => g.id);
      const { data: gm } = ids.length ? await supabase.from("group_members").select("group_id, user_id").in("group_id", ids) : { data: [] };
      const byId = Object.fromEntries(people.map((p) => [p.user_id, p]));
      const groups = (groupRows ?? []).map((g) => ({
        ...g,
        members: (gm ?? [])
          .filter((m) => m.group_id === g.id)
          .map((m) => ({ user_id: m.user_id, name: byId[m.user_id]?.name ?? `User ${m.user_id.slice(0, 8)}`, kind: byId[m.user_id]?.kind ?? "human" })),
      }));
      return { tab, people, groups };
    }

    if (tab === "access") {
      const { data: grants } = await supabase.from("space_group_grants").select("group_id, role").eq("space_id", ctx.space.id);
      return { tab, grants: (grants ?? []).map((g) => ({ group_id: g.group_id, role: g.role })) };
    }

    return { tab: "general" };
  });

/** Validate (SpaceSettingsSchema) and save space settings as the signed-in user; RLS allows space admins only. */
export const saveSpaceSettings = createServerFn({ method: "POST" })
  .validator((d: { spaceId: string; settings: SpaceSettings }) => {
    if (typeof d.spaceId !== "string") throw new Error("Bad request");
    return d;
  })
  .handler(async ({ data }): Promise<SaveSettingsResult> => saveSettings(data.spaceId, data.settings));
