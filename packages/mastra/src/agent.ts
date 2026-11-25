// System-prompt snippet and an agent-config helper that wires Supaknowledge into any Mastra Agent.
//
//   const agent = new Agent(withSupaknowledge({ id: "reporter", name: "Reporter", instructions: "...", model }, kf));
import type { Supaknowledge } from "@supaknowledge/sdk";
import { supaknowledgeTools, type SupaknowledgeTools, type SupaknowledgeToolsOptions } from "./tools.ts";

/** Instructions that teach a working agent to use Supaknowledge and to flag what it had to work out itself. */
export function createSupaknowledgeInstructions(opts: { prefix?: string } = {}): string {
  const t = (n: string) => `${opts.prefix ?? ""}${n}`;
  return [
    "## Team knowledge (Supaknowledge)",
    `Before answering questions about internal processes, metrics, systems or data, or writing queries against internal data, call ${t("search_knowledge")} and read the relevant results with ${t("read_concept")}.`,
    `If a skill fits the task (see ${t("list_skills")} or the search results), load it with ${t("load_skill")} and follow it.`,
    "Prefer human_reviewed knowledge; verify stale or unverified concepts before relying on them.",
    `Call ${t("flag_knowledge")} (cheap; never ask permission) when the knowledge you needed was missing, when a concept turned out wrong or outdated ` +
      "(an error, a tool result or the user contradicted it), when concepts conflict or are unclear, or when you had to work something out yourself " +
      "(a column name, a workaround, a definition) that the next agent should not have to rediscover. Give specifics and the fix if you know it, then continue.",
  ].join("\n");
}

/** The default Supaknowledge instructions (no tool prefix). Append them to your agent's instructions. */
export const supaknowledgeInstructions: string = createSupaknowledgeInstructions();

export interface WithSupaknowledgeOptions extends SupaknowledgeToolsOptions {
  /** Append the Supaknowledge instructions to the agent's instructions. Default true. */
  instructions?: boolean;
}

type Dynamic<T> = T | ((ctx: any) => T | Promise<T>);

function appendInstructions(base: unknown, extra: string): unknown {
  if (base === undefined || base === null || base === "") return extra;
  if (typeof base === "string") return `${base}\n\n${extra}`;
  if (Array.isArray(base)) {
    if (base.every((m) => typeof m === "string")) return [...base, extra];
    return [...base, { role: "system", content: extra }];
  }
  return [base, { role: "system", content: extra }]; // a single system message object
}

/**
 * Add Supaknowledge tools (and, by default, the Supaknowledge instructions) to a Mastra agent config. Works with static and
 * dynamic (function) `instructions` and `tools`; your own tools win on name clashes.
 */
export function withSupaknowledge<C extends { instructions?: Dynamic<any>; tools?: Dynamic<any> }>(
  config: C,
  client: Supaknowledge,
  opts: WithSupaknowledgeOptions = {},
): C & { tools: NonNullable<C["tools"]> | SupaknowledgeTools } {
  const kfTools = supaknowledgeTools(client, opts);
  const addTools = (tools: unknown) => ({ ...kfTools, ...((tools as Record<string, unknown> | undefined) ?? {}) });
  const tools =
    typeof config.tools === "function"
      ? async (ctx: unknown) => addTools(await (config.tools as (c: unknown) => unknown)(ctx))
      : addTools(config.tools);
  if (opts.instructions === false) return { ...config, tools } as C & { tools: SupaknowledgeTools };
  const snippet = createSupaknowledgeInstructions({ prefix: opts.prefix });
  const instructions =
    typeof config.instructions === "function"
      ? async (ctx: unknown) => appendInstructions(await (config.instructions as (c: unknown) => unknown)(ctx), snippet)
      : appendInstructions(config.instructions, snippet);
  return { ...config, tools, instructions } as C & { tools: SupaknowledgeTools };
}
