// The offline eval is deterministic, so CI can hold it to the behaviour the scripts define: the curator's fixes
// change what the same scripted agent does on the same tasks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importBundle, lintConcept, parsePgError } from "@supaknowledge/core";
import { renderTable, writeResults } from "../src/harness.ts";
import { curatorLine } from "../src/cli.ts";
import { evalBundle, OFFLINE_NOTE, runOfflineEval } from "../src/offline.ts";
import { mentionsAmount, SUBSCRIPTIONS_PATH, TASKS } from "../src/tasks.ts";
import { ACTIVE_SUBSCRIPTIONS, executeSql, listTables, resultRows } from "../src/worlds.ts";

test("the eval bundle (revenue-report + the eval's concepts) is valid OKF", () => {
  const parsed = importBundle(evalBundle(), { toId: (s) => (s === "finance" ? "g-finance" : undefined), toSlug: (id) => id });
  assert.deepEqual(parsed.warnings, []);
  const sub = parsed.concepts.find((c) => c.draft.path === SUBSCRIPTIONS_PATH)!;
  assert.equal(sub.draft.kind, "data_access");
  assert.deepEqual(lintConcept(sub.draft, sub.files), []);
});

test("the simulated app database answers like Postgres", () => {
  assert.equal(parsePgError(executeSql("select count(*) from public.subscriptions").content[0]!.text)!.condition, "undefined_table");
  const bad = executeSql("select count(*) from billing.subscriptions where status = 'active'");
  assert.equal(bad.isError, true);
  assert.equal(parsePgError(bad.content[0]!.text)!.condition, "invalid_enum_value");
  const ok = executeSql("select plan, count(*) as active from billing.subscriptions where status = 'live' group by plan");
  assert.equal(ok.isError, undefined);
  assert.equal(resultRows(ok).reduce((n, r) => n + Number(r.active), 0), ACTIVE_SUBSCRIPTIONS);
  assert.match(listTables().content[0]!.text, /billing\.subscriptions/);
});

test("answer checks accept the usual ways of writing an amount", () => {
  assert.ok(mentionsAmount("NA: $2.1M", 2_140_000));
  assert.ok(mentionsAmount("NA: 2,140,000 USD", 2_140_000));
  assert.ok(mentionsAmount("APAC $640K", 640_000));
  assert.ok(!mentionsAmount("APAC $650K", 640_000));
  assert.equal(TASKS.length, 5);
  assert.equal(new Set(TASKS.map((t) => t.id)).size, TASKS.length);
});

test("offline eval: the same agent does better after the curator run and review", async () => {
  const { results, store } = await runOfflineEval();
  assert.equal(results.mode, "offline");
  assert.equal(results.agent, "scripted");
  assert.equal(results.curator_model, "scripted");
  assert.equal(results.note, OFFLINE_NOTE);
  assert.equal(results.curator.run_status, "succeeded");

  const byId = Object.fromEntries(results.tasks.map((t) => [t.id, t]));
  // the renamed BigQuery column: recovered before (with an error and a flag), clean after the auto-applied fix
  assert.deepEqual([byId["revenue-by-region"]!.before.success, byId["revenue-by-region"]!.before.tool_errors, byId["revenue-by-region"]!.before.agent_flags], [true, 1, 1]);
  assert.deepEqual([byId["revenue-by-region"]!.after.success, byId["revenue-by-region"]!.after.tool_errors], [true, 0]);
  // the human correction becomes a skill change; it needs review, then the report passes
  assert.equal(byId["revenue-report"]!.before.success, false);
  assert.equal(byId["revenue-report"]!.before.corrected, true);
  assert.equal(byId["revenue-report"]!.after.success, true);
  // Supabase MCP execute_sql errors become SQL-error flags without the agent flagging anything
  const subs = byId["active-subscriptions"]!;
  assert.deepEqual([subs.before.success, subs.before.tool_errors, subs.before.agent_flags, subs.before.sql_error_flags], [false, 2, 0, 2]);
  assert.deepEqual([subs.after.success, subs.after.tool_errors, subs.after.sql_error_flags], [true, 0, 0]);
  // control: nothing to fix, nothing changes
  assert.deepEqual([byId["arr-definition"]!.before.success, byId["arr-definition"]!.after.success], [true, true]);
  // the explanation is finance-only: the curator proposes nothing for everyone, so the task still fails
  assert.deepEqual([byId["arr-board-pack"]!.before.success, byId["arr-board-pack"]!.after.success], [false, false]);

  assert.equal(results.summary.before.succeeded, 2);
  assert.equal(results.summary.after.succeeded, 4);
  assert.ok(results.summary.after.tool_errors < results.summary.before.tool_errors);

  // what the curator saw of the Supabase MCP calls: redacted SQL, no rows
  const trace = store.traces.find((t) => t.id === "trace-before-active-subscriptions")!;
  const sql = trace.events.filter((e) => e.tool_name === "mcp__supabase__execute_sql");
  assert.ok(sql.length === 2 && sql.every((e) => e.is_error));
  assert.ok(sql.every((e) => /status = '\?'/.test(JSON.stringify(e.tool_input))));
  const sqlFlags = store.flags.filter((f) => f.evidence.source === "sql-error");
  assert.deepEqual(sqlFlags.map((f) => f.evidence.condition).sort(), ["invalid_enum_value", "undefined_table"]);
  assert.ok(sqlFlags.every((f) => f.concept_path === SUBSCRIPTIONS_PATH && f.status === "resolved"));

  const table = renderTable(results);
  assert.match(table, /^total\s+2\/5\s+4\s+5\s+4\/5\s+0\s+1\s*$/m);
  assert.match(curatorLine(results), /3 proposal\(s\), 2 auto-applied by policy, 1 approved in review/);

  const out = join(mkdtempSync(join(tmpdir(), "kf-eval-")), "offline.json");
  writeResults(out, results);
  assert.equal(JSON.parse(readFileSync(out, "utf8")).summary.after.succeeded, 4);
});

test("without review, the skill change stays pending and the report still fails", async () => {
  const { results } = await runOfflineEval({ review: false });
  const report = results.tasks.find((t) => t.id === "revenue-report")!;
  assert.equal(report.after.success, false);
  assert.equal(results.summary.after.succeeded, 3);
  assert.ok(results.curator.proposals.some((p) => p.status === "pending" && p.paths.includes("skills/revenue-report")));
});
