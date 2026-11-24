import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMcpConfig, Supaknowledge, SupaknowledgeError, parseSse, TraceRecorder, withSupaknowledge } from "../src/index.ts";
import { json, mcpRoute, mockFetch } from "./helpers.ts";

const URL = "http://kf.test";
const KEY = "skn_11111111-1111-1111-1111-111111111111_" + "x".repeat(40);
const SPACE_ID = "22222222-2222-2222-2222-222222222222";

describe("Supaknowledge over MCP", () => {
  it("initializes once, sends the agent key and session id, parses SSE tool results", async () => {
    const { fetch, calls } = mockFetch([
      mcpRoute(
        (name, args) => {
          assert.equal(name, "search_knowledge");
          assert.deepEqual(args, { query: "arr", kinds: ["domain"], limit: 3 });
          return { results: [{ path: "metrics/arr", title: "ARR", kind: "domain", trust: "human_reviewed" }] };
        },
        { sseResponses: true },
      ),
    ]);
    const kf = new Supaknowledge({ url: URL + "/", space: "acme/finance", apiKey: KEY, fetch });
    const r1 = await kf.search("arr", { kinds: ["domain"], limit: 3 });
    const r2 = await kf.search("arr", { kinds: ["domain"], limit: 3 });
    assert.equal(r1[0]!.path, "metrics/arr");
    assert.equal(r2.length, 1);
    const methods = calls.map((c) => c.body.method);
    assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/call", "tools/call"]);
    assert.equal(calls[0]!.url, "http://kf.test/functions/v1/mcp?space=acme/finance");
    assert.equal(calls[0]!.headers.authorization, `Bearer ${KEY}`);
    assert.equal(calls[2]!.headers["mcp-session-id"], "sess-1");
    assert.equal(calls[2]!.headers["mcp-protocol-version"], "2025-06-18");
    assert.match(calls[2]!.headers.accept!, /text\/event-stream/);
  });

  it("read returns null for a missing concept, flag returns the id", async () => {
    const { fetch } = mockFetch([
      mcpRoute((name, args) => {
        if (name === "read_concept") throw new Error(`concept ${args.path} not found`);
        if (name === "flag_knowledge") {
          assert.deepEqual(args, { kind: "incorrect", observation: "col renamed", concept_path: "data/orders", suggested_fix: "use net" });
          return { id: "f-1" };
        }
        throw new Error("unexpected");
      }),
    ]);
    const kf = new Supaknowledge({ url: URL, space: "acme/finance", apiKey: KEY, fetch });
    assert.equal(await kf.read("nope"), null);
    const f = await kf.flag({ kind: "incorrect", observation: "col renamed", conceptPath: "data/orders", suggestedFix: "use net" });
    assert.equal(f.id, "f-1");
  });

  it("surfaces HTTP errors as SupaknowledgeError with status", async () => {
    const { fetch } = mockFetch([(c) => (c.url.includes("/mcp") ? json({ error: "invalid or revoked agent key" }, 401) : undefined)]);
    const kf = new Supaknowledge({ url: URL, space: "acme/finance", apiKey: KEY, fetch });
    await assert.rejects(kf.search("x"), (e: unknown) => e instanceof SupaknowledgeError && e.status === 401 && /revoked/.test(e.message));
  });

  it("validates constructor options", () => {
    assert.throws(() => new Supaknowledge({ url: URL, space: "a/b" }), /apiKey/);
    assert.throws(() => new Supaknowledge({ url: URL, space: "a/b", apiKey: KEY, transport: "rest" }), /rest/);
  });
});

