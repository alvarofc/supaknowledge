import { createFileRoute } from "@tanstack/react-router";
import { Bot, ChevronLeft, ChevronRight, ListChecks, ScrollText, Sparkles } from "lucide-react";
import { JsonDetails, StatChips } from "@/components/activity/json-view";
import { CancelRunButton } from "@/components/activity/cancel-run-button";
import { TaskPayload } from "@/components/activity/task-payload";
import { OutcomeBadge, RUN_STATUS, duration } from "@/components/activity/outcome-badge";
import { RunCuratorButton } from "@/components/activity/run-curator-button";
import { AgentBadge, StatusDot } from "@/components/kf/badges";
import { LiveRefresh } from "@/components/kf/live-refresh";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { Callout, Card, EmptyState, PageHeader } from "@/components/ui/card";
import { Link } from "@/components/ui/link";
import { LinkTabs } from "@/components/ui/tabs";
import { actorLabel, cancelledBy, shortId } from "@/lib/format";
import { title } from "@/lib/meta";
import { atLeast } from "@/lib/roles";
import { useSpace } from "@/lib/use-space";
import { PAGE_SIZE, loadActivity } from "@/server/activity.functions";
import { Timestamp } from "@/components/kf/timestamp";

export const Route = createFileRoute("/_authed/w/$workspace/$space/activity/")({
  validateSearch: (search: Record<string, unknown>): { tab?: string; page?: number } => ({
    tab: typeof search.tab === "string" ? search.tab : undefined,
    page: search.page === undefined ? undefined : Number.parseInt(String(search.page), 10) || undefined,
  }),
  loaderDeps: ({ search }) => ({ tab: search.tab, page: search.page ?? 1 }),
  loader: ({ params, deps }) => loadActivity({ data: { workspace: params.workspace, space: params.space, tab: deps.tab, page: deps.page } }),
  head: () => ({ meta: [title("Activity")] }),
  component: ActivityPage,
});

type ActivityData = Awaited<ReturnType<typeof loadActivity>>;
type RunsData = NonNullable<ActivityData["runs"]>;
type TracesData = NonNullable<ActivityData["traces"]>;
type AuditData = NonNullable<ActivityData["audit"]>;
type Ctx = ReturnType<typeof useSpace>;

const TRIGGER_LABEL: Record<string, string> = {
  cron: "Nightly schedule",
  flag_threshold: "Flag threshold",
  manual: "Manual",
  staleness: "Staleness sweep",
};

function ActivityPage() {
  const ctx = useSpace();
  const { tab, page, runs, traces, audit } = Route.useLoaderData();
  const isAdmin = atLeast(ctx.role, "admin");
  const isReviewer = atLeast(ctx.role, "reviewer");

  const tabs = [
    { id: "runs", label: "Curator runs", href: `${ctx.base}/activity?tab=runs` },
    ...(isReviewer ? [{ id: "traces", label: "Traces", href: `${ctx.base}/activity?tab=traces` }] : []),
    ...(isAdmin ? [{ id: "audit", label: "Audit log", href: `${ctx.base}/activity?tab=audit` }] : []),
  ];

  return (
    <>
      <PageHeader
        title="Activity"
        actions={
          tab === "runs" ? <LiveRefresh spaceId={ctx.space.id} tables={["curator_runs"]} /> : null
        }
      />
      {/* on wide screens the product sidebar carries these tabs */}
      <LinkTabs tabs={tabs} active={tab} className="mb-4 lg:hidden" />
      <div>
        {tab === "runs" && runs ? <Runs ctx={ctx} isAdmin={isAdmin} isReviewer={isReviewer} data={runs} /> : null}
        {tab === "traces" && traces ? <Traces ctx={ctx} page={page} data={traces} /> : null}
        {tab === "audit" && audit ? <Audit ctx={ctx} page={page} data={audit} /> : null}
      </div>
    </>
  );
}

