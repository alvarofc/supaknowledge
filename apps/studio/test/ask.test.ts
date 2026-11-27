import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ASK_LIMITS,
  askTraceExternalId,
  exposedConceptPaths,
  flagShare,
  modelHistory,
  normalizePath,
  splitNdjson,
  traceAudience,
  usedConcepts,
  validateConversation,
} from "../src/lib/ask.ts";
import type { AskEvent, AskToolCall } from "../src/lib/ask.ts";
import { McpClient, McpError, askTools, modelInputSchema, parseRpcBody, serverArgs } from "../src/server/ask/mcp.server.ts";
import type { McpTool } from "../src/server/ask/mcp.server.ts";
import { AskRateLimiter, perMinuteFromEnv } from "../src/server/ask/rate-limit.server.ts";
import { TraceClient, turnEvents } from "../src/server/ask/trace.server.ts";

// --- what the MCP server returns (supabase/functions/mcp/index.ts) -----------------------------------------

const SEARCH_OUTPUT = JSON.stringify({
  space: "acme/revenue",
  results: [
    { path: "data/bigquery/revenue", title: "Revenue fact table", kind: "data_access", trust: "unverified", stale: false, snippet: "…" },
    { path: "skills/revenue-report", title: "Revenue report", kind: "skill", trust: "human_reviewed", stale: false, snippet: "…" },
    { path: "metrics/arr", title: "ARR", kind: "domain", trust: "human_reviewed", stale: false, snippet: "…" },
  ],
  hint: "Call read_concept(path) for the full text.",
});

// read_concept joins every part with a blank line (supabase/functions/mcp/index.ts)
const READ_OUTPUT = [
  "# Revenue fact table",
  "_Daily recognized revenue per invoice line._",
  "path: data/bigquery/revenue\nkind: data_access | type: BigQuery Table | status: stable | revision: 2\ntrust: unverified",
  "---",
  "Use revenue_usd_net.",
  "---",
  "Links:",
  "- metrics/arr",
  "Referenced by:",
  "- skills/revenue-report (Revenue report)",
  "- finance/board-pack (Board pack)",
  "Files:",
  "- query.sql (120 bytes)",
].join("\n\n");

const LOAD_OUTPUT = "# Skill: revenue-report\n\npath: skills/revenue-report | revision: 3\n\ndescription: Build the report\n\n---\n\nSteps…";

const call = (name: string, input: Record<string, unknown>, output: string, isError = false, id = name): AskToolCall => ({ id, name, input, output, isError });

test("usedConcepts: read and loaded concepts first, then search results, failed calls ignored", () => {
  const concepts = usedConcepts([
    call("search_knowledge", { query: "revenue by region" }, SEARCH_OUTPUT),
    call("read_concept", { path: "data/bigquery/revenue" }, READ_OUTPUT),
    call("load_skill", { name: "revenue-report" }, LOAD_OUTPUT),
    call("read_concept", { path: "nope/x" }, 'No concept at "nope/x" in acme/revenue.', true),
  ]);
  assert.deepEqual(concepts, [
    { path: "data/bigquery/revenue", title: "Revenue fact table", use: "read" },
    { path: "skills/revenue-report", title: "Revenue report", use: "loaded" },
    { path: "metrics/arr", title: "ARR", use: "found" },
  ]);
});

test("usedConcepts: a read path given as a file path is normalized like the MCP server does", () => {
  assert.equal(normalizePath("/finance/board-pack.md"), "finance/board-pack");
  assert.equal(normalizePath("./skills/x/SKILL.md"), "skills/x");
  assert.equal(normalizePath("   "), null);
  const out = "# Board pack\n\nkind: domain";
  assert.deepEqual(usedConcepts([call("read_concept", { path: "/finance/board-pack.md" }, out)]), [{ path: "finance/board-pack", title: "Board pack", use: "read" }]);
});

test("usedConcepts: unparseable output counts for nothing", () => {
  assert.deepEqual(usedConcepts([call("search_knowledge", { query: "x" }, "not json"), call("list_skills", {}, "{}")]), []);
});

test("exposedConceptPaths adds backlinks read_concept showed (their titles reached the model)", () => {
  const paths = exposedConceptPaths([call("read_concept", { path: "data/bigquery/revenue" }, READ_OUTPUT)]);
  assert.deepEqual(paths.sort(), ["data/bigquery/revenue", "finance/board-pack", "skills/revenue-report"]);
});

