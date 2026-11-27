import { Check, Circle, FileDiff, Loader2, TriangleAlert, X, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import type { CuratorProgress } from "@supaknowledge/core/progress";
import { RunCuratorButton } from "@/components/activity/run-curator-button";
import { StatusDot } from "@/components/kf/badges";
import { Timestamp } from "@/components/kf/timestamp";
import { Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { Link } from "@/components/ui/link";
import { buildTimeline, parseProgress, runToShow } from "@/lib/curator-progress";
import type { GroupState, RowKind, TimelineRow } from "@/lib/curator-progress";
import { joinChannel } from "@/lib/realtime";
import { createClient } from "@/lib/supabase/client";

export interface LiveRun {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** keep replaying a finished run's steps for this long after it ended */
const RECENT_MS = 30 * 60_000;

/**
 * The space's curator, live: whether it is running and, step by step, what the current (or just finished) run does.
 * Steps arrive over Realtime Broadcast on the private channel curator:<space id> (editors and up; see
 * kf_curator_progress()). They carry ids and counts only; a proposal's title is read through RLS here, so someone who
 * cannot see the proposal never sees it. On join, stored events of the shown run are replayed (up to 25).
 */
export function CuratorLive({ spaceId, base, runs, canRun }: { spaceId: string; base: string; runs: LiveRun[]; canRun: boolean }) {
  const active = runs.find((r) => r.status === "queued" || r.status === "running") ?? null;
  const latest = runs[0] ?? null;
  const lastFinished = runs.find((r) => r.finished_at) ?? null;
  const [events, setEvents] = useState<CuratorProgress[]>([]);
  // replay from the run worth showing at mount: the active one, or one that ended recently
  const [replaySince] = useState(() => {
    const r = active ?? latest;
    if (!r) return undefined;
    if (!active && (!r.finished_at || Date.now() - Date.parse(r.finished_at) > RECENT_MS)) return undefined;
    return Date.parse(r.created_at) - 5_000;
  });

  useEffect(() => {
    const seen = new Set<string>();
    const h = joinChannel(`curator:${spaceId}`, { broadcast: { replaySince } }, {
      onBroadcast: (msg) => {
        const e = parseProgress(msg.payload);
        if (!e) return;
        const id = msg.meta?.id ?? `${e.task_id}|${e.at}|${e.seq}`;
        if (seen.has(id)) return;
        seen.add(id);
        setEvents((prev) => [...prev, e].slice(-500));
      },
    });
    return () => h.leave();
  }, [spaceId, replaySince]);

  const shown = runToShow(active?.id ?? null, events, latest?.id ?? null);
  const groups = buildTimeline(events, shown);

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-medium text-fg">
            <StatusDot tone={active ? (active.status === "running" ? "info" : "neutral") : "neutral"} />
            {active ? (active.status === "running" ? "Curator running" : "Curator run queued") : "Curator not running"}
          </h2>
          <p className="mt-0.5 text-xs text-subtle">
            {active ? (
              active.started_at ? (
                <>
                  Started <Timestamp iso={active.started_at} />
                </>
              ) : (
                "Waiting for a worker"
              )
            ) : lastFinished?.finished_at ? (
              <>
                Last run finished <Timestamp iso={lastFinished.finished_at} />
              </>
            ) : (
              "No run has finished yet"
            )}
          </p>
        </div>
        {canRun ? <RunCuratorButton spaceId={spaceId} active={Boolean(active)} /> : null}
      </div>
      {groups.length ? (
        <ol className="flex flex-col gap-3 border-t border-line px-4 py-3" aria-live="polite">
          {groups.map((g) => (
            <li key={g.taskId}>
              <div className="flex items-center gap-2 text-xs font-medium text-muted">
                <GroupIcon state={g.state} />
                {g.label}
              </div>
              {g.rows.length ? (
                <ul className="mt-1 ml-[7px] flex flex-col gap-1 border-l border-line pl-4">
                  {g.rows.map((r) => (
                    <Row key={r.key} row={r} base={base} />
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </Card>
  );
}

function GroupIcon({ state }: { state: GroupState }) {
  if (state === "running") return <Loader2 className="size-3.5 animate-spin text-info" aria-label="Running" />;
  if (state === "done") return <Check className="size-3.5 text-ok" aria-label="Done" />;
  if (state === "retrying") return <TriangleAlert className="size-3.5 text-warn" aria-label="Will be retried" />;
  return <X className="size-3.5 text-danger" aria-label="Failed" />;
}

const ROW_ICON: Record<RowKind, { icon: typeof Check; className: string }> = {
  info: { icon: Circle, className: "size-2 fill-current text-subtle" },
  pending: { icon: Loader2, className: "size-3.5 animate-spin text-info" },
  done: { icon: Check, className: "size-3.5 text-ok" },
  warn: { icon: TriangleAlert, className: "size-3.5 text-warn" },
  fail: { icon: X, className: "size-3.5 text-danger" },
  proposal: { icon: FileDiff, className: "size-3.5 text-accent" },
  applied: { icon: Zap, className: "size-3.5 text-ok" },
};

function Row({ row, base }: { row: TimelineRow; base: string }) {
  const { icon: Icon, className } = ROW_ICON[row.kind];
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className="flex h-5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
        <Icon className={className} />
      </span>
      <span className={cn("min-w-0 flex-1", row.kind === "pending" ? "text-fg" : "text-muted")}>
        {row.kind === "proposal" && row.proposalId ? <ProposalTitle id={row.proposalId} base={base} /> : row.text}
      </span>
      {row.detail ? <span className="shrink-0 text-xs text-subtle tabular-nums">{row.detail}</span> : null}
    </li>
  );
}

const titles = new Map<string, string | null>();

/** The proposal's title, read as the viewer: a proposal they cannot see (restricted evidence) stays unnamed. */
function ProposalTitle({ id, base }: { id: string; base: string }) {
  const [title, setTitle] = useState<string | null | undefined>(titles.get(id));
  useEffect(() => {
    if (titles.has(id)) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await createClient().from("proposals").select("title").eq("id", id).maybeSingle();
      if (error) return; // transient: leave it unresolved
      titles.set(id, data?.title ?? null);
      if (!cancelled) setTitle(data?.title ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);
  if (title === undefined) return <>Proposal created</>;
  if (title === null) return <>Created a proposal you can&apos;t open: it involves knowledge outside your groups</>;
  return (
    <>
      Proposed{" "}
      <Link href={`${base}/proposals/${id}`} className="text-accent hover:underline">
        {title}
      </Link>
    </>
  );
}
