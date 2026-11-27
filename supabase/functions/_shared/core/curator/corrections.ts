// Mining "correction moments" from agent traces: places where a human corrected the agent or the agent
// recovered from an error. A cheap heuristic pass picks candidate traces; a fast model extracts lessons.
import type { LLM } from "../llm.ts";
import type { Trace, TraceEvent } from "../types.ts";
import { CORRECTIONS_SYSTEM, UNTRUSTED_DATA_RULE, untrusted, withHouseRules } from "./prompts.ts";
import { CorrectionSchema, type CorrectionOutput } from "./schemas.ts";
import type { NewSyntheticFlag } from "./store.ts";
import { stableHash } from "./hash.ts";
import { isMcpErrorResult, knowledgeTool, type PgError, parsePgError, redactSql, sqlToolCall } from "../sql-errors.ts";

const CORRECTION_CUES = [
  /\b(no|nope),?\s/i,
  /\bactually\b/i,
  /\bthat'?s (wrong|not right|incorrect|outdated)\b/i,
  /\b(instead|rather)\b/i,
  /\bshould (be|use|have)\b/i,
  /\b(we|they) (always|never|usually)\b/i,
  /\bfrom now on\b/i,
  /\b(please )?(remember|don'?t forget)\b/i,
  /\b(renamed|deprecated|moved to|no longer)\b/i,
  /\bwrong (table|column|number|format|header|source)\b/i,
];

export interface TraceSignalScore {
  score: number;
  reasons: string[];
}

/** Heuristic score: how likely is this trace to contain a correction worth learning from? */
export function scoreTrace(trace: Trace): TraceSignalScore {
  const reasons: string[] = [];
  let score = 0;
  if (trace.outcome === "corrected") {
    score += 3;
    reasons.push("outcome=corrected");
  } else if (trace.outcome === "failure") {
    score += 2;
    reasons.push("outcome=failure");
  }
  let sawAssistant = false;
  const failedTools = new Map<string, number>();
  for (const e of trace.events) {
    if (e.role === "feedback") {
      score += 3;
      reasons.push(`feedback@${e.seq}`);
    }
    if (e.role === "assistant") sawAssistant = true;
    if (e.role === "user" && sawAssistant && e.content && CORRECTION_CUES.some((re) => re.test(e.content!))) {
      score += 2;
      reasons.push(`user-correction@${e.seq}`);
    }
    if (e.role === "tool" && e.tool_name) {
      if (e.is_error) failedTools.set(e.tool_name, e.seq);
      else if (failedTools.has(e.tool_name)) {
        score += 2;
        reasons.push(`tool-recovery:${e.tool_name}@${failedTools.get(e.tool_name)}->${e.seq}`);
        failedTools.delete(e.tool_name);
      }
    }
  }
  return { score, reasons };
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + ` …[${s.length - n} more chars]`;
}

function renderValue(v: unknown, n: number): string {
  if (v === null || v === undefined) return "";
  return clip(typeof v === "string" ? v : JSON.stringify(v), n);
}

/**
 * The events the correction heuristic points at, most important first: feedback and correcting user turns, then
 * failed tools (each with the later successful call of the same tool that shows the recovery, if any); within
 * each group the latest first, so a long trace never loses its late corrections to early errors.
 */
function signalEvents(events: TraceEvent[]): { at: number; recovery: number | null }[] {
  const human: number[] = [];
  const tools: { at: number; recovery: number | null }[] = [];
  let sawAssistant = false;
  events.forEach((e, i) => {
    if (e.role === "assistant") sawAssistant = true;
    if (e.role === "feedback") human.push(i);
    else if (e.role === "user" && sawAssistant && e.content && CORRECTION_CUES.some((re) => re.test(e.content!))) human.push(i);
    else if (e.role === "tool" && e.is_error) {
      let recovery: number | null = null;
      for (let j = i + 1; j < events.length; j++) {
        const r = events[j]!;
        if (r.role === "tool" && r.tool_name === e.tool_name && !r.is_error) {
          recovery = j;
          break;
        }
      }
      tools.push({ at: i, recovery });
    }
  });
  return [...human.reverse().map((at) => ({ at, recovery: null })), ...tools.reverse()];
}

/**
 * Compact transcript for the model: long tool payloads are clipped, structure is kept. A transcript over
 * maxChars keeps, in order and as far as each fits: the correction moments (human corrections first, then failed
 * tools with their recovery; latest first), the turn before each, the opening event, then as much of the end and
 * the start as fits (an event too large to fit is skipped, not a reason to stop).
 * Omitted runs are marked, so a correction late in a long trace is never cut off.
 */
export function renderTrace(trace: Trace, maxChars = 24_000): string {
  const header = `Trace ${trace.id} "${trace.name ?? ""}" outcome=${trace.outcome}`;
  const events = trace.events as TraceEvent[];
  const lines = events.map((e) => {
    const head = `[${e.seq}] ${e.role}${e.tool_name ? `:${e.tool_name}` : ""}${e.is_error ? " (ERROR)" : ""}`;
    const parts = [e.content ? clip(e.content, 2000) : "", e.tool_input !== undefined ? `input=${renderValue(e.tool_input, 800)}` : "", e.tool_output !== undefined ? `output=${renderValue(e.tool_output, 1200)}` : ""].filter(Boolean);
    return `${head}: ${parts.join(" | ")}`;
  });
  const omitted = (n: number) => `…[${n} event${n === 1 ? "" : "s"} omitted]`;
  const full = [header, ...lines].join("\n");
  if (full.length <= maxChars) return full;

  // Budget: every kept line costs its length + a newline; every run of omitted events costs one marker line.
  const MARKER = omitted(lines.length).length + 1;
  const budget = maxChars - header.length;
  const keep = new Array<boolean>(lines.length).fill(false);
  let used = MARKER; // nothing kept yet: one marker for the whole run
  const take = (i: number): void => {
    if (i < 0 || i >= lines.length || keep[i]) return;
    // i sits inside an omitted run (one marker); keeping it leaves a run on each side that is still omitted
    const markers = (i > 0 && !keep[i - 1] ? 1 : 0) + (i < lines.length - 1 && !keep[i + 1] ? 1 : 0) - 1;
    const cost = lines[i]!.length + 1 + markers * MARKER;
    if (used + cost > budget) return; // too big: smaller events further on may still fit
    keep[i] = true;
    used += cost;
  };
  const signals = signalEvents(events);
  for (const s of signals) {
    take(s.at);
    if (s.recovery !== null) take(s.recovery);
  }
  for (const s of signals) {
    take(s.at - 1);
    if (s.recovery !== null) take(s.recovery - 1);
  }
  take(0); // the opening event usually states the task
  for (let i = lines.length - 1; i >= 0; i--) take(i);
  for (let i = 0; i < lines.length; i++) take(i);

  const out = [header];
  let gap = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) {
      gap++;
      continue;
    }
    if (gap) out.push(omitted(gap));
    gap = 0;
    out.push(lines[i]!);
  }
  if (gap) out.push(omitted(gap));
  return clip(out.join("\n"), maxChars);
}

