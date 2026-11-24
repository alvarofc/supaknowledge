// Supaknowledge as tools for any tool-calling LLM loop: OpenAI-compatible chat completions / responses (your own
// endpoint, Vercel AI Gateway, OpenRouter, vLLM, Ollama...), or any framework that takes JSON Schema tool
// definitions. For Mastra agents, use @supaknowledge/mastra instead.
//
//   const tools = [...myTools, ...kf.knowledgeTools()];        // [{ type: "function", function: {...} }]
//   const msg = (await chat({ messages, tools })).choices[0].message;
//   for (const r of await kf.handleToolCalls(msg.tool_calls ?? [])) {   // Supaknowledge calls only; others skipped
//     messages.push({ role: "tool", tool_call_id: r.tool_call_id, content: r.content });
//   }
//
// Definitions are plain objects (no provider SDK dependency).
import type { TraceRecorder } from "./trace.ts";
import { CONCEPT_KINDS, FLAG_KINDS } from "./types.ts";
import type { Concept, ConceptKind, FlagInput, FlagKind, FlagResult, SearchOptions, SearchResult, Skill, SkillSummary } from "./types.ts";

export const KNOWLEDGE_TOOL_NAMES = ["search_knowledge", "read_concept", "list_skills", "load_skill", "flag_knowledge"] as const;
export type KnowledgeToolName = (typeof KNOWLEDGE_TOOL_NAMES)[number];

/** JSON Schema (draft 2020-12 subset) for a tool's arguments. */
export interface ToolParameters {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** Framework-neutral definition: name, description and a JSON Schema for the arguments. */
export interface JsonSchemaToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolParameters;
}

/** OpenAI-compatible function tool (chat completions `tools`; also accepted by most gateways and local servers). */
export interface FunctionToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: ToolParameters };
}

export type ToolFormat = "openai" | "json-schema";

export interface KnowledgeToolsOptions {
  /** Prefix tool names (e.g. "kf_") to avoid clashes with your own tools. */
  prefix?: string;
  /** Subset of tools to expose. Default: all of KNOWLEDGE_TOOL_NAMES. */
  include?: KnowledgeToolName[];
  /** "openai" (default): `{ type: "function", function: { name, description, parameters } }`.
   *  "json-schema": `{ name, description, inputSchema }` for any other framework. */
  format?: ToolFormat;
}

export interface ToolCallResult {
  /** Text to send back to the model as the tool result */
  content: string;
  is_error?: boolean;
}

/** A tool call as models return it: `{ id, name, arguments }`, or the OpenAI `{ id, function: { name, arguments } }`.
 *  `arguments` may be an object or a JSON string. */
export type ToolCallLike =
  | { id: string; name: string; arguments?: unknown; input?: unknown }
  | { id: string; type?: string; function: { name: string; arguments?: unknown } };

export interface ToolCallOutput extends ToolCallResult {
  tool_call_id: string;
  name: string;
}

export interface KnowledgeBackend {
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
  read(path: string): Promise<Concept | null>;
  listSkills(): Promise<SkillSummary[]>;
  loadSkill(name: string): Promise<Skill | null>;
  flag(input: FlagInput): Promise<FlagResult>;
}

/** Tool descriptions, shared by every integration (also used by @supaknowledge/mastra). */
export const TOOL_DESCRIPTIONS: Record<KnowledgeToolName, string> = {
  search_knowledge:
    "Search the team's curated knowledge base: skills (how to do the work), domain knowledge (how the business works: definitions, policies, metrics) and data-access notes (where live data lives and how to query it). " +
    "Use it before answering questions about internal processes, metrics, systems or data, and before writing queries against internal data. " +
    "Results include a trust tier and a staleness marker; read the full concept with read_concept.",
  read_concept: "Read one knowledge concept in full (markdown body, frontmatter, links) by its path, as returned by search_knowledge.",
  list_skills: "List the available skills (name and one-line description). Load one with load_skill when it matches your task.",
  load_skill:
    "Load a skill (step-by-step procedure for a task) by name, including its instructions and attached files. Use when search_knowledge or list_skills shows a relevant skill.",
  flag_knowledge:
    "Report knowledge that is missing, wrong, outdated, conflicting or unclear, so the curator can fix it. " +
    "Call it whenever the knowledge base did not have what you needed, when reality (an error, a tool result, a user correction) contradicted it, " +
    "or when you had to work something out yourself that the next agent should not have to rediscover. It is cheap; do not ask for permission.",
};

