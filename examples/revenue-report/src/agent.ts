// The working agent of the demo as a real Mastra Agent wired with @supaknowledge/mastra. It uses the same model
// settings as the curator, read from the shell environment:
//
//   KF_LLM_MODEL=acme/your-model KF_LLM_BASE_URL=https://llm.acme.internal/v1 KF_LLM_API_KEY=...   your endpoint
//   KF_LLM_MODEL=vercel/openai/gpt-6.2-sol AI_GATEWAY_API_KEY=...                                   Vercel AI Gateway
//   (+ optional KF_LLM_FALLBACK_MODELS, KF_LLM_HEADERS, KF_LLM_API, OPENROUTER_API_KEY)
//
// Without KF_LLM_MODEL the demo falls back to a simulated agent that follows the same script.
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { llmConfigFromEnv, modelChain, type LLMConfig, type ModelChainEntry } from "@supaknowledge/core";
import { traceRun, withSupaknowledge } from "@supaknowledge/mastra";
import type { Supaknowledge } from "@supaknowledge/sdk";
import { z } from "zod";
import { runWarehouseQuery, SKILL_NAME } from "./lib.ts";

/** The model config the curator would use, from the shell environment; null when KF_LLM_MODEL is not set. */
export function agentModelFromEnv(env: Record<string, string | undefined> = process.env): { label: string; model: ModelChainEntry[] } | null {
  if (!env.KF_LLM_MODEL?.trim()) return null;
  const cfg: LLMConfig = llmConfigFromEnv((n) => env[n]);
  return {
    label: `${cfg.model}${cfg.endpoint?.baseUrl ? ` at ${cfg.endpoint.baseUrl}` : ""}`,
    // same chain as the curator: custom endpoint, headers, extra body (e.g. Qwen thinking off), fallbacks
    model: modelChain(cfg),
  };
}

const warehouseTool = createTool({
  id: "run_warehouse_query",
  description:
    "Run a BigQuery SQL query against Acme's warehouse (project acme-prod) and return the rows. " +
    "Errors come back verbatim (for example an unrecognized column name).",
  inputSchema: z.object({ sql: z.string().describe("BigQuery Standard SQL") }),
  execute: async ({ sql }) => runWarehouseQuery(sql),
});

export function revenueAgent(kf: Supaknowledge, model: ModelChainEntry[]): Agent {
  return new Agent(
    withSupaknowledge(
      {
        id: "revenue-report-agent",
        name: "Revenue report agent",
        instructions: [
          "You are Acme Analytics' revenue-report agent. You write the monthly revenue report for the leadership sync.",
          `Start from the team's skill for this task (${SKILL_NAME}) and the knowledge about the revenue table, then query the warehouse with run_warehouse_query.`,
          "If a query fails, fix it and retry; when the documentation turned out to be wrong, flag it.",
          "Answer with the finished report in markdown, nothing else.",
        ].join("\n"),
        model,
        tools: { run_warehouse_query: warehouseTool },
      },
      kf,
    ),
  );
}

export interface AgentRunSummary {
  traceId: string | null;
  draft: string;
  finalReport: string;
  toolCalls: { name: string; isError: boolean }[];
  flagged: boolean;
}

/**
 * The story with a real model: the agent writes the report (its tool calls, errors and flags are recorded by
 * @supaknowledge/mastra), then the finance lead's correction comes in and the agent revises the report.
 */
export async function runRealAgent(
  kf: Supaknowledge,
  model: ModelChainEntry[],
  story: { ask: string; correction: string },
  trace: { name: string; externalId: string; metadata: Record<string, unknown>; author: string },
  onTool: (name: string, input: unknown, output: unknown, isError: boolean) => void,
): Promise<AgentRunSummary> {
  const agent = revenueAgent(kf, model);
  const run = traceRun(kf, { name: trace.name, externalId: trace.externalId, metadata: trace.metadata, input: story.ask, flushIntervalMs: 0 });
  const toolCalls: AgentRunSummary["toolCalls"] = [];
  const onStepFinish = (step: { content?: unknown[] }) => {
    run.options.onStepFinish(step);
    for (const p of (step.content ?? []) as { type?: string; toolName?: string; input?: unknown; output?: { type?: string; value?: unknown } }[]) {
      if (p.type !== "tool-result") continue;
      const isError = String(p.output?.type ?? "").startsWith("error");
      toolCalls.push({ name: String(p.toolName), isError });
      onTool(String(p.toolName), p.input, p.output?.value, isError);
    }
  };
  try {
    const first = await agent.generate(story.ask, { ...run.options, onStepFinish, maxSteps: 12 });
    run.trace.feedback(story.correction, { author: trace.author });
    const second = await agent.generate(
      [
        { role: "user", content: story.ask },
        { role: "assistant", content: first.text },
        { role: "user", content: story.correction },
      ],
      { ...run.options, onStepFinish, maxSteps: 4 },
    );
    const traceId = await run.end(second, { outcome: "corrected" });
    return { traceId, draft: first.text, finalReport: second.text, toolCalls, flagged: toolCalls.some((t) => t.name === "flag_knowledge" && !t.isError) };
  } catch (e) {
    await run.fail(e);
    throw e;
  }
}