describe("REST fallback", () => {
  it("falls back to PostgREST when the mcp function is not deployed, and sends apikey", async () => {
    const { fetch, calls } = mockFetch([
      (c) => (c.url.includes("/functions/v1/mcp") ? json({ error: "not implemented" }, 501) : undefined),
      (c) => (c.url.includes("/rest/v1/spaces?") ? json([{ id: SPACE_ID }]) : undefined),
      (c) =>
        c.url.endsWith("/rest/v1/rpc/search_knowledge")
          ? json([{ concept_id: "c1", path: "metrics/arr", title: "ARR", kind: "domain" }])
          : undefined,
      (c) => (c.url.endsWith("/rest/v1/rpc/log_concept_usage") ? json(1) : undefined),
      (c) => (c.url.endsWith("/rest/v1/rpc/flag_knowledge") ? json("flag-uuid") : undefined),
    ]);
    const kf = new Supaknowledge({ url: URL, space: "acme/finance", accessToken: async () => "jwt-1", publishableKey: "pk", fetch });
    const rs = await kf.search("arr", { limit: 2 });
    assert.equal(rs[0]!.path, "metrics/arr");
    const rpc = calls.find((c) => c.url.endsWith("/rpc/search_knowledge"))!;
    assert.equal(rpc.headers.apikey, "pk");
    assert.equal(rpc.headers.authorization, "Bearer jwt-1");
    assert.deepEqual(rpc.body, { p_space: SPACE_ID, p_query: "arr", p_kinds: null, p_limit: 2 });
    assert.match(calls.find((c) => c.url.includes("/spaces?"))!.url, /slug=eq\.finance&workspaces\.slug=eq\.acme/);

    // second call goes straight to REST (no new MCP attempt)
    const before = calls.filter((c) => c.url.includes("/mcp")).length;
    const f = await kf.flag({ kind: "missing", observation: "no churn definition" });
    assert.equal(f.id, "flag-uuid");
    assert.equal(calls.filter((c) => c.url.includes("/mcp")).length, before);
  });
});

describe("TraceRecorder", () => {
  it("buffers events, creates the trace on first flush and patches on end", async () => {
    const { fetch, calls } = mockFetch([
      (c) => (c.method === "POST" && c.url.endsWith("/functions/v1/traces") ? json({ trace_id: "t-1" }) : undefined),
      (c) => (c.method === "PATCH" && c.url.endsWith("/functions/v1/traces/t-1") ? json({ ok: true }) : undefined),
    ]);
    const kf = new Supaknowledge({ url: URL, space: "acme/finance", apiKey: KEY, fetch });
    const t = kf.trace({ name: "revenue report", externalId: "run-7", flushIntervalMs: 0 });
    t.user("weekly revenue please").tool({ name: "sql", input: { q: "select 1" }, output: "error", isError: true });
    assert.equal(calls.length, 0, "nothing is sent until flush");
    await t.flush();
    t.feedback("use revenue_usd_net").assistant("done");
    const id = await t.end({ outcome: "corrected" });
    assert.equal(id, "t-1");
    const [create, patch] = calls;
    assert.equal(create!.body.space, "acme/finance");
    assert.equal(create!.body.external_id, "run-7");
    assert.equal(create!.body.name, "revenue report");
    assert.deepEqual(create!.body.events.map((e: any) => e.role), ["user", "tool"]);
    assert.equal(create!.body.events[1].tool_name, "sql");
    assert.equal(create!.body.events[1].is_error, true);
    assert.ok(create!.body.events[0].at);
    assert.equal(patch!.body.outcome, "corrected");
    assert.ok(patch!.body.ended_at);
    assert.deepEqual(patch!.body.events.map((e: any) => e.role), ["feedback", "assistant"]);
  });

  it("never throws into the host app and retries transient failures", async () => {
    let fail = true;
    const errors: unknown[] = [];
    const { fetch, calls } = mockFetch([
      (c) => {
        if (!c.url.endsWith("/functions/v1/traces")) return undefined;
        return fail ? json({ error: "boom" }, 503) : json({ trace_id: "t-2" });
      },
    ]);
    const kf = new Supaknowledge({ url: URL, space: "acme/finance", apiKey: KEY, fetch, onError: (e) => errors.push(e) });
    const t = kf.trace({ flushIntervalMs: 0 });
    t.user("hi");
    await t.flush(); // fails, keeps the event
    assert.equal(errors.length, 1);
    fail = false;
    t.assistant("hello");
    await t.flush();
    assert.equal(t.id, "t-2");
    assert.deepEqual(calls.at(-1)!.body.events.map((e: any) => e.role), ["user", "assistant"]);
  });

  it("drops a batch the server rejects as invalid (4xx) instead of retrying forever", async () => {
    const errors: unknown[] = [];
    const rec = new TraceRecorder(
      {
        create: async () => {
          throw new SupaknowledgeError("bad", { status: 400 });
        },
        update: async () => {},
        flag: async () => ({ id: null }),
      },
      { flushIntervalMs: 0, onError: (e) => errors.push(e) },
    );
    rec.user("x");
    await rec.flush();
    await rec.flush();
    assert.equal(errors.length, 1);
  });

  it("auto-flushes when the batch is full", async () => {
    const { fetch, calls } = mockFetch([(c) => (c.url.endsWith("/traces") ? json({ trace_id: "t-3" }) : undefined)]);
    const kf = new Supaknowledge({ url: URL, space: "a/b", apiKey: KEY, fetch });
    const t = kf.trace({ maxBatch: 2, flushIntervalMs: 0 });
    t.user("1").assistant("2");
    await t.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.body.events.length, 2);
  });
});

