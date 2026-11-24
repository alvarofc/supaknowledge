// LLM access for the curator, through Mastra's model router. Bring any model:
//   * your own OpenAI-compatible endpoint   KF_LLM_BASE_URL + KF_LLM_API_KEY, model "acme/my-model"
//   * Vercel AI Gateway                      AI_GATEWAY_API_KEY, model "vercel/openai/gpt-6.2-sol"
//   * OpenRouter or any provider Mastra knows (see https://mastra.ai/models)
// The engine only depends on the small `LLM` interface below, so tests use ScriptedLLM.
import { Agent } from "@mastra/core/agent";
import type { ToolsInput } from "@mastra/core/agent";
import type { z } from "zod";

export interface GenerateRequest<T> {
  system: string;
  /** user-turn content; several strings keep the stable context first (better prompt caching) */
  input: string | string[];
  schema: z.ZodType<T>;
  /** "fast" = cheap bulk calls (trace mining); "main" = drafting and review */
  tier?: "main" | "fast";
  /** model id override for this call (otherwise the configured model for `tier`) */
  model?: string;
  maxTokens?: number;
  /** tools the model may call before answering (agentic research) */
  tools?: ToolsInput;
  maxSteps?: number;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens?: number;
}

export interface GenerateResult<T> {
  output: T;
  model: string;
  usage: Usage;
}

export interface LLM {
  generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>>;
}

export class LLMOutputError extends Error {}
export class LLMConfigError extends Error {}

export interface ModelEndpoint {
  /** OpenAI-compatible base URL, e.g. https://llm.acme.internal/v1 */
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** OpenAI wire format of the endpoint */
  api?: "chat" | "responses";
  /**
   * Extra JSON merged into every request body, for server-specific switches.
   * e.g. Qwen on vLLM without thinking: { "chat_template_kwargs": { "enable_thinking": false } }
   */
  extraBody?: Record<string, unknown>;
}

export interface LLMConfig {
  /** "provider/model" (router) or any id served by `endpoint`, e.g. "acme/llama-4-maverick" */
  model: string;
  /** cheaper model for bulk calls; defaults to `model` */
  fastModel?: string;
  /** tried in order when the primary model errors */
  fallbackModels?: string[];
  /** when set, every model id is served by this OpenAI-compatible endpoint */
  endpoint?: ModelEndpoint;
  /** API keys for router gateways by provider prefix, e.g. { vercel: "...", openrouter: "..." } */
  gatewayKeys?: Record<string, string>;
  /** "auto" lets Mastra fall back to prompt-injected JSON on models without native structured output */
  jsonPromptInjection?: boolean | "auto";
}

type ModelConfig = string | { id: `${string}/${string}`; url?: string; apiKey?: string; headers?: Record<string, string>; api?: "chat" | "responses" };

/** One Mastra model entry per model id: the primary first, then fallbacks (Mastra tries them in order). */
export interface ModelChainEntry {
  model: ModelConfig;
  maxRetries: number;
  providerOptions?: Record<string, Record<string, never>>;
}

/**
 * Turn an LLMConfig into the `model` array a Mastra Agent accepts. Shared by the curator and by any Mastra
 * agent that should use the same model setup (custom endpoint + key + headers + extra body, or a gateway).
 */
export function modelChain(config: LLMConfig, primary: string = config.model): ModelChainEntry[] {
  const e = config.endpoint;
  const resolve = (id: string): ModelConfig => {
    const qualified = (id.includes("/") ? id : `custom/${id}`) as `${string}/${string}`;
    if (e?.baseUrl) return { id: qualified, url: e.baseUrl, apiKey: e.apiKey, headers: e.headers, api: e.api ?? "chat" };
    const key = config.gatewayKeys?.[qualified.split("/")[0]!];
    return key ? { id: qualified, apiKey: key } : qualified;
  };
  // OpenAI-compatible providers merge providerOptions[<provider id>] into the request body
  const extra = e?.baseUrl && e.extraBody && Object.keys(e.extraBody).length ? e.extraBody : undefined;
  const chain = [primary, ...(config.fallbackModels ?? []).filter((m) => m !== primary)];
  return chain.map((id) => ({
    model: resolve(id),
    maxRetries: 1,
    ...(extra ? { providerOptions: { [id.includes("/") ? id.split("/")[0]! : "custom"]: extra as Record<string, never> } } : {}),
  }));
}

