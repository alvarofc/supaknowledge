// System-prompt snippet and an agent-config helper that wires Supaknowledge into any Mastra Agent.
//
//   const agent = new Agent(withSupaknowledge({ id: "reporter", name: "Reporter", instructions: "...", model }, kf));
import type { KnowledgeToolName, Supaknowledge } from "@supaknowledge/sdk";
import { supaknowledgeTools, type SupaknowledgeTools, type SupaknowledgeToolsOptions } from "./tools.ts";

/**
 * Instructions that teach a working agent to use Supaknowledge and to flag what it had to work out itself. Pass the same
 * `include` as to supaknowledgeTools() so the prompt only names tools the agent has; returns "" when none of the
 * included tools needs instructions.
 */
export function createSupaknowledgeInstructions(opts: { prefix?: string; include?: readonly KnowledgeToolName[] } = {}): string {
  const t = (n: KnowledgeToolName) => `${opts.prefix ?? ""}${n}`;
  const has = (n: KnowledgeToolName) => !opts.include || opts.include.includes(n);
  const lines: string[] = [];
  if (has("search_knowledge")) {
    const read = has("read_concept") ? ` and read the relevant results with ${t("read_concept")}` : "";
    lines.push(`Before answering questions about internal processes, metrics, systems or data, or writing queries against internal data, call ${t("search_knowledge")}${read}.`);
  } else if (has("read_concept")) {
    lines.push(`Read concepts you know the path of with ${t("read_concept")} before relying on internal processes, metrics, systems or data.`);
  }
  if (has("load_skill")) {
    const where = [has("list_skills") ? t("list_skills") : "", has("search_knowledge") ? "the search results" : ""].filter(Boolean).join(" or ");
    lines.push(`If a skill fits the task${where ? ` (see ${where})` : ""}, load it with ${t("load_skill")} and follow it.`);
  }
  if (has("search_knowledge") || has("read_concept") || has("load_skill")) {
    lines.push("Prefer human_reviewed knowledge; verify stale or unverified concepts before relying on them.");
  }
  if (has("flag_knowledge")) {
    lines.push(
      `Call ${t("flag_knowledge")} (cheap; never ask permission) when the knowledge you needed was missing, when a concept turned out wrong or outdated ` +
        "(an error, a tool result or the user contradicted it), when concepts conflict or are unclear, or when you had to work something out yourself " +
        "(a column name, a workaround, a definition) that the next agent should not have to rediscover. Give specifics and the fix if you know it, then continue.",
    );
  }
  return lines.length ? ["## Team knowledge (Supaknowledge)", ...lines].join("\n") : "";
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
  const snippet = opts.instructions === false ? "" : createSupaknowledgeInstructions({ prefix: opts.prefix, include: opts.include });
  if (!snippet) return { ...config, tools } as C & { tools: SupaknowledgeTools };
  const instructions =
    typeof config.instructions === "function"
      ? async (ctx: unknown) => appendInstructions(await (config.instructions as (c: unknown) => unknown)(ctx), snippet)
      : appendInstructions(config.instructions, snippet);
  return { ...config, tools, instructions } as C & { tools: SupaknowledgeTools };
}
