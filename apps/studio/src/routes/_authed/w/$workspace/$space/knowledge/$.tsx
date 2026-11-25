import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Bot, ChevronRight, FileText, Info, Link2, Paperclip, TriangleAlert } from "lucide-react";
import { AudienceBadge, FlagKindBadge, KindBadge, KindIcon, StaleBadge, TrustBadge } from "@/components/kf/badges";
import { LiveRefresh } from "@/components/kf/live-refresh";
import { Markdown } from "@/components/kf/markdown";
import { ConceptActions } from "@/components/knowledge/concept-actions";
import { FrontmatterPanel, SourcesList } from "@/components/knowledge/frontmatter";
import { parseSources } from "@/lib/okf-sources";
import { ConceptHistory } from "@/components/knowledge/history";
import { conceptHref } from "@/components/knowledge/paths";
import { Badge } from "@/components/ui/badge";
import { Callout, Card, CardHeader } from "@/components/ui/card";
import { Link } from "@/components/ui/link";
import { LinkTabs } from "@/components/ui/tabs";
import { actorLabel, pluralize } from "@/lib/format";
import { title } from "@/lib/meta";
import { atLeast } from "@/lib/roles";
import { useSpace } from "@/lib/use-space";
import { loadConcept } from "@/server/concept.functions";
import { Timestamp } from "@/components/kf/timestamp";

/** Concept path from the splat ("metrics/arr"), decoding each segment like the links in conceptHref() encode it. */
function pathFromSplat(splat: string | undefined): string {
  return (splat ?? "")
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join("/");
}

export const Route = createFileRoute("/_authed/w/$workspace/$space/knowledge/$")({
  validateSearch: (search: Record<string, unknown>): { tab?: string; from?: string; to?: string } => {
    const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);
    return { tab: str(search.tab), from: str(search.from), to: str(search.to) };
  },
  loaderDeps: ({ search }) => ({ history: search.tab === "history" }),
  loader: ({ params, deps }) =>
    loadConcept({ data: { workspace: params.workspace, space: params.space, path: pathFromSplat(params._splat), history: deps.history } }),
  head: ({ params }) => ({ meta: [title(pathFromSplat(params._splat))] }),
  component: ConceptPage,
});

