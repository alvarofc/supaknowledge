import { createFileRoute } from "@tanstack/react-router";
import { BookOpen, Plus, Search, SearchX } from "lucide-react";
import { KIND_HELP, KIND_LABEL, KindIcon, StaleBadge, TrustBadge } from "@/components/kf/badges";
import { LiveRefresh } from "@/components/kf/live-refresh";
import { conceptHref } from "@/components/knowledge/paths";
import { KnowledgeTree } from "@/components/knowledge/tree";
import { LinkButton } from "@/components/ui/button";
import { Card, EmptyState, PageHeader } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { controlClass } from "@/components/ui/form";
import { Link } from "@/components/ui/link";
import type { Database } from "@/lib/database.types";
import { pluralize } from "@/lib/format";
import { title } from "@/lib/meta";
import { atLeast } from "@/lib/roles";
import { useSpace } from "@/lib/use-space";
import { loadKnowledge } from "@/server/knowledge.functions";

type Kind = Database["public"]["Enums"]["concept_kind"];
const KINDS: Kind[] = ["skill", "domain", "data_access"];

export const Route = createFileRoute("/_authed/w/$workspace/$space/knowledge/")({
  validateSearch: (search: Record<string, unknown>): { q?: string; kind?: string } => ({
    q: typeof search.q === "string" || typeof search.q === "number" ? String(search.q) : undefined,
    kind: typeof search.kind === "string" ? search.kind : undefined,
  }),
  loaderDeps: ({ search }) => ({ q: search.q, kind: search.kind }),
  loader: ({ params, deps }) => loadKnowledge({ data: { workspace: params.workspace, space: params.space, q: deps.q, kind: deps.kind } }),
  head: () => ({ meta: [title("Knowledge")] }),
  component: KnowledgePage,
});

