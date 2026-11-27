# Supaknowledge on Supabase

A summary for Supabase's partner and integrations listing.

## What it does

Supaknowledge is an open-source (Apache-2.0) knowledge factory for AI agents. Agents read company knowledge (skills,
domain knowledge, data-access notes) over MCP and flag what is missing or wrong. A curator turns those flags, agent
traces and source documents (Notion, Slack, GitHub, Google Drive, web pages, uploads) into reviewable proposals with
citations. People approve them in Studio, a web app, or with the `kf` CLI, and every agent sees the result.

It is a Supabase project: migrations and Edge Functions that run on a hosted Supabase project, on a self-hosted
Supabase, or locally with `supabase start`. There is no other backend.

Status: alpha (0.1). APIs, the schema and file formats may change before 1.0.

## Supabase products it uses

| Product | Used for |
|---|---|
| Postgres + row level security | Knowledge, revisions, flags, proposals and the audit log. Every access rule (workspaces, spaces, roles, audience groups) is enforced by RLS and covered by pgTAP tests |
| pgvector + full-text search | Hybrid search in one SQL function |
| Edge Functions | The remote MCP server, trace ingest, bundle import and export, the curator, connectors and embeddings |
| Edge Runtime AI (`Supabase.ai`, gte-small) | Embeddings without an external API key |
| Auth | People, headless agents (API keys) and MCP clients, which sign in through Supabase Auth's OAuth 2.1 server; anonymous sign-ins for the optional public demo |
| Queues (pgmq) and Cron | Embedding, connector and curator pipelines, nightly maintenance |
| Storage | Skill files and raw source files, with access that follows the rows they belong to |
| Vault | Connector tokens and the internal secret cron jobs send to the functions |
| Realtime | The live review inbox in Studio |
| Management API and OAuth for integrations | `kf deploy` configures a hosted project; `kf deploy --login` signs in with Supabase OAuth and can create the project |

## Setup

From a clone of the repository, with Node 22.18 or later:

1. `npm install && npm run build:cli`
2. Deploy to a hosted Supabase project, either with a personal access token
   (`SUPABASE_ACCESS_TOKEN=... npx kf deploy --project-ref <ref> --env-file ./hosted.env`) or by signing in with
   Supabase in the browser (`npx kf deploy --login`, which can also create the project). The command applies the
   migrations, sets the Vault and function secrets, deploys the Edge Functions, configures Auth and checks the result.
3. Deploy Studio to Cloudflare Workers (`npm run build:cloudflare` and `npm run deploy:cloudflare` in
   `apps/studio`), Vercel, Netlify or any Node host, with the project URL and publishable key.
4. Sign up in Studio, create a workspace and a space (`npx kf init`), and import knowledge
   (`npx kf import <dir> --apply`).
5. Connect an agent: `claude mcp add --transport http supaknowledge '<project-url>/functions/v1/mcp?space=<workspace>/<space>'`,
   or any MCP client; it signs in through Supabase Auth.
6. Set a model for the curator (any OpenAI-compatible endpoint, the Vercel AI Gateway or OpenRouter).

## Links

- Repository: https://github.com/alvarofc/supaknowledge
- Deploy guide: [docs/deploy.md](deploy.md)
- Architecture: [docs/architecture.md](architecture.md)
- Access control: [docs/access-control.md](access-control.md)
- MCP: [docs/mcp.md](mcp.md)
- CLI: [docs/cli.md](cli.md)
- License: [Apache-2.0](../LICENSE)

Supaknowledge is a community project and is not affiliated with or endorsed by Supabase, Inc.
