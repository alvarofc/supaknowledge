// The demo's real-agent path (a Mastra Agent wired with @supaknowledge/mastra) against a mock OpenAI-compatible model
// and a fake Supaknowledge: tool calls, the warehouse error, the flag and the correction all land in one trace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Supaknowledge } from "@supaknowledge/sdk";
import { agentModelFromEnv, runRealAgent } from "../src/agent.ts";
import { REVENUE_TABLE_PATH, STORY } from "../src/lib.ts";
import { startMockModel } from "./mock-model.ts";

test("model settings come from the same env vars as the curator", () => {
  assert.equal(agentModelFromEnv({}), null);
  const ep = agentModelFromEnv({ KF_LLM_MODEL: "acme/m1", KF_LLM_FALLBACK_MODELS: "acme/m2", KF_LLM_BASE_URL: "https://llm.acme/v1", KF_LLM_API_KEY: "k" })!;
  assert.deepEqual(ep.model.map((m) => m.model), [
    { id: "acme/m1", url: "https://llm.acme/v1", apiKey: "k", headers: undefined, api: "chat" },
    { id: "acme/m2", url: "https://llm.acme/v1", apiKey: "k", headers: undefined, api: "chat" },
  ]);
  const gw = agentModelFromEnv({ KF_LLM_MODEL: "vercel/openai/gpt-6.2-sol", AI_GATEWAY_API_KEY: "gw" })!;
  assert.deepEqual(gw.model[0]!.model, { id: "vercel/openai/gpt-6.2-sol", apiKey: "gw" });
});

test("the real agent searches, hits the renamed column, flags it, and the trace has everything", async () => {
  const model = await startMockModel();
  const writes: { method: string; body: any }[] = [];
  const mcpCalls: { name: string; args: any }[] = [];
  const json = (d: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(d), { headers: { "content-type": "application/json", ...h } });
  const fetch = async (url: string, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    if (url.includes("/functions/v1/traces")) {
      writes.push({ method: init.method ?? "GET", body });
      return json({ trace_id: "t-1" });
    }
    if (body.method === "initialize") return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "supaknowledge" } } }, { "mcp-session-id": "s" });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const { name, arguments: args } = body.params;
    mcpCalls.push({ name, args });
    const out =
      name === "search_knowledge" ? { results: [{ path: REVENUE_TABLE_PATH, title: "Revenue table", kind: "data_access" }] }
      : name === "read_concept" ? { concept: { path: REVENUE_TABLE_PATH, title: "Revenue table", kind: "data_access", body: "```sql\n" + STORY.firstQuery + "\n```" } }
      : name === "load_skill" ? { skill: { path: "skills/revenue-report", title: "Revenue report", kind: "skill", body: "1. Query\n2. Write" } }
      : { id: "f-1" };
    return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(out) }] } });
  };
  try {
    const kf = new Supaknowledge({ url: "http://kf.test", space: "acme/revenue", apiKey: "skn_x", fetch });
    const cfg = agentModelFromEnv({ KF_LLM_MODEL: "mock/agent", KF_LLM_BASE_URL: model.url, KF_LLM_API_KEY: "k" })!;
    const seen: string[] = [];
    const out = await runRealAgent(kf, cfg.model, STORY, { name: "Nov", externalId: "x", metadata: {}, author: "lead@acme" }, (n, _i, _o, err) => seen.push(`${n}${err ? "!" : ""}`));
    assert.deepEqual(seen, ["load_skill", "search_knowledge", "read_concept", "run_warehouse_query!", "run_warehouse_query", "flag_knowledge"]);
    assert.equal(out.flagged, true);
    assert.equal(out.traceId, "t-1");
    assert.ok(out.finalReport.startsWith("ACME CONFIDENTIAL"));
    assert.equal(mcpCalls.find((c) => c.name === "flag_knowledge")!.args.trace_id, "t-1");
    const events = writes.flatMap((w) => w.body.events ?? []);
    const roles = events.map((e: any) => (e.role === "tool" ? e.tool_name : e.role));
    assert.equal(roles[0], "user");
    assert.ok(roles.includes("feedback"));
    const failed = events.find((e: any) => e.tool_name === "run_warehouse_query" && e.is_error);
    assert.match(String(failed.tool_output), /Unrecognized name: revenue_usd/);
    assert.equal(writes.at(-1)!.body.outcome, "corrected");
  } finally {
    model.close();
  }
});
