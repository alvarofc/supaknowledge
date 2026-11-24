import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { getNavigation } from "@/server/space.server";

/** "/": the last space you visited, else your first space, else onboarding. */
const landing = createServerFn({ method: "GET" }).handler(async () => {
  const nav = await getNavigation();
  if (nav.workspaces.length === 0) throw redirect({ href: "/onboarding" });

  const last = getCookie("kf_last");
  if (last) {
    const [, w, ws, sp] = decodeURIComponent(last).split("/");
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
  loader: () => landing(),
});
