import assert from "node:assert/strict";
import { test } from "node:test";
import type { CuratorProgress } from "@supaknowledge/core/progress";
import { buildTimeline, formatMs, parseProgress, runToShow } from "../src/lib/curator-progress.ts";
import { initials, nameList, viewersFrom } from "../src/lib/presence.ts";

const ME = "11111111-1111-1111-1111-111111111111";
const ANA = "22222222-2222-2222-2222-222222222222";
const BOB = "33333333-3333-3333-3333-333333333333";

test("viewersFrom lists other people once, reviewing first, and ignores malformed presence", () => {
  const state = {
    [ME]: [{ user_id: ME, state: "reviewing" }],
    [BOB]: [{ user_id: BOB, state: "viewing" }],
    [ANA]: [{ user_id: ANA, state: "viewing" }, { user_id: ANA, state: "reviewing" }],
    "not-a-uuid": [{ user_id: "not-a-uuid", state: "viewing" }],
    // a payload claiming another key's identity is ignored
    "44444444-4444-4444-4444-444444444444": [{ user_id: BOB, state: "reviewing" }],
  };
  assert.deepEqual(viewersFrom(state, ME), [
    { userId: ANA, state: "reviewing" },
    { userId: BOB, state: "viewing" },
  ]);
  assert.deepEqual(viewersFrom({ [ME]: [{ user_id: ME, state: "viewing" }] }, ME), [], "alone: nobody to show");
});

test("initials and name lists", () => {
  assert.equal(initials("Ana López"), "AL");
  assert.equal(initials("bob"), "B");
  assert.equal(initials("cleo.smith@example.com"), "CS");
  assert.equal(initials(""), "?");
  assert.equal(initials("Eli (engineer)"), "E");
  assert.equal(initials("Fiona Reyes (finance lead)"), "FR");
  assert.equal(nameList(["Ana"]), "Ana");
  assert.equal(nameList(["Ana", "Bob"]), "Ana and Bob");
  assert.equal(nameList(["Ana", "Bob", "Cleo"]), "Ana, Bob and Cleo");
  assert.equal(nameList(["Ana", "Bob", "Cleo", "Dan"]), "Ana, Bob and 2 others");
});

let at = 0;
function ev(task: string, step: string, e: Record<string, unknown>, run = "run-1", seq?: number): CuratorProgress {
  const ms = ++at;
  return { v: 1, seq: seq ?? ms, at: new Date(Date.UTC(2026, 10, 27, 10, 0, 0, ms)).toISOString(), run_id: run, task_id: task, step, ...e } as CuratorProgress;
}

test("parseProgress accepts curator events and rejects anything else", () => {
  assert.ok(parseProgress(ev("t", "draft", { type: "task_started", attempt: 1 })));
  assert.equal(parseProgress({ ...ev("t", "draft", { type: "task_started", attempt: 1 }), v: 2 }), null);
  assert.equal(parseProgress(ev("t", "draft", { type: "drop_tables" })), null);
  assert.equal(parseProgress(ev("t", "draft", { type: "model_call_started", purpose: "exfiltrate" })), null);
  assert.equal(parseProgress(ev("t", "draft", { type: "proposal_created" })), null);
  assert.equal(parseProgress("progress"), null);
  assert.equal(parseProgress(null), null);
});

