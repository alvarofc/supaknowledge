// Mining "correction moments" from agent traces: places where a human corrected the agent or the agent
// recovered from an error. A cheap heuristic pass picks candidate traces; a fast model extracts lessons.
import type { LLM } from "../llm.ts";
import type { Trace, TraceEvent } from "../types.ts";
import { CORRECTIONS_SYSTEM, withHouseRules } from "./prompts.ts";
import { CorrectionSchema, type CorrectionOutput } from "./schemas.ts";
import type { NewSyntheticFlag } from "./store.ts";

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

/** Compact transcript for the model: long tool payloads are clipped, structure is kept. */
export function renderTrace(trace: Trace, maxChars = 24_000): string {
  const lines: string[] = [`Trace ${trace.id} "${trace.name ?? ""}" outcome=${trace.outcome}`];
  for (const e of trace.events as TraceEvent[]) {
    const head = `[${e.seq}] ${e.role}${e.tool_name ? `:${e.tool_name}` : ""}${e.is_error ? " (ERROR)" : ""}`;
    const parts = [e.content ? clip(e.content, 2000) : "", e.tool_input !== undefined ? `input=${renderValue(e.tool_input, 800)}` : "", e.tool_output !== undefined ? `output=${renderValue(e.tool_output, 1200)}` : ""].filter(Boolean);
    lines.push(`${head}: ${parts.join(" | ")}`);
  }
  return clip(lines.join("\n"), maxChars);
}

export async function extractLessons(
  llm: LLM,
  trace: Trace,
  opts: { instructions?: string } = {},
): Promise<CorrectionOutput> {
  const res = await llm.generate({
    system: withHouseRules(CORRECTIONS_SYSTEM, opts.instructions ?? ""),
    input: renderTrace(trace),
    schema: CorrectionSchema,
    tier: "fast",
    maxTokens: 4000,
  });
  return res.output;
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
      evidence: { seqs: l.seqs, quote: l.evidence_quote, knowledge_kind: l.knowledge_kind, source: "trace-correction" },
      audience: trace.audience,
    }));
}
