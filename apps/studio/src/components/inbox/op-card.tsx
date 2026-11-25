import { ArrowRight, ExternalLink, GitBranch, TriangleAlert } from "lucide-react";
import { Link } from "@/components/ui/link";
import { DiffView, FieldDiff } from "@/components/kf/diff-view";
import { KindIcon } from "@/components/kf/badges";
import { Badge } from "@/components/ui/badge";
import type { Tone } from "@/components/ui/badge";
import { Callout, Card } from "@/components/ui/card";
import type { Database, Json } from "@/lib/database.types";
import { formatBytes, skillFiles } from "@/lib/skill-files";
import { conceptHref } from "./flag-list";

type Enums = Database["public"]["Enums"];
export type OpRow = Pick<
  Database["public"]["Tables"]["proposal_ops"]["Row"],
  "id" | "ord" | "op" | "concept_id" | "path" | "new_path" | "base_revision" | "after" | "target_audience" | "rationale"
>;

/** The editable state of a concept, as written by apply_proposal. */
export interface ConceptState {
  path: string;
  kind: Enums["concept_kind"];
  type: string;
  title: string;
  description: string;
  body: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  status: Enums["concept_status"];
  superseded_by: string | null;
  stale_after: string | null;
  audience: string[];
  revision?: number;
}

function asObject(j: Json | undefined | null): Record<string, unknown> {
  return j && typeof j === "object" && !Array.isArray(j) ? (j) : {};
}

/** Mirror apply_proposal: what the concept looks like after this op. */
export function applyOp(op: OpRow, before: ConceptState | null): ConceptState {
  const a = asObject(op.after);
  const str = (k: string) => (typeof a[k] === "string" ? (a[k]) : undefined);
  if (op.op === "create" || !before) {
    return {
      path: op.path,
      kind: (str("kind") as Enums["concept_kind"]) ?? "domain",
      type: str("type") ?? "Reference",
      title: str("title") ?? op.path,
      description: str("description") ?? "",
      body: str("body") ?? "",
      frontmatter: asObject(a.frontmatter as Json),
      tags: Array.isArray(a.tags) ? (a.tags as string[]) : [],
      status: (str("status") as Enums["concept_status"]) ?? "stable",
      superseded_by: str("superseded_by") ?? null,
      stale_after: str("stale_after") ?? null,
      audience: op.target_audience,
    };
  }
  if (op.op === "deprecate") return { ...before, status: "deprecated", superseded_by: str("superseded_by") ?? before.superseded_by };
  if (op.op === "move") return { ...before, path: op.new_path ?? before.path };
  return {
    ...before,
    kind: (str("kind") as Enums["concept_kind"]) ?? before.kind,
    type: str("type") ?? before.type,
    title: str("title") ?? before.title,
    description: str("description") ?? before.description,
    body: str("body") ?? before.body,
    frontmatter: a.frontmatter && typeof a.frontmatter === "object" ? asObject(a.frontmatter as Json) : before.frontmatter,
    tags: "tags" in a && Array.isArray(a.tags) ? (a.tags as string[]) : before.tags,
    status: (str("status") as Enums["concept_status"]) ?? before.status,
    superseded_by: "superseded_by" in a ? (str("superseded_by") ?? null) : before.superseded_by,
    stale_after: "stale_after" in a ? (str("stale_after") ?? null) : before.stale_after,
    audience: op.target_audience,
  };
}

const OP_META: Record<Enums["proposal_op_kind"], { label: string; tone: Tone }> = {
  create: { label: "Create", tone: "ok" },
  update: { label: "Update", tone: "info" },
  deprecate: { label: "Deprecate", tone: "warn" },
  move: { label: "Move", tone: "violet" },
};