function Runs({ ctx, isAdmin, isReviewer, data }: { ctx: Ctx; isAdmin: boolean; isReviewer: boolean; data: RunsData }) {
  const { list, tasks, profiles } = data;
  const active = list.some((r) => r.status === "queued" || r.status === "running");

  return (
    <div className="flex flex-col gap-4">
      {isReviewer ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <p className="max-w-xl text-sm text-muted">
            The curator runs nightly and whenever enough flags pile up on one concept. Run it now to process open flags, new traces and
            changed source documents since the last successful run.
          </p>
          <RunCuratorButton spaceId={ctx.space.id} active={active} />
        </Card>
      ) : null}
      {list.length === 0 ? (
        <EmptyState framed icon={<Sparkles />} title="The curator has not run yet">
          Each run gathers open flags, new agent traces and changed source documents, clusters them by topic, researches each cluster
          and drafts proposals with citations. Runs appear here with their stats as they happen.
        </EmptyState>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {list.map((r) => {
              const st = RUN_STATUS[r.status];
              const runTasks = tasks.filter((t) => t.run_id === r.id);
              const d = duration(r.started_at, r.finished_at);
              const canceller = cancelledBy(r.error);
              return (
                <li key={r.id} id={`run-${r.id}`} className="scroll-mt-20 px-4 py-3.5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-fg">
                      <StatusDot tone={st.tone} /> {st.label}
                    </span>
                    <Badge>{TRIGGER_LABEL[r.trigger] ?? r.trigger}</Badge>
                    {r.requested_by ? (
                      <span className="text-xs text-subtle">by {profiles[r.requested_by]?.display_name ?? "a reviewer"}</span>
                    ) : null}
                    {isReviewer && (r.status === "queued" || r.status === "running") ? <CancelRunButton runId={r.id} /> : null}
                    {/* "running for" uses the clock, which differs between the server render and hydration */}
                    <span className="ml-auto text-xs text-subtle" suppressHydrationWarning>
                      <Timestamp iso={r.created_at} />
                      {d ? ` · ${r.finished_at ? "took" : "running for"} ${d}` : r.status === "queued" ? " · waiting for a worker" : ""}
                    </span>
                  </div>
                  {r.status === "cancelled" ? (
                    <Callout tone="neutral" className="mt-2" title="Run cancelled">
                      {canceller ? (
                        `Cancelled by ${canceller === "system" ? "the system" : actorLabel(canceller, profiles)}.`
                      ) : r.error ? (
                        <span className="font-mono text-xs">{r.error}</span>
                      ) : null}
                    </Callout>
                  ) : r.error ? (
                    <Callout tone="danger" className="mt-2" title="Run failed">
                      <span className="font-mono text-xs">{r.error}</span>
                    </Callout>
                  ) : null}
                  <div className="mt-2">
                    <StatChips stats={r.stats} />
                  </div>
                  {r.since && r.since !== "-infinity" ? (
                    <p className="mt-1.5 text-xs text-subtle">
                      Covers activity from <Timestamp iso={r.since} format="date" /> to <Timestamp iso={r.until} format="date" />
                    </p>
                  ) : r.until ? (
                    <p className="mt-1.5 text-xs text-subtle">Covers everything up to <Timestamp iso={r.until} format="date" /> (first run)</p>
                  ) : null}
                  {isAdmin && runTasks.length ? (
                    <details className="mt-2">
                      <summary className="inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-muted select-none hover:text-fg">
                        <ListChecks className="size-3.5" /> {runTasks.length} tasks
                      </summary>
                      <ul className="mt-2 flex flex-col gap-2 border-l border-line pl-3">
                        {runTasks.map((t) => (
                          <li key={t.id} className="text-xs">
                            <div className="flex flex-wrap items-center gap-2">
                              <StatusDot tone={RUN_STATUS[t.status].tone} />
                              <span className="font-mono text-fg">{t.step}</span>
                              <span className="text-subtle">{RUN_STATUS[t.status].label}</span>
                              {t.attempts > 1 ? <Badge tone="warn">{t.attempts} attempts</Badge> : null}
                              {/* unfinished tasks measure against the clock, which differs between the server render and hydration */}
                              <span className="ml-auto text-subtle" suppressHydrationWarning>
                                {duration(t.created_at, t.finished_at) ?? ""}
                              </span>
                            </div>
                            {t.error ? <p className="mt-1 font-mono text-danger">{t.error}</p> : null}
                            <TaskPayload workspace={ctx.workspace.slug} space={ctx.space.slug} taskId={t.id} />
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Traces({ ctx, page, data }: { ctx: Ctx; page: number; data: TracesData }) {
  const { traces, count, profiles } = data;
  if (!traces.length && page === 1) {
    return (
      <EmptyState
        framed
        icon={<Bot />}
        title="No traces yet"
        actions={
          <LinkButton href={`${ctx.base}/agents`} size="sm">
            Connect an agent
          </LinkButton>
        }
      >
        Traces are transcripts of what agents actually did. Agents send them to the <code className="font-mono text-xs">traces</code>{" "}
        endpoint; the curator looks for moments where a person corrected the agent or a tool call failed, and turns them into flags.
      </EmptyState>
    );
  }
  return (
    <>
      <Card>
        <ul className="divide-y divide-line">
          {traces.map((t) => {
            const who = t.principal_id ? profiles[t.principal_id] : undefined;
            const events = t.events;
            return (
              <li key={t.id}>
                <Link href={`${ctx.base}/activity/traces/${t.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-surface-2/60">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{t.name ?? `Trace ${shortId(t.id)}`}</span>
                  <OutcomeBadge outcome={t.outcome} />
                  {t.curated_at ? <Badge tone="accent">Curated</Badge> : null}
                  <span className="inline-flex items-center gap-1.5 text-xs text-subtle">
                    {who?.display_name ?? "Unknown sender"}
                    {who?.kind === "agent" ? <AgentBadge /> : null}
                    {t.on_behalf_of ? ` for ${profiles[t.on_behalf_of]?.display_name ?? "a user"}` : ""}
                  </span>
                  <span className="text-xs text-subtle tabular-nums">{events} events</span>
                  <Timestamp iso={t.started_at} className="text-xs text-subtle" />
                </Link>
              </li>
            );
          })}
        </ul>
      </Card>
      <Pager base={`${ctx.base}/activity?tab=traces`} page={page} total={count ?? 0} />
    </>
  );
}

function Audit({ ctx, page, data }: { ctx: Ctx; page: number; data: AuditData }) {
  const { rows, count, profiles } = data;
  if (!rows.length && page === 1) {
    return (
      <EmptyState framed icon={<ScrollText />} title="Nothing audited yet">
        Every privileged action lands here: applied and rejected proposals, auto-applies, connector secrets being set. The log is
        append-only and visible to space admins.
      </EmptyState>
    );
  }
  const targetHref = (kind: string | null, id: string | null) =>
    kind === "proposal" && id ? `${ctx.base}/proposals/${id}` : kind === "source" && id ? `${ctx.base}/sources/${id}` : null;
  return (
    <>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-2 text-left text-subtle">
              <th className="px-4 py-1.5 mono-label">When</th>
              <th className="px-4 py-1.5 mono-label">Actor</th>
              <th className="px-4 py-1.5 mono-label">Action</th>
              <th className="px-4 py-1.5 mono-label">Target</th>
              <th className="px-4 py-1.5 mono-label">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => {
              const href = targetHref(r.target_kind, r.target_id);
              return (
                <tr key={r.id} className="align-top">
                  <td className="px-4 py-2 text-xs whitespace-nowrap text-subtle">
                    <Timestamp iso={r.at} />
                  </td>
                  <td className="px-4 py-2 text-muted">{actorLabel(r.actor, profiles)}</td>
                  <td className="px-4 py-2 font-mono text-xs text-fg">{r.action}</td>
                  <td className="px-4 py-2 text-xs">
                    {r.target_kind ? (
                      href ? (
                        <Link href={href} className="text-accent hover:underline">
                          {r.target_kind} {shortId(r.target_id)}
                        </Link>
                      ) : (
                        <span className="text-muted">
                          {r.target_kind} {shortId(r.target_id)}
                        </span>
                      )
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </td>
                  <td className="max-w-xs px-4 py-2">
                    <JsonDetails label="data" value={r.data} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <Pager base={`${ctx.base}/activity?tab=audit`} page={page} total={count ?? 0} />
    </>
  );
}

function Pager({ base, page, total }: { base: string; page: number; total: number }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return null;
  return (
    <nav className="mt-3 flex items-center justify-between text-sm" aria-label="Pagination">
      <span className="text-xs text-subtle">
        Page {page} of {pages} · {total} entries
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <LinkButton size="sm" href={`${base}&page=${page - 1}`}>
            <ChevronLeft className="size-3.5" /> Newer
          </LinkButton>
        ) : null}
        {page < pages ? (
          <LinkButton size="sm" href={`${base}&page=${page + 1}`}>
            Older <ChevronRight className="size-3.5" />
          </LinkButton>
        ) : null}
      </div>
    </nav>
  );
}
