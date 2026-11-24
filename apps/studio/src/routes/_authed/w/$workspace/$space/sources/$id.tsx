import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, FileText } from "lucide-react";
import { AudienceBadge, StatusDot } from "@/components/kf/badges";
import { ConnectorIcon, SOURCE_PAGE_SIZE, configSummary, connectorDef, intervalLabel } from "@/components/sources/connectors";
import { DocumentSearch } from "@/components/sources/document-search";
import { SourceActions } from "@/components/sources/source-actions";
import { UploadForm } from "@/components/sources/upload-form";
import { Badge } from "@/components/ui/badge";
import { Callout, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui/card";
import { Link } from "@/components/ui/link";
import { actorLabel, formatDate, timeAgo } from "@/lib/format";
import { title } from "@/lib/meta";
import { atLeast } from "@/lib/roles";
import { useSpace } from "@/lib/use-space";
import { loadSource } from "@/server/sources.functions";

export const Route = createFileRoute("/_authed/w/$workspace/$space/sources/$id")({
  // numbers stay numbers so the router keeps the URL as ?page=2&deleted=1
  validateSearch: (search: Record<string, unknown>): { page?: number; deleted?: number } => ({
    page: search.page === undefined ? undefined : Math.max(0, Number(search.page) || 0),
    deleted: Number(search.deleted) === 1 ? 1 : undefined,
  }),
  loaderDeps: ({ search }) => ({ page: search.page ?? 0, showDeleted: search.deleted === 1 }),
  loader: ({ params, deps }) =>
    loadSource({ data: { workspace: params.workspace, space: params.space, id: params.id, page: deps.page, showDeleted: deps.showDeleted } }),
  head: ({ loaderData }) => ({ meta: [title(loaderData?.source.name ?? "Source")] }),
  component: SourcePage,
});

function SourcePage() {
  const ctx = useSpace();
  const { source, docs, total, page, profiles } = Route.useLoaderData();
  const showDeleted = Route.useSearch().deleted === 1;
  const def = connectorDef(source.connector);
  const isAdmin = atLeast(ctx.role, "admin");
  const pageHref = (p: number) => `${ctx.base}/sources/${source.id}?page=${p}${showDeleted ? "&deleted=1" : ""}`;
  const configJson = JSON.stringify(source.config, null, 2);

  return (
    <>
      <Link href={`${ctx.base}/sources`} className="mb-3 inline-flex items-center gap-1 text-xs text-subtle hover:text-fg">
        <ArrowLeft className="size-3.5" /> Sources
      </Link>
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-1.5">
            <ConnectorIcon kind={source.connector} className="size-3.5" /> {def.label}
          </span>
        }
        title={source.name}
        description={def.description}
        actions={isAdmin ? <SourceActions source={source} base={ctx.base} groups={ctx.groups} myGroupIds={ctx.myGroupIds} /> : null}
      />

      {source.last_error ? (
        <Callout tone="danger" title="Last sync failed" className="mb-4">
          <span className="font-mono text-xs break-words">{source.last_error}</span>
          {def.token && isAdmin ? <span className="mt-1 block">If the token expired or lost access, set a new one and sync again.</span> : null}
        </Callout>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title="Details" />
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 px-4 py-3 text-sm">
            <dt className="text-subtle">Status</dt>
            <dd className="flex items-center gap-1.5">
              <StatusDot tone={source.status === "error" || source.last_error ? "danger" : source.status === "paused" ? "neutral" : "ok"} />
              {source.status === "error" ? "Error" : source.status === "paused" ? "Paused" : "Active"}
            </dd>
            {source.connector !== "upload" ? (
              <>
                <dt className="text-subtle">Schedule</dt>
                <dd>{intervalLabel(source.sync_interval)}</dd>
                <dt className="text-subtle">Last sync</dt>
                <dd title={formatDate(source.last_synced_at)}>{source.last_synced_at ? timeAgo(source.last_synced_at) : "Never"}</dd>
              </>
            ) : null}
            <dt className="text-subtle">Scope</dt>
            <dd>{configSummary(source.connector, source.config)}</dd>
            <dt className="text-subtle">Audience</dt>
            <dd>{source.audience.length ? <AudienceBadge audience={source.audience} groups={ctx.groups} /> : "Everyone in the space"}</dd>
            {def.token ? (
              <>
                <dt className="text-subtle">Token</dt>
                <dd className="text-muted">Write-only (Vault)</dd>
              </>
            ) : null}
            <dt className="text-subtle">Added</dt>
            <dd>
              {timeAgo(source.created_at)}
              {source.created_by ? ` by ${actorLabel(`human:${source.created_by}`, profiles)}` : ""}
            </dd>
          </dl>
          {def.fields.length ? (
            <details className="border-t border-line px-4 py-3">
              <summary className="cursor-pointer text-xs font-medium text-subtle">Raw config</summary>
              <pre className="mt-2 overflow-x-auto rounded bg-surface-2 p-2 font-mono text-xs">{configJson}</pre>
            </details>
          ) : null}
        </Card>

        <div className="flex flex-col gap-4 lg:col-span-2">
          {source.connector === "upload" && isAdmin ? (
            <Card>
              <CardHeader title="Upload a document" description="Uploaded documents are treated like synced ones: chunked, embedded and read by the next curator run." />
              <div className="px-4 py-4">
                <UploadForm sourceId={source.id} />
              </div>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title={`Documents (${total})`}
              description="Raw evidence, visible to editors and up who are in each document's audience."
              actions={
                <Link
                  href={`${ctx.base}/sources/${source.id}${showDeleted ? "" : "?deleted=1"}`}
                  className="text-xs text-subtle underline-offset-2 hover:text-fg hover:underline"
                >
                  {showDeleted ? "Hide deleted" : "Show deleted"}
                </Link>
              }
            />
            <div className="border-b border-line px-4 py-3">
              <DocumentSearch spaceId={ctx.space.id} sourceId={source.id} base={ctx.base} />
            </div>
            {!docs?.length ? (
              <EmptyState icon={<FileText />} title="No documents yet">
                {source.connector === "upload"
                  ? "Upload a document above. It becomes evidence the curator can cite."
                  : source.last_synced_at
                    ? "The last sync found nothing in scope. Check the configuration and that the integration can access it."
                    : "Documents appear after the first sync. Use “Sync now” to start one."}
              </EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line bg-surface-2 text-left text-subtle">
                      <th className="px-4 py-1.5 mono-label">Document</th>
                      <th className="hidden px-4 py-1.5 mono-label sm:table-cell">Type</th>
                      <th className="px-4 py-1.5 mono-label">Changed</th>
                      <th className="hidden px-4 py-1.5 mono-label md:table-cell">Synced</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {docs.map((d) => (
                      <tr key={d.id} className={d.deleted_at ? "opacity-60" : undefined}>
                        <td className="max-w-0 px-4 py-2">
                          <div className="flex items-center gap-2">
                            <Link href={`${ctx.base}/sources/documents/${d.id}`} className="truncate font-medium text-fg hover:text-accent">
                              {d.title || d.external_id}
                            </Link>
                            {d.url ? (
                              <a href={d.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-subtle hover:text-fg" aria-label="Open original">
                                <ExternalLink className="size-3.5" />
                              </a>
                            ) : null}
                            {d.deleted_at ? <Badge tone="neutral">Deleted upstream</Badge> : null}
                            <AudienceBadge audience={d.audience} groups={ctx.groups} />
                          </div>
                          <div className="truncate font-mono text-[11px] text-subtle">{d.external_id}</div>
                        </td>
                        <td className="hidden px-4 py-2 text-xs text-muted sm:table-cell">{d.mime_type ?? "—"}</td>
                        <td className="px-4 py-2 text-xs whitespace-nowrap text-muted" title={formatDate(d.changed_at)}>
                          {timeAgo(d.changed_at)}
                        </td>
                        <td className="hidden px-4 py-2 text-xs whitespace-nowrap text-muted md:table-cell" title={formatDate(d.synced_at)}>
                          {timeAgo(d.synced_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {total > SOURCE_PAGE_SIZE ? (
              <nav className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-subtle" aria-label="Pagination">
                <span>
                  {page * SOURCE_PAGE_SIZE + 1}–{Math.min(total, page * SOURCE_PAGE_SIZE + SOURCE_PAGE_SIZE)} of {total}
                </span>
                <span className="flex gap-3">
                  {page > 0 ? <Link href={pageHref(page - 1)} className="hover:text-fg">Previous</Link> : null}
                  {(page + 1) * SOURCE_PAGE_SIZE < total ? <Link href={pageHref(page + 1)} className="hover:text-fg">Next</Link> : null}
                </span>
              </nav>
            ) : null}
          </Card>
        </div>
      </div>
    </>
  );
}
