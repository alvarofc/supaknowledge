import { BadgeCheck, GitPullRequestArrow } from "lucide-react";
import { Link } from "@/components/ui/link";
import { DiffView, FieldDiff } from "@/components/kf/diff-view";
import { Card, CardHeader, EmptyState } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import type { Database } from "@/lib/database.types";
import { actorLabel } from "@/lib/format";
import type { ProfileMap } from "@/lib/format";
import { RevertButton } from "./concept-actions";
import { Timestamp } from "@/components/kf/timestamp";

export type Revision = Pick<
  Database["public"]["Tables"]["concept_revisions"]["Row"],
  | "id"
  | "revision"
  | "path"
  | "kind"
  | "type"
  | "title"
  | "description"
  | "body"
  | "frontmatter"
  | "tags"
  | "status"
  | "superseded_by"
  | "stale_after"
  | "audience"
  | "actor"
  | "reason"
  | "proposal_id"
  | "created_at"
>;
export type Verification = Pick<Database["public"]["Tables"]["verifications"]["Row"], "id" | "revision" | "actor" | "note" | "created_at">;

function fields(r: Revision, groupName: (id: string) => string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    path: r.path,
    title: r.title,
    description: r.description,
    kind: r.kind,
    type: r.type,
    status: r.status,
    tags: r.tags,
    superseded_by: r.superseded_by,
    stale_after: r.stale_after,
    audience: r.audience.length ? r.audience.map(groupName) : "everyone in the space",
  };
  const fm = r.frontmatter && typeof r.frontmatter === "object" && !Array.isArray(r.frontmatter) ? r.frontmatter : {};
  for (const [k, v] of Object.entries(fm)) out[`frontmatter.${k}`] = v;
  return out;
}

