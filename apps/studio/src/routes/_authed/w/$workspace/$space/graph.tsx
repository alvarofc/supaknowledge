import { createFileRoute } from "@tanstack/react-router";
import { Network, SearchX } from "lucide-react";
import { useMemo } from "react";
import type { ReactNode } from "react";
import { KIND_HELP, KIND_LABEL, KindIcon, StaleBadge, TrustBadge } from "@/components/kf/badges";
import { ConceptMark, EvidenceMark, ForceGraph, KIND_COLOR } from "@/components/graph/force-graph";
import { conceptHref } from "@/components/knowledge/paths";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { Callout, Card, EmptyState, PageHeader } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { Link } from "@/components/ui/link";
import { buildGraph, CONCEPT_KINDS, graphSearch, hasConceptFilters, parseGraphFilters } from "@/lib/graph";
import type { GraphFilters, GraphNode } from "@/lib/graph";
import { pluralize } from "@/lib/format";
import { title } from "@/lib/meta";
import { atLeast } from "@/lib/roles";
import { useSpace } from "@/lib/use-space";
import { GRAPH_LIMIT, loadGraph } from "@/server/graph.functions";

type Search = GraphFilters & { view?: "list" };

export const Route = createFileRoute("/_authed/w/$workspace/$space/graph")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    ...parseGraphFilters(search),
    view: search.view === "list" ? "list" : undefined,
  }),
  // filters apply in the browser: changing one does not refetch
  loader: ({ params }) => loadGraph({ data: { workspace: params.workspace, space: params.space } }),
  head: () => ({ meta: [title("Knowledge graph")] }),
  component: GraphPage,
});

const chip = (on: boolean) =>
  cn(
    "inline-flex h-[26px] items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors",
    on ? "border-line-strong bg-surface-3/70 text-fg" : "border-line-strong bg-button text-muted shadow-xs hover:text-fg",
  );

