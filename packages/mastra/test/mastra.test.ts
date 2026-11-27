// @supaknowledge/mastra against a real Mastra Agent: the model is a mock OpenAI-compatible endpoint (custom-endpoint
// model config `{ id, url, apiKey }`), Supaknowledge is a fake fetch.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { Supaknowledge } from "@supaknowledge/sdk";
import { z } from "zod";
import { createSupaknowledgeInstructions, generateWithTrace, supaknowledgeInstructions, supaknowledgeTools, traceRun, withSupaknowledge } from "../src/index.ts";
import { fakeSupaknowledge, mockModel, type ChatRequest } from "./helpers.ts";

const KEY = "skn_11111111-1111-1111-1111-111111111111_" + "x".repeat(40);

function knowledge(name: string, args: any): unknown {
  if (name === "search_knowledge") {
    return { results: [{ path: "data/bigquery/revenue", title: "Revenue table", kind: "data_access", trust: "human_reviewed", snippet: "sum(revenue_usd)" }] };
  }
  if (name === "read_concept") throw new Error(`concept ${args.path} not found`);
  if (name === "list_skills") return { skills: [{ path: "skills/revenue-report", description: "Weekly revenue report" }] };
  if (name === "flag_knowledge") return { id: "f-1" };
  throw new Error(`unexpected tool ${name}`);
}

const toolMessages = (r: ChatRequest) => r.messages.filter((m) => m.role === "tool");

