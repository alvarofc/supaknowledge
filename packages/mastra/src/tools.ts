// Supaknowledge knowledge as Mastra tools: search_knowledge, read_concept, list_skills, load_skill, flag_knowledge.
//
//   const agent = new Agent({ ..., tools: { ...myTools, ...supaknowledgeTools(kf) } });
//
// Results are plain text for the model. Failures throw, so Mastra hands the model an error result it can
// recover from (the host agent never sees an exception). When the run is traced with traceRun() /
// generateWithTrace(), searches and flags are linked to that trace through the run's RequestContext.
import { createTool, type Tool } from "@mastra/core/tools";
import type { RequestContext } from "@mastra/core/request-context";
import { CONCEPT_KINDS, FLAG_KINDS, KNOWLEDGE_TOOL_NAMES, TOOL_DESCRIPTIONS, handleToolCall } from "@supaknowledge/sdk";
import type { ConceptKind, FlagKind, KnowledgeBackend, KnowledgeToolName, Supaknowledge, TraceRecorder } from "@supaknowledge/sdk";
import { z } from "zod";

/** RequestContext key under which traceRun() stores the run's TraceRecorder. */
export const SUPAKNOWLEDGE_TRACE_KEY = "supaknowledge.trace";

export interface SupaknowledgeToolsOptions {
  /** Prefix tool names and ids (e.g. "kf_") to avoid clashes with your own tools. */
  prefix?: string;
  /** Subset of tools to expose. Default: all five. */
  include?: KnowledgeToolName[];
}

/** The TraceRecorder traceRun() put on this request, if any. */
export function traceFromContext(requestContext: RequestContext<unknown> | undefined): TraceRecorder | undefined {
  try {
    const t = requestContext?.getRaw(SUPAKNOWLEDGE_TRACE_KEY);
    return t && typeof t === "object" && typeof (t as TraceRecorder).flag === "function" ? (t as TraceRecorder) : undefined;
  } catch {
    return undefined;
  }
}

const kinds = z.enum(CONCEPT_KINDS as [ConceptKind, ...ConceptKind[]]);
const flagKinds = z.enum(FLAG_KINDS as [FlagKind, ...FlagKind[]]);

const INPUT_SCHEMAS = {
  search_knowledge: z.object({
    query: z.string().describe("What you are looking for, in natural language."),
    kinds: z.array(kinds).optional().describe("Optional filter by kind."),
    limit: z.number().int().min(1).max(20).optional().describe("Maximum results (default 8)."),
  }),
  read_concept: z.object({ path: z.string().describe('Concept path, e.g. "metrics/arr".') }),
  list_skills: z.object({}),
  load_skill: z.object({ name: z.string().describe('Skill name, e.g. "revenue-report".') }),
  flag_knowledge: z.object({
    kind: flagKinds.describe(
      "missing: the knowledge base lacked what you needed; incorrect: it says something wrong; outdated: it was true once; " +
        "conflicting: two concepts disagree; unclear: you could not tell what it means.",
    ),
    observation: z.string().describe("What you observed, with specifics (error messages, the correct value if known)."),
    concept_path: z.string().optional().describe("Path of the concept this is about (omit for missing knowledge)."),
    query: z.string().optional().describe("What you were trying to do or find."),
    suggested_fix: z.string().optional().describe("How the knowledge should change, if you know."),
  }),
} satisfies Record<KnowledgeToolName, z.ZodType>;

function backendFor(client: Supaknowledge, trace: TraceRecorder | undefined): KnowledgeBackend {
  // make sure the trace exists so concept usage is attributed to it (no request once it does, none while the
  // recorder is backing off after failures)
  const traceId = async (given?: string): Promise<string | undefined> => given ?? (trace ? ((await trace.ensureId()) ?? undefined) : undefined);
  return {
    search: async (query, opts) => client.search(query, { ...opts, traceId: await traceId(opts?.traceId) }),
    read: async (path, opts) => {
      const id = await traceId(opts?.traceId);
      return client.read(path, id ? { traceId: id } : {});
    },
    listSkills: () => client.listSkills(),
    loadSkill: async (name, opts) => {
      const id = await traceId(opts?.traceId);
      return client.loadSkill(name, id ? { traceId: id } : {});
    },
    flag: async (input) => {
      if (!trace) return client.flag(input);
      const r = await trace.flag(input); // linked to the trace; null when the server refused it
      if (!r) throw new Error("the flag could not be recorded (Supaknowledge unreachable or refused it)");
      return r;
    },
  };
}

async function execute(client: Supaknowledge, tool: KnowledgeToolName, input: unknown, requestContext: RequestContext<unknown> | undefined): Promise<string> {
  const r = await handleToolCall(backendFor(client, traceFromContext(requestContext)), tool, input);
  if (!r) throw new Error(`unknown Supaknowledge tool ${tool}`);
  // throwing turns the call into an error result for the model (Mastra catches it); the content explains what to do
  if (r.is_error) throw new Error(r.content);
  return r.content;
}

/** A Mastra tool (its result is the text the model reads). */
export type SupaknowledgeTool = Tool<any, any, any, any, any, string, any>;

function makeTool(client: Supaknowledge, tool: KnowledgeToolName, id: string): SupaknowledgeTool {
  return createTool({
    id,
    description: TOOL_DESCRIPTIONS[tool],
    inputSchema: INPUT_SCHEMAS[tool],
    execute: (input: unknown, context) => execute(client, tool, input, context?.requestContext as RequestContext<unknown> | undefined),
  });
}

export type SupaknowledgeTools = Record<string, SupaknowledgeTool>;

/**
 * Supaknowledge knowledge tools for a Mastra agent, keyed by tool name (with the optional prefix):
 * search_knowledge, read_concept, list_skills, load_skill and flag_knowledge.
 */
export function supaknowledgeTools(client: Supaknowledge, opts: SupaknowledgeToolsOptions = {}): SupaknowledgeTools {
  const prefix = opts.prefix ?? "";
  const tools: SupaknowledgeTools = {};
  for (const name of opts.include ?? [...KNOWLEDGE_TOOL_NAMES]) tools[prefix + name] = makeTool(client, name, prefix + name);
  return tools;
}