export async function extractLessons(
  llm: LLM,
  trace: Trace,
  opts: { instructions?: string; signal?: AbortSignal; alreadyFlagged?: NewSyntheticFlag[] } = {},
): Promise<CorrectionOutput> {
  const input = [untrusted(`trace:${trace.id}`, renderTrace(trace))];
  // SQL errors already became flags without the model: say so, so the model does not restate them as lessons
  if (opts.alreadyFlagged?.length) {
    input.push(
      "These SQL errors in the trace are already flagged; only add a lesson about them when the trace shows more than the error itself (for example a human explaining the fix):\n" +
        untrusted(`trace:${trace.id}:sql-flags`, opts.alreadyFlagged.map((f) => `- ${f.observation}`).join("\n")),
    );
  }
  const res = await llm.generate({
    system: withHouseRules(CORRECTIONS_SYSTEM + UNTRUSTED_DATA_RULE, opts.instructions ?? ""),
    input: input.length === 1 ? input[0]! : input,
    signal: opts.signal,
    schema: CorrectionSchema,
    tier: "fast",
    maxTokens: 4000,
  });
  return res.output;
}

/** Stable key of a lesson: normalized text + the event seqs it cites. */
export function lessonKey(lesson: string, seqs: number[]): string {
  return stableHash(`${lesson.toLowerCase().replace(/\s+/g, " ").trim()}|${[...seqs].sort((a, b) => a - b).join(",")}`);
}

