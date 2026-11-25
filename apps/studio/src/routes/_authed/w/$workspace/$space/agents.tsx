import { createFileRoute } from "@tanstack/react-router";
import { Bot, ShieldCheck, UserRound } from "lucide-react";
import { AgentAvatar, AgentRowActions, CreateAgentButton } from "@/components/agents/agent-actions";
import { ConnectSnippets } from "@/components/agents/connect-snippets";
import { RoleBadge } from "@/components/kf/badges";
import { ConnectedApps } from "@/components/oauth/connected-apps";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, Code, EmptyState, PageHeader } from "@/components/ui/card";
import { actorLabel } from "@/lib/format";
import { title } from "@/lib/meta";
import { isWorkspaceAdmin } from "@/lib/roles";
import { useSpace } from "@/lib/use-space";
import { loadAgents } from "@/server/agents.functions";
import { Timestamp } from "@/components/kf/timestamp";

export const Route = createFileRoute("/_authed/w/$workspace/$space/agents")({
  loader: ({ params }) => loadAgents({ data: { workspace: params.workspace, space: params.space } }),
  head: () => ({ meta: [title("Agents")] }),
  component: AgentsPage,
});

function AgentsPage() {
  const ctx = useSpace();
  const { agents: list, roleHere, profiles, statusKnown } = Route.useLoaderData();
  const admin = isWorkspaceAdmin(ctx.workspaceRole);
  const actionCtx = { workspaceId: ctx.workspace.id, wsSlug: ctx.workspace.slug, spaceId: ctx.space.id, spaceSlug: ctx.space.slug, spaceName: ctx.space.name };

  return (
    <>
      <PageHeader
        title="Agents"
        actions={admin ? <CreateAgentButton ctx={actionCtx} /> : null}
      />

      <Card className="mb-6">
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              <UserRound className="size-4 text-accent" /> Connect as yourself (OAuth)
            </span>
          }
          description="Best for coding assistants you use day to day: Claude Code, Cursor, Claude Desktop."
        />
        <div className="grid grid-cols-1 gap-6 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] [&>*]:min-w-0">
          <ol className="flex flex-col gap-3 text-sm text-muted">
            <li className="flex gap-3">
              <Step n={1} />
              <span>
                Add the MCP server to your client. No key needed: the client discovers that the server is protected by{" "}
                <strong className="font-medium text-fg">Supabase Auth&apos;s OAuth 2.1 server</strong> and registers itself.
              </span>
            </li>
            <li className="flex gap-3">
              <Step n={2} />
              <span>
                Your browser opens Studio&apos;s consent screen. Sign in and approve the client. You can see which client is asking and where it will
                redirect.
              </span>
            </li>
            <li className="flex gap-3">
              <Step n={3} />
              <span>
                The agent then reads <strong className="font-medium text-fg">with exactly your permissions</strong>: same spaces, same audience groups.
                It can search, read, load skills, record traces and flag problems, but never edit, approve or administer anything, whatever your
                role. Flags it raises are attributed to you, and RLS applies to every call.
              </span>
            </li>
          </ol>
          <ConnectSnippets wsSlug={ctx.workspace.slug} spaceSlug={ctx.space.slug} />
        </div>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title={`Headless agents in ${ctx.workspace.name}`}
          description="For CI jobs, bots and services. Each has its own API key, and row level security applies to it as to a person."
        />
        {!statusKnown && list.length ? (
          <p className="border-b border-line px-4 py-2 text-xs text-warn">
            The revoked state of some agents is unknown, so they may not be marked here.
          </p>
        ) : null}
        {list.length === 0 ? (
          <EmptyState
            icon={<Bot />}
            title="No headless agents yet"
            actions={admin ? <CreateAgentButton ctx={actionCtx} /> : null}
          >
            <p>
              Register an agent for automation that runs without a person: a CI job, a Slack bot, a nightly report. It gets a key like{" "}
              <Code>skn_&lt;agent-id&gt;_&lt;secret&gt;</Code> and a role per space — usually <strong className="font-medium text-fg">reader</strong>, so it can
              search, read and flag, but never see raw sources or other people&apos;s traces.
            </p>
            {!admin ? <p className="mt-2">Only workspace admins can create agents.</p> : null}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {list.map((a) => (
              <li key={a.id} className="flex items-start gap-3 px-4 py-3">
                <AgentAvatar />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={a.revoked ? "text-sm font-medium text-muted line-through" : "text-sm font-medium text-fg"}>{a.name}</span>
                    {a.revoked ? (
                      <Badge tone="danger" title="Its key no longer works. Restore it from the actions menu.">
                        Revoked
                      </Badge>
                    ) : null}
                    {roleHere[a.id] ? <RoleBadge role={roleHere[a.id]} /> : <Badge title="This agent has no direct role in this space">Not in this space</Badge>}
                    {a.key_prefix ? (
                      <code className="rounded border border-line bg-surface-2 px-1.5 py-px font-mono text-[11px] text-muted" title="Start of the current key">
                        {a.key_prefix}…
                      </code>
                    ) : null}
                  </div>
                  {a.description ? <p className="mt-0.5 text-sm text-muted">{a.description}</p> : null}
                  <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-subtle">
                    <span>
                      {a.last_seen_at ? (
                        <>
                          Last active <Timestamp iso={a.last_seen_at} />
                        </>
                      ) : (
                        "Never used"
                      )}
                    </span>
                    <span>
                      Created <Timestamp iso={a.created_at} />
                      {a.created_by ? ` by ${actorLabel(`human:${a.created_by}`, profiles)}` : ""}
                    </span>
                  </p>
                </div>
                {admin ? <AgentRowActions agent={{ id: a.id, name: a.name, revoked: a.revoked }} ctx={actionCtx} /> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="mt-6">
        <ConnectedApps />
      </div>

      <p className="mt-4 flex items-start gap-2 text-xs text-subtle">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
        Keys are shown once and stored only as a hash. Revoking an agent bans its Auth user, so it cannot start new sessions; restoring it
        lifts the ban. Agents can never be space or workspace admins.
      </p>
    </>
  );
}

function Step({ n }: { n: number }) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-accent/30 bg-accent-soft font-mono text-[11px] text-accent" aria-hidden="true">
      {n}
    </span>
  );
}
