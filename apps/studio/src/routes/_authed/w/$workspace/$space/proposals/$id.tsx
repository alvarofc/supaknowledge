import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowLeft,
  Bot,
  ExternalLink,
  FileText,
  Flag,
  GitMerge,
  Link2,
  MessageSquare,
  Quote,
  ShieldAlert,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { AudienceBadge, EscalationBadge, FlagKindBadge, ProposalStatusBadge, RiskBadge } from "@/components/kf/badges";
import { LiveRefresh } from "@/components/kf/live-refresh";
import { Markdown } from "@/components/kf/markdown";
import { conceptHref } from "@/components/inbox/flag-list";
import { OpCard } from "@/components/inbox/op-card";
import type { ConceptState } from "@/components/inbox/op-card";
import { RetryFileSync, ReviewActions } from "@/components/inbox/review-actions";
import { Badge } from "@/components/ui/badge";
import type { Tone } from "@/components/ui/badge";
import { Callout, Card, CardHeader, EmptyState } from "@/components/ui/card";
import { Link } from "@/components/ui/link";
import type { Database } from "@/lib/database.types";
import { actorLabel, pluralize } from "@/lib/format";
import { title } from "@/lib/meta";
import { atLeast } from "@/lib/roles";
import { useSpace } from "@/lib/use-space";
import { loadProposal } from "@/server/proposal.functions";
import type { ConceptCols } from "@/server/proposal.functions";
import { safeHref } from "@/lib/safe-href";
import { Timestamp } from "@/components/kf/timestamp";

type Enums = Database["public"]["Enums"];

export const Route = createFileRoute("/_authed/w/$workspace/$space/proposals/$id")({
  loader: ({ params }) => loadProposal({ data: { workspace: params.workspace, space: params.space, id: params.id } }),
  head: () => ({ meta: [title("Review proposal")] }),
  component: ProposalPage,
});

function toState(c: ConceptCols): ConceptState {
  return {
    ...c,
    frontmatter: c.frontmatter && typeof c.frontmatter === "object" && !Array.isArray(c.frontmatter) ? (c.frontmatter) : {},
  };
}

function parseConflicts(note: string | null): { ord: number; path: string; reason: string }[] | null {
  if (!note) return null;
  try {
    const v = JSON.parse(note) as unknown;
    if (Array.isArray(v)) return v.filter((x) => x && typeof x === "object") as { ord: number; path: string; reason: string }[];
  } catch {
    // free-text note
  }
  return null;
}

const DECISION: Record<Enums["review_decision"], { label: string; tone: Tone }> = {
  approve: { label: "Approved", tone: "ok" },
  reject: { label: "Rejected", tone: "danger" },
  comment: { label: "Comment", tone: "neutral" },
  request_changes: { label: "Requested changes", tone: "warn" },
};

