// @supaknowledge/sdk: a dependency-free client for Supaknowledge (Node 18+, Deno, browsers, edge runtimes).
export { Supaknowledge, withSupaknowledge, SDK_VERSION } from "./client.ts";
export { SupaknowledgeError, isNotDeployed, requestJson, parseRetryAfter, retryPolicy, withRetry, MAX_RETRIES, MAX_RETRY_WAIT_MS } from "./http.ts";
export type { RequestOptions, RetryPolicy } from "./http.ts";
export { TraceRecorder } from "./trace.ts";
export type { McpToolEvent, TraceOptions, ToolEvent, TraceTransport } from "./trace.ts";
export { McpClient, MCP_PROTOCOL_VERSION, READ_ONLY_TOOLS, parseSse } from "./mcp.ts";
export type { McpToolResult } from "./mcp.ts";
export { buildMcpConfig, mcpEndpoint } from "./mcp-config.ts";
export type { McpConfig, McpConfigOptions, McpClientKind } from "./mcp-config.ts";
export {
  knowledgeTools,
  handleToolCall,
  handleToolCalls,
  formatConcept,
  formatSearchResults,
  formatSkillList,
  KNOWLEDGE_TOOL_NAMES,
  TOOL_DESCRIPTIONS,
} from "./tools.ts";
export type {
  FunctionToolDefinition,
  JsonSchemaToolDefinition,
  KnowledgeToolName,
  KnowledgeToolsOptions,
  KnowledgeBackend,
  ToolCallLike,
  ToolCallOutput,
  ToolCallResult,
  ToolFormat,
  ToolParameters,
} from "./tools.ts";
export * from "./types.ts";
export { parseConceptMarkdown, parseSkillMarkdown } from "./parse.ts";