export function ConceptHistory({
  conceptId,
  currentRevision,
  revisions,
  verifications,
  profiles,
  groups,
  from,
  to,
  historyHref,
  base,
  canRevert,
}: {
  conceptId: string;
  currentRevision: number;
  revisions: Revision[];
  verifications: Verification[];
  profiles: ProfileMap;
  groups: { id: string; name: string }[];
  from: number | null;
  to: number | null;
  historyHref: (from: number | null, to: number) => string;
  base: string;
  canRevert: boolean;
}) {
  if (!revisions.length) {
    return (
      <EmptyState framed icon={<GitPullRequestArrow />} title="No revisions you can see">
        Every applied proposal appends a revision. Older revisions may be hidden if they had a narrower audience than you can read.
      </EmptyState>
    );
  }
  const sorted = [...revisions].sort((a, b) => b.revision - a.revision);
  const toRev = sorted.find((r) => r.revision === to) ?? sorted[0];
  const older = sorted.filter((r) => r.revision < toRev.revision);
  const fromRev = (from !== null ? sorted.find((r) => r.revision === from) : undefined) ?? older[0] ?? null;
  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? "hidden group";

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <Card className="self-start">
        <CardHeader title="Revisions" description="Newest first. Pick one to compare." />
        <ol className="max-h-[70vh] divide-y divide-line overflow-y-auto">
          {sorted.map((r) => {
            const vs = verifications.filter((v) => v.revision === r.revision);
            const human = vs.some((v) => v.actor.startsWith("human:"));
            const active = r.revision === toRev.revision;
            return (
              <li key={r.id}>
                <Link
                  href={historyHref(null, r.revision)}
                  scroll={false}
                  aria-current={active ? "true" : undefined}
                  className={cn("block px-4 py-2.5 text-sm hover:bg-surface-2/70", active && "bg-surface-2")}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-fg">r{r.revision}</span>
                    {r.revision === currentRevision ? <span className="text-[11px] text-accent">current</span> : null}
                    {vs.length ? (
                      <span title={human ? "Verified by a person" : "Machine confirmed"} className={human ? "text-ok" : "text-info"}>
                        <BadgeCheck className="size-3.5" />
                      </span>
                    ) : null}
                    <span className="ml-auto text-xs text-subtle">
                      <Timestamp iso={r.created_at} />
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted">{actorLabel(r.actor, profiles)}</div>
                  {r.reason ? <div className="mt-0.5 line-clamp-2 text-xs text-subtle">{r.reason}</div> : null}
                </Link>
              </li>
            );
          })}
        </ol>
      </Card>

      <div className="min-w-0 space-y-4">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
            <div className="min-w-0 text-sm">
              <div className="font-medium text-fg">
                Revision {toRev.revision}
                {fromRev ? <span className="font-normal text-muted"> compared with revision {fromRev.revision}</span> : <span className="font-normal text-muted"> (first revision)</span>}
              </div>
              <div className="mt-0.5 text-xs text-subtle">
                {actorLabel(toRev.actor, profiles)} · <Timestamp iso={toRev.created_at} format="date" />
                {toRev.proposal_id ? (
                  <>
                    {" · "}
                    <Link href={`${base}/proposals/${toRev.proposal_id}`} className="text-accent hover:underline">
                      view proposal
                    </Link>
                  </>
                ) : null}
              </div>
              {toRev.reason ? <p className="mt-1.5 text-sm text-muted">{toRev.reason}</p> : null}
            </div>
            {canRevert && toRev.revision !== currentRevision ? <RevertButton conceptId={conceptId} revision={toRev.revision} base={base} /> : null}
          </div>
          {older.length > 0 ? (
            <form method="get" className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2 text-xs text-muted">
              <input type="hidden" name="tab" value="history" />
              <input type="hidden" name="to" value={toRev.revision} />
              <label htmlFor="from-rev">Compare against</label>
              <select
                // remount when the compared revisions change on client navigation (defaultValue is read only once)
                key={`${toRev.revision}:${fromRev?.revision ?? ""}`}
                id="from-rev"
                name="from"
                defaultValue={fromRev?.revision}
                className="h-7 rounded border border-line bg-surface px-2 text-xs text-fg"
              >
                {older.map((r) => (
                  <option key={r.id} value={r.revision}>
                    r{r.revision} · {actorLabel(r.actor, profiles)}
                  </option>
                ))}
              </select>
              <button type="submit" className="h-7 rounded border border-line bg-surface px-2 text-xs font-medium text-fg hover:bg-surface-2">
                Compare
              </button>
            </form>
          ) : null}
          {verifications.filter((v) => v.revision === toRev.revision).length ? (
            <ul className="border-t border-line px-4 py-2 text-xs text-muted">
              {verifications
                .filter((v) => v.revision === toRev.revision)
                .map((v) => (
                  <li key={v.id} className="flex items-start gap-1.5 py-0.5">
                    <BadgeCheck className={cn("mt-px size-3.5 shrink-0", v.actor.startsWith("human:") ? "text-ok" : "text-info")} />
                    <span>
                      Verified by {actorLabel(v.actor, profiles)} <Timestamp iso={v.created_at} />
                      {v.note ? <span className="text-subtle"> — “{v.note}”</span> : null}
                    </span>
                  </li>
                ))}
            </ul>
          ) : null}
        </Card>

        <section aria-label="Field changes">
          <h3 className="mb-2 text-sm font-medium text-fg">Fields</h3>
          {fromRev ? (
            <FieldDiff before={fields(fromRev, groupName)} after={fields(toRev, groupName)} />
          ) : (
            <FieldDiff before={{}} after={fields(toRev, groupName)} />
          )}
        </section>
        <section aria-label="Body changes">
          <h3 className="mb-2 text-sm font-medium text-fg">Body</h3>
          <DiffView
            before={fromRev?.body ?? ""}
            after={toRev.body}
            beforeLabel={fromRev ? `Revision ${fromRev.revision}` : "Empty"}
            afterLabel={`Revision ${toRev.revision}`}
          />
        </section>
      </div>
    </div>
  );
}
