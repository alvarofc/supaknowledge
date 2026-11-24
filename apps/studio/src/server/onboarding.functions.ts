import { createServerFn } from "@tanstack/react-start";
import { isWorkspaceAdmin } from "@/lib/roles";
import { getNavigation, requireUser } from "@/server/space.server";
import { getSupabase } from "@/server/supabase.server";

type Step = "workspace" | "space" | "connect";
type OnboardingSearch = { workspace?: string; space?: string; step?: string };

/** Where the wizard starts: a new workspace, a new space in a workspace you administer, or "connect". */
export const loadOnboarding = createServerFn({ method: "GET" })
  .validator((d: OnboardingSearch) => d)
  .handler(async ({ data: sp }) => {
    const user = await requireUser("/onboarding");
    const nav = await getNavigation();
    const { data: memberships } = await getSupabase().from("workspace_members").select("workspace_id, role").eq("user_id", user.id);
    const adminOf = new Set((memberships ?? []).filter((m) => isWorkspaceAdmin(m.role)).map((m) => m.workspace_id));

    const ws = sp.workspace ? nav.workspaces.find((w) => w.slug === sp.workspace) : undefined;
    const space = ws && sp.space ? nav.spaces.find((s) => s.workspace_id === ws.id && s.slug === sp.space) : undefined;

    let initial: { step: Step; workspace?: { id: string; slug: string; name: string }; space?: { slug: string; name: string } };
    if (ws && space && sp.step === "connect") initial = { step: "connect", workspace: ws, space: { slug: space.slug, name: space.name } };
    else if (ws && adminOf.has(ws.id)) initial = { step: "space", workspace: ws };
    else initial = { step: "workspace" };

    return { initial, userId: user.id, hasAny: nav.workspaces.length > 0 };
  });