function ConceptPage() {
  const ctx = useSpace();
  const sp = Route.useSearch();
  const { concept, links, backlinks, related, files, flags, verifications, revisions, profiles } = Route.useLoaderData();
  const byId = new Map(related.map((c) => [c.id, c]));

  const tab = sp.tab === "history" ? "history" : "content";
  const href = `${conceptHref(ctx.base, concept.path)}`;
  const canEdit = atLeast(ctx.role, "editor");
  const canVerify = atLeast(ctx.role, "reviewer");

  const currentVer = verifications.filter((v) => v.revision === concept.revision);
  const verifiedByMe = currentVer.some((v) => v.actor === `human:${ctx.user.id}`);
  const sourcesCount = parseSources(concept.frontmatter).length;
  const segs = concept.path.split("/");

  const toNum = (s: string | undefined) => (s && /^\d+$/.test(s) ? Number(s) : null);

  return (
    <div>
      <nav aria-label="Breadcrumb" className="mb-3 flex flex-wrap items-center gap-1 text-xs text-subtle">
        <Link href={`${ctx.base}/knowledge`} className="hover:text-fg">
          Knowledge
        </Link>
        {segs.map((s, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="size-3" />
            <span className={i === segs.length - 1 ? "font-mono text-muted" : "font-mono"}>{s}</span>
          </span>
        ))}
      </nav>

      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-normal tracking-tight sm:text-2xl text-fg">
            <KindIcon kind={concept.kind} className="size-5" />
            <span className={concept.status === "deprecated" ? "line-through decoration-subtle" : undefined}>{concept.title}</span>
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <KindBadge kind={concept.kind} />
            <Badge>{concept.type}</Badge>
            {concept.status !== "stable" ? <Badge tone={concept.status === "deprecated" ? "danger" : "neutral"}>{concept.status}</Badge> : null}
            <TrustBadge trust={concept.trust} />
            {concept.is_stale ? <StaleBadge /> : null}
            <AudienceBadge audience={concept.audience} groups={ctx.groups} />
          </div>
          <p className="mt-2 text-xs text-subtle">
            <span className="font-mono">{concept.path}</span> · revision {concept.revision} · updated by {actorLabel(concept.generated_by, profiles)}{" "}
            <Timestamp iso={concept.generated_at} />
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <ConceptActions
            conceptId={concept.id}
            spaceId={ctx.space.id}
            path={concept.path}
            revision={concept.revision}
            base={ctx.base}
            canEdit={canEdit}
            canVerify={canVerify}
            alreadyVerifiedByMe={verifiedByMe}
          />
          <LiveRefresh spaceId={ctx.space.id} tables={["concepts"]} />
        </div>
      </div>

      {concept.status === "deprecated" ? (
        <Callout tone="warn" icon={<TriangleAlert />} title="Deprecated" className="mb-4">
          Agents do not get this concept in search results.
          {concept.superseded_by ? (
            <>
              {" "}
              It was superseded by{" "}
              <Link href={conceptHref(ctx.base, concept.superseded_by)} className="font-medium text-accent hover:underline">
                {concept.superseded_by}
              </Link>
              .
            </>
          ) : null}
        </Callout>
      ) : null}
      {concept.is_stale ? (
        <Callout tone="warn" icon={<Info />} title="Past its freshness date" className="mb-4">
          This concept was due for a re-check on <Timestamp iso={concept.stale_after} format="date" />. The nightly staleness sweep asks the curator to compare it
          against its sources; verify it yourself if you know it is still right.
        </Callout>
      ) : null}
      {concept.audience.length > 0 ? (
        <Callout tone="neutral" icon={<Info />} className="mb-4">
          Restricted knowledge: only members of {concept.audience.map((id) => ctx.groups.find((g) => g.id === id)?.name ?? "a hidden group").join(", ")} can
          see this concept, its history and flags about it — whatever their role.
        </Callout>
      ) : null}

      <div className="mb-5">
        <LinkTabs
          active={tab}
          tabs={[
            { id: "content", label: "Content", href },
            { id: "history", label: "History", href: `${href}?tab=history`, count: concept.revision },
          ]}
        />
      </div>

      {tab === "history" ? (
        <ConceptHistory
          conceptId={concept.id}
          currentRevision={concept.revision}
          revisions={revisions}
          verifications={verifications}
          profiles={profiles}
          groups={ctx.groups}
          from={toNum(sp.from)}
          to={toNum(sp.to)}
          historyHref={(from, to) => `${href}?tab=history&to=${to}${from !== null ? `&from=${from}` : ""}`}
          base={ctx.base}
          canRevert={canEdit}
        />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0 space-y-5">
            {concept.description ? <p className="text-[15px] text-muted">{concept.description}</p> : null}
            {concept.tags.length ? (
              <div className="flex flex-wrap gap-1.5" aria-label="Tags">
                {concept.tags.map((t) => (
                  <span key={t} className="rounded-md border border-line bg-surface-2 px-1.5 py-px font-mono text-[11px] text-muted">
                    #{t}
                  </span>
                ))}
              </div>
            ) : null}
            <Card className="px-5 py-5 sm:px-7">
              {concept.body.trim() ? (
                <Markdown conceptPath={concept.path} conceptKind={concept.kind} knowledgeBase={`${ctx.base}/knowledge`}>
                  {concept.body}
                </Markdown>
              ) : (
                <p className="text-sm text-subtle">This concept has no body yet.</p>
              )}
            </Card>

            {flags.length ? (
              <Card>
                <CardHeader
                  title={`Open flags (${flags.length})`}
                  description="Problems agents or people reported. The curator picks them up on its next run."
                  actions={
                    <Link href={ctx.base} className="text-xs text-accent hover:underline">
                      Open inbox
                    </Link>
                  }
                />
                <ul className="divide-y divide-line">
                  {flags.map((f) => (
                    <li key={f.id} className="px-4 py-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <FlagKindBadge kind={f.kind} />
                        <span className="text-xs text-subtle">
                          {f.synthetic ? (
                            <span className="inline-flex items-center gap-1">
                              <Bot className="size-3" /> mined from a trace
                            </span>
                          ) : (
                            <>from {f.created_by ? (profiles[f.created_by]?.display_name ?? "a user") : "unknown"}</>
                          )}{" "}
                          · <Timestamp iso={f.created_at} />
                        </span>
                      </div>
                      <p className="mt-1 text-fg">{f.observation}</p>
                      {f.suggested_fix ? <p className="mt-1 text-xs text-muted">Suggested fix: {f.suggested_fix}</p> : null}
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </div>

          <aside className="space-y-4" aria-label="Concept details">
            <Card>
              <CardHeader title={`Sources${sourcesCount ? ` (${sourcesCount})` : ""}`} />
              <SourcesList frontmatter={concept.frontmatter} base={ctx.base} />
            </Card>
            <Card>
              <CardHeader title="Links" description="Parsed from the markdown body" />
              {links.length === 0 && backlinks.length === 0 ? (
                <p className="px-4 py-3 text-sm text-subtle">No links yet. Link related concepts in the body with relative paths like [ARR](metrics/arr.md).</p>
              ) : (
                <div className="divide-y divide-line">
                  {links.length ? (
                    <div className="px-4 py-2">
                      <div className="mono-label mb-1 flex items-center gap-1 text-subtle">
                        <ArrowRight className="size-3" /> Links to
                      </div>
                      <ul className="space-y-1">
                        {links.map((l) => {
                          const target = l.to_concept ? byId.get(l.to_concept) : undefined;
                          return (
                            <li key={l.to_path} className="text-sm">
                              {target ? (
                                <Link href={conceptHref(ctx.base, target.path)} className="flex items-center gap-1.5 hover:text-accent">
                                  <KindIcon kind={target.kind} className="size-3.5" />
                                  <span className="truncate">{target.title}</span>
                                </Link>
                              ) : (
                                <span className="flex items-center gap-1.5 text-subtle" title="No concept at this path (or you cannot see it)">
                                  <Link2 className="size-3.5" />
                                  <span className="truncate font-mono text-xs">{l.to_path}</span>
                                  <Badge tone="warn">missing</Badge>
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}
                  {backlinks.length ? (
                    <div className="px-4 py-2">
                      <div className="mono-label mb-1 flex items-center gap-1 text-subtle">
                        <ArrowLeft className="size-3" /> Linked from
                      </div>
                      <ul className="space-y-1">
                        {backlinks.map((b) => {
                          const src = byId.get(b.from_concept);
                          if (!src) return null;
                          return (
                            <li key={b.from_concept} className="text-sm">
                              <Link href={conceptHref(ctx.base, src.path)} className="flex items-center gap-1.5 hover:text-accent">
                                <KindIcon kind={src.kind} className="size-3.5" />
                                <span className="truncate">{src.title}</span>
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}
                </div>
              )}
            </Card>
            {files.length ? (
              <Card>
                <CardHeader title={`Files (${files.length})`} description="Scripts, templates and references shipped with the skill" />
                <ul className="divide-y divide-line">
                  {files.map((f) => (
                    <li key={f.id} className="flex items-center gap-2 px-4 py-2 text-sm">
                      <Paperclip className="size-3.5 shrink-0 text-subtle" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.path}</span>
                      {f.size_bytes !== null ? <span className="text-xs text-subtle">{formatBytes(f.size_bytes)}</span> : null}
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
            <Card>
              <CardHeader title="Frontmatter" description="OKF metadata, preserved verbatim" />
              <FrontmatterPanel frontmatter={concept.frontmatter} />
            </Card>
            <Card className="px-4 py-3 text-xs text-subtle">
              <div className="flex items-center gap-1.5">
                <FileText className="size-3.5" /> Created <Timestamp iso={concept.created_at} format="date" />
              </div>
              <div className="mt-1">
                {currentVer.length
                  ? `${pluralize(currentVer.length, "verification")} of this revision`
                  : "Nobody has verified this revision yet"}
              </div>
            </Card>
          </aside>
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
