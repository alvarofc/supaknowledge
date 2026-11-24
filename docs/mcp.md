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
| `flag_knowledge` | `kind` (`missing` · `incorrect` · `outdated` · `conflicting` · `unclear`), `observation`, `concept_path?`, `query?`, `suggested_fix?`, `space?`, `trace_id?` | The new flag id. The flag inherits the concept's audience and records the OAuth client |

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

## Troubleshooting

| Symptom | Cause |
|---|---|
| `several spaces are available; pass space=…` | Add `?space=<ws>/<space>` to the URL |
| `space "…" not found or not accessible` | Wrong slug, or the principal has no role on that space |
| `invalid or revoked agent key` | The key was rotated, or the agent was revoked or deleted |
| OAuth opens `localhost` but Studio runs on `127.0.0.1` | Use the same host as Auth's `site_url` (`http://127.0.0.1:3000` locally) |
| Search finds only exact words | Embeddings are missing; see [getting started](getting-started.md#troubleshooting) |
