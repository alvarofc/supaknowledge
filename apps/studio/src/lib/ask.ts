// Shared by the Ask page (browser) and its server route: the stream protocol, the limits, and which concepts an
// answer used. Pure functions only; no imports, so tests and both bundles can use it.

/** One message of the conversation as the browser keeps it and sends it back with each question. */
export interface AskMessage {
  role: "user" | "assistant";
  content: string;
}

/** A tool call the agent made over MCP, with the text the MCP server returned. */
export interface AskToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output: string;
  isError: boolean;
}

export type ConceptUse = "read" | "loaded" | "found";

/** A concept an answer used: read or loaded in full, or only seen in search results. */
export interface UsedConcept {
  path: string;
  title: string | null;
  use: ConceptUse;
}

/** Whether the turn was recorded as a trace for the curator, and why not when it was not. */
export type AskTraceState =
  | { status: "recorded"; traceId: string }
  | { status: "off" }
  | { status: "failed"; message: string }
  | { status: "skipped"; message: string };

/** Newline-delimited JSON events the /api/ask route streams back for one question. */
export type AskEvent =
  | { type: "text"; delta: string }
  | { type: "tool-call"; call: Omit<AskToolCall, "output" | "isError"> }
  | { type: "tool-result"; call: AskToolCall }
  | { type: "done"; concepts: UsedConcept[]; trace: AskTraceState }
  | { type: "error"; message: string; trace?: AskTraceState };

/** Flag kinds the "Flag this answer" form offers, most likely first (flag_knowledge's `kind`). */
export const ASK_FLAG_KINDS = ["incorrect", "missing", "outdated", "unclear", "conflicting"] as const;
export type AskFlagKind = (typeof ASK_FLAG_KINDS)[number];

/** The error text of a run the person stopped. */
export const STOPPED = "Stopped.";

export const ASK_LIMITS = {
  /** characters in one question */
  questionMax: 4000,
  /** earlier messages sent back to the model (the oldest are dropped) */
  historyMessages: 20,
  /** characters of one earlier message sent back to the model */
  historyMessageMax: 8000,
  /** model steps (tool calls plus the answer) per question */
  maxSteps: 8,
  /** characters of the note on a flag */
  noteMax: 4000,
} as const;

