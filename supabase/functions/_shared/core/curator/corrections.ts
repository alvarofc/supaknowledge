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

/** Indexes of the events the correction heuristic points at: feedback, correcting user turns, failed tools. */
function signalEventIndexes(events: TraceEvent[]): number[] {
  const out: number[] = [];
  let sawAssistant = false;
  events.forEach((e, i) => {
    if (e.role === "assistant") sawAssistant = true;
    if (e.role === "feedback" || (e.role === "tool" && e.is_error)) out.push(i);
    else if (e.role === "user" && sawAssistant && e.content && CORRECTION_CUES.some((re) => re.test(e.content!))) out.push(i);
  });
  return out;
}

/**
 * Compact transcript for the model: long tool payloads are clipped, structure is kept. A transcript over
 * maxChars keeps the correction moments (and the turn before each), then as much of the end and the start as
 * fits, and marks what it left out, so a correction late in a long trace is never cut off.
 */
export function renderTrace(trace: Trace, maxChars = 24_000): string {
  const header = `Trace ${trace.id} "${trace.name ?? ""}" outcome=${trace.outcome}`;
  const events = trace.events as TraceEvent[];
  const lines = events.map((e) => {
    const head = `[${e.seq}] ${e.role}${e.tool_name ? `:${e.tool_name}` : ""}${e.is_error ? " (ERROR)" : ""}`;
    const parts = [e.content ? clip(e.content, 2000) : "", e.tool_input !== undefined ? `input=${renderValue(e.tool_input, 800)}` : "", e.tool_output !== undefined ? `output=${renderValue(e.tool_output, 1200)}` : ""].filter(Boolean);
    return `${head}: ${parts.join(" | ")}`;
  });
  const full = [header, ...lines].join("\n");
  if (full.length <= maxChars) return full;

  // every kept line reserves room for one omission marker before it (and one is reserved for the end)
  const MARKER = 32;
  const budget = maxChars - header.length - MARKER;
  const keep = new Set<number>();
  let used = 0;
  const take = (i: number): boolean => {
    if (i < 0 || i >= lines.length || keep.has(i)) return true;
    const cost = lines[i]!.length + 1 + MARKER;
    if (used + cost > budget) return false;
    keep.add(i);
    used += cost;
    return true;
  };
  for (const i of signalEventIndexes(events)) {
    take(i - 1);
    take(i);
  }
  for (let i = lines.length - 1; i >= 0 && take(i); i--);
  for (let i = 0; i < lines.length && take(i); i++);

  const out = [header];
  let gap = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!keep.has(i)) {
      gap++;
      continue;
    }
    if (gap) out.push(`…[${gap} event${gap === 1 ? "" : "s"} omitted]`);
    gap = 0;
    out.push(lines[i]!);
  }
  if (gap) out.push(`…[${gap} event${gap === 1 ? "" : "s"} omitted]`);
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
