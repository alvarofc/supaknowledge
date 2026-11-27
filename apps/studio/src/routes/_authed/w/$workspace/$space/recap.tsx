import { createFileRoute, useRouter } from "@tanstack/react-router";
import { CalendarRange, ChevronLeft, ChevronRight } from "lucide-react";
import { RecapShareActions } from "@/components/recap/share-actions";
import { conceptHref } from "@/components/knowledge/paths";
import { LinkButton } from "@/components/ui/button";
import { Callout, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { Select } from "@/components/ui/form";
import { Link } from "@/components/ui/link";
import { title } from "@/lib/meta";
import { currentMonth, isEmptyRecap, monthLabel, recapKpis, recentMonths, shiftMonth } from "@/lib/recap";
import type { Kpi } from "@/lib/recap";
import { useSpace } from "@/lib/use-space";
import { loadRecap } from "@/server/recap.functions";

export const Route = createFileRoute("/_authed/w/$workspace/$space/recap")({
  validateSearch: (search: Record<string, unknown>): { month?: string; scope?: "workspace" } => ({
    month: typeof search.month === "string" ? search.month : undefined,
    scope: search.scope === "workspace" ? "workspace" : undefined,
  }),
  loaderDeps: ({ search }) => ({ month: search.month, scope: search.scope }),
  loader: ({ params, deps }) => loadRecap({ data: { workspace: params.workspace, space: params.space, month: deps.month, scope: deps.scope } }),
  head: () => ({ meta: [title("Recap")] }),
  component: RecapPage,
});

function RecapPage() {
  const ctx = useSpace();
  const router = useRouter();
  const { month, scope, recap, error } = Route.useLoaderData();
  const latest = currentMonth();
  const scopeName = scope === "workspace" ? ctx.workspace.name : ctx.space.name;

  const href = (next: { month?: string; scope?: "space" | "workspace" }) => {
    const u = new URLSearchParams();
    const m = next.month ?? month;
    const s = next.scope ?? scope;
    if (m !== latest) u.set("month", m);
    if (s === "workspace") u.set("scope", "workspace");
    const q = u.toString();
    return `${ctx.base}/recap${q ? `?${q}` : ""}`;
  };

  const months = recentMonths(latest, 24);
  if (!months.includes(month)) months.push(month);
  const prev = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);

  const header = (
    <PageHeader
      title="Knowledge recap"
      description="Calendar months in UTC. Only knowledge and flags you can see are counted."
      actions={
        <>
          <div role="group" aria-label="Scope" className="inline-flex rounded-md border border-line bg-surface-2 p-0.5">
            {(["space", "workspace"] as const).map((s) => (
              <Link
                key={s}
                href={href({ scope: s })}
                aria-current={s === scope ? "true" : undefined}
                className={cn(
                  "rounded-[5px] border px-2.5 py-0.5 text-xs transition-colors",
                  s === scope ? "border-line-strong bg-button text-fg shadow-xs" : "border-transparent text-subtle hover:text-fg",
                )}
              >
                {s === "space" ? "This space" : "Workspace"}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <LinkButton href={href({ month: prev })} size="sm" aria-label={`Previous month, ${monthLabel(prev)}`} className="px-1.5">
              <ChevronLeft />
            </LinkButton>
            <label htmlFor="recap-month" className="sr-only">
              Month
            </label>
            <Select
              id="recap-month"
              value={month}
              onChange={(e) => void router.navigate({ href: href({ month: e.target.value }) })}
              className="h-[26px] w-40 py-0 text-xs"
            >
              {months.map((m) => (
                <option key={m} value={m}>
                  {monthLabel(m)}
                </option>
              ))}
            </Select>
            {month < latest ? (
              <LinkButton href={href({ month: next })} size="sm" aria-label={`Next month, ${monthLabel(next)}`} className="px-1.5">
                <ChevronRight />
              </LinkButton>
            ) : (
              <span aria-hidden="true" className="w-[26px]" />
            )}
          </div>
        </>
      }
    />
  );

  if (error || !recap) {
    return (
      <div>
        {header}
        <Callout tone="danger" title="Could not compute the recap">
          {error ?? "No data returned."} Reload the page to try again.
        </Callout>
      </div>
    );
  }

  if (isEmptyRecap(recap)) {
    return (
      <div>
        {header}
        <EmptyState
          framed
          icon={<CalendarRange />}
          title={`Nothing to recap for ${monthLabel(month)}`}
          actions={
            <LinkButton size="sm" href={href({ month: prev })}>
              Show {monthLabel(prev)}
            </LinkButton>
          }
        >
          No concept you can see was added or changed, no flag was raised or fixed and nothing went stale in{" "}
          {scope === "workspace" ? "this workspace" : "this space"} that month.
        </EmptyState>
      </div>
    );
  }

  const wsSlug = ctx.workspace.slug;
  const kpiHref = (k: Kpi) => (k.concept ? conceptHref(`/w/${wsSlug}/${k.concept.space_slug}`, k.concept.path) : null);

  return (
    <div>
      {header}
      <Card>
        <CardHeader
          title={`${scopeName}, ${monthLabel(month)}`}
          description={scope === "workspace" ? `Across ${recap.spaces} space${recap.spaces === 1 ? "" : "s"} you can read` : undefined}
          actions={<RecapShareActions recap={recap} scopeName={scopeName} />}
        />
        <dl className="grid grid-cols-1 overflow-hidden rounded-b-md sm:grid-cols-2 lg:grid-cols-3">
          {recapKpis(recap).map((k) => {
            const link = kpiHref(k);
            return (
              <div key={k.key} className="-mt-px -ml-px min-w-0 border-t border-l border-line px-4 py-4">
                <dt className="mono-label text-subtle">{k.label}</dt>
                <dd className={cn("mt-1.5 truncate tabular-nums tracking-tight", /^\d/.test(k.value) ? "text-2xl" : "text-lg", k.empty ? "text-subtle" : "text-fg")}>
                  {link ? (
                    <Link href={link} className="hover:text-accent">
                      {k.value}
                    </Link>
                  ) : (
                    k.value
                  )}
                </dd>
                {k.context ? <dd className="mt-0.5 truncate text-xs text-subtle">{k.context}</dd> : null}
              </div>
            );
          })}
        </dl>
      </Card>
    </div>
  );
}
