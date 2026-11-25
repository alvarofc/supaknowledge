import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getNavigation } from "@/server/space.server";

/** /w/<workspace>: go to its first space, or create one. */
const workspaceLanding = createServerFn({ method: "GET" })
  .validator((d: { workspace: string }) => d)
  .handler(async ({ data }) => {
    const nav = await getNavigation();
    const ws = nav.workspaces.find((w) => w.slug === data.workspace);
    if (!ws) throw notFound({ routeId: "/_authed" });
    const first = nav.spaces.find((s) => s.workspace_id === ws.id);
    throw redirect({ href: first ? `/w/${ws.slug}/${first.slug}` : `/onboarding?workspace=${ws.slug}` });
  });

export const Route = createFileRoute("/_authed/w/$workspace/")({
  loader: ({ params }) => workspaceLanding({ data: { workspace: params.workspace } }),
});
