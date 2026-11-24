import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { AudienceBadge } from "@/components/kf/badges";
import { Markdown } from "@/components/kf/markdown";
import { ConnectorIcon } from "@/components/sources/connectors";
import { Badge } from "@/components/ui/badge";
import { Callout, Card, CardHeader, PageHeader } from "@/components/ui/card";
import { Link } from "@/components/ui/link";

import { title } from "@/lib/meta";
import { useSpace } from "@/lib/use-space";
import { loadSourceDocument } from "@/server/sources.functions";
import { safeHref } from "@/lib/safe-href";
import { Timestamp } from "@/components/kf/timestamp";

export const Route = createFileRoute("/_authed/w/$workspace/$space/sources/documents/$id")({
  validateSearch: (search: Record<string, unknown>): { view?: string } => ({
    view: typeof search.view === "string" ? search.view : undefined,
  }),
  loader: ({ params }) => loadSourceDocument({ data: { workspace: params.workspace, space: params.space, id: params.id } }),
  head: ({ loaderData }) => ({ meta: [title(loaderData ? loaderData.doc.title || loaderData.doc.external_id : "Document")] }),
  component: DocumentPage,
});

function isMarkdown(mime: string | null, content: string) {
  if (mime && /markdown|md/.test(mime)) return true;
  if (mime && /html|plain/.test(mime) && !/^#{1,6} /m.test(content)) return false;
  return /^#{1,6} |\n- |\n\* |\[[^\]]+\]\(/m.test(content);
}

function DocumentPage() {
  const ctx = useSpace();
  const { view } = Route.useSearch();
  const { doc, source } = Route.useLoaderData();

  const asMarkdown = view ? view === "rendered" : isMarkdown(doc.mime_type, doc.content);
  const meta = doc.metadata && typeof doc.metadata === "object" && !Array.isArray(doc.metadata) ? Object.entries(doc.metadata) : [];
  const toggleHref = `${ctx.base}/sources/documents/${doc.id}?view=${asMarkdown ? "raw" : "rendered"}`;

  return (
    <>
      <Link href={source ? `${ctx.base}/sources/${source.id}` : `${ctx.base}/sources`} className="mb-3 inline-flex items-center gap-1 text-xs text-subtle hover:text-fg">
        <ArrowLeft className="size-3.5" /> {source ? source.name : "Sources"}
      </Link>
      <PageHeader
        eyebrow={
          source ? (
            <span className="inline-flex items-center gap-1.5">
              <ConnectorIcon kind={source.connector} className="size-3.5" /> Source document
            </span>
          ) : (
            "Source document"
          )
        }
        title={doc.title || doc.external_id}
        actions={
          safeHref(doc.url) ? (
            <a href={safeHref(doc.url)!} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
              Open original <ExternalLink className="size-3.5" />
            </a>
          ) : null
        }
      />
      {doc.deleted_at ? (
        <Callout tone="warn" title="Deleted upstream" className="mb-4">
          This document was removed from {source?.name ?? "its source"} <Timestamp iso={doc.deleted_at} />. Knowledge that cites it may need a review.
        </Callout>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <Card className="min-w-0">
          <CardHeader
            title="Content"
            description="Extracted text the curator reads and cites."
            actions={
              <Link href={toggleHref} className="text-xs text-subtle hover:text-fg">
                {asMarkdown ? "View raw text" : "Render as Markdown"}
              </Link>
            }
          />
          <div className="px-5 py-4">
            {!doc.content.trim() ? (
              <p className="text-sm text-muted">No text was extracted from this document.</p>
            ) : asMarkdown ? (
              <Markdown>{doc.content}</Markdown>
            ) : (
              <pre className="font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-fg">{doc.content}</pre>
            )}
          </div>
        </Card>
        <Card className="h-fit">
          <CardHeader title="About" />
          <dl className="flex flex-col gap-2.5 px-4 py-3 text-sm">
            {source ? (
              <div>
                <dt className="mono-label text-subtle">Source</dt>
                <dd>
                  <Link href={`${ctx.base}/sources/${source.id}`} className="text-accent hover:underline">
                    {source.name}
                  </Link>
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="mono-label text-subtle">Audience</dt>
              <dd>{doc.audience.length ? <AudienceBadge audience={doc.audience} groups={ctx.groups} /> : "Everyone in the space"}</dd>
            </div>
            {doc.author ? (
              <div>
                <dt className="mono-label text-subtle">Author</dt>
                <dd>{doc.author}</dd>
              </div>
            ) : null}
            <div>
              <dt className="mono-label text-subtle">External ID</dt>
              <dd className="font-mono text-xs break-all">{doc.external_id}</dd>
            </div>
            {doc.mime_type ? (
              <div>
                <dt className="mono-label text-subtle">Type</dt>
                <dd>
                  <Badge>{doc.mime_type}</Badge>
                </dd>
              </div>
            ) : null}
            {doc.external_updated_at ? (
              <div>
                <dt className="mono-label text-subtle">Updated upstream</dt>
                <dd>
                  <Timestamp iso={doc.external_updated_at} format="date" />
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="mono-label text-subtle">Content changed</dt>
              <dd>
                <Timestamp iso={doc.changed_at} format="date" />
              </dd>
            </div>
            <div>
              <dt className="mono-label text-subtle">Last synced</dt>
              <dd>
                <Timestamp iso={doc.synced_at} format="date" />
              </dd>
            </div>
            {doc.storage_path ? (
              <div>
                <dt className="mono-label text-subtle">Original file</dt>
                <dd className="font-mono text-xs break-all text-muted">{doc.storage_path}</dd>
              </div>
            ) : null}
          </dl>
          {meta.length ? (
            <details className="border-t border-line px-4 py-3">
              <summary className="cursor-pointer text-xs font-medium text-subtle">Metadata ({meta.length})</summary>
              <pre className="mt-2 overflow-x-auto rounded bg-surface-2 p-2 font-mono text-[11px]">{JSON.stringify(doc.metadata, null, 2)}</pre>
            </details>
          ) : null}
        </Card>
      </div>
    </>
  );
}
