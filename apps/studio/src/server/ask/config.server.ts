// Server-side configuration of the Ask page: the model (KF_LLM_* in the Studio server's environment, read at
// runtime), the per-person rate limit, and a short-lived cache of the MCP server's instructions and tool list.
import { LLMConfigError, llmConfigFromEnv } from "@supaknowledge/core";
import type { LLMConfig } from "@supaknowledge/core";
import { AskRateLimiter, perMinuteFromEnv } from "./rate-limit.server.ts";
import type { McpClient, McpTool } from "./mcp.server.ts";

const env = (name: string): string | undefined => (typeof process !== "undefined" ? process.env[name] : undefined) || undefined;

export type AskModel = { ok: true; config: LLMConfig } | { ok: false; reason: "missing" | "invalid"; message: string };

/** The model config Ask uses, from the same variables as the curator (see docs/curator.md, model configuration). */
export function askModel(): AskModel {
  try {
    const config = llmConfigFromEnv(env);
    if (!config.model) return { ok: false, reason: "missing", message: "KF_LLM_MODEL is not set on the Studio server." };
    return { ok: true, config };
  } catch (e) {
    if (e instanceof LLMConfigError) return { ok: false, reason: "invalid", message: e.message };
    throw e;
  }
}

/**
 * Anonymous sessions (public demo visitors) may not use Ask unless KF_ASK_ANONYMOUS=true: every visitor is a new
 * user, so the per-person limit would not cap what the deployment spends on the model.
 */
export function askAllowsAnonymous(): boolean {
  return env("KF_ASK_ANONYMOUS") === "true";
}

let limiter: AskRateLimiter | null = null;

export function askLimiter(): AskRateLimiter {
  if (!limiter) {
    limiter = new AskRateLimiter({ perMinute: perMinuteFromEnv(env("KF_ASK_MESSAGES_PER_MINUTE")) });
    setInterval(() => limiter?.sweep(), 5 * 60_000).unref?.();
  }
  return limiter;
}

export function askPerMinute(): number {
  return perMinuteFromEnv(env("KF_ASK_MESSAGES_PER_MINUTE"));
}

/** The MCP server's instructions and tools do not depend on the caller; refetch them every few minutes. */
const META_TTL_MS = 5 * 60_000;
let meta: { at: number; value: Promise<{ instructions: string; tools: McpTool[] }> } | null = null;

export function mcpMeta(client: McpClient): Promise<{ instructions: string; tools: McpTool[] }> {
  if (meta && Date.now() - meta.at < META_TTL_MS) return meta.value;
  const value = Promise.all([client.instructions(), client.listTools()]).then(([instructions, tools]) => ({ instructions, tools }));
  meta = { at: Date.now(), value };
  value.catch(() => {
    if (meta?.value === value) meta = null;
  });
  return value;
}