export function lessonsToFlags(trace: Trace, out: CorrectionOutput): NewSyntheticFlag[] {
  return out.lessons
    .filter((l) => l.durable && l.lesson.trim())
    .map((l) => ({
      space_id: trace.space_id,
      trace_id: trace.id,
      kind: l.kind,
      concept_path: l.concept_path,
      query: null,
      observation: l.observation,
      suggested_fix: l.lesson,
      evidence: {
        seqs: l.seqs,
        quote: l.evidence_quote,
        knowledge_kind: l.knowledge_kind,
        source: "trace-correction",
        // same trace + same lesson => same key, so re-mining a trace (retries) never duplicates the flag
        dedupe_key: lessonKey(l.lesson, l.seqs),
      },
      audience: trace.audience,
    }));
}

// ---------------------------------------------------------------------------------------------------------
// SQL errors (Supabase MCP execute_sql / apply_migration, or any SQL tool) -> synthetic flags, no model needed
// ---------------------------------------------------------------------------------------------------------

/** At most this many SQL-error flags per trace (one per distinct condition + identifier). */
export const MAX_SQL_FLAGS_PER_TRACE = 5;

function outputText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The identifier a flag is about, as "column revenue_usd" / "table billing.subscriptions"... */
function subject(err: PgError): { label: string; leaf: string | null } {
  const id = err.identifiers;
  const leafOf = (s: string) => s.split(".").pop() ?? s;
  if (id.column) return { label: `column ${id.relation ? `${id.relation}.` : ""}${id.column}`, leaf: leafOf(id.column) };
  if (id.relation) return { label: `table ${id.relation}`, leaf: leafOf(id.relation) };
  if (id.schema) return { label: `schema ${id.schema}`, leaf: id.schema };
  if (id.function) return { label: `function ${id.function}`, leaf: leafOf(id.function.replace(/\(.*$/, "")) };
  if (id.type && id.value !== undefined) return { label: `enum ${id.type} value "${id.value}"`, leaf: id.value || null };
  if (id.type) return { label: `type ${id.type}`, leaf: leafOf(id.type) };
  if (id.role) return { label: `role ${id.role}`, leaf: id.role };
  if (id.operator) return { label: `operator ${id.operator}`, leaf: null };
  return { label: err.condition, leaf: null };
}

const CONDITION_TEXT: Record<string, string> = {
  undefined_column: "the column does not exist",
  undefined_table: "the table does not exist",
  undefined_function: "the function or operator does not exist",
  undefined_object: "the type or role does not exist",
  invalid_schema_name: "the schema does not exist",
  insufficient_privilege: "the caller lacks the privilege",
  rls_violation: "a row level security policy rejected the write",
  invalid_enum_value: "the value is not a label of the enum",
};

/**
 * Turn failed SQL tool calls in a trace into synthetic flags, without a model. A call counts when it is a
 * Supabase MCP `execute_sql` / `apply_migration` (any client prefix) or any tool whose input is SQL, it failed,
 * and its output is a Postgres error that knowledge could have prevented (undefined column, table, schema,
 * function or type, missing privilege, RLS, unknown enum value; syntax errors do not count).
 *
 * The flag names the identifier, carries the redacted failing SQL, the error, Postgres's hint and the redacted SQL
 * of a later successful call of the same tool (the recovery) as evidence, and never any row data. When the agent
 * read a concept (`read_concept` / `load_skill`) that mentions the identifier before the error, the flag is
 * about that concept (`incorrect`; `missing` for privilege errors); otherwise it is a `missing` flag.
 */
export function sqlErrorFlags(trace: Trace, max = MAX_SQL_FLAGS_PER_TRACE): NewSyntheticFlag[] {
  const events = trace.events as TraceEvent[];
  const out: NewSyntheticFlag[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < events.length && out.length < max; i++) {
    const e = events[i]!;
    if (e.role !== "tool") continue;
    const call = sqlToolCall(e);
    if (!call) continue;
    const text = typeof e.tool_output === "string" ? e.tool_output : "";
    const failed = !!e.is_error || isMcpErrorResult(e.tool_output) || /^\s*(?:ERROR:|\{\s*"error")/.test(text);
    if (!failed) continue;
    const err = parsePgError(e.tool_output);
    if (!err?.knowledge) continue;
    const subj = subject(err);
    const key = `${err.condition}|${subj.label.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // the recovery: the next successful call of the same tool
    let recovery: TraceEvent | null = null;
    for (let j = i + 1; j < events.length; j++) {
      const r = events[j]!;
      if (r.role !== "tool" || r.is_error || isMcpErrorResult(r.tool_output)) continue;
      const rc = sqlToolCall(r);
      if (rc && rc.tool === call.tool && rc.sql) {
        recovery = r;
        break;
      }
    }
    // the knowledge the agent followed: the latest concept it read before the error that names the identifier
    let consulted: string | null = null;
    if (subj.leaf) {
      const re = new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(subj.leaf)}($|[^A-Za-z0-9_])`, "i");
      for (let j = i - 1; j >= 0 && !consulted; j--) {
        const k = events[j]!;
        const kt = k.role === "tool" && !k.is_error ? knowledgeTool(k.tool_name) : null;
        if (!kt || kt.tool === "search_knowledge" || !re.test(outputText(k.tool_output))) continue;
        const input = (k.tool_input ?? {}) as Record<string, unknown>;
        if (kt.tool === "read_concept" && typeof input.path === "string") consulted = input.path;
        if (kt.tool === "load_skill" && typeof input.name === "string") consulted = input.name.includes("/") ? input.name : `skills/${input.name}`;
      }
    }

    const privilege = err.condition === "insufficient_privilege" || err.condition === "rls_violation";
    const kind = consulted && !privilege ? "incorrect" : "missing";
    const observation = [
      `${call.tool} failed with ${err.code ?? "a Postgres error"} (${err.condition}): ${err.message}.`,
      CONDITION_TEXT[err.condition] ? `Postgres says ${CONDITION_TEXT[err.condition]} (${subj.label}).` : "",
      consulted ? `Before this call the agent read ${consulted}, which mentions ${subj.leaf}.` : "",
      recovery ? "A later call of the same tool succeeded (recovery_sql in the evidence)." : "The agent did not recover in this trace.",
    ].filter(Boolean).join(" ");
    const suggestion = err.identifiers.suggestion
      ? `Postgres suggests the column "${err.identifiers.suggestion}". Check the schema and correct the knowledge.`
      : recovery
        ? "Compare the failing SQL with recovery_sql and document the identifiers that worked."
        : privilege
          ? `Document who can read or write ${subj.label.replace(/^\w+ /, "")}, and which role or path an agent should use instead.`
          : null;
    out.push({
      space_id: trace.space_id,
      trace_id: trace.id,
      kind,
      concept_path: consulted,
      query: subj.label,
      observation,
      suggested_fix: suggestion,
      evidence: {
        source: "sql-error",
        tool: call.tool,
        ...(call.server ? { server: call.server } : {}),
        ...(call.supabase_mcp ? { supabase_mcp: true } : {}),
        sqlstate: err.code,
        condition: err.condition,
        error: err.message,
        ...(err.hint ? { hint: err.hint } : {}),
        identifiers: err.identifiers,
        ...(consulted ? { consulted } : {}),
        seqs: recovery ? [e.seq, recovery.seq] : [e.seq],
        sql: call.sql ? redactSql(call.sql, 600) : null,
        ...(recovery ? { recovery_sql: redactSql(sqlToolCall(recovery)!.sql!, 600) } : {}),
        // one flag per trace + condition + identifier, however often the agent repeated the mistake
        dedupe_key: stableHash(`sql-error|${key}`),
      },
      audience: trace.audience,
    });
  }
  return out;
}
