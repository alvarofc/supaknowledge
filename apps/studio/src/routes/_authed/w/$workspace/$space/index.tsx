import { createFileRoute } from "@tanstack/react-router";
import { CheckCheck, Flag, GitPullRequestArrow, History, Inbox as InboxIcon } from "lucide-react";
import { FlagItem } from "@/components/inbox/flag-list";
import { ProposalItem } from "@/components/inbox/proposal-list";
import { LiveRefresh } from "@/components/kf/live-refresh";
import { LinkButton } from "@/components/ui/button";
import { Card, EmptyState, PageHeader } from "@/components/ui/card";
import { LinkTabs } from "@/components/ui/tabs";
import { title } from "@/lib/meta";
import { atLeast } from "@/lib/roles";
import { useSpace } from "@/lib/use-space";
import { loadInbox } from "@/server/inbox.functions";

type Tab = "proposals" | "flags" | "history";

export const Route = createFileRoute("/_authed/w/$workspace/$space/")({
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === "string" ? search.tab : undefined,
  }),
  loader: ({ params }) => loadInbox({ data: { workspace: params.workspace, space: params.space } }),
  head: () => ({ meta: [title("Inbox")] }),
  component: InboxPage,
});

function InboxPage() {
  const ctx = useSpace();
  const sp = Route.useSearch();
  const { pending, history, flags, profiles } = Route.useLoaderData();
  const isEditor = atLeast(ctx.role, "editor");
  const canReview = atLeast(ctx.role, "reviewer");

  const requested = (sp.tab ?? "") as Tab;
  const tab: Tab = isEditor ? (["proposals", "flags", "history"].includes(requested) ? requested : "proposals") : "flags";

  const tabs = isEditor
    ? [
        { id: "proposals", label: "Proposals", href: `${ctx.base}?tab=proposals`, count: pending.length },
        { id: "flags", label: "Open flags", href: `${ctx.base}?tab=flags`, count: flags.length },
        { id: "history", label: "History", href: `${ctx.base}?tab=history` },
      ]
    : [{ id: "flags", label: "Your open flags", href: `${ctx.base}?tab=flags`, count: flags.length }];

  return (
    <>
      <PageHeader
        title="Inbox"
        description={
          isEditor
            ? "What your agents reported and what the curator proposes to change. Review proposals like pull requests; nothing changes the knowledge until it is applied."
            : "Flags you raised. Editors and reviewers in this space decide what changes."
        }
        actions={<LiveRefresh spaceId={ctx.space.id} tables={["proposals", "flags"]} />}
      />
      {/* on wide screens the product sidebar carries these tabs */}
      <LinkTabs tabs={tabs} active={tab} className="mb-4 lg:hidden" />
      <div>
        {tab === "proposals" ? (
          pending.length ? (
            <Card>
              <ul className="divide-y divide-line">
                {pending.map((p) => (
                  <ProposalItem key={p.id} p={p} base={ctx.base} profiles={profiles} />
                ))}
              </ul>
            </Card>
          ) : (
            <EmptyState
              framed
              icon={<CheckCheck />}
              title="Inbox zero"
              actions={
                <>
                  <LinkButton href={`${ctx.base}?tab=flags`} size="sm">
                    See open flags
                  </LinkButton>
                  {canReview ? (
                    <LinkButton href={`${ctx.base}/activity`} size="sm" variant="ghost">
                      Run the curator
                    </LinkButton>
                  ) : null}
                </>
              }
            >
              Proposals are changesets to your knowledge. The curator drafts them from agent flags, traces and sources, each with
              citations; people can propose edits too (“Suggest an edit” on any concept). Low-risk ones may be auto-applied by your
              space policy — everything else waits here for a reviewer.
            </EmptyState>
          )
        ) : null}

        {tab === "history" ? (
          history.length ? (
            <Card>
              <ul className="divide-y divide-line">
                {history.map((p) => (
                  <ProposalItem key={p.id} p={p} base={ctx.base} profiles={profiles} history />
                ))}
              </ul>
            </Card>
          ) : (
            <EmptyState framed icon={<History />} title="No decisions yet">
              Applied, auto-applied, rejected and conflicted proposals show up here. Every applied proposal becomes a new revision of
              the concepts it touched, so you can always see who changed what, and why.
            </EmptyState>
          )
        ) : null}

        {tab === "flags" ? (
          flags.length ? (
            <Card>
              <ul className="divide-y divide-line">
                {flags.map((f) => (
                  <FlagItem key={f.id} flag={f} base={ctx.base} profiles={profiles} groups={ctx.groups} canDismiss={canReview} />
                ))}
              </ul>
            </Card>
          ) : (
            <EmptyState
              framed
              icon={isEditor ? <Flag /> : <InboxIcon />}
              title={isEditor ? "No open flags" : "You have no open flags"}
              actions={
                <LinkButton href={`${ctx.base}/agents`} size="sm">
                  Connect an agent
                </LinkButton>
              }
            >
              <span className="block">
                Flags are how the factory learns. Working agents call <code className="font-mono text-xs">flag_knowledge</code> when
                knowledge is missing, wrong, outdated, conflicting or unclear; people use “Report a problem” on a concept.
              </span>
              <span className="mt-2 flex items-center justify-center gap-1.5 text-xs text-subtle">
                <Flag className="size-3.5" /> agents flag
                <span aria-hidden="true">→</span>
                <GitPullRequestArrow className="size-3.5" /> the curator proposes
                <span aria-hidden="true">→</span>
                <CheckCheck className="size-3.5" /> people review
              </span>
            </EmptyState>
          )
        ) : null}
      </div>
    </>
  );
}
