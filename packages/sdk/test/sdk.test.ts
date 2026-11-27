import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMcpConfig, parseRetryAfter, retryPolicy, Supaknowledge, SupaknowledgeError, parseSse, TraceRecorder, withSupaknowledge } from "../src/index.ts";
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
          assert.deepEqual(args, { kind: "incorrect", observation: "col renamed", concept_path: "data/orders", suggested_fix: "use net", evidence: { error: "42703" } });
          return { id: "f-1" };
        }
        throw new Error("unexpected");
      }),
    ]);
    const kf = new Supaknowledge({ url: URL, space: "acme/finance", apiKey: KEY, fetch });
    assert.equal(await kf.read("nope"), null);
    const f = await kf.flag({ kind: "incorrect", observation: "col renamed", conceptPath: "data/orders", suggestedFix: "use net", evidence: { error: "42703" } });
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
      { id: "c2", name: "flag_knowledge", arguments: { kind: "missing", observation: "no churn def", evidence: { error: "42703" } } },
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
    assert.deepEqual(flagCall.body.params.arguments.evidence, { error: "42703" });
    // evidence is in the schema, and a non-object is rejected rather than dropped
    assert.equal((kf.knowledgeTools({ include: ["flag_knowledge"] })[0]!.function.parameters as any).properties.evidence.type, "object");
    const bad = await kf.handleToolCall("flag_knowledge", { kind: "missing", observation: "x", evidence: "oops" });
    assert.equal(bad?.is_error, true);
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

  it("rejects a key env name that is not an identifier, and says to replace literal placeholders", () => {
    for (const apiKeyEnv of ["X\"; rm -rf ~; \"", "1KEY", "A-B", "$(id)", ""]) {
      assert.throws(() => buildMcpConfig({ url: "https://p.supabase.co", space: "a/b", apiKeyEnv }), /environment variable name/);
    }
    assert.match(buildMcpConfig({ url: "https://p.supabase.co", space: "a/b", apiKeyEnv: "_MY_KEY2" }).command!, /Bearer \$_MY_KEY2"$/);
    for (const client of ["claude-desktop", "generic"] as const) {
      const cfg = buildMcpConfig({ url: "https://p.supabase.co", space: "a/b", client, apiKeyEnv: "MY_KEY" });
      assert.match(JSON.stringify(cfg.config), /<MY_KEY>/);
      assert.match(cfg.notes[0]!, /^Replace <MY_KEY> in the config/);
    }
    assert.match(buildMcpConfig({ url: "https://p.supabase.co", space: "a/b", client: "cursor" }).notes[0]!, /^Set SUPAKNOWLEDGE_API_KEY/);
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

  it("takes skill files only from the ## Files trailer, outside fenced blocks", async () => {
    const { parseSkillMarkdown } = await import("../src/index.ts");
    const md = [
      "# Skill: r\n\npath: skills/r | revision: 1\n\ndescription: d.",
      "---",
      "### Step heading in the instructions\n\n```md\n## Files\n\n### not/a/file.md\n```",
      "---",
      "## Files",
      "### scripts/q.sql",
      "```sql\nselect 1\n~~~\n### inside/content.txt\n```",
      "### assets/logo.png",
      "(binary; 10 bytes; storage: concept-files/x)",
    ].join("\n\n");
    const s = parseSkillMarkdown(md);
    assert.deepEqual(s.files, [{ path: "scripts/q.sql" }, { path: "assets/logo.png" }]);
    assert.match(s.body, /^### Step heading in the instructions/);
    assert.ok(!s.body.includes("scripts/q.sql"));
    // no trailer: headings in the body are not files
    assert.equal(parseSkillMarkdown("# Skill: r\n\npath: skills/r\n\n---\n\n### Only a heading").files, undefined);
  });

  it("parses the read_concept Files: trailer into files", async () => {
    const { parseConceptMarkdown } = await import("../src/index.ts");
    const c = parseConceptMarkdown(
      "# R\n\npath: skills/r\nkind: skill | type: Skill | status: stable | revision: 1\ntrust: human_reviewed\n\n---\n\nBody\n\n```\nFiles:\n\n- fake\n```\n\nFiles:\n\n- scripts/q.sql (12 bytes)\n\n- README\n\nUse load_skill(\"r\") to get the file contents.",
    );
    assert.deepEqual(c.files, [{ path: "scripts/q.sql", size_bytes: 12 }, { path: "README" }]);
    assert.equal(c.body, "Body\n\n```\nFiles:\n\n- fake\n```");
  });

  it("finds the trailers whatever the body's fences look like (inline ``` spans, list-item fences, unclosed fences)", async () => {
    const { parseConceptMarkdown, parseSkillMarkdown } = await import("../src/index.ts");
    const head = "# R\n\npath: skills/r\nkind: skill | type: Skill | status: stable | revision: 1\ntrust: human_reviewed\n\n---\n\n";
    const skillHead = "# Skill: r\n\npath: skills/r | revision: 1\n\ndescription: d.\n\n---\n\n";
    const skillTrailer = "\n\n---\n\n## Files\n\n### scripts/q.sql\n\n```sql\nselect 1\n```";
    for (const body of ["Run ```inline code``` first", "- step\n\n  ```sh\n  echo ok\n  ```", "Unclosed:\n\n```sh\necho ok"]) {
      const c = parseConceptMarkdown(`${head}${body}\n\nFiles:\n\n- scripts/q.sql (12 bytes)`);
      assert.deepEqual([c.body, c.files], [body, [{ path: "scripts/q.sql", size_bytes: 12 }]], body);
      const s = parseSkillMarkdown(`${skillHead}${body}${skillTrailer}`);
      assert.deepEqual([s.body, s.files], [body, [{ path: "scripts/q.sql" }]], body);
    }
  });

  it("parses a Files: trailer that follows an empty body, and leaves body sections that are not the trailer alone", async () => {
    const { parseConceptMarkdown, parseSkillMarkdown } = await import("../src/index.ts");
    const head = "# R\n\npath: skills/r\nkind: skill | type: Skill | status: stable | revision: 1\ntrust: human_reviewed\n\n---\n\n";
    const empty = parseConceptMarkdown(`${head}Files:\n\n- a.txt (3 bytes)\n\nUse load_skill("r") to get the file contents.`);
    assert.deepEqual([empty.body, empty.files], ["", [{ path: "a.txt", size_bytes: 3 }]]);
    // the renderer always prints a size: "(0 bytes)" and "(unknown size)" keep a parenthesized file name intact
    const sizes = parseConceptMarkdown(`${head}Files:\n\n- report (12 bytes) (0 bytes)\n\n- notes (v2) (unknown size)`);
    assert.deepEqual(sizes.files, [{ path: "report (12 bytes)", size_bytes: 0 }, { path: "notes (v2)" }]);
    // the body's own "Files:" section (a tight list, then prose) is not an attachment list
    const own = parseConceptMarkdown(`${head}Files:\n- one\n- two\n\nThat is all.`);
    assert.deepEqual([own.body, own.files], ["Files:\n- one\n- two\n\nThat is all.", undefined]);
    // links, backlinks and files together
    const all = parseConceptMarkdown(`${head}Body\n\n---\n\nLinks:\n\n- a/b\n\n- c/d [missing]\n\nReferenced by:\n\n- e/f (E)\n\nFiles:\n\n- x.md`);
    assert.deepEqual([all.body, all.links, all.files], ["Body", [{ path: "a/b", exists: true }, { path: "c/d", exists: false }], [{ path: "x.md" }]]);
    // a skill body section headed "## Files" that is not followed by rendered file blocks is not the trailer
    const skill = parseSkillMarkdown("# Skill: r\n\npath: skills/r\n\n---\n\nIntro\n\n---\n\n## Files\n\n### Which files to touch\n\nOnly the SQL ones.");
    assert.deepEqual([skill.body, skill.files], ["Intro\n\n---\n\n## Files\n\n### Which files to touch\n\nOnly the SQL ones.", undefined]);
    // an empty skill body still yields the files
    const emptySkill = parseSkillMarkdown("# Skill: r\n\npath: skills/r\n\n---\n\n\n\n---\n\n## Files\n\n### a.bin\n\n(binary; 4 bytes; storage: concept-files/x)");
    assert.deepEqual([emptySkill.body, emptySkill.files], ["", [{ path: "a.bin" }]]);
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

  it("REST fallback: loadSkill accepts a full path (skills/<name>) like the MCP tool", async () => {
    const { fetch, calls } = mockFetch([
      (c) => (c.url.includes("/rest/v1/concepts?") ? json([{ path: "skills/revenue-report" }]) : undefined),
      (c) => (c.url.endsWith("/rpc/read_concept") ? json({ id: "c1", path: c.body.p_path, kind: "skill", title: "R", body: "" }) : undefined),
      (c) => (c.url.endsWith("/rpc/log_concept_usage") ? json(1) : undefined),
    ]);
    const kf = new Supaknowledge({ url: URL, space: SPACE_ID, accessToken: "jwt", publishableKey: "pk", transport: "rest", fetch });
    for (const ref of ["skills/revenue-report", "/skills/revenue-report/SKILL.md", "revenue-report"]) {
      const s = await kf.loadSkill(ref);
      assert.equal(s?.path, "skills/revenue-report", ref);
      assert.equal(s?.name, "revenue-report");
    }
    assert.match(decodeURIComponent(calls[0]!.url), /path\.eq\.skills\/revenue-report,path\.like\.\*\/skills\/revenue-report\)/);
    assert.equal(await kf.loadSkill("../etc"), null);
  });

  it("reportError routes to the client's onError", () => {
    const errors: unknown[] = [];
    const kf = new Supaknowledge({ url: URL, space: "a/b", apiKey: KEY, fetch: mockFetch([]).fetch, onError: (e) => errors.push(e) });
    kf.reportError(new Error("x"));
    assert.equal(errors.length, 1);
  });
});

describe("429 retries", () => {
  /** answers 429 (Retry-After: `after`) for the first `n` matching calls, then defers to the next route */
  const throttle = (match: (c: any) => boolean, n: number, after = "0") => {
    let left = n;
    return (c: any) => (match(c) && left-- > 0 ? json({ error: "too many failed sign-ins for this agent; retry later" }, 429, { "retry-after": after }) : undefined);
  };
  const isTool = (name: string) => (c: any) => c.body?.method === "tools/call" && c.body.params.name === name;

  it("parses Retry-After and clamps the policy to 2 retries / 30 s", () => {
    assert.equal(parseRetryAfter("3"), 3000);
    assert.equal(parseRetryAfter(null), undefined);
    assert.equal(parseRetryAfter("soon"), undefined);
    assert.equal(parseRetryAfter(new Date(Date.UTC(2030, 0, 1, 0, 0, 10)).toUTCString(), Date.UTC(2030, 0, 1)), 10_000);
    assert.deepEqual(retryPolicy(undefined), { retries: 2, maxWaitMs: 30_000 });
    assert.deepEqual(retryPolicy({ retries: 9, maxWaitMs: 120_000 }), { retries: 2, maxWaitMs: 30_000 });
    assert.deepEqual(retryPolicy({ retries: 1, maxWaitMs: 500 }), { retries: 1, maxWaitMs: 500 });
    assert.deepEqual(retryPolicy(false), { retries: 0, maxWaitMs: 0 });
  });

  it("retries read-only MCP calls (and initialize) on 429", async () => {
    const { fetch, calls } = mockFetch([
      throttle((c) => c.body?.method === "initialize", 1),
      throttle(isTool("search_knowledge"), 2),
      mcpRoute(() => [{ path: "metrics/arr", title: "ARR", kind: "domain" }]),
    ]);
    const kf = new Supaknowledge({ url: URL, space: "a/b", apiKey: KEY, fetch });
    const rows = await kf.search("arr");
    assert.equal(rows.length, 1);
    assert.equal(calls.filter(isTool("search_knowledge")).length, 3, "two retries");
    assert.equal(calls.filter((c) => c.body?.method === "initialize").length, 2);
  });

  it("gives up after 2 retries with status 429 and retryAfterMs", async () => {
    const { fetch, calls } = mockFetch([throttle(isTool("read_concept"), 10), mcpRoute(() => ({ path: "x" }))]);
    const kf = new Supaknowledge({ url: URL, space: "a/b", apiKey: KEY, fetch });
    await assert.rejects(kf.read("x"), (e: any) => e instanceof SupaknowledgeError && e.status === 429 && e.retryAfterMs === 0);
    assert.equal(calls.filter(isTool("read_concept")).length, 3);
  });

  it("does not wait for a Retry-After over the limit", async () => {
    const { fetch, calls } = mockFetch([throttle(isTool("list_skills"), 10, "120"), mcpRoute(() => [])]);
    const kf = new Supaknowledge({ url: URL, space: "a/b", apiKey: KEY, fetch });
    const t0 = Date.now();
    await assert.rejects(kf.listSkills(), (e: any) => e.status === 429 && e.retryAfterMs === 120_000);
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(calls.filter(isTool("list_skills")).length, 1);
  });

  it("never retries writes: flags and trace appends", async () => {
    const { fetch, calls } = mockFetch([
      throttle(isTool("flag_knowledge"), 10),
      throttle((c) => c.url.endsWith("/functions/v1/traces"), 10),
      mcpRoute(() => ({ id: "f-1" })),
    ]);
    const errors: unknown[] = [];
    const kf = new Supaknowledge({ url: URL, space: "a/b", apiKey: KEY, fetch, onError: (e) => errors.push(e) });
    await assert.rejects(kf.flag({ kind: "missing", observation: "no ARR definition" }), (e: any) => e.status === 429);
    assert.equal(calls.filter(isTool("flag_knowledge")).length, 1);
    const trace = kf.trace({ flushIntervalMs: 0 });
    trace.user("hi");
    await trace.end();
    assert.equal(calls.filter((c) => c.url.endsWith("/functions/v1/traces")).length, 1, "trace create is not repeated");
  });

  it("retries REST reads but not REST writes; retry: false turns retries off", async () => {
    const restRpc = (fn: string) => (c: any) => c.url.endsWith(`/rest/v1/rpc/${fn}`);
    const { fetch, calls } = mockFetch([
      throttle(restRpc("search_knowledge"), 1),
      throttle(restRpc("flag_knowledge"), 1),
      (c) => (restRpc("search_knowledge")(c) ? json([]) : undefined),
      (c) => (restRpc("flag_knowledge")(c) ? json("f-1") : undefined),
    ]);
    const kf = new Supaknowledge({ url: URL, space: SPACE_ID, accessToken: "jwt", publishableKey: "pk", transport: "rest", fetch });
    assert.deepEqual(await kf.search("arr"), []);
    assert.equal(calls.filter(restRpc("search_knowledge")).length, 2);
    await assert.rejects(kf.flag({ kind: "missing", observation: "x" }), (e: any) => e.status === 429);
    assert.equal(calls.filter(restRpc("flag_knowledge")).length, 1);

    const off = mockFetch([throttle(isTool("search_knowledge"), 1), mcpRoute(() => [])]);
    const kf2 = new Supaknowledge({ url: URL, space: "a/b", apiKey: KEY, fetch: off.fetch, retry: false });
    await assert.rejects(kf2.search("arr"), (e: any) => e.status === 429);
  });
});

describe("TraceRecorder.mcpTool", () => {
  it("records another MCP server's call in one line, without row data", async () => {
    const events: any[] = [];
    const trace = new TraceRecorder({ create: async (b) => (events.push(...(b.events as any[])), { trace_id: "t" }), update: async () => {}, flag: async () => ({ id: null }) }, { flushIntervalMs: 0 });
    trace.mcpTool({ server: "supabase", name: "execute_sql", input: { query: "select revenue_usd from orders" }, result: { content: [{ type: "text", text: 'ERROR:  42703: column "revenue_usd" does not exist' }], isError: true } });
    trace.mcpTool({ server: "supabase", name: "execute_sql", input: { query: "select email from users" }, result: { content: [{ type: "text", text: '[{"email":"bob@example.com"}]' }] } });
    trace.mcpTool({ server: "supabase", name: "list_tables", input: { schemas: ["public"] }, result: { content: [{ type: "text", text: "orders, users" }] } });
    trace.mcpTool({ server: "supabase", name: "apply_migration", input: { name: "x", query: "create table t()" }, error: new Error("network down") });
    await trace.end();
    assert.deepEqual(events.map((e) => [e.tool_name, e.is_error, e.tool_output]), [
      ["mcp__supabase__execute_sql", true, 'ERROR:  42703: column "revenue_usd" does not exist'],
      ["mcp__supabase__execute_sql", false, { omitted: "row data" }],
      ["mcp__supabase__list_tables", false, "orders, users"],
      ["mcp__supabase__apply_migration", true, "network down"],
    ]);
    assert.doesNotMatch(JSON.stringify(events), /bob@example\.com/);
  });
});
