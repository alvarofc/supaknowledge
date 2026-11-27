import { Outlet, createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/shell/app-shell";
import { loadSpaceShell } from "@/server/shell.functions";

export const Route = createFileRoute("/_authed/w/$workspace/$space")({
  loader: ({ params }) => loadSpaceShell({ data: { workspace: params.workspace, space: params.space } }),
  component: SpaceLayout,
});

function SpaceLayout() {
  const { ctx, nav, inboxCount } = Route.useLoaderData();
  return (
    <AppShell
      base={ctx.base}
      user={{ email: ctx.user.email, isAnonymous: ctx.user.isAnonymous }}
      workspace={ctx.workspace}
      space={ctx.space}
      role={ctx.role}
      workspaceRole={ctx.workspaceRole}
      workspaces={nav.workspaces}
      spaces={nav.spaces}
      inboxCount={inboxCount}
    >
      <Outlet />
    </AppShell>
  );
}
