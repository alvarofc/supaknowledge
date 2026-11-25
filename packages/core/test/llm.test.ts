// MastraLLM against a local mock OpenAI-compatible endpoint: custom endpoint, fallback models, tools + structured output.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { MastraLLM, llmConfigFromEnv, LLMConfigError } from "../src/llm.ts";

interface Seen { model: string; auth?: string; tools: number; hasToolResult: boolean; custom?: string; body?: Record<string, unknown> }

function mockEndpoint(handler: (body: Record<string, unknown>, seen: Seen) => { status?: number; message?: Record<string, unknown> }) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown> & { messages?: { role: string }[]; tools?: unknown[]; model: string };
      const s: Seen = {
        model: body.model, auth: req.headers.authorization, tools: body.tools?.length ?? 0,
        hasToolResult: (body.messages ?? []).some((m) => m.role === "tool"), custom: req.headers["x-acme"] as string | undefined, body,
      };
      seen.push(s);
      const { status = 200, message } = handler(body, s);
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "upstream down", type: "server_error" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "c", object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: (message as { tool_calls?: unknown })?.tool_calls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      }));
    });
  });
  return new Promise<{ url: string; seen: Seen[]; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, close: () => server.close() })),
  );
}

const Schema = z.object({ decision: z.enum(["propose", "no_change"]), title: z.string() });
const answer = { content: JSON.stringify({ decision: "propose", title: "Use revenue_usd_net" }) };

test("custom OpenAI-compatible endpoint: model id, key, headers, structured output, usage", async () => {
  const ep = await mockEndpoint(() => ({ message: answer }));
  try {
    const llm = new MastraLLM({ model: "acme/curator-1", endpoint: { baseUrl: ep.url, apiKey: "k-123", headers: { "x-acme": "yes" } } });
    const r = await llm.generate({ system: "s", input: ["a", "b"], schema: Schema });
    assert.deepEqual(r.output, { decision: "propose", title: "Use revenue_usd_net" });
    assert.equal(r.usage.input_tokens, 12);
    assert.equal(ep.seen[0]!.model, "curator-1");
    assert.equal(ep.seen[0]!.auth, "Bearer k-123");
    assert.equal(ep.seen[0]!.custom, "yes");
  } finally {
    ep.close();
  }
});

test("falls back to the next model when the primary errors", async () => {
  const ep = await mockEndpoint((body) => (body.model === "broken" ? { status: 500 } : { message: answer }));
  try {
    const llm = new MastraLLM({ model: "acme/broken", fallbackModels: ["acme/healthy"], endpoint: { baseUrl: ep.url, apiKey: "k" } });
    const r = await llm.generate({ system: "s", input: "x", schema: Schema });
    assert.equal(r.output.decision, "propose");
    assert.ok(ep.seen.some((s) => s.model === "broken"));
    assert.equal(ep.seen.at(-1)!.model, "healthy");
  } finally {
    ep.close();
  }
});

test("research tools run before the structured answer", async () => {
  let toolInput: unknown;
  const ep = await mockEndpoint((_body, s) =>
    s.tools && !s.hasToolResult
      ? { message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "search_knowledge", arguments: JSON.stringify({ query: "revenue table" }) } }] } }
      : { message: answer },
  );
  try {
    const llm = new MastraLLM({ model: "acme/curator-1", endpoint: { baseUrl: ep.url, apiKey: "k" } });
    const search = createTool({
      id: "search_knowledge",
      description: "search",
      inputSchema: z.object({ query: z.string() }),
      execute: async (input) => {
        toolInput = input;
        return { results: [{ ref: "concept:data/bigquery/revenue" }] };
      },
    });
    const r = await llm.generate({ system: "s", input: "x", schema: Schema, tools: { search_knowledge: search }, maxSteps: 4 });
    assert.deepEqual(toolInput, { query: "revenue table" });
    assert.equal(r.output.title, "Use revenue_usd_net");
    assert.ok(ep.seen.some((s) => s.hasToolResult), "the tool result was sent back to the model");
  } finally {
    ep.close();
  }
});

test("config from env: endpoint, gateway keys, fallbacks; missing model is a clear error", () => {
  const env: Record<string, string> = {
    KF_LLM_MODEL: "vercel/openai/gpt-6.2-sol",
    KF_LLM_FALLBACK_MODELS: "openrouter/a/b, vercel/x/y",
    AI_GATEWAY_API_KEY: "gw",
    KF_LLM_HEADERS: '{"x-team":"kf"}',
  };
  const c = llmConfigFromEnv((n) => env[n]);
  assert.equal(c.model, "vercel/openai/gpt-6.2-sol");
  assert.deepEqual(c.fallbackModels, ["openrouter/a/b", "vercel/x/y"]);
  assert.equal(c.gatewayKeys?.vercel, "gw");
  assert.equal(c.endpoint, undefined);
  const withEp = llmConfigFromEnv((n) => ({ ...env, KF_LLM_BASE_URL: "https://llm.acme/v1", KF_LLM_API_KEY: "k" })[n], { model: "acme/m" });
  assert.equal(withEp.model, "acme/m", "space settings override the env model");
  assert.equal(withEp.endpoint?.baseUrl, "https://llm.acme/v1");
  assert.deepEqual(withEp.endpoint?.headers, { "x-team": "kf" });
  assert.throws(() => new MastraLLM(llmConfigFromEnv(() => undefined)), LLMConfigError);
});

test("extra body fields reach a vLLM-style endpoint (Qwen with thinking off)", async () => {
  const ep = await mockEndpoint(() => ({ message: answer }));
  try {
    const cfg = llmConfigFromEnv((n) => ({
      KF_LLM_MODEL: "acme/qwen3.8-flash", KF_LLM_BASE_URL: ep.url, KF_LLM_API_KEY: "k",
      KF_LLM_EXTRA_BODY: '{"chat_template_kwargs":{"enable_thinking":false}}',
    } as Record<string, string>)[n]);
    const r = await new MastraLLM(cfg).generate({ system: "s", input: "x", schema: Schema });
    assert.equal(r.output.decision, "propose");
    assert.equal(ep.seen[0]!.model, "qwen3.8-flash");
    assert.deepEqual(ep.seen[0]!.body?.chat_template_kwargs, { enable_thinking: false });
  } finally {
    ep.close();
  }
});
