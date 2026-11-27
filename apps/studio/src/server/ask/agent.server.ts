// The Ask agent: a Mastra agent on the deployment's model (KF_LLM_* through @supaknowledge/core's modelChain) whose
// tools are the MCP server's tools, called over HTTP with the person's token. The model sees the MCP server's own
// instructions, tool descriptions, input schemas and result text.
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { modelChain } from "@supaknowledge/core";
import type { LLMConfig } from "@supaknowledge/core";
import { ASK_LIMITS, STOPPED } from "../../lib/ask.ts";
import type { AskEvent, AskMessage, AskToolCall } from "../../lib/ask.ts";
import { serverArgs } from "./mcp.server.ts";
import type { McpCallResult, McpTool } from "./mcp.server.ts";
import type { TimelineItem } from "./trace.server.ts";

/** Appended to the MCP server's instructions: what this conversation is. */
export function askInstructions(mcpInstructions: string, space: string): string {
  return [
    mcpInstructions.trim(),
    `## This conversation
A member of the team is asking you questions in Supaknowledge Studio's Ask page, about the knowledge space ${space}. Answer from what the tools return and name the concept paths you relied on. If the knowledge does not cover the question, say so instead of guessing. Keep answers short.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface RunAskOptions {
  config: LLMConfig;
  instructions: string;
  tools: McpTool[];
  callTool: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<McpCallResult>;
  messages: AskMessage[];
  traceId: string | null;
  emit: (e: AskEvent) => void;
  signal?: AbortSignal;
  /** a Mastra model instead of the one `config` describes (tests use a scripted model) */
  model?: unknown;
}

export interface AskRun {
  timeline: TimelineItem[];
  calls: AskToolCall[];
  text: string;
  /** a model or stream error, after whatever was produced before it */
  error: string | null;
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (e && typeof e === "object" && "message" in e) return String((e).message);
  return typeof e === "string" ? e : JSON.stringify(e);
}

export async function runAsk(o: RunAskOptions): Promise<AskRun> {
  const timeline: TimelineItem[] = [];
  const calls: AskToolCall[] = [];
  let segment = "";
  let text = "";
  let counter = 0;
  const flushText = () => {
    if (segment) timeline.push({ kind: "text", text: segment, at: new Date().toISOString() });
    segment = "";
  };

  const tools = Object.fromEntries(
    o.tools.map((t) => [
      t.name,
      createTool({
        id: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        execute: async (input: unknown) => {
          flushText();
          const id = `call_${++counter}`;
          const args = serverArgs(input, null); // what the model asked for, without the server-set arguments
          o.emit({ type: "tool-call", call: { id, name: t.name, input: args } });
          let result: McpCallResult;
          try {
            result = await o.callTool(t.name, serverArgs(input, o.traceId), o.signal);
          } catch (e) {
            result = { text: errorText(e), isError: true };
          }
          const call: AskToolCall = { id, name: t.name, input: args, output: result.text, isError: result.isError };
          calls.push(call);
          timeline.push({ kind: "tool", call, at: new Date().toISOString() });
          o.emit({ type: "tool-result", call });
          // an MCP error result: Mastra hands the model an error result with this text
          if (result.isError) throw new Error(result.text || `${t.name} failed`);
          return result.text;
        },
      }),
    ]),
  );

  const agent = new Agent({ id: "supaknowledge-ask", name: "Supaknowledge Ask", instructions: o.instructions, model: (o.model ?? modelChain(o.config)) as ReturnType<typeof modelChain>, tools });
  let error: string | null = null;
  try {
    const messages = o.messages.map((m) => (m.role === "user" ? { role: "user" as const, content: m.content } : { role: "assistant" as const, content: m.content }));
    const out = await agent.stream(messages, {
      maxSteps: ASK_LIMITS.maxSteps,
      modelSettings: { maxOutputTokens: 4000 },
      ...(o.signal ? { abortSignal: o.signal } : {}),
    });
    let needsBreak = false;
    for await (const chunk of out.fullStream as AsyncIterable<{ type: string; payload?: Record<string, unknown> }>) {
      if (chunk.type === "text-delta") {
        let delta = typeof chunk.payload?.text === "string" ? chunk.payload.text : "";
        if (needsBreak && text) {
          // a new step's text starts a new paragraph, whatever whitespace the model put around it
          delta = delta.replace(/^\s+/, "");
          if (!delta) continue;
          delta = (text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n") + delta;
        }
        if (!delta) continue;
        needsBreak = false;
        segment += delta;
        text += delta;
        o.emit({ type: "text", delta });
      } else if (chunk.type === "step-finish") {
        flushText();
        needsBreak = true;
      } else if (chunk.type === "error") {
        error = errorText(chunk.payload?.error);
      }
    }
    if (!error && out.error) error = errorText(out.error);
  } catch (e) {
    error = o.signal?.aborted ? STOPPED : errorText(e);
  }
  flushText();
  return { timeline, calls, text, error };
}