export function OpCard({
  op,
  before,
  currentRevision,
  pending,
  applied,
  base,
  groups,
  citationLabels,
}: {
  op: OpRow;
  /** state before the op: the current concept (pending) or the previous revision (applied) */
  before: ConceptState | null;
  /** live revision of the target concept, for drift detection */
  currentRevision: number | null;
  pending: boolean;
  applied: boolean;
  base: string;
  groups: { id: string; name: string }[];
  citationLabels: string[];
}) {
  const after = applyOp(op, before);
  const meta = OP_META[op.op];
  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? "hidden group";
  const audienceLabel = (a: string[]) => (a.length ? a.map(groupName).join(", ") : "Everyone in the space");
  const scalar = (s: ConceptState | null) =>
    s
      ? {
          path: s.path,
          title: s.title,
          description: s.description,
          type: s.type,
          kind: s.kind,
          status: s.status,
          tags: s.tags.length ? s.tags.join(", ") : null,
          stale_after: s.stale_after,
          superseded_by: s.superseded_by,
          audience: audienceLabel(s.audience),
        }
      : {};
  const drifted = pending && op.op !== "create" && op.base_revision != null && currentRevision != null && currentRevision !== op.base_revision;
  const missing = pending && op.op !== "create" && currentRevision == null;
  const targetPath = op.op === "move" ? (op.new_path ?? op.path) : op.path;
  const files = skillFiles(op.after);
  const widens = before && before.audience.length > 0 && (after.audience.length === 0 || after.audience.some((g) => !before.audience.includes(g)));

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <Badge tone={meta.tone}>{meta.label}</Badge>
        <KindIcon kind={after.kind} />
        <span className="font-mono text-sm text-fg">{op.path}</span>
        {op.op === "move" && op.new_path ? (
          <>
            <ArrowRight className="size-3.5 text-subtle" aria-label="to" />
            <span className="font-mono text-sm text-fg">{op.new_path}</span>
          </>
        ) : null}
        <span className="ml-auto flex items-center gap-2 text-xs text-subtle">
          {op.base_revision != null ? (
            <span className="inline-flex items-center gap-1" title="Revision the change was drafted against">
              <GitBranch className="size-3.5" /> base r{op.base_revision}
              {currentRevision != null && pending ? ` · now r${currentRevision}` : ""}
            </span>
          ) : null}
          {applied && op.concept_id ? (
            <Link href={conceptHref(base, targetPath)} className="inline-flex items-center gap-1 text-accent hover:underline">
              Open concept <ExternalLink className="size-3" />
            </Link>
          ) : null}
        </span>
      </div>
      <div className="flex flex-col gap-4 px-4 py-4">
        {op.rationale ? (
          <p className="text-sm text-muted">
            <span className="font-medium text-fg">Why: </span>
            {op.rationale}
          </p>
        ) : null}
        {drifted ? (
          <Callout tone="warn" icon={<TriangleAlert />} title="This concept changed after the proposal was drafted">
            Drafted against revision {op.base_revision}, the concept is now at revision {currentRevision}. Approving will not overwrite
            the newer revision: the proposal will be marked conflicted instead.
          </Callout>
        ) : null}
        {missing ? (
          <Callout tone="warn" icon={<TriangleAlert />} title="Target concept not found">
            The concept was deleted or moved, or you cannot see it. Applying will mark this proposal conflicted.
          </Callout>
        ) : null}
        {widens ? (
          <Callout tone="danger" icon={<TriangleAlert />} title="Audience widens">
            From <strong>{audienceLabel(before.audience)}</strong> to <strong>{audienceLabel(after.audience)}</strong>.
          </Callout>
        ) : null}

        <section aria-label="Field changes">
          <h3 className="mb-2 mono-label text-subtle">Fields</h3>
          <FieldDiff before={scalar(before)} after={scalar(after)} />
        </section>
        {JSON.stringify(before?.frontmatter ?? {}) !== JSON.stringify(after.frontmatter) ? (
          <section aria-label="Frontmatter changes">
            <h3 className="mb-2 mono-label text-subtle">Frontmatter</h3>
            <FieldDiff before={before?.frontmatter ?? {}} after={after.frontmatter} />
          </section>
        ) : null}
        {(before?.body ?? "") !== after.body ? (
          <section aria-label="Body changes">
            <h3 className="mb-2 mono-label text-subtle">Body</h3>
            <DiffView
              before={before?.body ?? ""}
              after={after.body}
              mode={op.op === "create" ? "unified" : "split"}
              beforeLabel={before?.revision ? `Revision ${before.revision}` : "Before"}
              afterLabel="Proposed"
            />
          </section>
        ) : op.op === "update" ? (
          <p className="text-xs text-subtle">The body is unchanged.</p>
        ) : null}
        {files.length ? (
          <section aria-label="Skill files">
            <h3 className="mb-2 mono-label text-subtle">Skill files ({files.length})</h3>
            <ul className="flex flex-col gap-1 rounded-md border border-line px-3 py-2">
              {files.map((f) => (
                <li key={f.path} className="flex items-center gap-3 text-xs">
                  <span className="min-w-0 flex-1 truncate font-mono text-fg">{f.path}</span>
                  {f.size !== null ? <span className="shrink-0 text-subtle">{formatBytes(f.size)}</span> : null}
                </li>
              ))}
            </ul>
            {files.some((f) => f.stripped) ? (
              <p className="mt-1 text-xs text-subtle">Copied into the concept's files; the proposal keeps only names and checksums.</p>
            ) : null}
          </section>
        ) : null}
        {citationLabels.length ? (
          <p className="text-xs text-subtle">
            Cites:{" "}
            {citationLabels.map((l, i) => (
              <span key={l}>
                {i ? ", " : ""}
                <a href={`#cite-${encodeURIComponent(l)}`} className="font-mono text-accent hover:underline">
                  [^{l}]
                </a>
              </span>
            ))}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
