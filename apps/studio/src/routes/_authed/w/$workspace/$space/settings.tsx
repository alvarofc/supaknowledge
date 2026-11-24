import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AccessGrants } from "@/components/settings/access";
import { CuratorSettingsForm } from "@/components/settings/curator-form";
import { DeleteSpace, GeneralForm } from "@/components/settings/general-form";
import { Groups } from "@/components/settings/groups";
import { SpaceMembers, WorkspaceMembers } from "@/components/settings/people";
import type { Person } from "@/components/settings/people";
import { Card, PageHeader } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { LinkTabs } from "@/components/ui/tabs";
import { title } from "@/lib/meta";
import { atLeast, isWorkspaceAdmin } from "@/lib/roles";
import { useSpace } from "@/lib/use-space";
import { SETTINGS_TABS, loadSettings } from "@/server/settings.functions";
import type { SettingsTab } from "@/server/settings.functions";

export const Route = createFileRoute("/_authed/w/$workspace/$space/settings")({
  validateSearch: (search: Record<string, unknown>): { tab?: SettingsTab } => ({
    tab: SETTINGS_TABS.includes(search.tab as SettingsTab) ? (search.tab as SettingsTab) : undefined,
  }),
  loaderDeps: ({ search }) => ({ tab: search.tab ?? "general" }),
  loader: ({ params, deps }) => loadSettings({ data: { workspace: params.workspace, space: params.space, tab: deps.tab } }),
  head: () => ({ meta: [title("Settings")] }),
  component: SettingsPage,
});

function SettingsPage() {
  const ctx = useSpace();
  const data = Route.useLoaderData();
  const tab = data.tab;
  const spaceAdmin = atLeast(ctx.role, "admin");
  const wsAdmin = isWorkspaceAdmin(ctx.workspaceRole);
  const href = (t: SettingsTab) => `${ctx.base}/settings${t === "general" ? "" : `?tab=${t}`}`;

  const tabs = [
    { id: "general", label: "General", href: href("general") },
    { id: "curator", label: "Curator & policy", href: href("curator") },
    { id: "members", label: "Members", href: href("members") },
    { id: "groups", label: "Groups", href: href("groups") },
    { id: "access", label: "Access", href: href("access") },
  ];

  let body: ReactNode = null;

  if (data.tab === "general") {
    body = (
      <div className="flex flex-col gap-6">
        <GeneralForm space={ctx.space} canEdit={spaceAdmin} />
        {wsAdmin ? <DeleteSpace space={ctx.space} wsSlug={ctx.workspace.slug} /> : null}
      </div>
    );
  } else if (data.tab === "curator") {
    body = <CuratorSettingsForm key={ctx.space.id} spaceId={ctx.space.id} initial={data.settings} canEdit={spaceAdmin} />;
  } else if (data.tab === "members") {
    body = (
      <div className="flex flex-col gap-6">
        <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">Your user ID</div>
            <p className="text-xs text-subtle">Send it to a workspace admin so they can add you to a workspace, space or group.</p>
            <code className="mt-1 block font-mono text-xs break-all text-muted">{ctx.user.id}</code>
          </div>
          <CopyButton value={ctx.user.id} label="Copy ID" />
        </Card>
        <SpaceMembers
          spaceId={ctx.space.id}
          members={data.members}
          candidates={data.people.map(({ user_id, name, kind }): Person => ({ user_id, name, kind }))}
          canManage={spaceAdmin}
          me={ctx.user.id}
          visibility={ctx.space.visibility}
        />
        <WorkspaceMembers
          workspaceId={ctx.workspace.id}
          workspaceName={ctx.workspace.name}
          members={data.people}
          canManage={wsAdmin}
          isOwner={ctx.workspaceRole === "owner"}
          me={ctx.user.id}
        />
      </div>
    );
  } else if (data.tab === "groups") {
    body = (
      <Groups
        workspaceId={ctx.workspace.id}
        groups={data.groups}
        people={data.people.map(({ user_id, name, kind }) => ({ user_id, name, kind }))}
        canManage={wsAdmin}
        me={ctx.user.id}
      />
    );
  } else {
    body = <AccessGrants spaceId={ctx.space.id} grants={data.grants} groups={ctx.groups} canManage={spaceAdmin} />;
  }

  return (
    <>
      <PageHeader title="Settings" description={`How ${ctx.space.name} is curated and who can use it.`} />
      {/* on wide screens the product sidebar carries these tabs */}
      <LinkTabs tabs={tabs} active={tab} className="mb-6 lg:hidden" />
      {body}
    </>
  );
}