test("buildTimeline shows a run step by step, one group per task", () => {
  const events = [
    ev("g", "gather", { type: "task_started", attempt: 1 }),
    ev("g", "gather", { type: "evidence", counts: { traces: 3 } }),
    ev("g", "gather", { type: "model_call_started", purpose: "mine" }),
    ev("g", "gather", { type: "model_call_finished", purpose: "mine", ok: true, ms: 1200, tokens: 900 }),
    ev("g", "gather", { type: "model_call_started", purpose: "mine" }),
    ev("g", "gather", { type: "model_call_finished", purpose: "mine", ok: true, ms: 800, tokens: 700 }),
    ev("g", "gather", { type: "lessons", traces_scanned: 3, traces_mined: 2, lessons: 1 }),
    ev("g", "gather", { type: "evidence", counts: { flags: 2, documents: 0 } }),
    ev("g", "gather", { type: "clusters", clusters: 2, deferred: 0, dismissed: 1 }),
    ev("g", "gather", { type: "task_finished" }),
    ev("d1", "draft", { type: "task_started", attempt: 1 }),
    ev("d1", "draft", { type: "evidence", counts: { flags: 1, traces: 1, documents: 0, source_excerpts: 2, concepts: 1, related: 0, rejections: 0 } }),
    ev("d1", "draft", { type: "model_call_started", purpose: "draft" }),
    ev("d1", "draft", { type: "model_call_finished", purpose: "draft", ok: true, ms: 12_400, tokens: 8000 }),
    ev("d1", "draft", { type: "draft_ops", ops: { update: 1 }, citations: 2, problems: 0 }),
    ev("d1", "draft", { type: "model_call_started", purpose: "review" }),
    ev("d1", "draft", { type: "model_call_finished", purpose: "review", ok: true, ms: 3000, tokens: 2000 }),
    ev("d1", "draft", { type: "self_review", ok: true, issues: 0, blockers: 0, skipped: false }),
    ev("d1", "draft", { type: "proposal_created", proposal_id: "p1" }),
    ev("d1", "draft", { type: "proposal_applied", proposal_id: "p1" }),
    ev("d1", "draft", { type: "task_finished" }),
    ev("d2", "draft", { type: "task_started", attempt: 1 }),
    ev("d2", "draft", { type: "model_call_started", purpose: "draft" }),
    ev("x", "draft", { type: "task_started", attempt: 1 }, "another-run"),
  ];
  // delivered out of order (replay + live): sorted by time
  const groups = buildTimeline([...events].reverse(), "run-1");
  assert.deepEqual(groups.map((g) => [g.label, g.state]), [["Gather", "done"], ["Draft 1", "done"], ["Draft 2", "running"]]);
  assert.deepEqual(groups[0].rows.map((r) => r.text), [
    "3 new traces to scan",
    "Checked 2 traces for corrections",
    "Mined 1 lesson from 2 traces",
    "2 open flags",
    "Queued 2 drafts, dismissed 1 flag",
  ]);
  assert.equal(groups[0].rows[1].detail, "2.0 s");
  assert.deepEqual(groups[1].rows.map((r) => [r.kind, r.text]), [
    ["info", "Working from 1 flag, 1 trace, 2 source excerpts, 1 concept to change"],
    ["done", "Drafted a changeset"],
    ["info", "Changeset with 1 update and 2 citations"],
    ["done", "Self-reviewed the changeset"],
    ["info", "Self-review found no issues"],
    ["proposal", "Proposal created"],
    ["applied", "Applied by the space's auto-apply policy"],
  ]);
  assert.equal(groups[1].rows[5].proposalId, "p1");
  assert.deepEqual(groups[2].rows.map((r) => [r.kind, r.text]), [["pending", "Researching and drafting a changeset"]]);
  assert.deepEqual(buildTimeline(events, null), []);
});

test("buildTimeline marks retries and failures, and calls cut off by a failure", () => {
  const groups = buildTimeline([
    ev("d", "draft", { type: "task_started", attempt: 1 }),
    ev("d", "draft", { type: "model_call_started", purpose: "draft" }),
    ev("d", "draft", { type: "task_failed", final: false }),
    ev("d", "draft", { type: "task_started", attempt: 2 }, "run-1", 1),
    ev("d", "draft", { type: "model_call_started", purpose: "draft" }, "run-1", 2),
    ev("d", "draft", { type: "model_call_finished", purpose: "draft", ok: false, ms: 500, tokens: 0 }, "run-1", 3),
    ev("d", "draft", { type: "task_failed", final: true }, "run-1", 4),
  ], "run-1");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].state, "failed");
  assert.deepEqual(groups[0].rows.map((r) => [r.kind, r.text]), [
    ["fail", "Researching and drafting a changeset"],
    ["fail", "Task failed, the queue retries it"],
    ["warn", "Attempt 2"],
    ["fail", "Drafting failed"],
    ["fail", "Task failed"],
  ]);
});

test("runToShow prefers the active run, then the newest run that sent events", () => {
  const events = [ev("a", "gather", { type: "task_finished" }, "old"), ev("b", "gather", { type: "task_started", attempt: 1 }, "new")];
  assert.equal(runToShow("active", events, "latest"), "active");
  assert.equal(runToShow(null, events, "latest"), "new");
  assert.equal(runToShow(null, [], "latest"), "latest");
  assert.equal(runToShow(null, [], null), null);
});

test("formatMs", () => {
  assert.equal(formatMs(450), "450 ms");
  assert.equal(formatMs(1234), "1.2 s");
  assert.equal(formatMs(12_400), "12 s");
  assert.equal(formatMs(125_000), "2 min 5 s");
});