test("exposedConceptPaths counts skills list_skills showed even when none is loaded", () => {
  const listed = JSON.stringify({
    space: "acme/revenue",
    skills: [
      { name: "board-pack", title: "Board pack", description: "finance only", path: "skills/board-pack" },
      { name: "revenue-report", title: "Revenue report", description: "", path: "skills/revenue-report" },
    ],
  });
  assert.deepEqual(exposedConceptPaths([call("list_skills", {}, listed)]).sort(), ["skills/board-pack", "skills/revenue-report"]);
  // a failed call and flag_knowledge's own output expose nothing
  assert.deepEqual(exposedConceptPaths([call("list_skills", {}, listed, true), call("flag_knowledge", {}, JSON.stringify({ path: "x/y" }))]), []);
});

test("traceAudience: unrestricted stays open, restricted narrows to a group every concept lists", () => {
  assert.deepEqual(traceAudience([]), []);
  assert.deepEqual(traceAudience([[], []]), []);
  assert.deepEqual(traceAudience([[], ["finance"]]), ["finance"]);
  assert.deepEqual(traceAudience([["finance", "exec"], ["exec", "finance", "board"]]), ["exec", "finance"]);
  // no group can read both: the turn is not recorded
  assert.equal(traceAudience([["finance"], ["hr"]]), null);
  // never wider than the trace already is
  assert.deepEqual(traceAudience([], ["finance"]), ["finance"]);
  assert.deepEqual(traceAudience([["finance", "exec"]], ["exec"]), ["exec"]);
  assert.equal(traceAudience([["finance"]], ["hr"]), null);
});

test("validateConversation: ends with a question, bounded, well formed", () => {
  assert.equal(validateConversation([]).ok, false);
  assert.equal(validateConversation("hi").ok, false);
  assert.equal(validateConversation([{ role: "system", content: "x" }]).ok, false);
  assert.equal(validateConversation([{ role: "user", content: "q" }, { role: "assistant", content: "a" }]).ok, false);
  assert.equal(validateConversation([{ role: "user", content: "   " }]).ok, false);
  assert.equal(validateConversation([{ role: "user", content: "x".repeat(ASK_LIMITS.questionMax + 1) }]).ok, false);
  const ok = validateConversation([{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }, { role: "user", content: "no, it is X" }]);
  assert.ok(ok.ok);
});

test("modelHistory keeps the latest messages, starts with a question and clips long ones", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? ("assistant" as const) : ("user" as const), content: `m${i}` }));
  many.push({ role: "user", content: "last" });
  const h = modelHistory(many);
  assert.ok(h.length <= ASK_LIMITS.historyMessages);
  assert.equal(h[0].role, "user");
  assert.equal(h.at(-1)?.content, "last");
  const long = modelHistory([{ role: "user", content: "x".repeat(ASK_LIMITS.historyMessageMax + 10) }]);
  assert.ok(long[0].content.endsWith("[truncated]"));
});

test("splitNdjson keeps a partial line for the next chunk", () => {
  const a = splitNdjson('{"type":"text","delta":"Hel"}\n{"type":"te');
  assert.deepEqual(a.events, [{ type: "text", delta: "Hel" }]);
  const b = splitNdjson(`${a.rest}xt","delta":"lo"}\n\nnot json\n`);
  assert.deepEqual(b.events, [{ type: "text", delta: "lo" }]);
  assert.equal(b.rest, "");
});

test("askTraceExternalId is stable per conversation", () => {
  assert.equal(askTraceExternalId("6f1c2d3e-0000-4000-8000-000000000000"), "studio-ask:6f1c2d3e-0000-4000-8000-000000000000");
});

// --- MCP client --------------------------------------------------------------------------------------------

const TOOLS: McpTool[] = [
  { name: "list_spaces", description: "List spaces", inputSchema: { type: "object", properties: {} } },
  {
    name: "search_knowledge",
    description: "Search",
    inputSchema: {
      type: "object",
      $schema: "https://json-schema.org/draft/2020-12/schema",
      properties: { query: { type: "string", minLength: 1 }, limit: { type: "integer" }, space: { type: "string" }, trace_id: { type: "string" } },
      required: ["query"],
    },
  },
];

