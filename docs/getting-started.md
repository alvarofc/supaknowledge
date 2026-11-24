# Getting started

This guide runs Supaknowledge on your machine, loads the example knowledge, connects an agent, and walks through one
turn of the loop: an agent flags a problem, the curator proposes a fix, a person approves it.

## 1. Prerequisites

- Node.js 22.18 or newer (24 recommended). The repo runs TypeScript directly with Node's type stripping.
- Docker, for the local Supabase stack. The Supabase CLI comes with `npm install` (`npx supabase`).
- Optional: [Claude Code](https://claude.com/claude-code) or another MCP client; a model for the curator (your own
  OpenAI-compatible endpoint, or a [Vercel AI Gateway](https://vercel.com/ai-gateway) or OpenRouter key); and
  [uv](https://docs.astral.sh/uv/) for the Python SDK tests.

## 2. Start the stack

```bash
npm install && npm run build:cli
cp supabase/.env.example supabase/.env
cp apps/studio/.env.example apps/studio/.env.local
npx supabase start
```

- `npm run build:cli` builds the `kf` CLI and links it, so `npx kf` runs the local build. (Before that, `npx kf`
  would offer to download an unrelated `kf` package from the npm registry: say no.)
- `supabase/.env` holds the Edge Function secrets that `supabase/config.jsonc` reads with `env()`:
  `KF_INTERNAL_SECRET` (cron → functions), the curator's model settings (`KF_LLM_MODEL`, `KF_LLM_BASE_URL`,
  `KF_LLM_API_KEY`, `AI_GATEWAY_API_KEY`, ...) and an optional `GITHUB_TOKEN` (GitHub connector). Leave the model
  settings empty for now.
- `npx supabase start` applies the migrations, runs `supabase/seed.sql` (it stores `project_url` and
  `kf_internal_secret` in Vault, so cron can call the functions) and serves every Edge Function. It prints the API
  URL (`http://127.0.0.1:54321`) and the publishable and secret keys; `npx supabase status` shows them again.

Background work starts right away: pg_cron drains the embedding queue every 10 seconds, source syncs every 30
seconds and curator tasks every 15 seconds (see [architecture](architecture.md#queues-and-cron)).

## 3. Sign up in Studio

```bash
npm run studio          # http://127.0.0.1:3000
```

Open **http://127.0.0.1:3000** (not `localhost`: Auth's local `site_url` and the OAuth redirects use 127.0.0.1)
and sign up with an email and password. Email confirmation is off locally; any emails (magic links) land in
Mailpit at http://127.0.0.1:54324. Studio's onboarding can create a workspace and space, but this guide uses the
CLI for that.

## 4. Create a space and load knowledge

```bash
npx kf login --url http://127.0.0.1:54321 --publishable-key sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH --email you@example.com
npx kf init --workspace acme --space revenue        # creates both, writes .supaknowledge.json in this folder
npx kf groups create finance && npx kf groups add finance me
npx kf lint examples/revenue-report/knowledge
npx kf import examples/revenue-report/knowledge --apply
```

- `kf login` prompts for your password and stores the session in `~/.config/supaknowledge/config.json`.
- `kf init` makes you the workspace **owner**, which makes you an admin of every space in it.
- The example bundle has one finance-only concept (`x-supaknowledge-audience: [finance]`), so create the `finance`
  group first. Import with a missing group logs `unknown audience group "finance" ignored` and the concept
  becomes readable by everyone in the space; see [access control](access-control.md#audiences).
- `kf import` sends the files to the `bundle` function, which turns them into **one proposal**. `--apply`
  approves it on the spot (you need the reviewer role). Every concept gets a revision and your verification, so
  it shows as `human_reviewed`.
- Within about 10 seconds the `embed` function chunks and embeds each concept and rebuilds the link graph.

Try it:

```bash
npx kf search "monthly revenue by region"
npx kf read data/bigquery/revenue
npx kf read skills/revenue-report
```

## 5. Connect an agent

**As yourself (OAuth).** The agent acts with your permissions:

```bash
claude mcp add --transport http supaknowledge 'http://127.0.0.1:54321/functions/v1/mcp?space=acme/revenue'
```

In Claude Code, run `/mcp`, pick `supaknowledge` and choose **Authenticate**. The browser opens Studio's consent page;
sign in if needed and allow. Then ask something like *"Use supaknowledge: how does Acme define ARR, and which table
should I query for revenue by region?"*.

**As a headless agent (API key).** For CI jobs, services and bots:

```bash
npx kf agents create revenue-bot --role reader      # prints skn_<agent-id>_<secret> once
export SUPAKNOWLEDGE_API_KEY=skn_...
npx kf mcp-config --client claude-code --agent-key  # prints the `claude mcp add ... --header` command
```

Other clients and the SDKs: [MCP](mcp.md), [SDKs](sdk.md).

## 6. Close the loop

Raise a flag the way an agent would (agents call the `flag_knowledge` tool; the CLI and SDKs wrap it):

```bash
npx kf flag outdated "Query failed: Unrecognized name: revenue_usd; Did you mean revenue_usd_net?" \
  --path data/bigquery/revenue --fix "Document revenue_usd_net instead of revenue_usd"
npx kf flags
```

Give the curator a model in `supabase/.env` and restart the stack (data is kept). Either your own
OpenAI-compatible endpoint (vLLM, LiteLLM, Ollama, an internal gateway...):

```bash
# supabase/.env
KF_LLM_MODEL=acme/your-model                   # the part after "/" is sent as the model name
KF_LLM_BASE_URL=https://llm.acme.internal/v1   # from Docker, reach your machine as http://host.docker.internal:<port>/v1
KF_LLM_API_KEY=...
```

or the Vercel AI Gateway:

```bash
# supabase/.env
KF_LLM_MODEL=vercel/openai/gpt-6.2-sol
AI_GATEWAY_API_KEY=...
```

Fallback models, a cheaper fast model and OpenRouter are covered in
[model configuration](curator.md#model-configuration).

```bash
npx supabase stop && npx supabase start
npx kf curate --watch          # request a run now and follow it
npx kf proposals               # what the curator proposed
npx kf proposal <id>           # rationale, citations and a diff of every change
npx kf approve <id>            # or: npx kf reject <id> --note "why"
```

The same happens in Studio: the **Inbox** of the space (`/w/acme/revenue`) updates live, and each proposal page
shows the diffs, citations and an approve / reject form. Without `kf curate`, runs start on their own: nightly
at 02:00 UTC when there is something new, and as soon as a concept collects three open flags (configurable).
See [curator](curator.md).

## 7. Run the demo

`examples/revenue-report` plays the whole story from the knowledge-factory post against your stack: two people
(a finance lead and an engineer), a workspace with a finance group, the bundle import, a headless agent that hits
a renamed column and flags it through the SDK, a trace where the finance lead corrects the report format, the
access model (the engineer and the agent cannot see the finance-only concept; the finance lead can) and a
curator run.

```bash
npm run demo                   # creates acme-demo-<id> workspaces and @acme-demo.test users
npm run demo -- --reset        # deletes everything earlier demo runs created
npm run demo:offline           # the same story with an in-memory store and a scripted model; no stack, no key
```

With `KF_LLM_MODEL` (and `KF_LLM_BASE_URL` / `KF_LLM_API_KEY`, or `AI_GATEWAY_API_KEY`) exported in your shell, the
demo's working agent is a real Mastra agent wired with `@supaknowledge/mastra`; otherwise it is simulated. Without a
model in `supabase/.env`, the demo stops at the curator step and prints how to configure one.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Concepts never get embedded; search only matches exact words | Cron calls the functions with the Vault secrets from `supabase/seed.sql` and the functions compare `KF_INTERNAL_SECRET` from `supabase/.env`. Make sure `supabase/.env` exists and restart. Recent calls: `select status_code, content from net._http_response order by created desc limit 5;` |
| Curator runs fail with `no model configured: set KF_LLM_MODEL` | Set the model settings in `supabase/.env`, then `npx supabase stop && npx supabase start`. |
| Curator tasks fail with `Cannot connect to API` | The functions run in Docker: use `http://host.docker.internal:<port>/v1`, not `127.0.0.1`, for an endpoint on your machine. |
| `npx kf` asks to install a package | Run `npm run build:cli` first. |
| Signed in on `localhost` but redirects go to `127.0.0.1` | Use http://127.0.0.1:3000 everywhere; cookies are per host. |
| Function errors | `docker logs -f supabase_edge_runtime_openkf` |
