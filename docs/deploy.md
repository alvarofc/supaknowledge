# Deploy

Supaknowledge is a Supabase project (migrations + Edge Functions) plus Studio, a TanStack Start app. This guide deploys the
project to Supabase's cloud and Studio to Vercel, then covers self-hosted Supabase.

## 1. Supabase project

Create a project in the [Supabase dashboard](https://supabase.com/dashboard), then from the repository root:

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push            # applies supabase/migrations (seed.sql is for local only)
```

The migrations enable what they need (`vector`, `pg_trgm`, `pgmq`, `pg_net`, `pg_cron`, `supabase_vault`), create
the queues, cron jobs, Storage buckets and the Realtime publication.

## 2. Vault secrets for cron

Cron jobs call the Edge Functions through `pg_net`, with two Vault secrets. Generate a long random string
(`openssl rand -hex 32`) and run in the SQL editor:

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<the random string>', 'kf_internal_secret');
```

Until both exist, the jobs log `vault secrets project_url / kf_internal_secret missing` and do nothing: no
embeddings, no source syncs, no curator runs.

## 3. Edge Functions

```bash
npm run sync:shared                         # make sure _shared/core matches packages/core
npx supabase functions deploy               # deploys every function in supabase/functions
npx supabase secrets set KF_INTERNAL_SECRET=<the same random string>

# the curator's model, ONE of:
# a) your OpenAI-compatible endpoint
npx supabase secrets set \
  KF_LLM_MODEL=acme/your-model \
  KF_LLM_BASE_URL=https://llm.acme.internal/v1 \
  KF_LLM_API_KEY=...
# b) the Vercel AI Gateway
npx supabase secrets set \
  KF_LLM_MODEL=vercel/openai/gpt-6.2-sol \
  AI_GATEWAY_API_KEY=...
```

Optional model secrets: `KF_LLM_FAST_MODEL` (cheaper model for trace mining), `KF_LLM_FALLBACK_MODELS`
(comma-separated, tried in order), `KF_LLM_HEADERS` (JSON object of extra headers for your endpoint), `KF_LLM_API`
(`chat` or `responses`), `OPENROUTER_API_KEY` (for `openrouter/...` ids). Secrets apply to new invocations; no
redeploy needed. The endpoint must be reachable from Supabase's Edge Functions (public, or through your network's
ingress). See [model configuration](curator.md#model-configuration).

`supabase/config.jsonc` sets `verify_jwt = false` for every function: they authenticate callers themselves
(agent keys are not JWTs; cron uses the internal secret). `SUPABASE_URL` and the project keys are provided by the
platform.

Optional secrets:

| Secret | When |
|---|---|
| `GITHUB_TOKEN` | Default token for GitHub sources without their own (public repos get a higher rate limit) |
| `KF_PUBLIC_URL` | The `mcp` function builds its OAuth metadata from the request host; set this when clients reach the project through a custom domain or proxy, e.g. `https://kb.example.com` |
| `CONNECTOR_DOC_LIMIT`, `CONNECTOR_TIME_BUDGET_MS` | Connector batch size and time budget per run (keep the budget below your plan's function wall-clock limit); see [connectors](connectors.md#limits-and-tuning) |

## 4. Auth

In **Authentication → URL Configuration**:

- **Site URL**: your Studio URL, e.g. `https://studio.example.com`. Email links and the OAuth consent redirect use
  it.
- **Redirect URLs**: `https://studio.example.com/**` (and your preview domains if you use them).

In **Authentication → OAuth Server** (needed for MCP clients that sign people in):

- enable the OAuth 2.1 server;
- authorization path: `/oauth/consent` (Studio's consent page);
- enable dynamic client registration, so Claude Code, Cursor and others can register themselves.

Decide whether anyone may sign up (**Authentication → Sign In / Providers**). People only see what they are
granted, but you may prefer invitations.

## 5. Studio on Vercel

Import the repository in Vercel with **Root Directory** `apps/studio` and the build command `npm run build`. Then
set these variables for Production and Preview. Vite inlines them at build time, so redeploy after changing them:

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | the project's publishable key (`sb_publishable_…`) |

Studio never needs a secret key.

The build uses Nitro, which detects Vercel and writes `.vercel/output`. The same build also deploys to Netlify, or to
any Node host with `npm run build -w @supaknowledge/studio` then `node apps/studio/.output/server/index.mjs`. Details
(monorepo settings, Netlify, Node/Docker, email templates): [Studio](studio.md#deploy).

## 6. Check it

```bash
curl -s https://<project-ref>.supabase.co/functions/v1/mcp/.well-known/oauth-protected-resource
```

Then sign up in Studio, and from your machine:

```bash
npx kf login --url https://<project-ref>.supabase.co --publishable-key sb_publishable_... --email you@example.com
npx kf init --workspace acme --space revenue
npx kf import ./knowledge --apply
npx kf search "something from your knowledge"     # semantic hits mean the embed cron works
```

If search only matches exact words after a minute, check the cron calls in the SQL editor:

```sql
select jobname, status, return_message, start_time from cron.job_run_details
  join cron.job using (jobid) order by start_time desc limit 10;
select status_code, content from net._http_response order by created desc limit 10;
```

A `401 internal secret required` / `invalid internal secret` means `KF_INTERNAL_SECRET` and the Vault
`kf_internal_secret` differ.

## Updating

```bash
git pull
npx supabase db push
npm run sync:shared && npx supabase functions deploy
```

and redeploy Studio. Migrations are additive and ordered; run them before deploying functions that depend on
them.

## Self-hosted Supabase

Supaknowledge uses only standard Supabase services, so it runs on the self-hosted Docker setup. Things to check:

- **Postgres extensions.** The `supabase/postgres` image ships `vector`, `pgmq`, `pg_net`, `pg_cron` and
  `supabase_vault`. `pg_cron` must be in `shared_preload_libraries` and run in the `postgres` database (both are
  the image's defaults).
- **Migrations.** Apply `supabase/migrations/*.sql` in order with `psql` as the `postgres` user, or use
  `supabase db push --db-url <connection string>`.
- **`project_url`.** The Vault secret must be a URL the *database container* can reach for
  `/functions/v1/<name>`, usually the internal API gateway (e.g. `http://kong:8000` in the default compose file;
  the local CLI stack uses `http://api.supabase.internal:8000`).
- **Edge Functions.** Copy `supabase/functions` into the functions volume of the edge runtime and give the
  runtime the secrets `KF_INTERNAL_SECRET` and the `KF_LLM_*` model settings (`KF_LLM_MODEL`, plus
  `KF_LLM_BASE_URL` / `KF_LLM_API_KEY` or `AI_GATEWAY_API_KEY`; see [model configuration](curator.md#model-configuration))
  and the usual `SUPABASE_URL` and keys. With a self-hosted model, the endpoint only has to be reachable from the
  edge runtime container. The
  `embed` and `mcp` functions use the runtime's built-in `Supabase.ai` gte-small model; keep the edge runtime
  version recent enough to provide it.
- **Auth.** Set the site URL and redirect URLs to Studio, and enable the OAuth 2.1 server with the authorization
  path `/oauth/consent` in the Auth (GoTrue) configuration; see the Supabase self-hosting docs for the
  environment variables of your version.
- **Public URL.** If the API gateway sits behind another proxy, set `KF_PUBLIC_URL` on the functions so MCP
  clients see the right OAuth metadata.
- **Time limits.** Workers budget about 110–120 s per invocation and the queue visibility timeouts are 120 s
  (embed) and 400 s (connectors, curator). Keep the edge runtime's wall-clock limit above the budgets.