const PARAMETERS: Record<KnowledgeToolName, ToolParameters> = {
  search_knowledge: {
    type: "object",
    properties: {
      query: { type: "string", description: "What you are looking for, in natural language." },
      kinds: { type: "array", items: { type: "string", enum: [...CONCEPT_KINDS] }, description: "Optional filter by kind." },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum results (default 8)." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  read_concept: {
    type: "object",
    properties: { path: { type: "string", description: 'Concept path, e.g. "metrics/arr".' } },
    required: ["path"],
    additionalProperties: false,
  },
  list_skills: { type: "object", properties: {}, additionalProperties: false },
  load_skill: {
    type: "object",
    properties: { name: { type: "string", description: 'Skill name, e.g. "revenue-report".' } },
    required: ["name"],
    additionalProperties: false,
  },
  flag_knowledge: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...FLAG_KINDS] },
      observation: { type: "string", description: "What you observed, with specifics (error messages, the correct value if known)." },
      concept_path: { type: "string", description: "Path of the concept this is about (omit for missing knowledge)." },
      query: { type: "string", description: "What you were trying to do or find." },
      suggested_fix: { type: "string", description: "How the knowledge should change, if you know." },
    },
    required: ["kind", "observation"],
    additionalProperties: false,
  },
};

export function knowledgeTools(opts: KnowledgeToolsOptions & { format: "json-schema" }): JsonSchemaToolDefinition[];
export function knowledgeTools(opts?: KnowledgeToolsOptions & { format?: "openai" }): FunctionToolDefinition[];
export function knowledgeTools(opts?: KnowledgeToolsOptions): FunctionToolDefinition[] | JsonSchemaToolDefinition[];
export function knowledgeTools(opts: KnowledgeToolsOptions = {}): FunctionToolDefinition[] | JsonSchemaToolDefinition[] {
  const prefix = opts.prefix ?? "";
  const names = opts.include ?? [...KNOWLEDGE_TOOL_NAMES];
  if (opts.format === "json-schema") {
    return names.map((n) => ({ name: prefix + n, description: TOOL_DESCRIPTIONS[n], inputSchema: structuredClone(PARAMETERS[n]) }));
  }
  return names.map((n) => ({
    type: "function" as const,
    function: { name: prefix + n, description: TOOL_DESCRIPTIONS[n], parameters: structuredClone(PARAMETERS[n]) },
  }));
}

function str(v: unknown, field: string, required = true): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new Error(`"${field}" is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new Error(`"${field}" must be a string`);
  return v;
}

export function formatSearchResults(results: SearchResult[]): string {
  if (!results.length) return "No knowledge found. If you needed it, consider calling flag_knowledge with kind \"missing\".";
  return JSON.stringify(
    results.map((r) => ({
      path: r.path,
      title: r.title,
      kind: r.kind,
      trust: r.trust,
      ...(r.stale ? { stale: true } : {}),
      ...(r.status && r.status !== "stable" ? { status: r.status } : {}),
      description: r.description,
      snippet: r.snippet,
    })),
    null,
    1,
  );
}

export function formatSkillList(skills: SkillSummary[]): string {
  if (!skills.length) return 'No skills yet. If you needed one, consider calling flag_knowledge with kind "missing".';
  return JSON.stringify(skills.map((s) => ({ name: s.name, description: s.description })), null, 1);
}

export function formatConcept(c: Concept): string {
  if (typeof c.markdown === "string" && c.markdown) return c.markdown;
  const meta = [
    `path: ${c.path}`,
    `kind: ${c.kind}`,
    c.type ? `type: ${c.type}` : null,
    c.trust ? `trust: ${c.trust}` : null,
    c.stale ? "stale: true (verify before relying on it)" : null,
    c.status && c.status !== "stable" ? `status: ${c.status}${c.superseded_by ? ` (superseded by ${c.superseded_by})` : ""}` : null,
    c.revision ? `revision: ${c.revision}` : null,
  ].filter(Boolean);
  const parts = [`# ${c.title}`, "", ...meta, ""];
  if (c.description) parts.push(`> ${c.description}`, "");
  parts.push(c.body.trim());
  if (c.links?.length) parts.push("", "Links:", ...c.links.map((l) => `- ${l.path}${l.exists === false ? " (missing)" : ""}`));
  if (c.files?.length) parts.push("", "Files:", ...c.files.map((f) => `- ${f.path}`));
  return parts.join("\n");
}

/**
 * Run one Supaknowledge tool call. Returns null when `name` is not a Supaknowledge tool. Never throws: failures come back
 * as `{ is_error: true }` so the model can recover.
 */