/** External id of the trace that records one Ask conversation (the traces function appends on the same id). */
export function askTraceExternalId(conversationId: string): string {
  return `studio-ask:${conversationId}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** Validate the conversation the browser sent: alternating text messages that end with the new question. */
export function validateConversation(input: unknown): { ok: true; messages: AskMessage[] } | { ok: false; message: string } {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, message: "Send at least one question." };
  const messages: AskMessage[] = [];
  for (const m of input) {
    if (!m || typeof m !== "object") return { ok: false, message: "Each message needs a role and text." };
    const { role, content } = m as Record<string, unknown>;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return { ok: false, message: "Each message needs a role and text." };
    messages.push({ role, content });
  }
  const last = messages[messages.length - 1];
  if (last.role !== "user" || !last.content.trim()) return { ok: false, message: "The last message must be your question." };
  if (last.content.length > ASK_LIMITS.questionMax) {
    return { ok: false, message: `Questions can be at most ${ASK_LIMITS.questionMax.toLocaleString("en-US")} characters.` };
  }
  return { ok: true, messages };
}

/** What the model sees of the conversation: the latest messages, each clipped, starting with a question. */
export function modelHistory(messages: AskMessage[]): AskMessage[] {
  const recent = messages.slice(-ASK_LIMITS.historyMessages).filter((m) => m.content.trim());
  while (recent.length && recent[0].role !== "user") recent.shift();
  return recent.map((m) => ({
    role: m.role,
    content: m.content.length > ASK_LIMITS.historyMessageMax ? `${m.content.slice(0, ASK_LIMITS.historyMessageMax)}\n…[truncated]` : m.content,
  }));
}

/** Concept path as the MCP server normalizes it ("/a/b.md" and "./a/b" are "a/b"; a skill's SKILL.md is the skill). */
export function normalizePath(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const n = p
    .trim()
    .replace(/^\.?\/+/, "")
    .replace(/\/SKILL\.md$/i, "")
    .replace(/\.md$/i, "")
    .replace(/\/SKILL$/i, "")
    .replace(/\/+$/, "");
  return n ? n : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const RANK: Record<ConceptUse, number> = { read: 0, loaded: 0, found: 1 };

/**
 * The concepts an answer used, from the MCP tool calls the agent made: concepts it read (read_concept) or loaded
 * (load_skill) first, then concepts that only came up in search results. Failed calls count for nothing.
 */
export function usedConcepts(calls: readonly AskToolCall[]): UsedConcept[] {
  const byPath = new Map<string, UsedConcept>();
  const add = (path: string | null, title: string | null, use: ConceptUse) => {
    if (!path) return;
    const prev = byPath.get(path);
    if (!prev) byPath.set(path, { path, title, use });
    else if (RANK[use] < RANK[prev.use]) byPath.set(path, { path, title: title ?? prev.title, use });
    else if (!prev.title && title) prev.title = title;
  };
  for (const c of calls) {
    if (c.isError) continue;
    if (c.name === "search_knowledge") {
      const results = (parseJson(c.output) as { results?: unknown } | null)?.results;
      if (!Array.isArray(results)) continue;
      for (const r of results) {
        if (r && typeof r === "object") {
          const o = r as Record<string, unknown>;
          add(normalizePath(o.path), typeof o.title === "string" ? o.title : null, "found");
        }
      }
    } else if (c.name === "read_concept") {
      // "# Title" on the first line, "path: <path>" in the metadata block
      const title = /^# (.+)$/m.exec(c.output)?.[1]?.trim() ?? null;
      const path = /^path: (\S+)/m.exec(c.output)?.[1] ?? c.input.path;
      add(normalizePath(path), title, "read");
    } else if (c.name === "load_skill") {
      // "path: skills/<name> | revision: 3" in the header
      add(normalizePath(/^path: ([^\s|]+)/m.exec(c.output)?.[1] ?? null), null, "loaded");
    }
  }
  return [...byPath.values()].sort((a, b) => RANK[a.use] - RANK[b.use]);
}

/** Every string `path` field anywhere in a JSON value. */
function jsonPaths(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) jsonPaths(v, out, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "path") {
      const p = normalizePath(v);
      if (p) out.add(p);
    } else jsonPaths(v, out, depth + 1);
  }
}

/**
 * Every concept whose content reached the model, for the trace's audience: what usedConcepts() finds, the concepts
 * read_concept listed as backlinks ("Referenced by:" with their titles), and every concept path in any other JSON
 * tool result. That last part covers list_skills (titles and descriptions of skills that were never loaded) and
 * fails closed for tools added to the MCP server later.
 */
export function exposedConceptPaths(calls: readonly AskToolCall[]): string[] {
  const paths = new Set(usedConcepts(calls).map((c) => c.path));
  for (const c of calls) {
    if (!c.isError && c.name !== "flag_knowledge") jsonPaths(parseJson(c.output), paths);
  }
  for (const c of calls) {
    if (c.isError || c.name !== "read_concept") continue;
    // read_concept joins its parts with blank lines: "Referenced by:", then one "- <path> (<title>)" part each
    const at = c.output.indexOf("\nReferenced by:");
    if (at < 0) continue;
    for (const line of c.output.slice(at + 1).split("\n").slice(1)) {
      if (!line.trim()) continue;
      const m = /^- (\S+) \(/.exec(line);
      if (!m) break;
      const p = normalizePath(m[1]);
      if (p) paths.add(p);
    }
  }
  return [...paths];
}

/**
 * Audience for a trace that showed content of concepts with these audiences (group ids; empty = everyone in the
 * space). Trace audiences mean "members of any listed group", so a reviewer may read the trace only through a group
 * that every restricted concept also lists: the intersection, also narrowed by the trace's current audience.
 * `null` when no group satisfies that (the turn must not be recorded); `[]` when nothing was restricted.
 */
export function traceAudience(conceptAudiences: readonly (readonly string[])[], current: readonly string[] = []): string[] | null {
  const restricted = [...conceptAudiences.filter((a) => a.length > 0), ...(current.length ? [current] : [])];
  if (!restricted.length) return [];
  let out = [...new Set(restricted[0])];
  for (const a of restricted.slice(1)) out = out.filter((g) => a.includes(g));
  return out.length ? out.sort() : null;
}

/**
 * Whether a flag raised from an answer may carry the question and answer. A flag is readable by everyone in the space
 * when its concept is unrestricted, or by the concept's audience groups. The answer may be copied only when every
 * group that can read the flag can read every restricted concept the answer used and the conversation's trace.
 * Otherwise only the unrestricted concept paths go with the flag.
 */
export function flagShare(
  concepts: readonly string[],
  conceptPath: string | null,
  audienceOf: ReadonlyMap<string, readonly string[]>,
  traceAudienceNow: readonly string[] = [],
): { answer: boolean; concepts: string[] } {
  const all = [...concepts];
  const open = all.filter((p) => (audienceOf.get(p) ?? []).length === 0);
  const needed = traceAudience(all.map((p) => audienceOf.get(p) ?? []), traceAudienceNow);
  if (needed !== null && needed.length === 0) return { answer: true, concepts: all };
  const flagAudience = conceptPath ? (audienceOf.get(conceptPath) ?? []) : [];
  const safe = needed !== null && flagAudience.length > 0 && flagAudience.every((g) => needed.includes(g));
  return safe ? { answer: true, concepts: all } : { answer: false, concepts: open };
}

/** Split a fetch body into NDJSON events as it arrives (keeps a partial last line for the next chunk). */
export function splitNdjson(buffer: string): { events: AskEvent[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const events: AskEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const e = parseJson(line);
    if (e && typeof e === "object" && typeof (e as { type?: unknown }).type === "string") events.push(e as AskEvent);
  }
  return { events, rest };
}
