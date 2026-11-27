// What both modes share: recording a task's tool calls, the metrics per task and phase, the terminal table and
// the JSON results file.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Trace, TraceEvent } from "@supaknowledge/core";
import { sqlErrorFlags } from "@supaknowledge/core/curator";
import type { EvalTask } from "./tasks.ts";

/** One agent run on one task, as the harness saw it. */
export interface TaskRun {
  task: string;
  /** did the answer pass the task's check (before any correction)? */
  success: boolean;
  /** failed tool calls (warehouse, execute_sql, knowledge tools) */
  tool_errors: number;
  /** flags the agent raised itself (flag_knowledge) */
  agent_flags: number;
  /** flags the curator mines from the trace's failed SQL calls without a model (Postgres errors) */
  sql_error_flags: number;
  /** a human correction was recorded on the trace */
  corrected: boolean;
  /** the answer, clipped */
  answer: string;
  trace_id: string | null;
}

export interface PhaseSummary {
  tasks: number;
  succeeded: number;
  success_rate: number;
  tool_errors: number;
  flags: number;
}

export interface CuratorSummary {
  run_status: string;
  stats: Record<string, unknown>;
  proposals: { title: string; risk: string; status: string; auto_applied: boolean; escalation: boolean; paths: string[] }[];
  /** what the simulated reviewer did between the curator run and the second phase */
  review: string;
}

export interface EvalResults {
  mode: "offline" | "live";
  /** who answered the tasks: "scripted" or the model id */
  agent: string;
  /** who drafted the curator's proposals: "scripted" or "KF_LLM_MODEL of the Edge Functions" */
  curator_model: string;
  note: string;
  generated_at: string;
  tasks: { id: string; title: string; before: TaskRun; after: TaskRun }[];
  summary: { before: PhaseSummary; after: PhaseSummary };
  curator: CuratorSummary;
}

/** A tool event as the harness records it (the same fields the traces function stores). */
export interface ToolCall {
  name: string;
  input: unknown;
  output: unknown;
  isError: boolean;
}

/** Collects one task's tool calls and flags, whatever records the trace itself. */
export class TaskLog {
  calls: ToolCall[] = [];
  agentFlags = 0;

  tool(name: string, input: unknown, output: unknown, isError: boolean): void {
    this.calls.push({ name, input, output, isError });
  }

  /** The curator's deterministic SQL-error flags for these calls (no model). */
  sqlErrorFlags(): number {
    const events: TraceEvent[] = this.calls.map((c, i) => ({ seq: i, role: "tool", tool_name: c.name, tool_input: c.input, tool_output: c.output, is_error: c.isError }));
    const trace: Trace = { id: "local", space_id: "local", principal_id: null, name: null, outcome: "unknown", audience: [], metadata: {}, started_at: "", events };
    return sqlErrorFlags(trace).length;
  }

  result(task: EvalTask, answer: string, success: boolean, corrected: boolean, traceId: string | null): TaskRun {
    return {
      task: task.id,
      success,
      tool_errors: this.calls.filter((c) => c.isError).length,
      agent_flags: this.agentFlags,
      sql_error_flags: this.sqlErrorFlags(),
      corrected,
      answer: answer.length > 400 ? `${answer.slice(0, 400)}…` : answer,
      trace_id: traceId,
    };
  }
}

export function summarize(runs: TaskRun[]): PhaseSummary {
  const succeeded = runs.filter((r) => r.success).length;
  return {
    tasks: runs.length,
    succeeded,
    success_rate: runs.length ? succeeded / runs.length : 0,
    tool_errors: runs.reduce((n, r) => n + r.tool_errors, 0),
    flags: runs.reduce((n, r) => n + r.agent_flags + r.sql_error_flags, 0),
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function cells(r: TaskRun): string[] {
  const flags = r.agent_flags + r.sql_error_flags;
  return [r.success ? "yes" : "no", String(r.tool_errors), r.sql_error_flags ? `${flags} (${r.sql_error_flags} SQL)` : String(flags)];
}

/** The compact terminal table: one row per task, before and after side by side, then the totals. */
export function renderTable(results: EvalResults): string {
  const idW = Math.max(12, ...results.tasks.map((t) => t.id.length)) + 2;
  const cols = ["passed", "tool errors", "flags"];
  const w = [8, 13, 12];
  const group = w.reduce((a, b) => a + b, 0) + 2;
  const row = (id: string, a: string[], b: string[]) => pad(id, idW) + a.map((c, i) => pad(c, w[i]!)).join("") + "  " + b.map((c, i) => pad(c, w[i]!)).join("");
  const lines = [
    pad("", idW) + pad("before", group) + "after",
    row("task", cols, cols),
    ...results.tasks.map((t) => row(t.id, cells(t.before), cells(t.after))),
  ];
  const s = results.summary;
  const total = (p: PhaseSummary) => [`${p.succeeded}/${p.tasks}`, String(p.tool_errors), String(p.flags)];
  lines.push(row("total", total(s.before), total(s.after)));
  return lines.map((l) => l.trimEnd()).join("\n");
}

export function writeResults(path: string, results: EvalResults): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(results, null, 2) + "\n");
}
