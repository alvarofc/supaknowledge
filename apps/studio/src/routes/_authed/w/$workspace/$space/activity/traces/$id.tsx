import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, BookOpen, MessagesSquare } from "lucide-react";
import { JsonDetails } from "@/components/activity/json-view";
import { OutcomeBadge, duration } from "@/components/activity/outcome-badge";
import { Transcript } from "@/components/activity/transcript";
import { FlagItem, conceptHref } from "@/components/inbox/flag-list";
import { AgentBadge, AudienceBadge, KindIcon } from "@/components/kf/badges";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, EmptyState } from "@/components/ui/card";
import { Link } from "@/components/ui/link";
import { shortId } from "@/lib/format";
import { title } from "@/lib/meta";
import { atLeast } from "@/lib/roles";
import { useSpace } from "@/lib/use-space";
import { loadTrace } from "@/server/activity.functions";
import { Timestamp } from "@/components/kf/timestamp";

export const Route = createFileRoute("/_authed/w/$workspace/$space/activity/traces/$id")({
  loader: ({ params }) => loadTrace({ data: { workspace: params.workspace, space: params.space, id: params.id } }),
  head: () => ({ meta: [title("Trace")] }),
  component: TracePage,
});

function TracePage() {
  const ctx = useSpace();
  const { trace, events, flags, usage, conceptIds, concepts, profiles } = Route.useLoaderData();
  const conceptById = new Map(concepts.map((c) => [c.id, c]));
  const sender = trace.principal_id ? profiles[trace.principal_id] : undefined;
  const d = duration(trace.started_at, trace.ended_at);
  const corrections = events.filter((e) => e.role === "feedback").length;
  const errors = events.filter((e) => e.is_error).length;

  return (
    <>
      <Link href={`${ctx.base}/activity?tab=traces`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> Traces
      </Link>
      <div className="mb-6">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <OutcomeBadge outcome={trace.outcome} />
          {trace.curated_at ? <Badge tone="accent">
              Curated <Timestamp iso={trace.curated_at} />
            </Badge> : <Badge>Not curated yet</Badge>}
          <AudienceBadge audience={trace.audience} groups={ctx.groups} />
        </div>
        <h1 className="text-xl font-normal tracking-tight sm:text-2xl">{trace.name ?? `Trace ${shortId(trace.id)}`}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-sm text-muted">
          Sent by {sender?.display_name ?? "an unknown sender"} {sender?.kind === "agent" ? <AgentBadge /> : null}
          {trace.on_behalf_of ? <> for {profiles[trace.on_behalf_of]?.display_name ?? "a user"}</> : null} ·{" "}
          <Timestamp iso={trace.started_at} format="date" />
          {d ? ` · ${d}` : ""}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section aria-labelledby="transcript-h" className="min-w-0">
          <h2 id="transcript-h" className="mb-3 text-sm font-medium">
            Transcript <span className="font-normal text-subtle">({events.length} events)</span>
          </h2>
          {events.length ? (
            <Transcript events={events} knowledgeBase={`${ctx.base}/knowledge`} />
          ) : (
            <EmptyState framed icon={<MessagesSquare />} title="No events recorded">
              The trace exists but its events have not been sent, or were cleaned up.
            </EmptyState>
          )}
        </section>

        <aside className="flex flex-col gap-4">
          <Card className="px-4 py-4 text-sm">
            <h2 className="mb-2 text-sm font-medium">Summary</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
              <dt className="text-subtle">Corrections</dt>
              <dd className={corrections ? "font-medium text-warn" : "text-muted"}>{corrections}</dd>
              <dt className="text-subtle">Tool errors</dt>
              <dd className={errors ? "font-medium text-danger" : "text-muted"}>{errors}</dd>
              <dt className="text-subtle">Knowledge used</dt>
              <dd className="text-muted">{conceptIds.length} concepts</dd>
              {trace.external_id ? (
                <>
                  <dt className="text-subtle">External id</dt>
                  <dd className="truncate font-mono text-muted" title={trace.external_id}>
                    {trace.external_id}
                  </dd>
                </>
              ) : null}
            </dl>
            <JsonDetails className="mt-3" label="Metadata" value={trace.metadata} />
          </Card>

          <Card>
            <CardHeader title="Knowledge used" description="What the agent searched, read or loaded during this work" />
            {usage.length ? (
              <ul className="divide-y divide-line">
                {usage.map((u) => {
                  const c = conceptById.get(u.concept_id);
                  return (
                    <li key={u.id} className="px-4 py-2 text-xs">
                      <div className="flex items-center gap-1.5">
                        {c ? <KindIcon kind={c.kind} className="size-3.5" /> : <BookOpen className="size-3.5 text-subtle" />}
                        {c ? (
                          <Link href={conceptHref(ctx.base, c.path)} className="truncate text-accent hover:underline" title={c.path}>
                            {c.title}
                          </Link>
                        ) : (
                          <span className="text-subtle">A concept you cannot see</span>
                        )}
                        <span className="ml-auto text-subtle">
                          {u.via} · r{u.revision}
                        </span>
                      </div>
                      {u.query ? <p className="mt-0.5 truncate text-subtle">“{u.query}”</p> : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-4 py-3 text-xs text-subtle">No knowledge was retrieved in this trace.</p>
            )}
          </Card>
        </aside>
      </div>

      <section aria-labelledby="flags-h" className="mt-6">
        <h2 id="flags-h" className="mb-3 text-sm font-medium">
          Flags from this trace <span className="font-normal text-subtle">({flags.length})</span>
        </h2>
        {flags.length ? (
          <Card>
            <ul className="divide-y divide-line">
              {flags.map((f) => (
                <FlagItem key={f.id} flag={f} base={ctx.base} profiles={profiles} groups={ctx.groups} canDismiss={atLeast(ctx.role, "reviewer")} inTrace />
              ))}
            </ul>
          </Card>
        ) : (
          <p className="text-sm text-subtle">
            No flags were raised from this trace{trace.curated_at ? "." : " yet. The curator mines corrections into flags when it processes traces."}
          </p>
        )}
      </section>
    </>
  );
}