export class MastraLLM implements LLM {
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    if (!config.model?.trim()) {
      throw new LLMConfigError("no model configured: set KF_LLM_MODEL (e.g. vercel/openai/gpt-6.2-sol or acme/my-model with KF_LLM_BASE_URL)");
    }
    this.config = config;
  }

  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const primary = req.model ?? (req.tier === "fast" ? this.config.fastModel ?? this.config.model : this.config.model);
    const model = modelChain(this.config, primary); // Mastra tries each model in order until one succeeds
    const parts = Array.isArray(req.input) ? req.input : [req.input];
    const maxOutputTokens = req.maxTokens ?? 16000;
    const usage: Usage = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };
    const add = (u: unknown) => {
      const x = (u ?? {}) as { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
      usage.input_tokens += x.inputTokens ?? 0;
      usage.output_tokens += x.outputTokens ?? 0;
      usage.cached_input_tokens! += x.cachedInputTokens ?? 0;
    };

    // Phase 1 (only with tools): research. Many models (vLLM-served Qwen among them) cannot call tools and
    // emit constrained JSON in the same request, so research and the structured answer are separate calls.
    let notes = "";
    if (req.tools && Object.keys(req.tools).length) {
      const researcher = new Agent({ id: "supaknowledge-researcher", name: "Supaknowledge researcher", instructions: req.system, model, tools: req.tools });
      const research = await researcher.generate(
        [...parts, RESEARCH_PHASE_PROMPT].join("\n\n"),
        { maxSteps: req.maxSteps ?? 8, modelSettings: { maxOutputTokens: Math.min(maxOutputTokens, 8000) } },
      );
      add(research.usage);
      notes = renderResearch(research as unknown as ResearchResult);
    }

    // Phase 2: the structured answer, no tools.
    const answerer = new Agent({ id: "supaknowledge-curator", name: "Supaknowledge curator", instructions: req.system, model });
    const result = await answerer.generate([...parts, ...(notes ? [notes] : [])].join("\n\n"), {
      structuredOutput: { schema: req.schema, jsonPromptInjection: this.config.jsonPromptInjection ?? "auto" },
      modelSettings: { maxOutputTokens },
    });
    add(result.usage);
    const output = result.object as T | undefined;
    if (output === undefined || output === null) {
      const text = typeof result.text === "string" ? result.text : "";
      throw new LLMOutputError(`model ${primary} returned output that does not match the schema (finish: ${String(result.finishReason)}; text: ${text.slice(0, 200)})`);
    }
    const modelId = (result.response as { modelId?: string } | undefined)?.modelId ?? primary;
    return { output, model: modelId, usage };
  }
}

const RESEARCH_PHASE_PROMPT = `## Research phase
Use the tools to gather any evidence you still need. Do not write the final answer yet. When you are done,
reply with research notes: every fact you will rely on, each with its evidence id (doc:..., trace:..., flag:...,
concept:...) and a short exact quote. Say explicitly when you found nothing relevant.`;

interface ResearchResult {
  text?: string;
  steps?: { toolCalls?: { payload?: { toolName?: string; args?: unknown }; toolName?: string; args?: unknown; input?: unknown }[]; toolResults?: { payload?: { toolName?: string; result?: unknown }; toolName?: string; result?: unknown; output?: unknown }[] }[];
}