test("parseRpcBody reads SSE and plain JSON responses", () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
  assert.deepEqual(parseRpcBody(sse, "text/event-stream"), [{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
  assert.deepEqual(parseRpcBody('{"jsonrpc":"2.0","id":2,"result":1}', "application/json"), [{ jsonrpc: "2.0", id: 2, result: 1 }]);
  assert.deepEqual(parseRpcBody("<html>", "text/html"), []);
});

test("askTools: no list_spaces, and the model never sees or sets space / trace_id", () => {
  const tools = askTools(TOOLS);
  assert.deepEqual(tools.map((t) => t.name), ["search_knowledge"]);
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties as object), ["query", "limit"]);
  assert.deepEqual(tools[0].inputSchema.required, ["query"]);
  assert.equal("$schema" in tools[0].inputSchema, false);
  assert.deepEqual(modelInputSchema({ properties: { space: {} }, required: ["space"] }), { type: "object", properties: {}, required: [] });
  assert.deepEqual(serverArgs({ query: "q", space: "other/space", trace_id: "forged" }, "t1"), { query: "q", trace_id: "t1" });
  assert.deepEqual(serverArgs({ query: "q", trace_id: "forged" }, null), { query: "q" });
  assert.deepEqual(serverArgs("nope", null), {});
});

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> | null }[] = [];
  const f = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init, body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    return handler(url, init);
  };
  return { f, calls };
}

const sse = (msg: unknown) => new Response(`event: message\ndata: ${JSON.stringify(msg)}\n\n`, { status: 200, headers: { "Content-Type": "text/event-stream" } });

test("McpClient calls the mcp function as the person, scoped to the space, and returns the tool text", async () => {
  const { f, calls } = fakeFetch((_url, init) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string };
    if (body.method === "tools/list") return sse({ jsonrpc: "2.0", id: body.id, result: { tools: TOOLS } });
    return sse({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "No concept at x" }], isError: true } });
  });
  const mcp = new McpClient({ endpoint: "http://sb/functions/v1/mcp", space: "acme/revenue", accessToken: "user-jwt", publishableKey: "pk", fetch: f });
  assert.equal((await mcp.listTools()).length, 2);
  assert.deepEqual(await mcp.callTool("read_concept", { path: "x" }), { text: "No concept at x", isError: true });
  assert.equal(calls[0].url, "http://sb/functions/v1/mcp?space=acme%2Frevenue");
  const headers = calls[1].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer user-jwt");
  assert.equal(headers.apikey, "pk");
  assert.deepEqual(calls[1].body?.params, { name: "read_concept", arguments: { path: "x" } });
});