export async function handleToolCall(
  kf: KnowledgeBackend,
  name: string,
  input: unknown,
  opts: { prefix?: string; trace?: TraceRecorder } = {},
): Promise<ToolCallResult | null> {
  const prefix = opts.prefix ?? "";
  if (!name.startsWith(prefix)) return null;
  const tool = name.slice(prefix.length) as KnowledgeToolName;
  if (!KNOWLEDGE_TOOL_NAMES.includes(tool)) return null;
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  let result: ToolCallResult;
  try {
    switch (tool) {
      case "search_knowledge": {
        const kinds = Array.isArray(args.kinds) ? (args.kinds.filter((k) => CONCEPT_KINDS.includes(k as ConceptKind)) as ConceptKind[]) : undefined;
        const limit = typeof args.limit === "number" ? Math.max(1, Math.min(20, Math.floor(args.limit))) : undefined;
        const rs = await kf.search(str(args.query, "query")!, { kinds: kinds?.length ? kinds : undefined, limit, traceId: opts.trace?.id ?? undefined });
        result = { content: formatSearchResults(rs) };
        break;
      }
      case "read_concept": {
        const path = str(args.path, "path")!;
        const c = await kf.read(path);
        result = c ? { content: formatConcept(c) } : { content: `No concept at "${path}". Use search_knowledge to find the right path.`, is_error: true };
        break;
      }
      case "list_skills": {
        const skills = await kf.listSkills();
        result = { content: formatSkillList(skills) };
        break;
      }
      case "load_skill": {
        const n = str(args.name, "name")!;
        const s = await kf.loadSkill(n);
        result = s ? { content: formatConcept(s) } : { content: `No skill named "${n}".`, is_error: true };
        break;
      }
      case "flag_knowledge": {
        const kind = str(args.kind, "kind")! as FlagKind;
        if (!FLAG_KINDS.includes(kind)) throw new Error(`"kind" must be one of ${FLAG_KINDS.join(", ")}`);
        const input: FlagInput = {
          kind,
          observation: str(args.observation, "observation")!,
          conceptPath: str(args.concept_path, "concept_path", false),
          query: str(args.query, "query", false),
          suggestedFix: str(args.suggested_fix, "suggested_fix", false),
        };
        const r = opts.trace ? await opts.trace.flag(input) : await kf.flag(input);
        result = { content: r?.id ? `Flag recorded (${r.id}). The curator will review it; continue with your task.` : "Flag recorded. Continue with your task." };
        break;
      }
    }
  } catch (e) {
    result = { content: `Supaknowledge ${tool} failed: ${(e as Error)?.message ?? String(e)}`, is_error: true };
  }
  opts.trace?.tool({ name: tool, input: args, output: result.content, isError: result.is_error ?? false });
  return result;
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __invalid_json__: raw };
  }
}

/**
 * Answer every Supaknowledge call in a list of tool calls, in parallel (calls to other tools are skipped).
 * Accepts `{ id, name, arguments }` and the OpenAI `{ id, function: { name, arguments } }` shape; `arguments`
 * may be a JSON string. Never throws.
 */
export async function handleToolCalls(
  kf: KnowledgeBackend,
  calls: readonly ToolCallLike[],
  opts: { prefix?: string; trace?: TraceRecorder } = {},
): Promise<ToolCallOutput[]> {
  const out = await Promise.all(
    (calls ?? []).map(async (c) => {
      const name = "function" in c && c.function ? c.function.name : (c as { name: string }).name;
      if (!c?.id || !name) return null;
      const raw = "function" in c && c.function ? c.function.arguments : ((c as { arguments?: unknown }).arguments ?? (c as { input?: unknown }).input);
      const args = parseArguments(raw);
      if (args && typeof args === "object" && "__invalid_json__" in args) {
        const bare = name.slice((opts.prefix ?? "").length);
        if (!name.startsWith(opts.prefix ?? "") || !KNOWLEDGE_TOOL_NAMES.includes(bare as KnowledgeToolName)) return null;
        return { tool_call_id: c.id, name, content: `Supaknowledge ${bare} failed: arguments are not valid JSON`, is_error: true } as ToolCallOutput;
      }
      const r = await handleToolCall(kf, name, args, opts);
      return r ? ({ tool_call_id: c.id, name, ...r } as ToolCallOutput) : null;
    }),
  );
  return out.filter((x): x is ToolCallOutput => x !== null);
}
