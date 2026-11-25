# Supaknowledge SDKs

Small clients for apps and agents that use Supaknowledge knowledge:

- **TypeScript**: `@supaknowledge/sdk`. No dependencies; runs anywhere `fetch` exists (Node 18+, Deno, Bun,
  browsers, Cloudflare / Vercel / Supabase Edge).
- **Mastra**: `@supaknowledge/mastra`, the recommended way to give an agent Supaknowledge: knowledge tools, instructions that
  teach it when to flag, and trace capture of its runs. Built on `@supaknowledge/sdk`. See [Mastra agents](#mastra-agents).
- **Python**: `supaknowledge`. Depends only on `httpx`. Python 3.10+.

None of them depends on a model provider. Tool definitions are OpenAI-compatible function tools by default (what
your own endpoint, the Vercel AI Gateway, OpenRouter, vLLM, LiteLLM or Ollama accept), or plain JSON Schema for
any other framework.

The TypeScript and Python clients cover the same ground:

| | TypeScript | Python |
|---|---|---|
| Search knowledge | `kf.search(query, { kinds, limit })` | `kf.search(query, kinds=, limit=)` |
| Read a concept | `kf.read(path, { traceId })` | `kf.read(path, trace_id=)` |
| Skills | `kf.listSkills()`, `kf.loadSkill(name, { traceId })` | `kf.list_skills()`, `kf.load_skill(name, trace_id=)` |
| Report a problem | `kf.flag({ kind, observation, conceptPath, suggestedFix })` | `kf.flag(kind, observation, concept_path=, suggested_fix=)` |
| Record a trace | `kf.trace({ name, externalId })` | `kf.trace(name=, external_id=)` |
| Tools for any LLM loop | `kf.knowledgeTools()`, `kf.handleToolCalls()`, `kf.handleToolCall()` | `kf.knowledge_tools()`, `kf.handle_tool_calls()`, `kf.handle_tool_call()` |
| MCP client config | `kf.mcpServerConfig({ client })` | `kf.mcp_server_config(client)` |

## Credentials

| Who | Credential | How to get it |
|---|---|---|
| A headless agent (service, CI, cron) | Agent key `skn_<agent-id>_<secret>` | `kf agents create <name>` or Studio > Agents |
| An app acting for a signed-in user | The user's Supabase access token (or an OAuth token) | `supabase.auth.getSession()` |

Both are sent as `Authorization: Bearer ...`. Every call runs under RLS as that principal, so an agent sees
exactly the spaces and audiences it was granted. Agents are usually `reader`s: they can search, read, load
skills, flag and send traces, but cannot see raw sources or other principals' traces.

## TypeScript

```bash
npm install @supaknowledge/sdk
```

```ts
import { Supaknowledge } from "@supaknowledge/sdk";

const kf = new Supaknowledge({
  url: process.env.SUPAKNOWLEDGE_URL!,         // https://<project>.supabase.co
  space: "acme/finance",                       // <workspace>/<space>
  apiKey: process.env.SUPAKNOWLEDGE_API_KEY,   // skn_...
});

const results = await kf.search("weekly revenue by region", { kinds: ["skill", "data_access"], limit: 5 });
for (const r of results) console.log(r.path, r.trust, r.stale ? "(stale)" : "");

const orders = await kf.read("data/orders");        // null when missing or not visible
const skills = await kf.listSkills();               // names + descriptions only
const skill = await kf.loadSkill("revenue-report"); // instructions + small text files inline

await kf.flag({
  kind: "incorrect",
  conceptPath: "data/orders",
  observation: "column revenue_usd does not exist; found revenue_usd_net",
  suggestedFix: "use revenue_usd_net",
});
```

Options (`new Supaknowledge({...})`):

| Option | Meaning |
|---|---|
| `url`, `space` | Project URL and `"<workspace>/<space>"` (required). |
| `apiKey` | Agent key. |
| `accessToken` | User token, or `() => string \| Promise<string>` so you can hand in a fresh one on each call. |
| `publishableKey` | Sent as `apikey`; required for the `rest` transport. |
| `transport` | `"auto"` (default), `"mcp"` or `"rest"` (see below). |
| `fetch`, `headers`, `timeoutMs` | Custom fetch (tests, proxies), extra headers, per-request timeout (default 30 s). |
| `onError` | Receives background errors (trace flushes). Defaults to `console.warn`. `kf.reportError(err)` sends an error there (used by `@supaknowledge/mastra`). |
| `retry` | 429 retries for idempotent requests: `{ retries, maxWaitMs }`, default and maximum `{ retries: 2, maxWaitMs: 30000 }`; `false` turns them off. See [Rate limits](#rate-limits-429). |

**Transports.** Knowledge calls go to the `mcp` Edge Function by default: it embeds the query with gte-small
and runs hybrid (vector + full-text) search, and it logs usage. With a user `accessToken` **and** a
`publishableKey`, the SDK can call the PostgREST RPCs directly instead (`transport: "rest"`). That path has no
query embedding, so `search` is **full-text only**. `"auto"` uses MCP and switches to REST only if the `mcp`
function is not deployed (404/501). Agent keys always use MCP (they are not JWTs).

`read` and `loadSkill` over MCP return the parsed fields plus `markdown`: the server's model-ready
rendering, which is what the tool helpers hand back to the model. Pass `{ traceId }` to attribute the read to a
trace (its concept usage then shows on the trace); the tool helpers do this for you. `loadSkill` takes a skill name
(`"revenue-report"`) or its full path (`"skills/revenue-report"`) on both transports. Over the REST transport,
`loadSkill` only returns `stable` skills and both calls wait for the usage log to be written (so it is not lost when
a serverless function freezes right after the call).

Errors are `SupaknowledgeError` with `status` (HTTP), `code` (Postgres / JSON-RPC / `"tool_error"`) and, when the
server sent `Retry-After`, `retryAfterMs`.

#### Rate limits (429)

The server answers `429 Too Many Requests` with a `Retry-After` header when an agent key failed to sign in too
often in a short window (the key exchange in the Edge Functions locks that agent out for a while), and on
`POST /functions/v1/curator/run` (per-space cooldown `KF_CURATOR_RUN_COOLDOWN_S`, plus a per-caller limit). The SDKs
retry **idempotent** requests on 429, honouring `Retry-After` (1 s, then 2 s when it is missing): at most 2
retries, and a `Retry-After` longer than 30 s is not waited for. Idempotent means reads: `search`, `read`,
`listSkills`, `loadSkill`, the MCP handshake, read-only MCP tools (`callTool` decides by the tool's name; pass
`{ idempotent }` to override) and REST reads. Writes are never retried automatically: `flag` and trace creates /
appends (posting a trace again with the same `externalId` re-uses the trace but appends its events again) surface
the 429 as a `SupaknowledgeError` (`status` 429, `retryAfterMs`). The trace recorder keeps a batch that failed with
429 and sends it again on its next flush, no sooner than `Retry-After` (a 429 means nothing was written).

### Traces

Traces are how the curator learns from real work: tool errors, backtracking and human corrections become
flags and then knowledge fixes. The recorder buffers events and sends them to the `traces` function.
**It never throws into your app**: recording methods are synchronous, `flush()` and `end()` never reject,
and failures go to `onError`. Transient failures (network, 5xx, 429) are retried with exponential backoff
(`retryBaseMs` doubling up to `retryMaxMs`; automatic flushes wait, explicit `flush()` / `end()` always try); a
batch the server rejects as invalid (4xx) is dropped. `trace.ensureId()` creates the trace on the server if needed
and returns its id (or null), so a first knowledge call can already be linked to it.

```ts
const trace = kf.trace({ name: "weekly revenue report", externalId: requestId });

trace.user("What was revenue last week?");
trace.tool({ name: "run_sql", input: { sql }, output: error.message, isError: true });
trace.feedback("Use revenue_usd_net, the gross column was dropped");   // human correction
trace.assistant(answer);

await trace.flag({ kind: "outdated", conceptPath: "data/orders", observation: "..." }); // linked to the trace
await trace.end({ outcome: "corrected" });   // unknown | success | failure | corrected
```

| Option | Default | |
|---|---|---|
| `flushIntervalMs` | 2000 | Flush this long after the first buffered event (0 = only on `maxBatch`, `flush()`, `end()`). The timer is `unref`ed in Node. |
| `maxBatch` | 50 | Flush as soon as this many events are buffered. |
| `maxBuffer` | 1000 | Cap while the server is unreachable (oldest dropped, also after a failed batch is put back). |
| `retryBaseMs`, `retryMaxMs` | 1000, 60000 | Backoff after a failed flush (at least the server's `Retry-After` on a 429). |
| `externalId` | | Your id for the run. The server is idempotent on it, and MCP tools accept it as `trace_id`. |

#### OpenTelemetry (OTLP) export

Any OpenTelemetry exporter that speaks OTLP/HTTP **JSON** can send traces without the SDK. The `traces` function
accepts `POST /functions/v1/traces/otlp` (also `/traces/otlp/v1/traces` and `/traces/v1/traces`), maps spans with
the GenAI semantic conventions to trace events, and groups them by OTLP trace id (idempotent: re-sending a trace
appends only new spans).

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="https://<project>.supabase.co/functions/v1/traces/otlp?space=acme/revenue&audience=finance"
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_TRACES_HEADERS="Authorization=Bearer skn_..."
```

| Parameter | Header alternative | |
|---|---|---|
| `space` | `x-supaknowledge-space` | Required: `<workspace>/<space>` or the space id |
| `audience` | `x-supaknowledge-audience` | Optional group slugs (or ids) restricting every trace in the export, e.g. `?audience=finance`; repeat the parameter or separate with commas. The query parameter wins over the header. Unknown groups are refused with 400. Without it, traces have no audience restriction (readable by the sender and the space's reviewers) |

Protobuf is not supported (415); set `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json`.

### Mastra agents

`@supaknowledge/mastra` plugs Supaknowledge into a [Mastra](https://mastra.ai) agent. It peer-depends on `@mastra/core` (1.85+)
and `zod`.

```bash
npm install @supaknowledge/mastra @supaknowledge/sdk @mastra/core zod
```

`@supaknowledge/sdk` is a peer dependency (`^0.1.0`), so your app and the Mastra tools share one client version.

| Export | What |
|---|---|
| `supaknowledgeTools(kf, { prefix?, include? })` | Mastra tools (`createTool`): `search_knowledge`, `read_concept`, `list_skills`, `load_skill`, `flag_knowledge`. Results are model-ready text; failures become error results the model can recover from |
| `supaknowledgeInstructions`, `createSupaknowledgeInstructions({ prefix, include })` | A short system-prompt section: search before answering about internal things, follow skills, and flag missing, wrong or outdated knowledge and anything the agent had to work out itself. With `include`, it only names those tools |
| `withSupaknowledge(agentConfig, kf, { prefix?, include?, instructions? })` | Returns the config with the tools added (yours win on name clashes) and the instructions appended. Works with static and dynamic (function) `instructions` and `tools` |
| `generateWithTrace(agent, kf, input, { trace?, options?, outcome? })` | `agent.generate()` recorded as a Supaknowledge trace. Resolves to `{ result, traceId, trace }`; agent errors are recorded and re-thrown |
| `traceRun(kf, { input?, name?, externalId?, metadata?, requestContext? })` | The same for any call shape, including `agent.stream()`: spread `run.options` into the call, then `run.end(result)` or `run.fail(error)` |

A traced run records the user input, every step's assistant text, every tool call (Supaknowledge's and yours) with its
input and result or error, and, when it ends, the outcome plus `model`, `steps` and token `usage` in the trace
metadata. Steps are recorded as they finish (Mastra's `onStepFinish`), so a run that crashes still leaves a
useful trace. The run's `RequestContext` carries the trace, so `search_knowledge`, `read_concept` and `load_skill`
attribute concept usage to it and `flag_knowledge` links each flag to it. Recording never throws into the agent:
errors go to the run's `onError`, else the client's `onError`.

With your own OpenAI-compatible endpoint (`{ id, url, apiKey }` is Mastra's custom-endpoint model config; the part
of the id after the first `/` is sent as the model name):

```ts
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { Supaknowledge } from "@supaknowledge/sdk";
import { generateWithTrace, withSupaknowledge } from "@supaknowledge/mastra";
import { z } from "zod";

const kf = new Supaknowledge({ url: process.env.SUPAKNOWLEDGE_URL!, space: "acme/finance", apiKey: process.env.SUPAKNOWLEDGE_API_KEY });

const runSql = createTool({
  id: "run_sql",
  description: "Run a SQL query against the warehouse",
  inputSchema: z.object({ sql: z.string() }),
  execute: async ({ sql }) => warehouse.query(sql), // errors reach the model and the trace
});

const analyst = new Agent(
  withSupaknowledge(
    {
      id: "finance-analyst",
      name: "Finance analyst",
      instructions: "You answer finance questions with data from the warehouse.",
      model: {
        id: "acme/llama-4-maverick",                 // sends "model": "llama-4-maverick"
        url: "https://llm.acme.internal/v1",         // any OpenAI-compatible endpoint
        apiKey: process.env.ACME_LLM_KEY,
        headers: { "x-team": "finance" },            // optional
      },
      tools: { run_sql: runSql },
    },
    kf,
  ),
);

const { result, traceId } = await generateWithTrace(analyst, kf, "What was revenue by region last week?", {
  trace: { name: "weekly revenue", externalId: requestId },
  options: { maxSteps: 10 },
});
console.log(result.text, traceId);
```

With the Vercel AI Gateway, use a `vercel/<provider>/<model>` id; Mastra reads `AI_GATEWAY_API_KEY` from the
environment. Fallback models go in an array, tried in order. This one streams, so it uses `traceRun`:

```ts
import { Agent } from "@mastra/core/agent";
import { Supaknowledge } from "@supaknowledge/sdk";
import { supaknowledgeInstructions, supaknowledgeTools, traceRun } from "@supaknowledge/mastra";

const kf = new Supaknowledge({ url: process.env.SUPAKNOWLEDGE_URL!, space: "acme/support", apiKey: process.env.SUPAKNOWLEDGE_API_KEY });

const support = new Agent({
  id: "support",
  name: "Support",
  instructions: `You answer customer questions about Acme's billing.\n\n${supaknowledgeInstructions}`,
  model: [
    { model: "vercel/openai/gpt-6.2-sol", maxRetries: 1 },
    { model: "vercel/openai/gpt-6.1-sol", maxRetries: 1 },   // fallback
  ],
  tools: { ...supaknowledgeTools(kf) },
});

const question = "Can I get a refund after 30 days?";
const run = traceRun(kf, { name: "billing question", input: question });
try {
  const stream = await support.stream(question, { ...run.options, maxSteps: 6 });
  for await (const chunk of stream.textStream) process.stdout.write(chunk);
  await run.end(await stream.getFullOutput());   // outcome "unknown"; pass { outcome } if you know better
} catch (e) {
  await run.fail(e);
  throw e;
}

```

`traceRun` reuses your `requestContext` if you pass one. A run can span several calls: spread `run.options` into
each, record a human correction in between with `run.trace.feedback("...")`, and call `run.end()` once at the end
(the revenue-report example does this). Events recorded after `end()` are dropped.

### Any other tool loop (OpenAI-compatible)

`kf.knowledgeTools()` returns OpenAI-compatible function tools for `search_knowledge`, `read_concept`,
`list_skills`, `load_skill` and `flag_knowledge` (`{ type: "function", function: { name, description, parameters } }`).
`kf.knowledgeTools({ format: "json-schema" })` returns plain `{ name, description, inputSchema }` definitions for
frameworks that want JSON Schema. `kf.handleToolCalls(message.tool_calls)` runs every Supaknowledge call in a list (in
parallel), accepting both `{ id, name, arguments }` and the OpenAI `{ id, function: { name, arguments } }` shape
(arguments as an object or a JSON string), and returns `[{ tool_call_id, name, content, is_error? }]`; calls to
your own tools are skipped, so you answer those yourself. `kf.handleToolCall(name, input)` does one call and
returns `null` for tools that are not Supaknowledge's. Neither throws: failures come back as `is_error: true` so the
model can recover. Pass `{ trace }` to record each call on a trace and link flags to it.

A complete loop against any chat-completions endpoint, with nothing but `fetch`:

```ts
import { Supaknowledge } from "@supaknowledge/sdk";

const kf = new Supaknowledge({ url: process.env.SUPAKNOWLEDGE_URL!, space: "acme/finance", apiKey: process.env.SUPAKNOWLEDGE_API_KEY });
const LLM_URL = process.env.LLM_BASE_URL!;          // e.g. https://llm.acme.internal/v1, or a gateway

async function answer(question: string): Promise<string> {
  const trace = kf.trace({ name: "finance question" });
  trace.user(question);
  const messages: any[] = [
    { role: "system", content: "You answer finance questions. Search the company knowledge base before answering, follow skills when one fits, and call flag_knowledge whenever knowledge was missing, wrong or outdated." },
    { role: "user", content: question },
  ];
  for (let step = 0; step < 10; step++) {
    const res = await fetch(`${LLM_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.LLM_API_KEY}` },
      body: JSON.stringify({ model: "your-model", messages, tools: [...kf.knowledgeTools() /*, ...yourTools */] }),
    });
    const msg = (await res.json()).choices[0].message;
    messages.push(msg);
    if (msg.tool_calls?.length) {
      for (const r of await kf.handleToolCalls(msg.tool_calls, { trace })) {
        messages.push({ role: "tool", tool_call_id: r.tool_call_id, content: r.content });
      }
      // + results of your own tools
      continue;
    }
    trace.assistant(msg.content ?? "");
    await trace.end({ outcome: "success" });
    return msg.content ?? "";
  }
  await trace.end({ outcome: "failure" });
  throw new Error("too many steps");
}
```

The functional form is also available: `const { tools, handleToolCalls, handleToolCall, isKnowledgeTool } =
withSupaknowledge(kf, { prefix: "kf_", trace })` (from `@supaknowledge/sdk`); use `prefix` if your own tools already use these
names.

### MCP clients

Agents that speak MCP can connect straight to the `mcp` Edge Function instead of using the SDK:

```
<project-url>/functions/v1/mcp?space=<workspace>/<space>
```

`kf.mcpServerConfig({ client })` (or `kf mcp-config`) prints the config. With an agent key the client sends
`Authorization: Bearer skn_...`; with `auth: "oauth"` the client signs the user in through Supabase Auth's
OAuth 2.1 server and sees what that user can see.

**Claude Code**

```bash
# as yourself (OAuth): then run /mcp in Claude Code and choose Authenticate
claude mcp add --transport http supaknowledge 'https://abc.supabase.co/functions/v1/mcp?space=acme/finance'

# as an agent
claude mcp add --transport http supaknowledge 'https://abc.supabase.co/functions/v1/mcp?space=acme/finance' \
  --header "Authorization: Bearer $SUPAKNOWLEDGE_API_KEY"
```

or in `.mcp.json` (Claude Code expands `${VAR}`):

```json
{
  "mcpServers": {
    "supaknowledge": {
      "type": "http",
      "url": "https://abc.supabase.co/functions/v1/mcp?space=acme/finance",
      "headers": { "Authorization": "Bearer ${SUPAKNOWLEDGE_API_KEY}" }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json` or `~/.cursor/mcp.json`; omit `headers` to sign in with OAuth):

```json
{
  "mcpServers": {
    "supaknowledge": {
      "url": "https://abc.supabase.co/functions/v1/mcp?space=acme/finance",
      "headers": { "Authorization": "Bearer ${env:SUPAKNOWLEDGE_API_KEY}" }
    }
  }
}
```

**Claude Desktop**: for OAuth, add the endpoint under Settings > Connectors > Add custom connector. With an
agent key, `kf mcp-config --client claude-desktop --agent-key` prints a `claude_desktop_config.json` entry that
bridges to the HTTP endpoint with `mcp-remote`.

Skills also work without MCP: `kf pull` writes them to `.claude/skills/<name>/SKILL.md`, where Claude Code
and Deep Agents discover them.

### Deno, browsers and edge

```ts
import { Supaknowledge } from "npm:@supaknowledge/sdk";   // Deno / Supabase Edge Functions
```

In a browser, use the signed-in user's token (`accessToken: async () => (await supabase.auth.getSession()).data.session!.access_token`)
and never ship an agent key to the client.

## Python

```bash
pip install supaknowledge
```

```python
from supaknowledge import Supaknowledge

kf = Supaknowledge("https://abc.supabase.co", "acme/finance", api_key=os.environ["SUPAKNOWLEDGE_API_KEY"])

for r in kf.search("weekly revenue", kinds=["skill", "data_access"], limit=5):
    print(r["path"], r.get("trust"))

concept = kf.read("data/orders")             # dict, or None
skill = kf.load_skill("revenue-report")
kf.flag("incorrect", "revenue_usd does not exist; found revenue_usd_net",
        concept_path="data/orders", suggested_fix="use revenue_usd_net")
```

Constructor: `Supaknowledge(url, space, *, api_key=None, access_token=None, publishable_key=None, transport="auto",
timeout=30.0, http_client=None, headers=None, on_error=None, max_retries=2, max_retry_wait=30.0)`. `on_error` defaults to a warning on the
`supaknowledge` logger (like `console.warn` in TypeScript). `access_token` may be a callable. Pass your own
`httpx.Client` to share connection pools or to test with `httpx.MockTransport`. The client is a context manager
(`with Supaknowledge(...) as kf:`). Results are plain dicts typed with `TypedDict`s (`SearchResult`, `Concept`, `Skill`).
The transports behave as in TypeScript, and so do [429 retries](#rate-limits-429): `max_retries` (0 turns them
off) and `max_retry_wait` (seconds) can only lower the bounds of 2 retries / 30 s; a write's 429 raises
`SupaknowledgeError` with `status` 429 and `retry_after` (seconds). `call_tool(..., idempotent=True)` overrides the
read-only tool list.

### Traces

```python
with kf.trace(name="weekly revenue", external_id=request_id) as trace:
    trace.user(question)
    trace.tool("run_sql", input={"sql": sql}, output=str(err), is_error=True)
    trace.feedback("use revenue_usd_net")
    trace.set_outcome("corrected")
# leaving the block ends the trace: outcome "success", or "failure" if the block raised (unless set)
```

Like the TypeScript recorder it never raises into your code (errors go to `on_error`). It flushes when
`max_batch` events are buffered, on `flush()` and on `end()`; there is no background thread. `kf.trace(...)` also
takes `max_batch`, `max_buffer` (cap while the server is unreachable, oldest dropped) and `on_error` (overrides the
client's). After a failed flush, automatic flushes back off (`retry_base` seconds doubling up to `retry_max`);
recording is thread-safe and the lock is never held during HTTP. `trace.ensure_id()` returns the server id,
creating the trace if needed.

### Tool loops

`kf.knowledge_tools()` returns OpenAI-compatible function tools (`format="json-schema"` gives plain
`{"name", "description", "input_schema"}` dicts). `kf.handle_tool_calls(message.tool_calls, trace=trace)` accepts
the OpenAI SDK's tool-call objects as well as dicts (`{"id", "name", "arguments"}` or
`{"id", "function": {"name", "arguments"}}`, arguments as a dict or a JSON string) and returns
`[{"tool_call_id", "name", "content", "is_error"?}]` for the Supaknowledge calls. A loop against any chat-completions
endpoint with `httpx`:

```python
import os
import httpx
from supaknowledge import Supaknowledge

kf = Supaknowledge(os.environ["SUPAKNOWLEDGE_URL"], "acme/finance", api_key=os.environ["SUPAKNOWLEDGE_API_KEY"])
llm = httpx.Client(base_url=os.environ["LLM_BASE_URL"], headers={"Authorization": f"Bearer {os.environ['LLM_API_KEY']}"}, timeout=120)

def answer(question: str) -> str:
    with kf.trace(name="finance question") as trace:
        trace.user(question)
        messages = [
            {"role": "system", "content": "Search the company knowledge base before answering, follow skills when one fits, "
                                          "and call flag_knowledge whenever knowledge was missing, wrong or outdated."},
            {"role": "user", "content": question},
        ]
        for _ in range(10):
            body = {"model": "your-model", "messages": messages, "tools": kf.knowledge_tools()}  # + your own tools
            msg = llm.post("/chat/completions", json=body).raise_for_status().json()["choices"][0]["message"]
            messages.append(msg)
            if msg.get("tool_calls"):
                for r in kf.handle_tool_calls(msg["tool_calls"], trace=trace):  # + results of your own tools
                    messages.append({"role": "tool", "tool_call_id": r["tool_call_id"], "content": r["content"]})
                continue
            trace.assistant(msg.get("content") or "")
            trace.set_outcome("success")
            return msg.get("content") or ""
        trace.set_outcome("failure")
        raise RuntimeError("too many steps")
```

`kf.handle_tool_call(name, input)` runs a single call and returns `{"content": ..., "is_error"?: True}`, or
`None` for tools that are not Supaknowledge's. Invalid JSON tool arguments come back as an error result and are
recorded on the trace. `kf.mcp_server_config("cursor", api_key=None, api_key_env="SUPAKNOWLEDGE_API_KEY")` and
`build_mcp_config(...)` produce the same MCP configs as the TypeScript SDK (`api_key=""` writes an environment
variable placeholder instead of inlining the key).

### Development

```bash
cd sdks/python
uv venv && uv pip install -e ".[test]"
.venv/bin/python -m pytest
```
