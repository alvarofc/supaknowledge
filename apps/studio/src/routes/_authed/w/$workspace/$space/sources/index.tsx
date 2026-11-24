import { createFileRoute } from "@tanstack/react-router";
import { ChevronRight, Lock, Plug } from "lucide-react";
import { AudienceBadge, StatusDot } from "@/components/kf/badges";
import { AddSourceButton } from "@/components/sources/add-source";
import { CONNECTORS, ConnectorIcon, configSummary, connectorDef, intervalLabel } from "@/components/sources/connectors";
import { DocumentSearch } from "@/components/sources/document-search";
import { Badge } from "@/components/ui/badge";
import { Callout, Card, EmptyState, PageHeader } from "@/components/ui/card";
import { Link } from "@/components/ui/link";
import { pluralize } from "@/lib/format";
import { title } from "@/lib/meta";
import { atLeast } from "@/lib/roles";
import { useSpace } from "@/lib/use-space";
import { loadSources } from "@/server/sources.functions";
import { Timestamp } from "@/components/kf/timestamp";

export const Route = createFileRoute("/_authed/w/$workspace/$space/sources/")({
  loader: ({ params }) => loadSources({ data: { workspace: params.workspace, space: params.space } }),
  head: () => ({ meta: [title("Sources")] }),
  component: SourcesPage,
});

function SourcesPage() {
  const ctx = useSpace();
  const { sources: list, docCount } = Route.useLoaderData();

  if (!atLeast(ctx.role, "editor")) {
    return (
      <>
        <PageHeader title="Sources" />
        <EmptyState framed icon={<Lock />} title="Sources are visible to editors and up">
          Raw documents from Notion, Slack, GitHub and Drive can carry sensitive material, so readers (including agents) only see the knowledge the
          curator distilled from them. Ask a space admin for the editor role if you need to review evidence.
        </EmptyState>
      </>
    );
  }

  const isAdmin = atLeast(ctx.role, "admin");
  const errored = list.filter((s) => s.status === "error" || s.last_error);

  return (
    <>
      <PageHeader
        title="Sources"
        description="Where the curator learns from. Connectors sync raw documents into this space; the curator reads what changed and proposes knowledge, citing the documents it used."
        actions={isAdmin ? <AddSourceButton spaceId={ctx.space.id} base={ctx.base} groups={ctx.groups} myGroupIds={ctx.myGroupIds} /> : null}
      />

      {errored.length > 0 ? (
        <Callout tone="danger" title={`${pluralize(errored.length, "source")} failed to sync`} className="mb-4">
          Open a source to see its last error. Usually it is an expired token or a page the integration can no longer access.
        </Callout>
      ) : null}

      {list.length === 0 ? (
        <EmptyState
          framed
          icon={<Plug />}
          title="No sources yet"
          actions={
            isAdmin ? <AddSourceButton variant="secondary" spaceId={ctx.space.id} base={ctx.base} groups={ctx.groups} myGroupIds={ctx.myGroupIds} /> : null
          }
        >
          <p>
            Connect the places where your team&apos;s knowledge already lives — {CONNECTORS.filter((c) => c.kind !== "upload").map((c) => c.label).join(", ")} —
            or upload documents by hand. Agents never read these documents directly: the curator turns them into reviewed, cited knowledge.
          </p>
          {!isAdmin ? <p className="mt-2">Only space admins can connect sources.</p> : null}
        </EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {list.map((s) => {
              const def = connectorDef(s.connector);
              const tone = s.status === "error" || s.last_error ? "danger" : s.status === "paused" ? "neutral" : "ok";
              return (
                <li key={s.id}>
                  <Link href={`${ctx.base}/sources/${s.id}`} className="flex items-center gap-4 px-4 py-3 hover:bg-surface-2/60">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-line bg-surface-2 text-muted">
                      <ConnectorIcon kind={s.connector} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-fg">{s.name}</span>
                        <Badge>{def.label}</Badge>
                        <AudienceBadge audience={s.audience} groups={ctx.groups} />
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-subtle">
                        <span className="inline-flex items-center gap-1.5">
                          <StatusDot tone={tone} />
                          {s.status === "error" || s.last_error ? "Error" : s.status === "paused" ? "Paused" : "Active"}
                        </span>
                        <span>{configSummary(s.connector, s.config)}</span>
                        <span>{pluralize(docCount[s.id] ?? 0, "document")}</span>
                        {s.connector !== "upload" ? (
                          <span>
                            {s.last_synced_at ? (
                              <>
                                Synced <Timestamp iso={s.last_synced_at} />
                              </>
                            ) : (
                              "Never synced"
                            )}{" "}
                            · {intervalLabel(s.sync_interval).toLowerCase()}
                          </span>
                        ) : null}
                      </span>
                      {s.last_error ? <span className="mt-1 block truncate text-xs text-danger">{s.last_error}</span> : null}
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-subtle" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {list.length > 0 ? (
        <section className="mt-8">
          <h2 className="mb-1 text-sm font-medium">Search all documents</h2>
          <p className="mb-3 text-xs text-subtle">Full-text search across every document you can see in this space.</p>
          <DocumentSearch spaceId={ctx.space.id} base={ctx.base} />
        </section>
      ) : null}
    </>
  );
}
