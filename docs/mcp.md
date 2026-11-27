# MCP: connecting agents

Supaknowledge serves knowledge to agents through one remote MCP server, the `mcp` Edge Function (Streamable HTTP). Any
MCP client can use it; the [SDKs](sdk.md) wrap the same tools for code that drives a model directly.

```
<project-url>/functions/v1/mcp?space=<workspace>/<space>
```

Locally: `http://127.0.0.1:54321/functions/v1/mcp?space=acme/revenue`. `kf mcp-config` prints the address and a
ready-made config for your client.

## Choosing the space

A tool call uses, in order: its own `space` argument, the space in the URL (`?space=<ws>/<space>`, or the path
form `/functions/v1/mcp/<ws>/<space>`; a space uuid works too), or the caller's only space. If the caller can read
several spaces and none is chosen, the tool fails with the list; `list_spaces` returns it too.

## Authentication

| Mode | Header | Acts as | Use it for |
|---|---|---|---|
| **OAuth** (default for people) | none at setup; the client signs in through Supabase Auth's OAuth 2.1 server | the signed-in person, with all their spaces and groups, limited to reading, searching, usage, flags and traces | Claude Code, Cursor, Claude Desktop on someone's machine |
| **Agent key** | `Authorization: Bearer skn_<agent-id>_<secret>` | the agent's own Auth user (usually a `reader` of one space) | CI, services, bots, shared agents |
| Supabase session | `Authorization: Bearer <access token>` | the person | apps that already have a Supabase session |