function GraphPage() {
  const ctx = useSpace();
  const { graph, error } = Route.useLoaderData();
  const search = Route.useSearch();
  const { view, ...filters } = search;
  const isEditor = atLeast(ctx.role, "editor");
  const isReviewer = atLeast(ctx.role, "reviewer");

  const built = useMemo(() => (graph ? buildGraph(graph, filters) : { nodes: [], edges: [] }), [graph, filters.kind, filters.flagged, filters.stale, filters.evidence]); // eslint-disable-line react-hooks/exhaustive-deps

  const href = (next: Partial<Search>) => {
    const merged = { ...search, ...next };
    const { view: v, ...f } = merged;
    return `${ctx.base}/graph${graphSearch(f, { view: v })}`;
  };

  const hrefFor = (n: GraphNode): string | null => {
    if (n.type === "concept") return conceptHref(ctx.base, n.path);
    if (n.kind === "source_document") return isEditor ? `${ctx.base}/sources/documents/${n.id}` : null;
    if (n.kind === "trace") return isReviewer ? `${ctx.base}/activity/traces/${n.id}` : null;
    return n.proposal_id ? `${ctx.base}/proposals/${n.proposal_id}` : null;
  };

  const header = (
    <PageHeader
      title="Knowledge graph"
      description={
        isEditor
          ? "Restricted concepts outside your groups are not shown."
          : "Restricted concepts outside your groups are not shown. Citations are visible to editors and up."
      }
    />
  );

  if (error || !graph) {
    return (
      <div>
        {header}
        <Callout tone="danger" title="Could not load the graph">
          {error ?? "No data returned."} Reload the page to try again.
        </Callout>
      </div>
    );
  }

  if (graph.concepts.length === 0) {
    return (
      <div>
        {header}
        <EmptyState framed icon={<Network />} title="No knowledge to draw yet">
          The graph fills in once concepts exist in this space. Approve a proposal in the Inbox, import a bundle with{" "}
          <code className="font-mono text-xs">kf import</code>, or suggest a concept from Knowledge.
        </EmptyState>
      </div>
    );
  }

  const counts = Object.fromEntries(CONCEPT_KINDS.map((k) => [k, graph.concepts.filter((c) => c.kind === k).length]));
  const flaggedCount = graph.concepts.filter((c) => c.open_flags > 0).length;
  const staleCount = graph.concepts.filter((c) => c.stale).length;
  const concepts = built.nodes.filter((n): n is Extract<GraphNode, { type: "concept" }> => n.type === "concept");
  const evidenceCount = built.nodes.length - concepts.length;

  return (
    <div>
      {header}

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by kind">
          <Link href={href({ kind: undefined })} aria-current={!filters.kind ? "true" : undefined} className={chip(!filters.kind)}>
            All kinds <span className="font-mono text-[11px] tabular-nums text-subtle">{graph.concepts.length}</span>
          </Link>
          {CONCEPT_KINDS.map((k) => (
            <Link
              key={k}
              href={href({ kind: filters.kind === k ? undefined : k })}
              aria-current={filters.kind === k ? "true" : undefined}
              title={KIND_HELP[k]}
              className={chip(filters.kind === k)}
            >
              <span aria-hidden="true" className="size-2 rounded-full" style={{ background: KIND_COLOR[k] }} />
              {KIND_LABEL[k]} <span className="font-mono text-[11px] tabular-nums text-subtle">{counts[k]}</span>
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="More filters">
          <Link href={href({ flagged: filters.flagged ? undefined : true })} aria-current={filters.flagged ? "true" : undefined} className={chip(Boolean(filters.flagged))}>
            Only with open flags <span className="font-mono text-[11px] tabular-nums text-subtle">{flaggedCount}</span>
          </Link>
          <Link href={href({ stale: filters.stale ? undefined : true })} aria-current={filters.stale ? "true" : undefined} className={chip(Boolean(filters.stale))}>
            Only stale <span className="font-mono text-[11px] tabular-nums text-subtle">{staleCount}</span>
          </Link>
          {isEditor ? (
            <Link
              href={href({ evidence: filters.evidence === false ? undefined : false })}
              aria-current={filters.evidence !== false ? "true" : undefined}
              className={chip(filters.evidence !== false)}
            >
              Citations
            </Link>
          ) : null}
          <span className="mx-1 hidden w-px self-stretch bg-line md:block" aria-hidden="true" />
          <div role="group" aria-label="View" className="hidden rounded-md border border-line bg-surface-2 p-0.5 md:inline-flex">
            {(["graph", "list"] as const).map((v) => {
              const on = (view ?? "graph") === v;
              return (
                <Link
                  key={v}
                  href={href({ view: v === "list" ? "list" : undefined })}
                  aria-current={on ? "true" : undefined}
                  className={cn(
                    "rounded-[5px] border px-2.5 py-0.5 text-xs capitalize transition-colors",
                    on ? "border-line-strong bg-button text-fg shadow-xs" : "border-transparent text-subtle hover:text-fg",
                  )}
                >
                  {v}
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      {graph.truncated ? (
        <Callout tone="warn" className="mb-4" title={`Showing the first ${GRAPH_LIMIT.toLocaleString("en-US")} concepts by path`}>
          Filter by kind to see the rest of the space.
        </Callout>
      ) : null}

      {concepts.length === 0 ? (
        <Card>
          <EmptyState
            icon={<SearchX />}
            title="No concepts match these filters"
            actions={
              hasConceptFilters(filters) ? (
                <LinkButton size="sm" href={href({ kind: undefined, flagged: undefined, stale: undefined })}>
                  Clear filters
                </LinkButton>
              ) : null
            }
          >
            {filters.flagged ? "No concept you can see has an open flag. " : null}
            {filters.stale ? "No concept you can see is past its re-check date. " : null}
          </EmptyState>
        </Card>
      ) : (
        <>
          {view !== "list" ? (
            <Card className="hidden md:block">
              <ForceGraph nodes={built.nodes} edges={built.edges} hrefFor={hrefFor} className="h-[min(70dvh,720px)] min-h-[420px]" />
              <GraphKey showEvidence={isEditor && filters.evidence !== false && evidenceCount > 0} />
            </Card>
          ) : null}
          <Card className={cn(view !== "list" && "md:hidden")}>
            <ConceptList concepts={concepts} base={ctx.base} />
          </Card>
          <p className="mt-3 text-xs text-subtle">
            {pluralize(concepts.length, "concept")}
            {evidenceCount ? `, ${pluralize(evidenceCount, "cited item")}` : ""} and {pluralize(built.edges.length, "connection")}.
          </p>
        </>
      )}
    </div>
  );
}

function KeyItem({ children, mark }: { children: ReactNode; mark: ReactNode }) {
  return (
    <li className="inline-flex items-center gap-1.5">
      <svg width="22" height="22" viewBox="-11 -11 22 22" aria-hidden="true" className="shrink-0">
        {mark}
      </svg>
      {children}
    </li>
  );
}

/** What the marks mean. Kind colours are on the filter chips above. */
function GraphKey({ showEvidence }: { showEvidence: boolean }) {
  const sample = { id: "", path: "", title: "", kind: "domain", status: "stable", stale_after: null, updated_at: "", type: "concept", degree: 0 } as const;
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2 text-xs text-muted">
      <KeyItem mark={<ConceptMark n={{ ...sample, trust: "human_reviewed", stale: false, open_flags: 0 }} r={5} />}>Verified</KeyItem>
      <KeyItem mark={<ConceptMark n={{ ...sample, trust: "unverified", stale: false, open_flags: 0 }} r={5} />}>Unverified</KeyItem>
      <KeyItem mark={<ConceptMark n={{ ...sample, trust: "human_reviewed", stale: true, open_flags: 0 }} r={4} />}>Stale</KeyItem>
      <KeyItem mark={<ConceptMark n={{ ...sample, trust: "human_reviewed", stale: false, open_flags: 1 }} r={4} />}>Open flags</KeyItem>
      <KeyItem mark={<line x1={-9} x2={9} y1={0} y2={0} stroke="var(--line-strong)" strokeWidth={1} />}>Link</KeyItem>
      {showEvidence ? (
        <>
          <KeyItem mark={<line x1={-9} x2={9} y1={0} y2={0} stroke="var(--line-strong)" strokeWidth={1} strokeDasharray="3 3" />}>Citation</KeyItem>
          <KeyItem mark={<EvidenceMark kind="source_document" r={4} />}>Document</KeyItem>
          <KeyItem mark={<EvidenceMark kind="trace" r={4} />}>Trace</KeyItem>
          <KeyItem mark={<EvidenceMark kind="flag" r={4} />}>Flag</KeyItem>
        </>
      ) : null}
    </ul>
  );
}

/** The same concepts as a list: the phone layout, and the keyboard-friendly view on larger screens. */
function ConceptList({ concepts, base }: { concepts: Extract<GraphNode, { type: "concept" }>[]; base: string }) {
  const sorted = [...concepts].sort((a, b) => b.open_flags - a.open_flags || Number(b.stale) - Number(a.stale) || a.path.localeCompare(b.path));
  return (
    <ul className="divide-y divide-line">
      {sorted.map((c) => (
        <li key={c.id}>
          <Link href={conceptHref(base, c.path)} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2/60">
            <KindIcon kind={c.kind} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-fg">{c.title}</span>
              <span className="block truncate font-mono text-xs text-subtle">{c.path}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {c.open_flags ? <Badge tone="danger">{pluralize(c.open_flags, "open flag")}</Badge> : null}
              {c.stale ? <StaleBadge /> : null}
              <TrustBadge trust={c.trust} compact />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