describe("an agent with Supaknowledge tools, traced", () => {
  it("searches, flags, and the whole run lands in one Supaknowledge trace", async () => {
    const model = await mockModel((req, i) => {
      if (i === 0) return { content: "Checking the knowledge base.", tool_calls: [{ id: "c1", name: "search_knowledge", arguments: { query: "monthly revenue table" } }] };
      if (i === 1) {
        return {
          tool_calls: [
            {
              id: "c2",
              name: "flag_knowledge",
              arguments: { kind: "incorrect", concept_path: "data/bigquery/revenue", observation: "revenue_usd was renamed to revenue_usd_net", suggested_fix: "use revenue_usd_net" },
            },
          ],
        };
      }
      return { content: "November revenue: EMEA $1.2M." };
    });
    const kf$ = fakeSupaknowledge(knowledge);
    const kf = new Supaknowledge({ url: "http://kf.test", space: "acme/finance", apiKey: KEY, fetch: kf$.fetch });
    try {
      const agent = new Agent(
        withSupaknowledge(
          { id: "reporter", name: "Reporter", instructions: "You write revenue reports.", model: { id: "acme/x", url: model.url, apiKey: "sk-test" } },
          kf,
        ),
      );
      const { result, traceId } = await generateWithTrace(agent, kf, "Write the November revenue report", {
        trace: { name: "November report", externalId: "run-1", flushIntervalMs: 0 },
        options: { maxSteps: 5 },
      });

      assert.equal(result.text.trim().endsWith("November revenue: EMEA $1.2M."), true);
      assert.equal(traceId, "t-1");

      // the model got the Supaknowledge tools, the instructions and our custom endpoint's key
      const first = model.requests[0]!;
      assert.equal(first.model, "x");
      assert.equal(first.authorization, "Bearer sk-test");
      assert.deepEqual(first.tools!.map((t) => t.function.name).sort(), ["flag_knowledge", "list_skills", "load_skill", "read_concept", "search_knowledge"]);
      assert.match(JSON.stringify(first.messages[0]), /You write revenue reports\.[\s\S]*flag_knowledge/);
      assert.match(String(toolMessages(model.requests[1]!)[0]!.content), /data\/bigquery\/revenue/);
      assert.match(String(toolMessages(model.requests[2]!).at(-1)!.content), /Flag recorded \(f-1\)/);

      // Supaknowledge saw the search and the flag, both linked to the trace
      const [search, flag] = kf$.toolCalls();
      assert.deepEqual(search, { name: "search_knowledge", arguments: { query: "monthly revenue table", trace_id: "t-1" } });
      assert.equal(flag!.name, "flag_knowledge");
      assert.deepEqual(flag!.arguments, {
        kind: "incorrect",
        observation: "revenue_usd was renamed to revenue_usd_net",
        concept_path: "data/bigquery/revenue",
        suggested_fix: "use revenue_usd_net",
        trace_id: "t-1",
      });

      // the trace: created once (with name / external id), then events appended, then closed with usage
      const writes = kf$.traceWrites();
      assert.equal(writes.filter((w) => w.method === "POST").length, 1);
      assert.equal(writes[0]!.body.name, "November report");
      assert.equal(writes[0]!.body.external_id, "run-1");
      assert.equal(writes[0]!.body.metadata.framework, "mastra");
      const events = kf$.events();
      assert.deepEqual(
        events.map((e) => (e.role === "tool" ? `tool:${e.tool_name}` : e.role)),
        ["user", "assistant", "tool:search_knowledge", "tool:flag_knowledge", "assistant"],
      );
      assert.equal(events[0].content, "Write the November revenue report");
      assert.deepEqual(events[2].tool_input, { query: "monthly revenue table" });
      assert.match(String(events[2].tool_output), /data\/bigquery\/revenue/);
      assert.equal(events[2].is_error, false);
      assert.equal(events[2].metadata.tool_call_id, "c1");
      const last = writes.at(-1)!;
      assert.equal(last.method, "PATCH");
      assert.equal(last.body.outcome, "unknown");
      assert.ok(last.body.ended_at);
      assert.equal(last.body.metadata.steps, 3);
      assert.deepEqual(last.body.metadata.usage, { input_tokens: 300, output_tokens: 30, cached_input_tokens: 0 });
    } finally {
      model.close();
    }
  });

  it("tool errors reach the model and the trace; other tools are recorded too", async () => {
    const model = await mockModel((_req, i) =>
      i === 0
        ? {
            tool_calls: [
              { id: "c1", name: "read_concept", arguments: { path: "metrics/churn" } },
              { id: "c2", name: "run_sql", arguments: { sql: "select sum(revenue_usd) from revenue" } },
            ],
          }
        : { content: "Done." },
    );
    const kf$ = fakeSupaknowledge(knowledge);
    const kf = new Supaknowledge({ url: "http://kf.test", space: "acme/finance", apiKey: KEY, fetch: kf$.fetch });
    const runSql = createTool({
      id: "run_sql",
      description: "Run SQL against the warehouse",
      inputSchema: z.object({ sql: z.string() }),
      execute: async () => {
        throw new Error('Unrecognized name: revenue_usd; did you mean "revenue_usd_net"?');
      },
    });
    try {
      const agent = new Agent({
        id: "a",
        name: "a",
        instructions: `You are an analyst.\n\n${supaknowledgeInstructions}`,
        model: { id: "acme/x", url: model.url, apiKey: "k" },
        tools: { ...supaknowledgeTools(kf), run_sql: runSql },
      });
      const run = traceRun(kf, { input: [{ role: "user", content: "What is our churn?" }], flushIntervalMs: 0 });
      const result = await agent.generate("What is our churn?", { ...run.options, maxSteps: 3 });
      assert.equal(await run.end(result), "t-1");

      const tm = toolMessages(model.requests[1]!);
      assert.match(String(tm.find((m) => m.tool_call_id === "c1")!.content), /No concept at "metrics\/churn"/);
      const events = kf$.events();
      const read = events.find((e) => e.tool_name === "read_concept");
      const sql = events.find((e) => e.tool_name === "run_sql");
      assert.equal(read.is_error, true);
      assert.equal(sql.is_error, true);
      assert.match(String(sql.tool_output), /revenue_usd_net/);
      assert.deepEqual(sql.tool_input, { sql: "select sum(revenue_usd) from revenue" });
    } finally {
      model.close();
    }
  });

  it("works with agent.stream(): steps are recorded once", async () => {
    const model = await mockModel((_req, i) =>
      i === 0 ? { tool_calls: [{ id: "c1", name: "list_skills", arguments: {} }] } : { content: "Use the revenue-report skill." },
    );
    const kf$ = fakeSupaknowledge(knowledge);
    const kf = new Supaknowledge({ url: "http://kf.test", space: "acme/finance", apiKey: KEY, fetch: kf$.fetch });
    try {
      const agent = new Agent(withSupaknowledge({ id: "a", name: "a", instructions: "x", model: { id: "acme/x", url: model.url, apiKey: "k" } }, kf));
      const run = traceRun(kf, { input: "Which skill writes reports?", flushIntervalMs: 0 });
      const stream = await agent.stream("Which skill writes reports?", { ...run.options, maxSteps: 3 });
      let text = "";
      for await (const chunk of stream.textStream) text += chunk;
      assert.equal(text, "Use the revenue-report skill.");
      await run.end(await stream.getFullOutput(), { outcome: "success" });
      const roles = kf$.events().map((e) => (e.role === "tool" ? `tool:${e.tool_name}` : e.role));
      assert.deepEqual(roles, ["user", "tool:list_skills", "assistant"]);
      assert.match(String(kf$.events()[1].tool_output), /revenue-report/);
      assert.equal(kf$.traceWrites().at(-1)!.body.outcome, "success");
    } finally {
      model.close();
    }
  });

  it("a failing run is recorded with outcome failure and the error is re-thrown unchanged", async () => {
    const model = await mockModel(() => ({ status: 400 }));
    const kf$ = fakeSupaknowledge(knowledge);
    const kf = new Supaknowledge({ url: "http://kf.test", space: "acme/finance", apiKey: KEY, fetch: kf$.fetch });
    try {
      const agent = new Agent({ id: "a", name: "a", instructions: "x", model: { id: "acme/x", url: model.url, apiKey: "k" }, tools: supaknowledgeTools(kf) });
      await assert.rejects(generateWithTrace(agent, kf, "hi", { trace: { flushIntervalMs: 0 } }), /invalid request/);
      const writes = kf$.traceWrites();
      assert.equal(writes[0]!.body.events[0].content, "hi");
      const last = writes.at(-1)!;
      assert.equal(last.method, "PATCH");
      assert.equal(last.body.outcome, "failure");
      // the trace was created at the end (no tool call needed it earlier): run metadata travels with the create
      assert.match(writes[0]!.body.metadata.error, /invalid request/);
      assert.ok(kf$.events().some((e) => e.tool_name === "exception" && e.is_error));
    } finally {
      model.close();
    }
  });

  it("never throws into the host agent when Supaknowledge traces are unreachable", async () => {
    const model = await mockModel((_req, i) =>
      i === 0 ? { tool_calls: [{ id: "c1", name: "flag_knowledge", arguments: { kind: "missing", observation: "no churn definition" } }] } : { content: "ok" },
    );
    const errors: unknown[] = [];
    const kf$ = fakeSupaknowledge(knowledge, { tracesDown: true });
    const kf = new Supaknowledge({ url: "http://kf.test", space: "acme/finance", apiKey: KEY, fetch: kf$.fetch, onError: (e) => errors.push(e) });
    try {
      const agent = new Agent(withSupaknowledge({ id: "a", name: "a", instructions: "x", model: { id: "acme/x", url: model.url, apiKey: "k" } }, kf));
      const { result, traceId } = await generateWithTrace(agent, kf, "hi", { trace: { flushIntervalMs: 0 } });
      assert.equal(result.text, "ok");
      assert.equal(traceId, null);
      assert.ok(errors.length > 0, "trace errors went to onError");
      // the flag still reached Supaknowledge, just without a trace id
      const flag = kf$.toolCalls().find((c) => c.name === "flag_knowledge")!;
      assert.equal(flag.arguments.trace_id, undefined);
      assert.match(String(toolMessages(model.requests[1]!)[0]!.content), /Flag recorded/);
    } finally {
      model.close();
    }
  });
});