Requests without a valid token get `401` with
`WWW-Authenticate: Bearer resource_metadata="<project-url>/functions/v1/mcp/.well-known/oauth-protected-resource"`,
which is how MCP clients discover the authorization server. Details, and how keys are revoked, are in
[access control](access-control.md#oauth-21-for-mcp-clients).

An OAuth token covers everything the tools below do, whatever the person's role, but nothing more: it cannot be
used to administer the workspace, create, approve or reject proposals (bundle import included), or verify and
revert knowledge, even through the REST API or the other functions. See
[what OAuth clients can do](access-control.md#what-oauth-clients-can-do).

## Tools

The server also sends instructions telling the model to search before working, prefer what it finds, treat
`unverified` and stale results with care, and flag every gap or mistake.

| Tool | Arguments | Returns |
|---|---|---|
| `list_spaces` | | The spaces the caller can read, as `"<workspace>/<space>"` |
| `search_knowledge` | `query`, `kinds?` (`skill` · `domain` · `data_access`), `limit?` (1–25, default 8), `space?`, `trace_id?` | Hybrid (vector + full-text) results: path, title, description, kind, type, trust tier, `stale`, snippet. An empty result suggests flagging the gap |
| `read_concept` | `path`, `space?`, `trace_id?` | Markdown: title, metadata (kind, type, status, revision, trust, staleness, last change), warnings for unverified / stale / deprecated content, the body, outgoing links (marked `[missing]` when the target does not exist), backlinks and attached files |
| `list_skills` | `space?` | Name, title and description of every stable skill (progressive disclosure) |
| `load_skill` | `name` (e.g. `revenue-report` or `skills/revenue-report`), `space?`, `trace_id?` | The SKILL.md body plus attached files; text files up to 32 KB are inlined (128 KB in total), others are listed |
| `flag_knowledge` | `kind` (`missing` · `incorrect` · `outdated` · `conflicting` · `unclear`), `observation`, `concept_path?`, `query?`, `suggested_fix?`, `evidence?` (a JSON object, at most 16,000 characters), `space?`, `trace_id?` | The new flag id. The flag inherits the concept's audience and records the OAuth client |

Everything runs under the caller's RLS: results never include concepts outside the caller's audiences, and a
`read_concept` on one answers "No concept at …", exactly like a missing path. `search_knowledge`, `read_concept`
and `load_skill` log `concept_usage`, which feeds the health page ("never used", flag rate per concept).

**Linking to a trace.** If the agent also records a trace (see [SDKs](sdk.md#traces)), pass its id (the Supaknowledge
trace id or the `external_id` you chose) as `trace_id`. Usage and flags are then attached to the trace, and the
curator reads the transcript when it works on the flag.

The server is stateless: no `initialize` handshake or session id is required, and each POST is a JSON-RPC
request. Responses come as `text/event-stream` (send `Accept: application/json, text/event-stream`):

```bash
curl -s "http://127.0.0.1:54321/functions/v1/mcp?space=acme/revenue" \
  -H "Authorization: Bearer $SUPAKNOWLEDGE_API_KEY" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_knowledge","arguments":{"query":"revenue by region"}}}'
```

## Claude Code

As yourself:

```bash
claude mcp add --transport http supaknowledge 'http://127.0.0.1:54321/functions/v1/mcp?space=acme/revenue'
```

Then run `/mcp`, select `supaknowledge` and choose **Authenticate**. The browser opens Studio's consent page (sign in
first if needed). Add `--scope user` to make the server available in every project.

As an agent:

```bash
export SUPAKNOWLEDGE_API_KEY=skn_...
claude mcp add --transport http supaknowledge 'http://127.0.0.1:54321/functions/v1/mcp?space=acme/revenue' \
  --header "Authorization: Bearer $SUPAKNOWLEDGE_API_KEY"
```

or commit a `.mcp.json` that references the variable instead of the key (Claude Code expands `${VAR}`):

```json
{
  "mcpServers": {
    "supaknowledge": {
      "type": "http",
      "url": "http://127.0.0.1:54321/functions/v1/mcp?space=acme/revenue",
      "headers": { "Authorization": "Bearer ${SUPAKNOWLEDGE_API_KEY}" }
    }
  }
}
```

Leave out `headers` to use OAuth instead.

## Cursor

`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "supaknowledge": {
      "url": "http://127.0.0.1:54321/functions/v1/mcp?space=acme/revenue",
      "headers": { "Authorization": "Bearer ${env:SUPAKNOWLEDGE_API_KEY}" }
    }
  }
}
```

Without `headers`, Cursor runs the OAuth flow.

## Claude Desktop and claude.ai

- **OAuth:** Settings → Connectors → Add custom connector, and paste the endpoint URL. Custom connectors are
  reached from Anthropic's servers, so the URL must be publicly reachable: use a deployed project
  ([deploy](deploy.md)), not `127.0.0.1`.
- **Agent key, local stack:** `kf mcp-config --client claude-desktop --agent-key skn_...` prints a
  `claude_desktop_config.json` entry (Settings → Developer → Edit Config) that bridges stdio to the HTTP endpoint
  with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "supaknowledge": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:54321/functions/v1/mcp?space=acme/revenue", "--header", "Authorization:${SUPAKNOWLEDGE_AUTH}"],
      "env": { "SUPAKNOWLEDGE_AUTH": "Bearer skn_..." }
    }
  }
}
```

## Other clients

Any client that speaks Streamable HTTP works. With an agent key, configure the URL and the `Authorization`
header (`kf mcp-config --client generic --agent-key`). For OAuth, the client must support the MCP authorization
spec (protected resource metadata, dynamic client registration, PKCE).

From code, `@supaknowledge/sdk` and the Python `supaknowledge` package call these tools for you and also turn them into
tool definitions for any model (OpenAI-compatible function tools or plain JSON Schema), and `@supaknowledge/mastra`
gives a Mastra agent the same tools plus trace capture; see [SDKs](sdk.md).

## Skills without MCP

Clients that load Agent Skills from disk can use them without MCP: `kf pull` writes every skill to
`.claude/skills/<name>/` and the whole OKF bundle to `.supaknowledge/knowledge/`, and only overwrites files it wrote
itself ([CLI](cli.md#knowledge-in-and-out)). Flags then go through `kf flag` or the SDK.

## Use with the Supabase MCP server

Agents that work on a Supabase project often have two MCP servers side by side: the
[Supabase MCP server](https://supabase.com/docs/guides/getting-started/mcp) for the database itself (`list_tables`,
`execute_sql`, `apply_migration`, `list_migrations`...) and Supaknowledge for what the data means and how to query
it. Together, a query that fails is no longer lost: it becomes evidence the curator turns into a fix of the
knowledge the agent followed.

### Configuration

The Supabase server and Supaknowledge usually point at different projects: the database your agent works on, and
the project that hosts Supaknowledge. Supabase documents the hosted server at `https://mcp.supabase.com/mcp`, with
`project_ref` to scope it to one project and `read_only=true` to run queries as a read-only Postgres user; with the
Supabase CLI, its docs give `http://localhost:54321/mcp` instead. Check
[Supabase's MCP guide](https://supabase.com/docs/guides/getting-started/mcp) for the current options.

**Claude Code**, `.mcp.json` in the project:

```json
{
  "mcpServers": {
    "supabase": {
      "type": "http",
      "url": "https://mcp.supabase.com/mcp?project_ref=<project-ref>&read_only=true"
    },
    "supaknowledge": {
      "type": "http",
      "url": "https://<kf-project>.supabase.co/functions/v1/mcp?space=acme/app"
    }
  }
}
```

or with the CLI:

```bash
claude mcp add --transport http supabase 'https://mcp.supabase.com/mcp?project_ref=<project-ref>&read_only=true'
claude mcp add --transport http supaknowledge 'https://<kf-project>.supabase.co/functions/v1/mcp?space=acme/app'
```

Then run `/mcp` and authenticate each server.

**Cursor**, `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "supabase": { "url": "https://mcp.supabase.com/mcp?project_ref=<project-ref>&read_only=true" },
    "supaknowledge": { "url": "https://<kf-project>.supabase.co/functions/v1/mcp?space=acme/app" }
  }
}
```

The server names are up to you. Supaknowledge recognises the Supabase tools by their own names after whatever
prefix the client adds: `mcp__supabase__execute_sql` (Claude Code), `supabase_execute_sql`, `supabase.execute_sql`
and a bare `execute_sql` all count.

### How the loop works

1. The agent searches Supaknowledge and reads the table guide (`read_concept data/orders`), then runs the
   documented query with `execute_sql`.
2. Postgres rejects it: `column "revenue_usd" does not exist`, `relation "public.subscriptions" does not exist`,
   `permission denied for table invoices`, a row level security violation, an unknown enum label.
3. The failure reaches Supaknowledge in one of two ways. The agent calls `flag_knowledge` (the server's
   instructions ask it to flag knowledge that turned out wrong), or the tool call arrives in a
   [trace](sdk.md#traces): `@supaknowledge/mastra` records every tool call of a Mastra agent, including MCP tools,
   and the SDKs record one in a line (below). Interactive clients such as Claude Code and Cursor do not send traces
   by themselves, so there the flag is the path.
4. Trace ingest stores the call without values: literals in the SQL become `'?'` and `?`, a successful result is
   replaced by its row count, and a failure keeps only the parsed Postgres error (SQLSTATE, message, hint), with
   values in it (`Key (email)=(…)`, `Failing row contains (…)`) redacted. An MCP result with `isError: true` is stored
   as an error even when the client recorded it as a normal result.
5. The curator's first step turns every failed SQL call whose error knowledge could have prevented into a synthetic
   flag, without a model call. The flag names the identifier (`column revenue_usd`) and carries the redacted failing
   SQL, the error, Postgres's hint and the redacted SQL of a later call of the same tool that succeeded. When the
   agent read a concept that mentions the identifier before the error, the flag is about that concept; otherwise it
   reports missing knowledge. One flag per trace and identifier, however often the agent repeated the mistake.
6. Triage and drafting work as for any flag ([curator](curator.md#pipeline)). A low-risk data-access fix backed by
   this evidence can apply itself under the space's [policy](curator.md#settings-and-policy); everything else
   waits for review.

| Postgres error | SQLSTATE | Flag |
|---|---|---|
| undefined column, table, schema, function or type | `42703`, `42P01`, `3F000`, `42883`, `42704` | `incorrect` on the concept the agent followed, else `missing` |
| permission denied, row level security violation | `42501` | `missing` (who may read or write it), on the concept when known |
| invalid enum value | `22P02` | `incorrect` on the concept when known, else `missing` |
| syntax errors and other errors | | no flag: the agent's mistake, not the knowledge's |

The same mining applies to any tool whose input is SQL (`{ "sql": ... }` or `{ "query": ... }`), such as your own
`run_sql` tool, and its flags' evidence is redacted the same way. Ingest only rewrites the Supabase MCP server's
`execute_sql` and `apply_migration` events; other tools are stored as sent.

### Capturing the calls in your own agent

With your own MCP client and the SDKs, one line per call records the Supabase tool's result on the trace. A
successful `execute_sql` result is replaced by `{ "omitted": "row data" }` before it leaves your process:

```ts
const result = await supabaseMcp.callTool({ name: "execute_sql", arguments: args });
trace.mcpTool({ server: "supabase", name: "execute_sql", input: args, result });
```

```python
result = await session.call_tool("execute_sql", args)
trace.mcp_tool("supabase", "execute_sql", args, result)
```

A Mastra agent traced with `@supaknowledge/mastra` needs nothing more: every tool call of the run is recorded,
Supabase MCP tools included, and an MCP result with `isError: true` is recorded as a failure.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `several spaces are available; pass space=…` | Add `?space=<ws>/<space>` to the URL |
| `space "…" not found or not accessible` | Wrong slug, or the principal has no role on that space |
| `invalid or revoked agent key` | The key was rotated, or the agent was revoked or deleted |
| OAuth opens `localhost` but Studio runs on `127.0.0.1` | Use the same host as Auth's `site_url` (`http://127.0.0.1:3000` locally) |
| Search finds only exact words | Embeddings are missing; see [getting started](getting-started.md#troubleshooting) |