function KnowledgePage() {
  const ctx = useSpace();
  const { q, kind, all, error, results, counts, total } = Route.useLoaderData();
  const canEdit = atLeast(ctx.role, "editor");

  const href = (next: { q?: string | null; kind?: Kind | null }) => {
    const u = new URLSearchParams();
    const nq = next.q === undefined ? q : next.q;
    const nk = next.kind === undefined ? kind : next.kind;
    if (nq) u.set("q", nq);
    if (nk) u.set("kind", nk);
    const s = u.toString();
    return `${ctx.base}/knowledge${s ? `?${s}` : ""}`;
  };

  return (
    <div>
      <PageHeader
        title="Knowledge"
        description="Everything your agents can search and read in this space: skills, domain knowledge and data access notes, with their trust tier and freshness."
        actions={
          <>
            <LiveRefresh spaceId={ctx.space.id} tables={["concepts"]} />
            {canEdit ? (
              <LinkButton href={`${ctx.base}/suggest`} variant="primary">
                <Plus className="size-4" /> New concept
              </LinkButton>
            ) : null}
          </>
        }
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <form action={`${ctx.base}/knowledge`} method="get" role="search" className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-subtle" aria-hidden="true" />
          <label htmlFor="kq" className="sr-only">
            Search knowledge
          </label>
          <input
            // remount on client navigation so the box shows the current query (defaultValue is read only once)
            key={`${kind ?? ""}:${q}`}
            id="kq"
            name="q"
            defaultValue={q}
            placeholder="Search titles, descriptions and bodies…"
            className={cn(controlClass, "h-8 w-full pl-9")}
          />
          {kind ? <input type="hidden" name="kind" value={kind} /> : null}
        </form>
        <div className="flex flex-wrap gap-1.5" aria-label="Filter by kind">
          <Link
            href={href({ kind: null })}
            aria-current={!kind ? "true" : undefined}
            className={cn(
              "inline-flex h-[26px] items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors",
              !kind ? "border-line-strong bg-surface-3/70 text-fg" : "border-line-strong bg-button text-muted shadow-xs hover:text-fg",
            )}
          >
            All <span className="font-mono text-[11px] tabular-nums text-subtle">{total}</span>
          </Link>
          {KINDS.map((k) => (
            <Link
              key={k}
              href={href({ kind: kind === k ? null : k })}
              aria-current={kind === k ? "true" : undefined}
              title={KIND_HELP[k]}
              className={cn(
                "inline-flex h-[26px] items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors",
                kind === k ? "border-line-strong bg-surface-3/70 text-fg" : "border-line-strong bg-button text-muted shadow-xs hover:text-fg",
              )}
            >
              <KindIcon kind={k} className="size-3.5" />
              {KIND_LABEL[k]} <span className="font-mono text-[11px] tabular-nums text-subtle">{counts[k]}</span>
            </Link>
          ))}
        </div>
      </div>

      {error ? (
        <Card className="p-4 text-sm text-danger">Could not load knowledge: {error}</Card>
      ) : q ? (
        <Card>
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5 text-sm">
            <span className="text-muted">
              {results?.error ? "Search failed" : pluralize(results?.data?.length ?? 0, "result")} for <span className="font-medium text-fg">“{q}”</span>
            </span>
            <Link href={href({ q: null })} className="text-xs text-subtle hover:text-fg">
              Clear search
            </Link>
          </div>
          {results?.error ? (
            <p className="p-4 text-sm text-danger">{results.error}</p>
          ) : !results?.data?.length ? (
            <EmptyState icon={<SearchX />} title="No matching knowledge">
              Search uses full-text matching here (agents also get semantic search through MCP). Try fewer or different words.
              {canEdit ? " If this knowledge should exist, suggest it as a new concept." : " If it should exist, flag it from an agent or ask an editor."}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {results.data.map((r) => (
                <li key={r.concept_id}>
                  <Link href={conceptHref(ctx.base, r.path)} className="block px-4 py-3 hover:bg-surface-2/60">
                    <div className="flex flex-wrap items-center gap-2">
                      <KindIcon kind={r.kind} />
                      <span className="text-sm font-medium text-fg">{r.title}</span>
                      <span className="font-mono text-xs text-subtle">{r.path}</span>
                      <span className="ml-auto flex items-center gap-1.5">
                        {r.stale ? <StaleBadge /> : null}
                        <TrustBadge trust={r.trust} />
                      </span>
                    </div>
                    {r.snippet ? <p className="mt-1 line-clamp-2 text-sm text-muted">{r.snippet}</p> : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : all.length === 0 ? (
        <Card>
          {kind && total > 0 ? (
            <EmptyState icon={<BookOpen />} title={`No ${KIND_LABEL[kind].toLowerCase()} knowledge yet`} actions={<LinkButton href={href({ kind: null })}>Show all kinds</LinkButton>}>
              {KIND_HELP[kind]}.
            </EmptyState>
          ) : (
            <EmptyState
              icon={<BookOpen />}
              title="This space has no knowledge yet"
              actions={
                canEdit ? (
                  <LinkButton href={`${ctx.base}/suggest`} size="sm">
                    <Plus /> Write the first concept
                  </LinkButton>
                ) : null
              }
            >
              <p>Knowledge comes in three kinds, all stored as concepts:</p>
              <ul className="mt-3 space-y-2 text-left">
                {KINDS.map((k) => (
                  <li key={k} className="flex items-start gap-2">
                    <KindIcon kind={k} className="mt-0.5" />
                    <span>
                      <span className="font-medium text-fg">{KIND_LABEL[k]}</span> — {KIND_HELP[k]}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3">
                It arrives through reviewed proposals: the curator drafts them from agent flags, traces and connected sources; you can import an
                existing OKF bundle or Agent Skills directory with the CLI (<code className="font-mono text-xs">kf import</code>); or you can suggest a
                concept yourself.
              </p>
            </EmptyState>
          )}
        </Card>
      ) : (
        <Card className="p-2">
          <KnowledgeTree concepts={all} base={ctx.base} />
        </Card>
      )}
      {!q && all.length > 0 ? (
        <p className="mt-3 text-xs text-subtle">
          {pluralize(all.length, "concept")} you can see. Restricted concepts (lock icon) are only visible to their audience groups.
        </p>
      ) : null}
    </div>
  );
}
