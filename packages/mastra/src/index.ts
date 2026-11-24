// @supaknowledge/mastra: Supaknowledge for Mastra agents.
//   supaknowledgeTools(kf)                  search_knowledge, read_concept, list_skills, load_skill, flag_knowledge
//   withSupaknowledge(agentConfig, kf)      adds the tools and the Supaknowledge instructions to an Agent config
//   traceRun(kf) / generateWithTrace(...)   record an agent run as a Supaknowledge trace for the curator
export { supaknowledgeTools, traceFromContext, SUPAKNOWLEDGE_TRACE_KEY } from "./tools.ts";
export type { SupaknowledgeTool, SupaknowledgeTools, SupaknowledgeToolsOptions } from "./tools.ts";
export { supaknowledgeInstructions, createSupaknowledgeInstructions, withSupaknowledge } from "./agent.ts";
export type { WithSupaknowledgeOptions } from "./agent.ts";
export { traceRun, generateWithTrace, recordInput, recordStep } from "./trace.ts";
export type { TracedRun, TraceRunOptions, GenerateWithTraceOptions, GenerateCapable, StepLike, ResultLike } from "./trace.ts";
