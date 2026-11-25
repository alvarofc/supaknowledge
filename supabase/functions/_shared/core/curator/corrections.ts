// Mining "correction moments" from agent traces: places where a human corrected the agent or the agent
// recovered from an error. A cheap heuristic pass picks candidate traces; a fast model extracts lessons.
import type { LLM } from "../llm.ts";
import type { Trace, TraceEvent } from "../types.ts";
import { CORRECTIONS_SYSTEM, UNTRUSTED_DATA_RULE, untrusted, withHouseRules } from "./prompts.ts";
import { CorrectionSchema, type CorrectionOutput } from "./schemas.ts";
import type { NewSyntheticFlag } from "./store.ts";
import { stableHash } from "./hash.ts";

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
  opts: { instructions?: string; signal?: AbortSignal } = {},
): Promise<CorrectionOutput> {
  const res = await llm.generate({
    system: withHouseRules(CORRECTIONS_SYSTEM + UNTRUSTED_DATA_RULE, opts.instructions ?? ""),
    input: untrusted(`trace:${trace.id}`, renderTrace(trace)),
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
