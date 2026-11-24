import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { getNavigation } from "@/server/space.server";

/** A malformed cookie (e.g. a stray `%`) must not turn the landing page into a 500. */
function safeDecode(v: string | undefined): string | null {
  if (!v) return null;
  try {
    return decodeURIComponent(v);
  } catch {
    return null;
  }
}

/**
 * "/": the workspace you just joined (?workspace=), else the last space you visited, else your first space, else
 * onboarding (which also shows open invitations).
 */
const landing = createServerFn({ method: "GET" })
  .validator((d: { workspace?: string }) => ({ workspace: typeof d.workspace === "string" ? d.workspace : undefined }))
  .handler(async ({ data }) => {
    const nav = await getNavigation();
    // new account: onboarding shows any open invitations above the "create a workspace" step
    if (nav.workspaces.length === 0) throw redirect({ href: "/onboarding" });

    const joined = data.workspace ? nav.workspaces.find((x) => x.slug === data.workspace) : undefined;
    if (joined) {
      const first = nav.spaces.find((s) => s.workspace_id === joined.id);
      throw redirect({ href: first ? `/w/${joined.slug}/${first.slug}` : `/onboarding?workspace=${joined.slug}` });
    }

    const last = safeDecode(getCookie("kf_last"));
    if (last) {
      const [, w, ws, sp] = last.split("/");
      const workspace = w === "w" ? nav.workspaces.find((x) => x.slug === ws) : undefined;
      if (workspace && nav.spaces.some((s) => s.workspace_id === workspace.id && s.slug === sp)) throw redirect({ href: `/w/${ws}/${sp}` });
    }
    for (const ws of nav.workspaces) {
      const first = nav.spaces.find((s) => s.workspace_id === ws.id);
      if (first) throw redirect({ href: `/w/${ws.slug}/${first.slug}` });
    }
    throw redirect({ href: `/onboarding?workspace=${nav.workspaces[0].slug}` });
  });

export const Route = createFileRoute("/_authed/")({
  validateSearch: (search: Record<string, unknown>): { workspace?: string } => ({
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
  }),
  loaderDeps: ({ search }) => ({ workspace: search.workspace }),
  loader: ({ deps }) => landing({ data: { workspace: deps.workspace } }),
});