/** Research notes + the raw tool results, so the answer phase sees every evidence id the tools returned. */
function renderResearch(r: ResearchResult): string {
  const results: string[] = [];
  for (const step of r.steps ?? []) {
    for (const tr of step.toolResults ?? []) {
      const name = tr.payload?.toolName ?? tr.toolName ?? "tool";
      const value = tr.payload?.result ?? tr.result ?? tr.output;
      const json = JSON.stringify(value);
      results.push(`### ${name}\n${json && json.length > 6000 ? json.slice(0, 6000) + " …[truncated]" : json}`);
    }
  }
  return [
    "## Research notes (from the research phase)",
    (r.text ?? "").trim() || "(no notes)",
    ...(results.length ? ["## Tool results from the research phase", ...results] : []),
    "## Answer phase\nNow write the final answer. Cite only evidence ids that appear above.",
  ].join("\n\n");
}

/**
 * Build the LLM config from environment variables (Edge Functions, CLI, workers):
 *   KF_LLM_MODEL, KF_LLM_FAST_MODEL, KF_LLM_FALLBACK_MODELS (comma separated)
 *   KF_LLM_BASE_URL, KF_LLM_API_KEY, KF_LLM_HEADERS (JSON object), KF_LLM_API (chat | responses),
 *   KF_LLM_EXTRA_BODY (JSON object merged into request bodies, e.g. vLLM chat_template_kwargs)
 *   AI_GATEWAY_API_KEY (Vercel AI Gateway), OPENROUTER_API_KEY
 * Space settings may override the model ids; endpoints and keys only ever come from the environment.
 */
export function llmConfigFromEnv(
  getEnv: (name: string) => string | undefined,
  overrides: { model?: string; fastModel?: string; fallbackModels?: string[] } = {},
): LLMConfig {
  const list = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let headers: Record<string, string> | undefined;
  const rawHeaders = getEnv("KF_LLM_HEADERS");
  if (rawHeaders) {
    try {
      headers = JSON.parse(rawHeaders) as Record<string, string>;
    } catch {
      throw new LLMConfigError("KF_LLM_HEADERS must be a JSON object");
    }
  }
  let extraBody: Record<string, unknown> | undefined;
  const rawExtra = getEnv("KF_LLM_EXTRA_BODY");
  if (rawExtra) {
    try {
      extraBody = JSON.parse(rawExtra) as Record<string, unknown>;
    } catch {
      throw new LLMConfigError("KF_LLM_EXTRA_BODY must be a JSON object");
    }
  }
  const baseUrl = getEnv("KF_LLM_BASE_URL") || undefined;
  const gatewayKeys: Record<string, string> = {};
  const vercel = getEnv("AI_GATEWAY_API_KEY");
  if (vercel) gatewayKeys.vercel = vercel;
  const openrouter = getEnv("OPENROUTER_API_KEY");
  if (openrouter) gatewayKeys.openrouter = openrouter;
  return {
    model: overrides.model || getEnv("KF_LLM_MODEL") || "",
    fastModel: overrides.fastModel || getEnv("KF_LLM_FAST_MODEL") || undefined,
    fallbackModels: overrides.fallbackModels?.length ? overrides.fallbackModels : list(getEnv("KF_LLM_FALLBACK_MODELS")),
    endpoint: baseUrl
      ? { baseUrl, apiKey: getEnv("KF_LLM_API_KEY"), headers, extraBody, api: getEnv("KF_LLM_API") === "responses" ? "responses" : "chat" }
      : undefined,
    gatewayKeys,
  };
}

/** Deterministic LLM for tests and offline demos: returns queued outputs in order. */
export class ScriptedLLM implements LLM {
  calls: GenerateRequest<unknown>[] = [];
  private outputs: unknown[] | ((req: GenerateRequest<unknown>) => unknown);
  constructor(outputs: unknown[] | ((req: GenerateRequest<unknown>) => unknown)) {
    this.outputs = outputs;
  }
  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    this.calls.push(req as GenerateRequest<unknown>);
    const raw = typeof this.outputs === "function" ? this.outputs(req as GenerateRequest<unknown>) : this.outputs.shift();
    if (raw === undefined) throw new LLMOutputError("ScriptedLLM ran out of outputs");
    return { output: req.schema.parse(raw), model: "scripted", usage: { input_tokens: 0, output_tokens: 0 } };
  }
}
