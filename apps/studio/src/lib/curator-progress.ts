// Turns the curator's live progress events (Realtime Broadcast on curator:<space id>, see
// packages/core/src/curator/progress.ts) into the step list Studio shows on Activity. Pure, so it is tested in Node.
import type { CuratorProgress, ModelPurpose } from "@supaknowledge/core/progress";

const TYPES = new Set([
  "task_started", "evidence", "model_call_started", "model_call_finished", "lessons", "clusters", "stale", "draft_ops",
  "self_review", "no_change", "draft_invalid", "proposal_created", "proposal_applied", "task_finished", "task_failed",
]);
const PURPOSES = new Set<ModelPurpose>(["mine", "triage", "draft", "repair", "review"]);

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** A progress event from a broadcast payload, or null when it is not one this version understands. */
export function parseProgress(payload: unknown): CuratorProgress | null {
  if (!payload || typeof payload !== "object") return null;
  const e = payload as Record<string, unknown>;
  if (e.v !== 1 || typeof e.type !== "string" || !TYPES.has(e.type)) return null;
  if (typeof e.run_id !== "string" || typeof e.task_id !== "string" || typeof e.step !== "string" || typeof e.at !== "string") return null;
  if (typeof e.seq !== "number") return null;
  if ((e.type === "model_call_started" || e.type === "model_call_finished") && !PURPOSES.has(e.purpose as ModelPurpose)) return null;
  if ((e.type === "proposal_created" || e.type === "proposal_applied") && typeof e.proposal_id !== "string") return null;
  return e as unknown as CuratorProgress;
}

export type RowKind = "info" | "pending" | "done" | "warn" | "fail" | "proposal" | "applied";

export interface TimelineRow {
  key: string;
  kind: RowKind;
  text: string;
  /** right-aligned detail, such as the duration of a model call */
  detail?: string;
  proposalId?: string;
}

export type GroupState = "running" | "done" | "retrying" | "failed";