describe("withSupaknowledge and instructions", () => {
  const kf = new Supaknowledge({ url: "http://kf.test", space: "a/b", apiKey: KEY, fetch: fakeSupaknowledge(knowledge).fetch });

  it("merges tools (yours win) and appends instructions, also for dynamic config and prefixes", async () => {
    const mine = createTool({ id: "search_knowledge", description: "mine", inputSchema: z.object({}), execute: async () => "x" });
    const cfg = withSupaknowledge({ instructions: ["a", "b"], tools: { search_knowledge: mine } }, kf, { prefix: "kf_" });
    assert.deepEqual(Object.keys(cfg.tools as object).sort(), ["kf_flag_knowledge", "kf_list_skills", "kf_load_skill", "kf_read_concept", "kf_search_knowledge", "search_knowledge"]);
    assert.equal((cfg.tools as any).search_knowledge, mine);
    assert.equal((cfg.tools as any).kf_flag_knowledge.id, "kf_flag_knowledge");
    assert.equal((cfg.instructions as string[]).length, 3);
    assert.match((cfg.instructions as string[])[2]!, /kf_flag_knowledge/);

    const dyn = withSupaknowledge({ instructions: async () => "base", tools: () => ({}) }, kf);
    assert.match(await (dyn.instructions as any)({}), /^base\n\n## Team knowledge/);
    assert.equal(Object.keys(await (dyn.tools as any)({})).length, 5);

    const plain = withSupaknowledge({ instructions: "only tools" }, kf, { instructions: false, include: ["search_knowledge"] });
    assert.equal(plain.instructions, "only tools");
    assert.deepEqual(Object.keys(plain.tools as object), ["search_knowledge"]);
  });

  it("the instructions teach when to flag", () => {
    assert.match(supaknowledgeInstructions, /flag_knowledge/);
    assert.match(supaknowledgeInstructions, /work something out yourself/);
    assert.match(createSupaknowledgeInstructions({ prefix: "kf_" }), /kf_search_knowledge/);
  });

  it("the instructions only name the tools in `include`", () => {
    const sub = createSupaknowledgeInstructions({ include: ["search_knowledge", "flag_knowledge"] });
    assert.match(sub, /search_knowledge/);
    assert.match(sub, /flag_knowledge/);
    assert.doesNotMatch(sub, /read_concept|list_skills|load_skill/);
    assert.equal(createSupaknowledgeInstructions({ include: [] }), "");

    const cfg = withSupaknowledge({ instructions: "base" }, kf, { include: ["load_skill"] });
    assert.doesNotMatch(cfg.instructions as string, /search_knowledge|flag_knowledge|list_skills|read_concept/);
    assert.match(cfg.instructions as string, /load it with load_skill/);
    assert.equal(withSupaknowledge({ instructions: "base" }, kf, { include: [] }).instructions, "base");
  });
});

describe("review fixes", () => {
  it("traceRun reports recording errors to the client's onError when the run sets none", async () => {
    const errors: unknown[] = [];
    const kf = new Supaknowledge({ url: "http://kf.test", space: "a/b", apiKey: KEY, fetch: fakeSupaknowledge(knowledge).fetch, onError: (e) => errors.push(e) });
    const broken = { setRaw: () => { throw new Error("ctx broken"); }, deleteRaw: () => {}, getRaw: () => undefined } as any;
    const run = traceRun(kf, { requestContext: broken, flushIntervalMs: 0 });
    assert.equal(errors.length, 1);
    assert.match(String((errors[0] as Error).message), /ctx broken/);
    await run.end(null);
  });

  it("read_concept and load_skill are linked to the traced run", async () => {
    const kf$ = fakeSupaknowledge((name) => {
      if (name === "read_concept") return { path: "metrics/arr", kind: "domain", type: "Metric", title: "ARR", description: "", body: "b" };
      if (name === "load_skill") return { skill: { path: "skills/r", kind: "skill", type: "Skill", title: "R", description: "", body: "s" } };
      throw new Error("unexpected");
    });
    const kf = new Supaknowledge({ url: "http://kf.test", space: "a/b", apiKey: KEY, fetch: kf$.fetch });
    const run = traceRun(kf, { flushIntervalMs: 0 });
    const tools = supaknowledgeTools(kf);
    await (tools.read_concept as any).execute({ path: "metrics/arr" }, { requestContext: run.requestContext });
    await (tools.load_skill as any).execute({ name: "r" }, { requestContext: run.requestContext });
    const byName = Object.fromEntries(kf$.toolCalls().map((c) => [c.name, c.arguments]));
    assert.equal(byName.read_concept.trace_id, "t-1");
    assert.equal(byName.load_skill.trace_id, "t-1");
    await run.end(null);
  });
});

describe("MCP tools in traced runs", () => {
  it("an MCP result with isError, returned as a normal tool result, is recorded as an error", async () => {
    const { TraceRecorder } = await import("@supaknowledge/sdk");
    const { recordStep } = await import("../src/index.ts");
    const events: any[] = [];
    const trace = new TraceRecorder({ create: async (b) => (events.push(...(b.events as any[])), { trace_id: "t" }), update: async () => {}, flag: async () => ({ id: null }) }, { flushIntervalMs: 0 });
    const failed = { content: [{ type: "text", text: 'ERROR:  42P01: relation "subscriptions" does not exist' }], isError: true };
    recordStep(trace, {
      content: [
        { type: "tool-call", toolCallId: "1", toolName: "supabase_execute_sql", input: { query: "select * from subscriptions" } },
        { type: "tool-result", toolCallId: "1", toolName: "supabase_execute_sql", output: { type: "json", value: failed } },
        { type: "tool-call", toolCallId: "2", toolName: "supabase_list_tables", input: {} },
        { type: "tool-result", toolCallId: "2", toolName: "supabase_list_tables", output: { content: [{ type: "text", text: "billing.subscriptions" }] } },
      ],
    });
    await trace.end();
    assert.deepEqual(events.map((e) => [e.tool_name, e.is_error]), [["supabase_execute_sql", true], ["supabase_list_tables", false]]);
  });
});