describe("tool helpers (OpenAI-compatible and JSON Schema)", () => {
  const tool = (name: string, args: any) => {
    if (name === "search_knowledge") return [{ path: "metrics/arr", title: "ARR", kind: "domain", trust: "unverified", snippet: "Annual..." }];
    if (name === "list_skills") return { skills: [{ path: "skills/revenue-report", title: "Revenue report", description: "Weekly revenue" }] };
    if (name === "load_skill") return { skill: { path: "skills/revenue-report", kind: "skill", type: "Skill", title: "Revenue report", description: "d", body: "Step 1" } };
    if (name === "flag_knowledge") return { id: "f-9", args };
    throw new Error("nope");
  };

  it("defaults to OpenAI-compatible function tools, optionally prefixed", () => {
    const { fetch } = mockFetch([]);
    const kf = new Supaknowledge({ url: URL, space: "a/b", apiKey: KEY, fetch });
    const tools = kf.knowledgeTools({ prefix: "kf_" });
    assert.deepEqual(
      tools.map((t) => t.function.name),
      ["kf_search_knowledge", "kf_read_concept", "kf_list_skills", "kf_load_skill", "kf_flag_knowledge"],
    );
    for (const t of tools) {
      assert.equal(t.type, "function");
      assert.equal(t.function.parameters.type, "object");
      assert.ok(t.function.description.length > 20);
    }
    // definitions are copies: mutating one does not leak into the next call
    (tools[0]!.function.parameters.properties as any).query = null;
    assert.ok((kf.knowledgeTools()[0]!.function.parameters.properties as any).query);
  });

  it("can emit plain JSON Schema definitions for other frameworks", () => {
    const { fetch } = mockFetch([]);
    const kf = new Supaknowledge({ url: URL, space: "a/b", apiKey: KEY, fetch });
    const tools = kf.knowledgeTools({ format: "json-schema", include: ["search_knowledge", "flag_knowledge"] });
    assert.deepEqual(tools.map((t) => t.name), ["search_knowledge", "flag_knowledge"]);
    assert.deepEqual(tools[1]!.inputSchema.required, ["kind", "observation"]);
    assert.equal((tools[0] as any).type, undefined);
  });

  it("handles tool calls, returns null for foreign tools and is_error for bad input", async () => {
    const { fetch } = mockFetch([mcpRoute(tool)]);
    const kf = new Supaknowledge({ url: URL, space: "a/b", apiKey: KEY, fetch });
    assert.equal(await kf.handleToolCall("get_weather", {}), null);
    const s = await kf.handleToolCall("search_knowledge", { query: "arr" });
    assert.match(s!.content, /metrics\/arr/);
    assert.equal(s!.is_error, undefined);
    const bad = await kf.handleToolCall("flag_knowledge", { kind: "wrong", observation: "x" });
    assert.equal(bad!.is_error, true);
    const ls = await kf.handleToolCall("list_skills", {});
    assert.deepEqual(JSON.parse(ls!.content), [{ name: "revenue-report", description: "Weekly revenue" }]);
    const sk = await kf.handleToolCall("load_skill", { name: "revenue-report" });
    assert.match(sk!.content, /# Revenue report[\s\S]*Step 1/);
  });

  it("handleToolCalls answers every Supaknowledge call (both shapes, JSON-string arguments) and records them on the trace", async () => {
    const { fetch, calls } = mockFetch([
      mcpRoute(tool),
      (c) => (c.url.endsWith("/traces") ? json({ trace_id: "t-5" }) : undefined),
    ]);
    const kf = new Supaknowledge({ url: URL, space: "a/b", apiKey: KEY, fetch });
    const trace = kf.trace({ flushIntervalMs: 0 });
    const { handleToolCalls, isKnowledgeTool } = withSupaknowledge(kf, { trace });
    assert.equal(isKnowledgeTool("flag_knowledge"), true);
    assert.equal(isKnowledgeTool("get_weather"), false);
    const results = await handleToolCalls([
      { id: "c1", type: "function", function: { name: "search_knowledge", arguments: '{"query":"arr"}' } },
      { id: "c2", name: "flag_knowledge", arguments: { kind: "missing", observation: "no churn def" } },
      { id: "c3", name: "other_tool", arguments: "{}" },
      { id: "c4", function: { name: "read_concept", arguments: "{not json" } },
    ]);
    assert.deepEqual(results.map((r) => r.tool_call_id), ["c1", "c2", "c4"]);
    assert.match(results[0]!.content, /metrics\/arr/);
    assert.match(results[1]!.content, /f-9/);
    assert.equal(results[2]!.is_error, true);
    assert.match(results[2]!.content, /not valid JSON/);
    // the flag went out with the trace id (trace flushed first)
    const flagCall = calls.find((c) => c.body?.params?.name === "flag_knowledge")!;
    assert.equal(flagCall.body.params.arguments.trace_id, "t-5");
    await trace.end();
  });
});

describe("MCP config", () => {
  it("renders Claude Code, Cursor and Desktop configs", () => {
    const cc = buildMcpConfig({ url: "https://p.supabase.co", space: "acme/finance", client: "claude-code" });
    assert.equal(cc.url, "https://p.supabase.co/functions/v1/mcp?space=acme/finance");
    assert.match(cc.command!, /^claude mcp add --transport http supaknowledge 'https:\/\/p\.supabase\.co\/functions\/v1\/mcp\?space=acme\/finance' --header "Authorization: Bearer \$SUPAKNOWLEDGE_API_KEY"$/);
    assert.deepEqual((cc.config as any).mcpServers.supaknowledge.headers, { Authorization: "Bearer ${SUPAKNOWLEDGE_API_KEY}" });
    const cur = buildMcpConfig({ url: "https://p.supabase.co", space: "acme/finance", client: "cursor", apiKey: KEY });
    assert.equal((cur.config as any).mcpServers.supaknowledge.headers.Authorization, `Bearer ${KEY}`);
    const oauth = buildMcpConfig({ url: "https://p.supabase.co", space: "acme/finance", client: "claude-code", auth: "oauth" });
    assert.equal((oauth.config as any).mcpServers.supaknowledge.headers, undefined);
    assert.ok(!oauth.command!.includes("--header"));
    const desk = buildMcpConfig({ url: "https://p.supabase.co", space: "acme/finance", client: "claude-desktop", apiKey: KEY });
    assert.equal((desk.config as any).mcpServers.supaknowledge.command, "npx");
  });

  it("kf.mcpServerConfig defaults to the agent key it was built with", () => {
    const { fetch } = mockFetch([]);
    const kf = new Supaknowledge({ url: URL, space: "a/b", apiKey: KEY, fetch });
    assert.match(kf.mcpServerConfig({ client: "claude-code" }).command!, new RegExp(KEY));
  });
});

describe("parseSse", () => {
  it("reads multi-line data and multiple events", () => {
    const msgs = parseSse('event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":1,"result":{}}\n\ndata: {"jsonrpc":"2.0","id":2,"result":{}}\n\n');
    assert.deepEqual(msgs.map((m) => m.id), [1, 2]);
  });
});

describe("MCP markdown parsing", () => {
  it("recovers concept fields from read_concept text", async () => {
    const { parseConceptMarkdown, parseSkillMarkdown } = await import("../src/index.ts");
    const c = parseConceptMarkdown(
      "# ARR\n\n_Annual._\n\npath: metrics/arr\nkind: domain | type: Metric | status: stable | revision: 3\ntrust: unverified | STALE (stale_after 2020-01-01)\n\n> Unverified\n\n---\n\nBody\n\n---\n\nLinks:\n\n- data/orders\n\n- x/y [missing]\n\nReferenced by:\n\n- a/b (A)",
    );
    assert.deepEqual([c.path, c.kind, c.type, c.revision, c.trust, c.stale, c.body, c.description], ["metrics/arr", "domain", "Metric", 3, "unverified", true, "Body", "Annual."]);
    assert.deepEqual(c.links, [{ path: "data/orders", exists: true }, { path: "x/y", exists: false }]);
    const s = parseSkillMarkdown("# Skill: revenue-report\n\npath: skills/revenue-report | revision: 2\n\ndescription: Weekly.\n\n---\n\nStep 1\n\n---\n\n## Files\n\n### scripts/q.sql\n\n```sql\nselect 1\n```");
    assert.deepEqual([s.name, s.path, s.revision, s.description, s.body], ["revenue-report", "skills/revenue-report", 2, "Weekly.", "Step 1"]);
    assert.deepEqual(s.files, [{ path: "scripts/q.sql" }]);
  });
});

describe("review fixes", () => {
  it("handleToolCall creates the trace before the first search and links search, read and load_skill to it", async () => {
    const seen: Record<string, any> = {};
    const { fetch, calls } = mockFetch([
      mcpRoute((name, args) => {
        seen[name] = args;
        if (name === "search_knowledge") return [{ path: "metrics/arr", title: "ARR", kind: "domain" }];
        if (name === "read_concept") return { path: "metrics/arr", kind: "domain", type: "Metric", title: "ARR", description: "", body: "b" };
        if (name === "load_skill") return { skill: { path: "skills/r", kind: "skill", type: "Skill", title: "R", description: "", body: "s" } };
        throw new Error("nope");
      }),
      (c) => (c.method === "POST" && c.url.endsWith("/traces") ? json({ trace_id: "t-9" }) : undefined),
      (c) => (c.method === "PATCH" ? json({ ok: true }) : undefined),
    ]);
    const kf = new Supaknowledge({ url: URL, space: "a/b", apiKey: KEY, fetch });
    const trace = kf.trace({ flushIntervalMs: 0 });
    await kf.handleToolCall("search_knowledge", { query: "arr" }, { trace });
    assert.equal(seen.search_knowledge.trace_id, "t-9");
    const firstSearch = calls.findIndex((c) => c.body?.params?.name === "search_knowledge");
    const create = calls.findIndex((c) => c.method === "POST" && c.url.endsWith("/traces"));
    assert.ok(create >= 0 && create < firstSearch, "the trace is created before the search");
    await kf.handleToolCall("read_concept", { path: "metrics/arr" }, { trace });
    await kf.handleToolCall("load_skill", { name: "r" }, { trace });
    assert.equal(seen.read_concept.trace_id, "t-9");
    assert.equal(seen.load_skill.trace_id, "t-9");
    assert.equal(calls.filter((c) => c.method === "POST" && c.url.endsWith("/traces")).length, 1, "created once");
    await trace.end();
  });

  it("read / loadSkill accept a traceId", async () => {
    const seen: any[] = [];
    const { fetch } = mockFetch([mcpRoute((name, args) => (seen.push([name, args]), { path: "x", kind: "skill", title: "X", body: "" }))]);
    const kf = new Supaknowledge({ url: URL, space: "a/b", apiKey: KEY, fetch });
    await kf.read("x", { traceId: "otel-1" });
    await kf.loadSkill("x", { traceId: "otel-1" });
    await kf.read("x");
    assert.deepEqual(seen, [
      ["read_concept", { path: "x", trace_id: "otel-1" }],
      ["load_skill", { name: "x", trace_id: "otel-1" }],
      ["read_concept", { path: "x" }],
    ]);
  });

  it("handleToolCalls records invalid-JSON arguments on the trace", async () => {
    const { fetch } = mockFetch([]);
    const kf = new Supaknowledge({ url: URL, space: "a/b", apiKey: KEY, fetch });
    const events: any[] = [];
    const trace = new TraceRecorder({ create: async (b) => (events.push(...(b.events as any[])), { trace_id: "t" }), update: async () => {}, flag: async () => ({ id: null }) }, { flushIntervalMs: 0 });
    const out = await kf.handleToolCalls([{ id: "c1", name: "read_concept", arguments: "{oops" }], { trace });
    assert.equal(out[0]!.is_error, true);
    await trace.end();
    assert.equal(events.length, 1);
    assert.equal(events[0].tool_name, "read_concept");
    assert.equal(events[0].is_error, true);
    assert.equal(events[0].tool_input, "{oops");
  });

  it("backs off after a failed flush: a full batch does not retry on every event, and maxBuffer holds after requeue", async () => {
    let attempts = 0;
    const errors: unknown[] = [];
    const rec = new TraceRecorder(
      {
        create: async () => {
          attempts++;
          throw new SupaknowledgeError("down", { status: 503 });
        },
        update: async () => {},
        flag: async () => ({ id: null }),
      },
      { flushIntervalMs: 0, maxBatch: 2, maxBuffer: 5, retryBaseMs: 60_000, onError: (e) => errors.push(e) },
    );
    rec.user("1").user("2"); // full batch -> one attempt
    await rec.flush(); // explicit flush always tries
    const before = attempts;
    for (let i = 3; i <= 20; i++) rec.user(String(i)); // backing off: no new requests
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(attempts, before, "no retry storm while backing off");
    assert.equal(await rec.ensureId(), null, "ensureId does not hit the server while backing off");
    assert.equal(attempts, before);
    // buffer stays capped (newest kept)
    const sent: any[] = [];
    (rec as any).t = { create: async (b: any) => (sent.push(...b.events), { trace_id: "t" }), update: async () => {}, flag: async () => ({ id: null }) };
    await rec.flush();
    assert.deepEqual(sent.map((e) => e.content), ["16", "17", "18", "19", "20"]);
    assert.equal(await rec.ensureId(), "t");
    await rec.end();
  });

  it("MCP: a non-JSON 200 body becomes a clear SupaknowledgeError", async () => {
    const { fetch } = mockFetch([(c) => (c.url.includes("/mcp") ? new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }) : undefined)]);
    const kf = new Supaknowledge({ url: URL, space: "a/b", apiKey: KEY, fetch });
    await assert.rejects(kf.search("x"), (e: unknown) => e instanceof SupaknowledgeError && e.code === "invalid_response" && /text\/html/.test(e.message));
  });

  it("buildMcpConfig shell-quotes the server name", () => {
    const cc = buildMcpConfig({ url: "https://p.supabase.co", space: "a/b", name: "kf; rm -rf ~", auth: "oauth" });
    assert.match(cc.command!, /add --transport http 'kf; rm -rf ~' /);
  });

  it("REST fallback: loadSkill only loads stable skills, prefers the exact path, and awaits usage logging", async () => {
    const { fetch, calls } = mockFetch([
      (c) => (c.url.includes("/rest/v1/concepts?") ? json([{ path: "a/revenue" }, { path: "revenue" }]) : undefined),
      (c) => (c.url.endsWith("/rpc/read_concept") ? json({ id: "c1", path: c.body.p_path, kind: "skill", title: "R", body: "" }) : undefined),
      (c) => (c.url.endsWith("/rpc/log_concept_usage") ? json(1) : undefined),
    ]);
    const kf = new Supaknowledge({ url: URL, space: SPACE_ID, accessToken: "jwt", publishableKey: "pk", transport: "rest", fetch });
    const s = await kf.loadSkill("revenue", { traceId: "not-a-uuid" });
    assert.equal(s!.path, "revenue");
    assert.match(calls[0]!.url, /status=eq\.stable/);
    const usage = calls.find((c) => c.url.endsWith("/rpc/log_concept_usage"));
    assert.ok(usage, "usage logged before loadSkill resolved");
    assert.equal(usage!.body.p_trace, null, "non-uuid trace ids are not sent to the uuid parameter");
  });

  it("reportError routes to the client's onError", () => {
    const errors: unknown[] = [];
    const kf = new Supaknowledge({ url: URL, space: "a/b", apiKey: KEY, fetch: mockFetch([]).fetch, onError: (e) => errors.push(e) });
    kf.reportError(new Error("x"));
    assert.equal(errors.length, 1);
  });
});