export interface TimelineGroup {
  taskId: string;
  label: string;
  state: GroupState;
  rows: TimelineRow[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

const STEP_LABEL: Record<string, string> = { gather: "Gather", triage: "Triage", draft: "Draft", sweep: "Staleness sweep" };

const MODEL_LABEL: Record<ModelPurpose, { pending: string; done: string; failed: string }> = {
  mine: { pending: "Checking traces for corrections", done: "Checked traces for corrections", failed: "A trace check failed" },
  triage: { pending: "Grouping signals into topics", done: "Grouped signals into topics", failed: "Grouping failed" },
  draft: { pending: "Researching and drafting a changeset", done: "Drafted a changeset", failed: "Drafting failed" },
  repair: { pending: "Fixing what the check found", done: "Revised the changeset", failed: "Revision failed" },
  review: { pending: "Self-reviewing the changeset", done: "Self-reviewed the changeset", failed: "Self-review failed" },
};

const EVIDENCE_LABEL: [key: string, one: string, many?: string][] = [
  ["flags", "flag"],
  ["traces", "trace"],
  ["documents", "document"],
  ["source_excerpts", "source excerpt"],
  ["concepts", "concept to change", "concepts to change"],
  ["related", "related concept"],
  ["rejections", "rejected proposal"],
];

function evidenceText(e: Extract<CuratorProgress, { type: "evidence" }>): string {
  const counts = e.counts ?? {};
  const keys = Object.keys(counts);
  if (keys.length === 1 && keys[0] === "traces" && e.step === "gather") {
    return num(counts.traces) ? `${plural(num(counts.traces), "new trace")} to scan` : "No new traces";
  }
  if (e.step !== "draft" && keys.every((k) => k === "flags" || k === "documents")) {
    // triage: open flags and documents changed since the last run
    if (!num(counts.flags) && !num(counts.documents)) return "No open flags or changed documents";
    return [num(counts.flags) ? plural(num(counts.flags), "open flag") : "", num(counts.documents) ? plural(num(counts.documents), "changed document") : ""]
      .filter(Boolean)
      .join(", ");
  }
  const parts = EVIDENCE_LABEL.filter(([k]) => num(counts[k]) > 0).map(([k, one, many]) => plural(num(counts[k]), one, many));
  return parts.length ? `Working from ${parts.join(", ")}` : "No evidence found";
}

const OP_LABEL: Record<string, [string, string]> = {
  update: ["update", "updates"],
  create: ["new concept", "new concepts"],
  deprecate: ["deprecation", "deprecations"],
  move: ["move", "moves"],
};

/** Events of one run as groups (one per task, in the order they started) of display rows. */
export function buildTimeline(events: CuratorProgress[], runId: string | null): TimelineGroup[] {
  if (!runId) return [];
  const seen = new Set<string>();
  const own = events
    .filter((e) => e.run_id === runId)
    .filter((e) => {
      const k = `${e.task_id}|${e.at}|${e.seq}|${e.type}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (a.at === b.at ? a.seq - b.seq : a.at < b.at ? -1 : 1));

  const groups = new Map<string, TimelineGroup & { mine: { started: number; finished: number; failed: number; ms: number; tokens: number; key: string } | null; open: Map<ModelPurpose, TimelineRow[]> }>();
  const drafts = { n: 0 };
  for (const e of own) {
    let g = groups.get(e.task_id);
    if (!g) {
      const label = e.step === "draft" ? `Draft ${++drafts.n}` : (STEP_LABEL[e.step] ?? e.step);
      g = { taskId: e.task_id, label, state: "running", rows: [], mine: null, open: new Map() };
      groups.set(e.task_id, g);
    }
    const key = `${e.task_id}:${e.at}:${e.seq}`;
    switch (e.type) {
      case "task_started":
        // calls still open from an earlier attempt were cut off by its failure
        for (const rows of g.open.values()) for (const r of rows) r.kind = "fail";
        g.open.clear();
        g.state = "running";
        if (e.attempt > 1) g.rows.push({ key, kind: "warn", text: `Attempt ${e.attempt}` });
        break;
      case "evidence":
        g.rows.push({ key, kind: "info", text: evidenceText(e) });
        break;
      case "model_call_started":
        if (e.purpose === "mine") {
          if (!g.mine) {
            g.mine = { started: 0, finished: 0, failed: 0, ms: 0, tokens: 0, key };
            g.rows.push({ key, kind: "pending", text: MODEL_LABEL.mine.pending });
          }
          g.mine.started++;
        } else {
          const row: TimelineRow = { key, kind: "pending", text: MODEL_LABEL[e.purpose].pending };
          g.rows.push(row);
          g.open.set(e.purpose, [...(g.open.get(e.purpose) ?? []), row]);
        }
        break;
      case "model_call_finished": {
        if (e.purpose === "mine") {
          if (!g.mine) {
            g.mine = { started: 1, finished: 0, failed: 0, ms: 0, tokens: 0, key };
            g.rows.push({ key, kind: "pending", text: MODEL_LABEL.mine.pending });
          }
          g.mine.finished++;
          if (!e.ok) g.mine.failed++;
          g.mine.ms += num(e.ms);
          g.mine.tokens += num(e.tokens);
          break;
        }
        const open = g.open.get(e.purpose) ?? [];
        const row = open.shift();
        const text = e.ok ? MODEL_LABEL[e.purpose].done : MODEL_LABEL[e.purpose].failed;
        const done: TimelineRow = { key: row?.key ?? key, kind: e.ok ? "done" : "fail", text, detail: formatMs(num(e.ms)) };
        if (row) Object.assign(row, done);
        else g.rows.push(done);
        break;
      }
      case "lessons":
        g.rows.push({
          key,
          kind: "info",
          text: e.lessons ? `Mined ${plural(e.lessons, "lesson")} from ${plural(e.traces_mined, "trace")}` : `No corrections in ${plural(e.traces_scanned, "trace")}`,
        });
        break;
      case "clusters": {
        const parts = [e.clusters ? `Queued ${plural(e.clusters, "draft")}` : "Nothing to draft"];
        if (e.deferred) parts.push(`${plural(e.deferred, "topic")} left for the next run`);
        if (e.dismissed) parts.push(`dismissed ${plural(e.dismissed, "flag")}`);
        g.rows.push({ key, kind: "info", text: parts.join(", ") });
        break;
      }
      case "stale":
        g.rows.push({ key, kind: "info", text: e.concepts ? `${plural(e.concepts, "concept")} past their review date` : "No concept is past its review date" });
        break;
      case "draft_ops": {
        const ops = Object.entries(e.ops ?? {})
          .filter(([, n]) => num(n) > 0)
          .map(([op, n]) => {
            const [one, many] = OP_LABEL[op] ?? [op, `${op}s`];
            return plural(num(n), one, many);
          });
        const text = `Changeset with ${ops.join(", ") || "no changes"} and ${plural(e.citations, "citation")}`;
        g.rows.push({ key, kind: e.problems ? "warn" : "info", text: e.problems ? `${text}. The check found ${plural(e.problems, "problem")}` : text });
        break;
      }
      case "self_review":
        g.rows.push(
          e.skipped
            ? { key, kind: "warn", text: "Self-review skipped" }
            : e.ok && !e.issues
              ? { key, kind: "info", text: "Self-review found no issues" }
              : { key, kind: "warn", text: `Self-review raised ${plural(e.issues, "issue")}${e.blockers ? `, ${plural(e.blockers, "blocker")}` : ""}` },
        );
        break;
      case "no_change":
        g.rows.push({ key, kind: "info", text: e.dismissed ? `No change needed, dismissed ${plural(e.dismissed, "flag")}` : "No change needed" });
        break;
      case "draft_invalid":
        g.rows.push({ key, kind: "warn", text: "No valid change left after the check" });
        break;
      case "proposal_created":
        g.rows.push({ key, kind: "proposal", text: "Proposal created", proposalId: e.proposal_id });
        break;
      case "proposal_applied":
        g.rows.push({ key, kind: "applied", text: "Applied by the space's auto-apply policy", proposalId: e.proposal_id });
        break;
      case "task_finished":
        g.state = "done";
        break;
      case "task_failed":
        g.state = e.final ? "failed" : "retrying";
        g.rows.push({ key, kind: "fail", text: e.final ? "Task failed" : "Task failed, the queue retries it" });
        break;
    }
  }

  return [...groups.values()].map(({ mine, open: _open, ...g }) => {
    if (mine) {
      const row = g.rows.find((r) => r.key === mine.key)!;
      const pending = mine.finished < mine.started && g.state === "running";
      row.kind = pending ? "pending" : mine.failed === mine.finished ? "fail" : "done";
      row.text = pending
        ? `${MODEL_LABEL.mine.pending} (${mine.finished} of ${mine.started})`
        : `Checked ${plural(mine.finished, "trace")} for corrections${mine.failed ? `, ${mine.failed} failed` : ""}`;
      if (!pending) row.detail = formatMs(mine.ms);
    }
    // a call still "pending" in a task that ended was cut off
    if (g.state !== "running") for (const r of g.rows) if (r.kind === "pending") r.kind = "fail";
    return g;
  });
}

/** The run whose steps to show: the active one, else the most recent run that sent events, else the latest run. */
export function runToShow(activeRunId: string | null, events: CuratorProgress[], latestRunId: string | null): string | null {
  if (activeRunId) return activeRunId;
  let newest: CuratorProgress | null = null;
  for (const e of events) if (!newest || e.at > newest.at) newest = e;
  return newest?.run_id ?? latestRunId;
}
