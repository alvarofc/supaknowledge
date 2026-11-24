import { notFound, redirect } from "@tanstack/react-router";
import { getRequest } from "@tanstack/react-start/server";
import type { Database } from "@/lib/database.types";
import type { SpaceRole, WorkspaceRole } from "@/lib/roles";
import { getSupabase, getUser } from "@/server/supabase.server";

export type Workspace = Pick<Database["public"]["Tables"]["workspaces"]["Row"], "id" | "slug" | "name">;
export type Space = Pick<
  Database["public"]["Tables"]["spaces"]["Row"],
  "id" | "slug" | "name" | "description" | "visibility" | "settings" | "workspace_id"
>;
export type Group = Pick<Database["public"]["Tables"]["groups"]["Row"], "id" | "slug" | "name" | "description">;

export interface SpaceContext {
  user: { id: string; email: string | null };
  workspace: Workspace;
  space: Space;
  /** effective space role from rpc my_space_role (null = no access) */
  role: SpaceRole | null;
  workspaceRole: WorkspaceRole | null;
  /** groups in this workspace, and the ids the current user belongs to (for audience display) */
  groups: Group[];
  myGroupIds: string[];
  /** base path for links: /w/<ws>/<space> */
  base: string;
}

/** Per-request memo, so the shell and the page loader share one lookup during SSR. */
function memo<T>(store: WeakMap<Request, Map<string, Promise<T>>>, key: string, load: () => Promise<T>): Promise<T> {
  const request = getRequest();
  let byKey = store.get(request);
  if (!byKey) store.set(request, (byKey = new Map()));
  let value = byKey.get(key);
  if (!value) byKey.set(key, (value = load()));
  return value;
}

/** Throws a redirect to /login (keeping the URL the user wanted) when signed out. */
export async function requireUser(next: string) {
  const user = await getUser();
  if (!user) throw redirect({ href: `/login?next=${encodeURIComponent(next)}` });
  return user;
}

const spaceContexts = new WeakMap<Request, Map<string, Promise<SpaceContext>>>();

/** Everything a space page needs about "where am I and what may I do". Throws notFound() when hidden. */
export function getSpaceContext(wsSlug: string, spaceSlug: string): Promise<SpaceContext> {
  return memo(spaceContexts, `${wsSlug}/${spaceSlug}`, async () => {
    const user = await requireUser(`/w/${wsSlug}/${spaceSlug}`);
    const supabase = getSupabase();

    const { data: workspace } = await supabase.from("workspaces").select("id, slug, name").eq("slug", wsSlug).maybeSingle();
    // a hidden or missing space has no shell to render in: show the full-page not-found
    if (!workspace) throw notFound({ routeId: "/_authed" });

    const { data: space } = await supabase
      .from("spaces")
      .select("id, slug, name, description, visibility, settings, workspace_id")
      .eq("workspace_id", workspace.id)
      .eq("slug", spaceSlug)
      .maybeSingle();
    if (!space) throw notFound({ routeId: "/_authed" });

    const [roleRes, wmRes, groupsRes, myGroupsRes] = await Promise.all([
      supabase.rpc("my_space_role", { p_space: space.id }),
      supabase.from("workspace_members").select("role").eq("workspace_id", workspace.id).eq("user_id", user.id).maybeSingle(),
      supabase.from("groups").select("id, slug, name, description").eq("workspace_id", workspace.id).order("name"),
      supabase.from("group_members").select("group_id").eq("user_id", user.id),
    ]);

    return {
      user: { id: user.id, email: user.email },
      workspace,
      space,
      role: (roleRes.data) ?? null,
      workspaceRole: wmRes.data?.role ?? null,
      groups: groupsRes.data ?? [],
      myGroupIds: (myGroupsRes.data ?? []).map((g) => g.group_id),
      base: `/w/${workspace.slug}/${space.slug}`,
    };
  });
}

export type Navigation = {
  workspaces: Workspace[];
  spaces: { id: string; slug: string; name: string; workspace_id: string; visibility: Database["public"]["Enums"]["space_visibility"] }[];
};

const navigations = new WeakMap<Request, Map<string, Promise<Navigation>>>();

/** Workspaces and the spaces the user can read, for the switcher and the landing redirect. */
export function getNavigation(): Promise<Navigation> {
  return memo(navigations, "nav", async () => {
    const supabase = getSupabase();
    const [{ data: workspaces }, { data: spaces }] = await Promise.all([
      supabase.from("workspaces").select("id, slug, name").order("name"),
      supabase.from("spaces").select("id, slug, name, workspace_id, visibility").order("name"),
    ]);
    return { workspaces: workspaces ?? [], spaces: spaces ?? [] };
  });
}

/** Display names for user ids (profiles RLS: you and your coworkers). */
export async function getProfiles(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (unique.length === 0) return {};
  const { data } = await getSupabase().from("profiles").select("id, display_name, kind").in("id", unique);
  return Object.fromEntries((data ?? []).map((p) => [p.id, { display_name: p.display_name, kind: p.kind }]));
}