test("McpClient reports a missing function and JSON-RPC errors", async () => {
  const missing = new McpClient({ endpoint: "http://sb/mcp", space: "a/b", accessToken: "t", fetch: async () => new Response('{"error":"not found"}', { status: 404 }) });
  await assert.rejects(() => missing.listTools(), (e: unknown) => e instanceof McpError && e.status === 404 && /not available/.test(e.message));
  const rpc = new McpClient({ endpoint: "http://sb/mcp", space: "a/b", accessToken: "t", fetch: async () => sse({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad args" } }) });
  await assert.rejects(() => rpc.callTool("x", {}), /bad args/);
});

// --- rate limit --------------------------------------------------------------------------------------------

test("AskRateLimiter: one question at a time and N per minute per person", () => {
  let now = 0;
  const rl = new AskRateLimiter({ perMinute: 2, now: () => now });
  const a = rl.acquire("u1");
  assert.ok(a.ok);
  assert.equal(rl.acquire("u1").ok, false, "second question while the first is answering");
  assert.ok(rl.acquire("u2").ok, "other people are not affected");
  if (a.ok) a.release();
  const b = rl.acquire("u1");
  assert.ok(b.ok);
  if (b.ok) b.release();
  now = 10_000;
  const c = rl.acquire("u1");
  assert.equal(c.ok, false);
  if (!c.ok) assert.equal(c.retryAfterSeconds, 50);
  now = 60_001;
  const d = rl.acquire("u1");
  assert.ok(d.ok);
  if (d.ok) {
    d.release();
    d.release(); // idempotent
  }
});

test("perMinuteFromEnv falls back to 10 for anything that is not a positive integer", () => {
  assert.equal(perMinuteFromEnv(undefined), 10);
  assert.equal(perMinuteFromEnv("0"), 10);
  assert.equal(perMinuteFromEnv("2.5"), 10);
  assert.equal(perMinuteFromEnv("abc"), 10);
  assert.equal(perMinuteFromEnv("30"), 30);
});

// --- traces ------------------------------------------------------------------------------------------------

test("turnEvents: the question, then text and tool calls in order, in the traces function's format", () => {
  const c = call("search_knowledge", { query: "revenue" }, SEARCH_OUTPUT, false, "call_1");
  const events = turnEvents(
    { content: "no, that column is revenue_usd_net", at: "2026-11-27T10:00:00.000Z" },
    [
      { kind: "text", text: "Let me check.", at: "2026-11-27T10:00:01.000Z" },
      { kind: "tool", call: c, at: "2026-11-27T10:00:02.000Z" },
      { kind: "text", text: "   ", at: "2026-11-27T10:00:03.000Z" },
      { kind: "text", text: "Use revenue_usd_net.", at: "2026-11-27T10:00:04.000Z" },
    ],
    { model: "acme/m" },
  );
  assert.deepEqual(
    events.map((e) => e.role),
    ["user", "assistant", "tool", "assistant"],
  );
  assert.deepEqual(events[2], {
    role: "tool",
    tool_name: "search_knowledge",
    tool_input: { query: "revenue" },
    tool_output: SEARCH_OUTPUT,
    is_error: false,
    metadata: { tool_call_id: "call_1" },
    at: "2026-11-27T10:00:02.000Z",
  });
  assert.deepEqual(events[3].metadata, { model: "acme/m" });
});

test("TraceClient: POST creates or finds the conversation's trace, PATCH appends with an optional audience", async () => {
  const { f, calls } = fakeFetch((_url, init) =>
    init.method === "POST" ? new Response(JSON.stringify({ trace_id: "t-1", created: true, appended: 0 }), { status: 201 }) : new Response(JSON.stringify({ trace_id: "t-1" })),
  );
  const tc = new TraceClient({ endpoint: "http://sb/functions/v1/traces", accessToken: "user-jwt", fetch: f });
  assert.equal(await tc.ensure({ space: "acme/revenue", externalId: "studio-ask:c1", name: "Ask: q", metadata: { source: "studio-ask" } }), "t-1");
  await tc.append("t-1", [{ role: "user", content: "q", at: "2026-11-27T10:00:00.000Z" }], ["g1"]);
  await tc.append("t-1", []);
  assert.equal(calls[0].url, "http://sb/functions/v1/traces");
  assert.deepEqual(calls[0].body, { space: "acme/revenue", external_id: "studio-ask:c1", name: "Ask: q", metadata: { source: "studio-ask" }, events: [] });
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer user-jwt");
  assert.equal(calls[1].url, "http://sb/functions/v1/traces/t-1");
  assert.equal(calls[1].init.method, "PATCH");
  assert.deepEqual(calls[1].body?.audience, ["g1"]);
  assert.equal("audience" in (calls[2].body ?? {}), false);
});

test("TraceClient surfaces the function's error", async () => {
  const tc = new TraceClient({ endpoint: "http://sb/traces", accessToken: "t", fetch: async () => new Response('{"error":"a trace with this external_id was sent by someone else"}', { status: 409 }) });
  await assert.rejects(() => tc.ensure({ space: "a/b", externalId: "x" }), /someone else/);
});

// --- the agent loop, against a scripted model ----------------------------------------------------------------

/** A minimal AI SDK v2 language model that streams a scripted list of responses, one per model step. */
function scriptedModel(steps: ((prompt: unknown) => Record<string, unknown>[])[]) {
  const prompts: unknown[] = [];
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  return {
    prompts,
    model: {
      specificationVersion: "v2" as const,
      provider: "scripted",
      modelId: "scripted-model",
      supportedUrls: {},
      doGenerate: () => Promise.reject(new Error("not used")),
      doStream: (options: { prompt: unknown }) => {
        prompts.push(options.prompt);
        const parts = steps[prompts.length - 1]?.(options.prompt) ?? [];
        return Promise.resolve({
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: "stream-start", warnings: [] });
              for (const p of parts) c.enqueue(p);
              const hasTool = parts.some((p) => p.type === "tool-call");
              c.enqueue({ type: "finish", finishReason: hasTool ? "tool-calls" : "stop", usage });
              c.close();
            },
          }),
        });
      },
    },
  };
}