function ProposalPage() {
  const ctx = useSpace();
  const data = Route.useLoaderData();
  const { p, ops, citations, reviews, run, profiles } = data;
  const applied = p.status === "applied";
  const pending = p.status === "pending" || p.status === "approved";
  const conceptById = new Map(Object.entries(data.current).map(([id, c]) => [id, toState(c)]));
  const beforeByConcept = new Map(Object.entries(data.before).map(([id, c]) => [id, c ? toState(c) : null]));
  const docs = new Map(data.docs.map((d) => [d.id, d]));
  const traces = new Map(data.traces.map((t) => [t.id, t]));
  const citedFlags = new Map(data.citedFlags.map((f) => [f.id, f]));
  const citedConcepts = new Map(data.citedConcepts.map((c) => [c.id, c]));
  const linkedFlags = data.linkedFlags.filter((f) => !citedFlags.has(f.id));
  // evidence the curator read while researching but did not cite: it still counts for escalation and visibility
  const cited = citations.filter((c) => !c.consulted);
  const consulted = citations.filter((c) => c.consulted);

  const [rationale, selfReview] = splitSelfReview(p.rationale, p.author.startsWith("curator"));
  const conflicts = p.status === "conflicted" ? parseConflicts(p.review_note) : null;
  const canReview = atLeast(ctx.role, "reviewer");
  const isAdmin = atLeast(ctx.role, "admin");
  const approveBlockedReason =
    p.escalation && !isAdmin
      ? "This proposal widens access to restricted knowledge. Only a space admin can approve it — ask one to review, or reject it."
      : null;
  const notes = reviews.filter((r) => r.decision === "comment" || r.decision === "request_changes");

  return (
    <>
      <Link href={ctx.base} className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> Inbox
      </Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <ProposalStatusBadge status={p.status} autoApplied={p.auto_applied} />
            <RiskBadge risk={p.risk} />
            {p.escalation ? <EscalationBadge /> : null}
          </div>
          <h1 className="text-xl font-normal tracking-tight sm:text-2xl text-fg">{p.title}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-sm text-muted">
            {p.author.startsWith("curator") ? <Bot className="size-3.5 text-subtle" aria-hidden="true" /> : null}
            Proposed by {actorLabel(p.author, profiles)} · <Timestamp iso={p.created_at} />
            {run ? (
              <>
                {" "}
                · from{" "}
                <Link href={`${ctx.base}/activity?tab=runs#run-${run.id}`} className="text-accent hover:underline">
                  a {run.trigger.replace("_", " ")} curator run
                </Link>
              </>
            ) : null}
          </p>
        </div>
        <LiveRefresh spaceId={ctx.space.id} tables={["proposals"]} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-6">
          {p.escalation ? (
            <Callout tone="danger" icon={<ShieldAlert />} title="Widens access — only a space admin can approve">
              Applying this would publish material that is restricted to some groups to a wider audience, or widen an existing
              concept&apos;s audience. It can never be auto-applied.
            </Callout>
          ) : null}
          {p.status === "conflicted" ? (
            <Callout tone="warn" icon={<TriangleAlert />} title="Conflicted: not applied">
              <p>
                The knowledge changed after this proposal was drafted, so applying it would overwrite someone else&apos;s work. Nothing
                was changed.
              </p>
              {conflicts?.length ? (
                <ul className="mt-2 list-disc pl-5">
                  {conflicts.map((c) => (
                    <li key={`${c.ord}-${c.path}`}>
                      <span className="font-mono text-xs text-fg">{c.path}</span>: {c.reason}
                    </li>
                  ))}
                </ul>
              ) : p.review_note ? (
                <p className="mt-2 font-mono text-xs">{p.review_note}</p>
              ) : null}
              <p className="mt-2">
                Reject it with a short note and the curator will redraft against the latest revision on its next run. If the newer
                revision is the mistake, revert that concept from its history instead.
              </p>
            </Callout>
          ) : null}

          <Card>
            <CardHeader title="Rationale" />
            <div className="px-4 py-4">
              {rationale.trim() ? (
                <Markdown knowledgeBase={`${ctx.base}/knowledge`}>{rationale}</Markdown>
              ) : (
                <p className="text-sm text-subtle">No rationale given.</p>
              )}
              {selfReview.length ? (
                <details className="mt-3 text-sm">
                  <summary className="w-fit cursor-pointer select-none text-muted hover:text-fg">
                    Curator self-review ({pluralize(selfReview.length, "note")})
                  </summary>
                  <div className="mt-2">
                    <Markdown knowledgeBase={`${ctx.base}/knowledge`}>{selfReview.join("\n")}</Markdown>
                  </div>
                </details>
              ) : null}
            </div>
          </Card>

          <section aria-labelledby="changes-h" className="flex flex-col gap-4">
            <h2 id="changes-h" className="text-sm font-medium text-fg">
              Changes <span className="font-normal text-subtle">({ops.length})</span>
            </h2>
            {ops.length === 0 ? (
              <EmptyState framed icon={<GitMerge />} title="This proposal has no changes">
                It may still be in draft by its author. Proposals change knowledge only through their ops.
              </EmptyState>
            ) : (
              ops.map((op) => {
                const current = op.concept_id ? conceptById.get(op.concept_id) : undefined;
                let before: ConceptState | null = null;
                if (op.op !== "create") {
                  if (applied && op.concept_id && beforeByConcept.has(op.concept_id)) before = beforeByConcept.get(op.concept_id) ?? null;
                  else if (current) before = current;
                }
                return (
                  <OpCard
                    key={op.id}
                    op={op}
                    before={before}
                    currentRevision={current?.revision ?? null}
                    pending={pending}
                    applied={applied}
                    base={ctx.base}
                    groups={ctx.groups}
                    citationLabels={cited.filter((c) => c.op_id === op.id).map((c) => c.label)}
                  />
                );
              })
            )}
          </section>

          <Card>
            <CardHeader title="Evidence" />
            {cited.length === 0 && linkedFlags.length === 0 ? (
              <p className="px-4 py-4 text-sm text-subtle">No citations. Treat uncited changes with extra care.</p>
            ) : (
              <ul className="divide-y divide-line">
                {cited.map((c) => (
                  <li key={c.id} id={`cite-${encodeURIComponent(c.label)}`} className="scroll-mt-20 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-subtle">[^{c.label}]</span>
                      <Badge>{c.ref_kind.replace("_", " ")}</Badge>
                      <AudienceBadge audience={c.audience} groups={ctx.groups} />
                      <CitationLink
                        kind={c.ref_kind}
                        refId={c.ref_id}
                        url={c.url}
                        base={ctx.base}
                        doc={c.ref_id ? docs.get(c.ref_id) : undefined}
                        trace={c.ref_id ? traces.get(c.ref_id) : undefined}
                        concept={c.ref_id ? citedConcepts.get(c.ref_id) : undefined}
                      />
                    </div>
                    {c.ref_kind === "flag" && c.ref_id && citedFlags.get(c.ref_id) ? (
                      <FlagSummary flag={citedFlags.get(c.ref_id)!} base={ctx.base} />
                    ) : null}
                    {c.quote ? (
                      <blockquote className="mt-2 flex gap-2 border-l-2 border-line-strong pl-3 text-sm text-muted">
                        <Quote className="mt-0.5 size-3.5 shrink-0 text-subtle" aria-hidden="true" />
                        <span className="whitespace-pre-wrap">{c.quote}</span>
                      </blockquote>
                    ) : null}
                  </li>
                ))}
                {linkedFlags.map((f) => (
                  <li key={f.id} className="px-4 py-3">
                    <div className="flex items-center gap-2 text-xs text-subtle">
                      <Flag className="size-3.5" /> Addresses flag
                    </div>
                    <FlagSummary flag={f} base={ctx.base} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {consulted.length ? (
            <Card>
              <CardHeader
                title={`Also consulted (${consulted.length})`}
                description="Read by the curator while researching but not cited. It still decides who can see this proposal and whether it widens access."
              />
              <ul className="divide-y divide-line">
                {consulted.map((c) => (
                  <li key={c.id} className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge>{c.ref_kind.replace("_", " ")}</Badge>
                      <AudienceBadge audience={c.audience} groups={ctx.groups} />
                      <CitationLink
                        kind={c.ref_kind}
                        refId={c.ref_id}
                        url={c.url}
                        base={ctx.base}
                        doc={c.ref_id ? docs.get(c.ref_id) : undefined}
                        trace={c.ref_id ? traces.get(c.ref_id) : undefined}
                        concept={c.ref_id ? citedConcepts.get(c.ref_id) : undefined}
                      />
                      {c.ref_kind === "flag" && c.ref_id && citedFlags.get(c.ref_id) ? (
                        <span className="truncate text-sm text-muted">{citedFlags.get(c.ref_id)!.observation}</span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
          <Card className="px-4 py-4">
            <h2 className="mb-3 text-sm font-medium">Decision</h2>
            {pending || p.status === "conflicted" ? (
              canReview ? (
                <ReviewActions
                  proposalId={p.id}
                  hasFiles={data.hasFiles}
                  canApprove={pending}
                  canReject
                  approveBlockedReason={pending ? approveBlockedReason : null}
                />
              ) : (
                <p className="text-sm text-muted">Reviewers and admins of this space decide on proposals. You can read it and its evidence.</p>
              )
            ) : (
              <div className="text-sm text-muted">
                {p.status === "applied" ? (
                  p.auto_applied ? (
                    <p className="flex items-start gap-1.5">
                      <Zap className="mt-0.5 size-3.5 shrink-0 text-ok" /> Applied automatically by the space auto-apply policy{" "}
                      {p.applied_at ? <Timestamp iso={p.applied_at} /> : ""}.
                    </p>
                  ) : (
                    <p>
                      Applied {p.applied_at ? <Timestamp iso={p.applied_at} /> : ""} by{" "}
                      {p.reviewed_by ? (profiles[p.reviewed_by]?.display_name ?? "a reviewer") : "a reviewer"}.
                    </p>
                  )
                ) : (
                  <p>
                    {p.status[0].toUpperCase() + p.status.slice(1)}
                    {p.reviewed_at ? (
                      <>
                        {" "}
                        <Timestamp iso={p.reviewed_at} />
                      </>
                    ) : (
                      ""
                    )}
                    {p.reviewed_by ? ` by ${profiles[p.reviewed_by]?.display_name ?? "a reviewer"}` : ""}.
                  </p>
                )}
                {p.review_note ? <p className="mt-2 border-l-2 border-line-strong pl-2">{p.review_note}</p> : null}
                {canReview && data.filesUnsynced ? <RetryFileSync proposalId={p.id} /> : null}
              </div>
            )}
          </Card>

          {notes.length ? (
            <Card className="px-4 py-4">
              <h2 className="mb-3 text-sm font-medium">Review notes</h2>
              <ul className="flex flex-col gap-3">
                {notes.map((r) => (
                  <li key={r.id} className="text-sm">
                    <div className="flex items-center gap-1.5 text-xs text-subtle">
                      <MessageSquare className="size-3.5" />
                      {r.reviewer ? (profiles[r.reviewer]?.display_name ?? "Reviewer") : "Curator"} · <Timestamp iso={r.created_at} />
                    </div>
                    {r.note ? <div className="mt-1"><Markdown size="sm">{r.note}</Markdown></div> : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card className="px-4 py-4">
            <h2 className="mb-3 text-sm font-medium">History</h2>
            <ol className="flex flex-col gap-2.5 text-sm">
              <li className="flex gap-2">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-subtle" aria-hidden="true" />
                <span className="text-muted">
                  Proposed by {actorLabel(p.author, profiles)}
                  <Timestamp iso={p.created_at} format="date" className="block text-xs text-subtle" />
                </span>
              </li>
              {reviews.map((r) => (
                <li key={r.id} className="flex gap-2">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-subtle" aria-hidden="true" />
                  <span className="min-w-0 text-muted">
                    <Badge tone={DECISION[r.decision].tone}>{DECISION[r.decision].label}</Badge>{" "}
                    {r.reviewer ? (profiles[r.reviewer]?.display_name ?? "a reviewer") : "system"}
                    <Timestamp iso={r.created_at} format="date" className="block text-xs text-subtle" />
                    {r.note && (r.decision === "approve" || r.decision === "reject") ? (
                      <span className="mt-1 block border-l-2 border-line-strong pl-2 text-xs">{r.note}</span>
                    ) : null}
                  </span>
                </li>
              ))}
              {p.auto_applied && p.applied_at ? (
                <li className="flex gap-2">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-ok" aria-hidden="true" />
                  <span className="text-muted">
                    Auto-applied by policy
                    <Timestamp iso={p.applied_at} format="date" className="block text-xs text-subtle" />
                  </span>
                </li>
              ) : null}
            </ol>
          </Card>
        </aside>
      </div>
    </>
  );
}

function FlagSummary({
  flag,
  base,
}: {
  flag: { id: string; kind: Enums["flag_kind"]; concept_path: string | null; observation: string; status: Enums["flag_status"]; trace_id: string | null };
  base: string;
}) {
  return (
    <div className="mt-2 rounded-md border border-line bg-surface-2/50 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <FlagKindBadge kind={flag.kind} />
        {flag.concept_path ? <span className="font-mono text-xs text-muted">{flag.concept_path}</span> : null}
        <Badge>{flag.status.replace("_", " ")}</Badge>
        {flag.trace_id ? (
          <Link href={`${base}/activity/traces/${flag.trace_id}`} className="ml-auto text-xs text-accent hover:underline">
            View trace
          </Link>
        ) : null}
      </div>
      <p className="mt-1.5 text-fg">{flag.observation}</p>
    </div>
  );
}

function CitationLink({
  kind,
  refId,
  url,
  base,
  doc,
  trace,
  concept,
}: {
  kind: Enums["citation_kind"];
  refId: string | null;
  url: string | null;
  base: string;
  doc?: { id: string; title: string | null; url: string | null };
  trace?: { id: string; name: string | null };
  concept?: { id: string; path: string; title: string };
}) {
  const cls = "inline-flex min-w-0 items-center gap-1 text-sm text-accent hover:underline";
  const docHref = safeHref(doc?.url);
  const urlHref = safeHref(url);
  if (kind === "source_document" && refId) {
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <Link href={`${base}/sources/documents/${refId}`} className={cls}>
          <FileText className="size-3.5 shrink-0" />
          <span className="truncate">{doc?.title ?? "Source document"}</span>
        </Link>
        {docHref ? (
          <a href={docHref} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-xs text-subtle hover:text-fg">
            original <ExternalLink className="size-3" />
          </a>
        ) : null}
      </span>
    );
  }
  if (kind === "trace" && refId) {
    return (
      <Link href={`${base}/activity/traces/${refId}`} className={cls}>
        <Bot className="size-3.5 shrink-0" />
        <span className="truncate">{trace?.name ?? "Agent trace"}</span>
      </Link>
    );
  }
  if (kind === "concept" && concept) {
    return (
      <Link href={conceptHref(base, concept.path)} className={cls}>
        <Link2 className="size-3.5 shrink-0" />
        <span className="truncate">{concept.title}</span>
      </Link>
    );
  }
  if (urlHref) {
    return (
      <a href={urlHref} target="_blank" rel="noopener noreferrer" className={cls}>
        <ExternalLink className="size-3.5 shrink-0" />
        <span className="truncate">{url}</span>
      </a>
    );
  }
  if (url) {
    // not an http(s) URL: show it, never link it
    return <span className="truncate font-mono text-xs text-muted">{url}</span>;
  }
  return null;
}

// The curator appends its self-review to the rationale (engine.ts): "\n\n**Curator self-review**\n- note\n- note".
const SELF_REVIEW_HEADING = "\n\n**Curator self-review**\n";

// The note prefixes the engine writes; a list inside a note's detail is not a new note.
const SELF_REVIEW_NOTE =
  /\n(?=- (?:the self-review did not approve|(?:\*\*BLOCKER\*\* )?(?:contradiction|unsupported_claim|lost_information|format|scope|other|check): ))/;

/** Only curator proposals carry a generated self-review; a person's or an import's rationale is shown as written. */
function splitSelfReview(text: string, fromCurator: boolean): [string, string[]] {
  const at = fromCurator ? text.lastIndexOf(SELF_REVIEW_HEADING) : -1;
  if (at < 0) return [text, []];
  const notes = text
    .slice(at + SELF_REVIEW_HEADING.length)
    .split(SELF_REVIEW_NOTE)
    .filter((note) => note.trim());
  return [text.slice(0, at), notes];
}
