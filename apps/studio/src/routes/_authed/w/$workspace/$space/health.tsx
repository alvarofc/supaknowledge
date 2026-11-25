import { createFileRoute } from "@tanstack/react-router";
import { HeartPulse, Info } from "lucide-react";
import { KIND_LABEL } from "@/components/kf/badges";
import { Bars } from "@/components/knowledge/bars";
import { conceptHref } from "@/components/knowledge/paths";
import { Badge } from "@/components/ui/badge";
import { Callout, Card, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { Link } from "@/components/ui/link";

import { title } from "@/lib/meta";
import { atLeast } from "@/lib/roles";
import { useSpace } from "@/lib/use-space";
import { HEALTH_DAYS, loadHealth } from "@/server/health.functions";
import { Timestamp } from "@/components/kf/timestamp";

export const Route = createFileRoute("/_authed/w/$workspace/$space/health")({
  validateSearch: (search: Record<string, unknown>): { days?: number } => ({
    days: search.days === undefined ? undefined : Number(search.days) || undefined,
  }),
  loaderDeps: ({ search }) => ({ days: search.days ?? 30 }),
  loader: ({ params, deps }) => loadHealth({ data: { workspace: params.workspace, space: params.space, days: deps.days } }),
  head: () => ({ meta: [title("Health")] }),
  component: HealthPage,
});

function HealthPage() {
  const ctx = useSpace();
  const { days, health: h, error } = Route.useLoaderData();

  const header = (
    <PageHeader
      title="Health"
      description="Restricted knowledge outside your groups is not counted."
      actions={
        <div role="group" aria-label="Time window" className="inline-flex rounded-md border border-line bg-surface-2 p-0.5">
          {HEALTH_DAYS.map((d) => (
            <Link
              key={d}
              href={`${ctx.base}/health?days=${d}`}
              aria-current={d === days ? "true" : undefined}
              className={cn(
                "rounded-[5px] border px-2.5 py-0.5 text-xs transition-colors",
                d === days ? "border-line-strong bg-button text-fg shadow-xs" : "border-transparent text-subtle hover:text-fg",
              )}
            >
              {d} days
            </Link>
          ))}
        </div>
      }
    />
  );

  if (error || !h) {
    return (
      <div>
        {header}
        <Callout tone="danger" title="Could not compute health">
          {error ?? "No data returned."}
        </Callout>
      </div>
    );
  }

  if (h.concepts === 0 && h.open_flags === 0 && h.pending_proposals === 0) {
    return (
      <div>
        {header}
        <EmptyState framed icon={<HeartPulse />} title="No knowledge to measure yet">
          Health tracks how much knowledge is human reviewed, what has gone stale, which concepts agents flag most and which are never used. It fills in
          as soon as the first proposal is applied in this space.
        </EmptyState>
      </div>
    );
  }

  const trustTotal = (h.by_trust.human_reviewed ?? 0) + (h.by_trust.machine_confirmed ?? 0) + (h.by_trust.unverified ?? 0);
  const reviewedShare = trustTotal ? Math.round(((h.by_trust.human_reviewed ?? 0) / trustTotal) * 100) : 0;
  const canSeeLoop = atLeast(ctx.role, "editor");

  return (
    <div className="space-y-6">
      {header}

      <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Concepts" value={h.concepts} hint="Active (not deprecated)" />
        <Stat label="Human reviewed" value={`${reviewedShare}%`} hint="Share of current revisions a person verified" tone={reviewedShare >= 50 ? "ok" : undefined} />
        <Stat label="Stale" value={h.stale} hint="Past their re-check date" tone={h.stale > 0 ? "warn" : undefined} />
        <Stat label="Never used" value={h.never_used} hint={`Not retrieved by anyone in ${days} days`} />
        <Stat label="Open flags" value={h.open_flags} hint="Waiting for the curator" tone={h.open_flags > 10 ? "warn" : undefined} />
        <Stat label="Missing knowledge" value={h.missing_flags} hint="Open “missing” flags" tone={h.missing_flags > 0 ? "warn" : undefined} />
        <Stat label="Pending proposals" value={h.pending_proposals} hint="Need a reviewer" />
        <Stat
          label={`Applied (${days}d)`}
          value={h.applied_proposals}
          hint={h.auto_applied ? `${h.auto_applied} auto-applied by policy` : "None auto-applied"}
        />
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader title="By trust tier" description="Healthy factories move knowledge to human reviewed over time." />
          <div className="p-4">
            <Bars
              total={trustTotal}
              items={[
                { key: "hr", label: "Human reviewed", value: h.by_trust.human_reviewed ?? 0, color: "bg-brand", hint: "A person verified the current revision" },
                { key: "mc", label: "Machine confirmed", value: h.by_trust.machine_confirmed ?? 0, color: "bg-info", hint: "Confirmed by an automated check" },
                { key: "un", label: "Unverified", value: h.by_trust.unverified ?? 0, color: "bg-subtle", hint: "Nobody verified the current revision" },
              ]}
            />
          </div>
        </Card>
        <Card>
          <CardHeader title="By kind" description="Skills say how to work, domain says how the business works, data access says where data lives." />
          <div className="p-4">
            <Bars
              total={h.concepts}
              items={[
                { key: "skill", label: KIND_LABEL.skill, value: h.by_kind.skill ?? 0, color: "bg-violet" },
                { key: "domain", label: KIND_LABEL.domain, value: h.by_kind.domain ?? 0, color: "bg-brand" },
                { key: "data_access", label: KIND_LABEL.data_access, value: h.by_kind.data_access ?? 0, color: "bg-info" },
              ]}
            />
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Most flagged"
          description={`Flag rate = flags ÷ times used in the last ${days} days.`}
        />
        {h.most_flagged.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-subtle">No flags in this window. Either the knowledge is solid, or agents are not flagging — check their system prompt encourages flag_knowledge.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left text-subtle">
                  <th className="px-4 py-1.5 mono-label">Concept</th>
                  <th className="px-4 py-1.5 text-right mono-label">Flags</th>
                  <th className="px-4 py-1.5 text-right mono-label">Uses</th>
                  <th className="px-4 py-1.5 text-right mono-label">Flag rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {h.most_flagged.map((r) => (
                  <tr key={r.path}>
                    <td className="px-4 py-2">
                      <Link href={conceptHref(ctx.base, r.path)} className="font-medium text-fg hover:text-accent">
                        {r.title}
                      </Link>
                      <div className="font-mono text-xs text-subtle">{r.path}</div>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.flags}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.uses}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      <span className={r.flag_rate >= 0.5 ? "font-medium text-danger" : r.flag_rate >= 0.2 ? "text-warn" : "text-muted"}>
                        {Number(r.flag_rate).toFixed(2)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Last curator run"
          actions={
            canSeeLoop ? (
              <Link href={`${ctx.base}/activity`} className="text-xs text-accent hover:underline">
                All runs
              </Link>
            ) : null
          }
        />
        {h.last_run ? (
          <div className="px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={h.last_run.status === "succeeded" ? "ok" : h.last_run.status === "failed" ? "danger" : "info"}>{h.last_run.status}</Badge>
              <span className="text-muted">triggered by {h.last_run.trigger.replace("_", " ")}</span>
              <span className="text-subtle">
                {h.last_run.finished_at ? (
                  <>
                    finished <Timestamp iso={h.last_run.finished_at} />
                  </>
                ) : (
                  "not finished"
                )}
              </span>
            </div>
            {h.last_run.stats && Object.keys(h.last_run.stats).length ? (
              <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {Object.entries(h.last_run.stats)
                  .filter(([, v]) => typeof v === "number" || typeof v === "string")
                  .map(([k, v]) => (
                    <div key={k} className="rounded-md border border-line bg-surface-2/60 px-3 py-2">
                      <dt className="mono-label text-subtle">{k.replaceAll("_", " ")}</dt>
                      <dd className="mt-0.5 text-lg tabular-nums text-fg">{String(v)}</dd>
                    </div>
                  ))}
              </dl>
            ) : null}
          </div>
        ) : (
          <p className="px-4 py-3 text-sm text-subtle">
            The curator has not run in this space yet. It runs nightly when there are open flags, new traces or changed sources, and whenever enough flags pile up on
            one concept.
          </p>
        )}
      </Card>

      <Callout tone="neutral" icon={<Info />} title="What good looks like">
        Few stale concepts, a rising human-reviewed share, flags that turn into applied proposals within days, and few never-used concepts (deprecate those, or
        improve their titles and descriptions so agents find them).
      </Callout>
    </div>
  );
}