test("runAsk: MCP tools are called with the trace id, results reach the model, and the stream reports it all", async () => {
  const { runAsk, askInstructions } = await import("../src/server/ask/agent.server.ts");
  const scripted = scriptedModel([
    () => [{ type: "tool-call", toolCallId: "m1", toolName: "search_knowledge", input: JSON.stringify({ query: "revenue by region", space: "other/space" }) }],
    () => [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Use " },
      { type: "text-delta", id: "t", delta: "data/bigquery/revenue." },
      { type: "text-end", id: "t" },
    ],
  ]);
  const sent: { name: string; args: Record<string, unknown> }[] = [];
  const events: AskEvent[] = [];
  const run = await runAsk({
    config: { model: "unused/model" },
    model: scripted.model,
    instructions: askInstructions("MCP server instructions.", "acme/revenue"),
    tools: askTools(TOOLS),
    callTool: (name, args) => {
      sent.push({ name, args });
      return Promise.resolve({ text: SEARCH_OUTPUT, isError: false });
    },
    messages: [{ role: "user", content: "How do I get revenue by region?" }],
    traceId: "trace-1",
    emit: (e) => events.push(e),
  });

  assert.equal(run.error, null);
  assert.deepEqual(sent, [{ name: "search_knowledge", args: { query: "revenue by region", trace_id: "trace-1" } }]);
  assert.equal(run.text, "Use data/bigquery/revenue.");
  assert.deepEqual(run.calls.map((c) => [c.name, c.input, c.isError]), [["search_knowledge", { query: "revenue by region" }, false]]);
  assert.deepEqual(run.timeline.map((t) => t.kind), ["tool", "text"]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["tool-call", "tool-result", "text", "text"],
  );
  // the second model step saw the MCP result text
  assert.ok(JSON.stringify(scripted.prompts[1]).includes("data/bigquery/revenue"));
  // and the system prompt starts with the MCP server's own instructions
  assert.ok(JSON.stringify(scripted.prompts[0]).includes("MCP server instructions."));
});

test("runAsk: an MCP error result is handed to the model as an error and recorded as one", async () => {
  const { runAsk } = await import("../src/server/ask/agent.server.ts");
  const scripted = scriptedModel([
    () => [{ type: "tool-call", toolCallId: "m1", toolName: "search_knowledge", input: JSON.stringify({ query: "q" }) }],
    () => [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Nothing found." },
      { type: "text-end", id: "t" },
    ],
  ]);
  const run = await runAsk({
    config: { model: "unused/model" },
    model: scripted.model,
    instructions: "x",
    tools: askTools(TOOLS),
    callTool: () => Promise.resolve({ text: "search failed: boom", isError: true }),
    messages: [{ role: "user", content: "q" }],
    traceId: null,
    emit: () => {},
  });
  assert.equal(run.error, null);
  assert.equal(run.calls[0].isError, true);
  assert.equal(run.calls[0].output, "search failed: boom");
  assert.ok(JSON.stringify(scripted.prompts[1]).includes("search failed: boom"));
});

test("flagShare: a restricted answer is attached only to a flag its readers could already read", () => {
  const aud = new Map<string, string[]>([
    ["metrics/arr", []],
    ["finance/board-pack", ["finance"]],
    ["finance/forecast", ["finance", "exec"]],
  ]);
  // nothing restricted: everything goes
  assert.deepEqual(flagShare(["metrics/arr"], null, aud), { answer: true, concepts: ["metrics/arr"] });
  // restricted answer flagged as "missing" (no concept) or on an open concept: answer withheld, open paths kept
  assert.deepEqual(flagShare(["metrics/arr", "finance/board-pack"], null, aud), { answer: false, concepts: ["metrics/arr"] });
  assert.deepEqual(flagShare(["metrics/arr", "finance/board-pack"], "metrics/arr", aud), { answer: false, concepts: ["metrics/arr"] });
  // flag on the finance-only concept: only finance can read it, and finance can read everything used
  assert.deepEqual(flagShare(["metrics/arr", "finance/board-pack"], "finance/board-pack", aud), { answer: true, concepts: ["metrics/arr", "finance/board-pack"] });
  // flag readable by exec, but exec cannot read the board pack
  assert.equal(flagShare(["finance/board-pack"], "finance/forecast", aud).answer, false);
  // an earlier turn restricted the trace to a group the flag's readers are not all in
  assert.equal(flagShare(["metrics/arr"], null, aud, ["finance"]).answer, false);
});
