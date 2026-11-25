# Deploy

Supaknowledge is a Supabase project (migrations + Edge Functions) plus Studio, a TanStack Start app. This guide deploys the
project to Supabase's cloud and Studio to Vercel, then covers self-hosted Supabase.

## Deploy with `kf deploy` (recommended)

Create a project in the [Supabase dashboard](https://supabase.com/dashboard) and a personal access token at
[supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens). Then, from a clone of this
repository (after `npm install && npm run build:cli`):

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...
npx kf deploy --project-ref <project-ref> --dry-run       # the plan: commands, secret names, Auth fields
npx kf deploy --project-ref <project-ref> --env-file ./hosted.env --studio-url https://studio.example.com
```

It runs the steps below for you, printing `[n/7]` with ✓, skipped or ✗ for each, and stops at the first failure:

1. **Project**: checks the project and the token through the Management API.
2. **Database**: `supabase db push --remote=<ref> --yes --skip-vault` with the repository's Supabase CLI.
3. **Vault**: reuses `kf_internal_secret` if it exists (generates one otherwise) and sets `project_url`.
4. **Function secrets** through the Management API, never `supabase secrets set` (see the warning in
   [Edge Functions](#3-edge-functions)): `KF_INTERNAL_SECRET` (the Vault value), `KF_PUBLIC_URL` (`--public-url`,
   default `https://<ref>.supabase.co`; a custom value already on the project is kept on re-runs), `KF_CURATOR_TASK_BUDGET_MS` (`--task-budget-ms`, else the project's value,
   else `140000`, safe on the Free plan; use `380000` on paid plans), and the model and connector settings from
   `--env-file` (`KF_LLM_*`, `AI_GATEWAY_API_KEY`, `OPENROUTER_API_KEY`, `GITHUB_TOKEN`, `KF_CONNECTOR*`,
   `KF_EMBEDS_*`, `KF_CURATOR_*`, `CONNECTOR_*`). `KF_INTERNAL_SECRET`, `KF_PUBLIC_URL` and `SUPABASE_*` in that
   file are ignored. Only names are printed. Without `--env-file` the model settings already on the project stay;
   without any `KF_LLM_MODEL` it warns that the curator needs a [model](curator.md#model-configuration).
5. **Edge Functions**: refuses a stale `_shared/core` (`npm run sync:shared`), then runs
   `supabase functions deploy --remote=<ref> --yes` from a temporary copy of `supabase/functions` and
   `supabase/config.jsonc` without `.env` files, `node_modules` or `edge_runtime.secrets`, and prints each
   function's size (warning when the curator nears the 20 MB limit). `--use-api` bundles on Supabase's servers
   instead of Docker.
6. **Auth**: OAuth 2.1 server with dynamic registration and `/oauth/consent`, the Before User Created hook and
   reauthentication for password changes. `--studio-url` (repeatable) sets the Site URL to the first origin and
   adds `<origin>/**` to the redirect URLs, keeping the ones already there. It never turns e-mail confirmations
   off, and warns if they are.
7. **Check**: the MCP metadata names `KF_PUBLIC_URL`, the `embed` function accepts the Vault secret exactly as cron
   sends it, and the OAuth metadata is served (it can take a minute; reported as still propagating).

It ends with the project URL, the MCP URL, the publishable key and the next steps. Re-running it is safe: the
internal secret is reused, the redirect list merged, and settings that already match are left alone.
`--skip-db`, `--skip-functions`, `--skip-auth` and `--skip-check` skip steps; `--access-token-stdin` reads the
token from stdin instead of `SUPABASE_ACCESS_TOKEN`.

What it does **not** do: host Studio ([step 5](#5-studio-on-vercel) stays manual; deploy Studio, then run
`kf deploy --project-ref <ref> --studio-url <studio-url> --skip-db --skip-functions` to point Auth at it), decide
who may sign up, or set up self-hosted Supabase. The sections below are the manual reference for each step.

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

> [!WARNING]
> The Supabase CLI also reads `supabase/.env` when it deploys functions or sets secrets, and uploads the values it
> finds there. If your checkout has a local-development `supabase/.env`, its `KF_INTERNAL_SECRET`,
> `KF_CURATOR_TASK_BUDGET_MS` and model settings can silently replace the ones you meant for the hosted project.
> The cron jobs then fail with `invalid internal secret`. Deploy functions from a checkout (or a copy of
> `supabase/functions` and `supabase/config.jsonc`) without `supabase/.env`, and run `secrets set` with
> `--project-ref <project-ref>` from such a directory (`--workdir` can point at one that holds only
> `supabase/config.jsonc`, since `secrets set` needs no function sources). Then compare
> digests: `npx supabase secrets list` shows the SHA-256 of each value, which must equal
> `printf %s '<value>' | shasum -a 256`.

The curator bundle is the largest function (about 19 MB unminified with Mastra). Supabase's limit is 20 MB per
function, so check the size `functions deploy` prints when you upgrade dependencies.

Optional model secrets: `KF_LLM_FAST_MODEL` (cheaper model for trace mining), `KF_LLM_FALLBACK_MODELS`
(comma-separated, tried in order), `KF_LLM_HEADERS` (JSON object of extra headers for your endpoint), `KF_LLM_API`
(`chat` or `responses`), `OPENROUTER_API_KEY` (for `openrouter/...` ids). Secrets apply to new invocations; no
redeploy needed. The endpoint must be reachable from Supabase's Edge Functions (public, or through your network's
ingress). See [model configuration](curator.md#model-configuration).

`supabase/config.jsonc` sets `verify_jwt = false` for every function, including `maintenance` (the Storage
garbage collector, which accepts nothing but the internal secret): they authenticate callers themselves (agent
keys are not JWTs; cron uses the internal secret). `supabase functions deploy` reads that setting; if you deploy a
single function by name, keep `--no-verify-jwt`. `SUPABASE_URL` and the project keys are provided by the platform.

Optional secrets (all listed in `edge_runtime.secrets` of `supabase/config.jsonc` and in
`supabase/.env.example` for local development; set them with `npx supabase secrets set NAME=value` when hosted):

| Secret | Default | When |
|---|---|---|
| `KF_PUBLIC_URL` | unset | Public origin of the API as MCP clients see it, e.g. `https://<project-ref>.supabase.co` or `https://kb.example.com`. The `mcp` function builds its OAuth metadata and resource URLs from it. Recommended for every deployment, required behind a custom domain or proxy. Without it the function uses `SUPABASE_PUBLIC_URL`, then `SUPABASE_URL` unless that is an internal host (`kong`, `*.internal`…), then validated request headers (those answers are sent `Cache-Control: no-store`) |
| `SUPABASE_PUBLIC_URL` | unset | Fallback for `KF_PUBLIC_URL` (some self-hosted setups already define it) |
| `KF_LLM_ALLOWED_MODELS` | any | Comma-separated model ids (`prefix/*` wildcards) that space admins may choose in curator settings; empty = any. See [model configuration](curator.md#model-configuration) |
| `KF_CURATOR_TASK_BUDGET_MS` | `110000` | Wall-clock budget per curator task (clamped to 30000–380000). Keep it below your plan's Edge Function wall-clock limit: at most `140000` on the Free plan (150 s), up to `380000` on paid plans (400 s). Slow self-hosted models benefit from the higher value |
| `KF_LLM_MAX_TOKENS_PER_RUN` | unset | Operator ceiling on model tokens (input + output) per curator run; a space's `curator.max_tokens_per_run` can go lower, never higher. Unset/`0` = the space setting alone. See [curator settings](curator.md#model-configuration) |
| `KF_CURATOR_RUN_COOLDOWN_S` | `120` | Minimum seconds between two manual runs of one space through `POST /curator/run` (`kf curate`, scripts); earlier requests get HTTP 429 with `Retry-After`. Studio's Run now calls the `request_curator_run` RPC, which only keeps one active run per space |
| `GITHUB_TOKEN` | unset | Default token for GitHub sources without their own (higher rate limit for public repos); only ever sent to `api.github.com`, see [connectors](connectors.md#github-github) |
| `KF_CONNECTOR_MAX_BYTES` | `20971520` (20 MiB) | Largest upstream response body a connector buffers; bigger files are skipped |
| `KF_CONNECTORS_ALLOW_PRIVATE_NETWORK` | `false` | `true` lets connectors reach private, loopback and link-local addresses (the SSRF guard refuses them otherwise). Only for self-hosted setups that sync intranet sites |
| `KF_CONNECTORS_EGRESS_PROXY` | unset | `http://[user:pass@]host:port` of an HTTP proxy every connector request goes through; the proxy must refuse non-public destinations itself (e.g. Smokescreen). Closes the DNS-rebinding gap of the in-function checks, see [connectors](connectors.md#outbound-requests-ssrf-guard) |
| `KF_EMBEDS_PER_REQUEST` | `4` | New chunks the `embed` function embeds per request (gte-small runs on the function's CPU); the `kf-embed` cron sends 4 jobs per request |
| `CONNECTOR_DOC_LIMIT`, `CONNECTOR_TIME_BUDGET_MS` | `200`, `120000` | Connector batch size and time budget per run (keep the budget below your plan's function wall-clock limit); see [connectors](connectors.md#limits-and-tuning). Not in `config.jsonc`: set them with `supabase secrets set` if you need them |

## 4. Auth

In **Authentication → URL Configuration**:

- **Site URL**: your Studio URL, e.g. `https://studio.example.com`. Email links and the OAuth consent redirect use
  it.
- **Redirect URLs**: `https://studio.example.com/**` (and your preview domains if you use them).

In **Authentication → OAuth Server** (needed for MCP clients that sign people in):

- enable the OAuth 2.1 server;
- authorization path: `/oauth/consent` (Studio's consent page);
- enable dynamic client registration, so Claude Code, Cursor and others can register themselves.

In **Authentication → Hooks**, add a **Before User Created** hook of type Postgres pointing at
`private.hook_before_user_created` (URI `pg-functions://postgres/private/hook_before_user_created`; the local stack
configures it in `supabase/config.jsonc`). It refuses public sign-up, OAuth and SSO with the e-mail domain reserved
for agents (`@agents.supaknowledge.internal`) with a clean 403. The database enforces the same rule with a trigger,
so without the hook such sign-ups still fail, just with a generic error.

**From the command line instead of the dashboard.** The Management API sets all of the above in one call,
without `supabase config push` (which would upload the local stack's settings, including email confirmations
off). `uri_allow_list` is one comma-separated string that **replaces** the current list, so include every redirect
URL you still need (preview domains, a local Studio). Create a personal access token at
[supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens), then:

```bash
curl -X PATCH "https://api.supabase.com/v1/projects/<project-ref>/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "site_url": "https://studio.example.com",
    "uri_allow_list": "https://studio.example.com/**",
    "oauth_server_enabled": true,
    "oauth_server_allow_dynamic_registration": true,
    "oauth_server_authorization_path": "/oauth/consent",
    "hook_before_user_created_enabled": true,
    "hook_before_user_created_uri": "pg-functions://postgres/private/hook_before_user_created",
    "security_update_password_require_reauthentication": true,
    "mailer_autoconfirm": false
  }'
```

The OAuth metadata (`/.well-known/oauth-authorization-server/auth/v1`) can take a minute to switch from
`OAuth server is disabled` to the real document.

Decide whether anyone may sign up (**Authentication → Sign In / Providers**). People only see what they are
granted: a new account belongs to no workspace until it accepts an invitation (Studio → Settings → Members, or
`kf members invite`). Supaknowledge sends no invitation e-mail itself; tell people to sign up and accept in Studio.
See [access control](access-control.md#joining-a-workspace-invitations).

> [!IMPORTANT]
> Keep **Confirm email** on (**Authentication → Sign In / Providers → Email**) in every shared or hosted project.
> Invitations are accepted by the account whose **confirmed** e-mail matches. With confirmations off, Auth marks
> every new address as confirmed, so anyone could sign up with an invited colleague's address and take their
> invitation (and its role). `supabase/config.jsonc` turns confirmations off only for the local single-developer
> stack; don't push that setting to a shared project.

## 5. Studio on Vercel

Import the repository in Vercel with **Root Directory** `apps/studio` and the build command `npm run build`. Then
set these variables for Production and Preview. Vite inlines them at build time, so redeploy after changing them:

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | the project's publishable key (`sb_publishable_…`) |
| `SITE_URL` | recommended: your Studio URL, e.g. `https://studio.example.com`. Server-only (read at runtime); sign-in and sign-out redirects always go there. |
| `TRUST_PROXY` | optional: `1` only if a proxy in front of Studio overwrites `X-Forwarded-Host` / `-Proto` (otherwise those headers are ignored) |

Studio never needs a secret key.

**Self-hosting Studio behind a TLS proxy** (nginx, Caddy, a load balancer, Docker behind Traefik): Studio receives
plain `http` from the proxy, so sign-in and sign-out would redirect to `http://…` unless it knows its public origin.
Set `SITE_URL=https://studio.example.com` (simplest), or set `TRUST_PROXY=1` when the proxy overwrites
`X-Forwarded-Proto` / `X-Forwarded-Host` on every request. Vercel and Netlify need neither. See
[Studio → Any Node host or Docker](studio.md#any-node-host-or-docker).

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
`kf_internal_secret` differ (see the `supabase/.env` warning in [Edge Functions](#3-edge-functions)). After you
fix it, embedding and sync jobs retry by themselves once their visibility timeout passes (about two minutes for
embeddings). Curator tasks count every delivery, including rejected ones: if the secret was wrong through three
deliveries, the task fails (its error then blames the time limit) and you start a new run (`kf curate` or Run now
in Studio).

**Studio on your machine against the hosted project** (before you deploy it, or to debug): put
`VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` of the hosted project in `apps/studio/.env.hosted.local`
(ignored by git), add `http://127.0.0.1:3000/**` and `http://localhost:3000/**` to the redirect URLs, and run
`npm run dev -w @supaknowledge/studio -- --mode hosted`. Sign-in works from either address. Email links and the OAuth
consent page (MCP sign-in) follow the project's Site URL, so they reach this local Studio only if the Site URL points
at it. That's fine on a test project; on a production project, keep the Site URL on your deployed Studio.

## Updating

```bash
git pull
npx kf deploy --project-ref <project-ref>          # or by hand:
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
  environment variables of your version. Keep e-mail confirmations on (`GOTRUE_MAILER_AUTOCONFIRM=false`) and
  register the Before User Created hook (`GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED=true`,
  `GOTRUE_HOOK_BEFORE_USER_CREATED_URI=pg-functions://postgres/private/hook_before_user_created`), as in
  [Auth](#4-auth).
- **Public URL.** Set `KF_PUBLIC_URL` (or `SUPABASE_PUBLIC_URL`) on the functions to the URL clients use, so MCP
  clients see the right OAuth metadata; the internal `SUPABASE_URL` (e.g. `http://kong:8000`) is never advertised.
- **Intranet sources.** Connectors refuse private network addresses; set `KF_CONNECTORS_ALLOW_PRIVATE_NETWORK=true`
  only if you need to sync sites on your own network.
- **Time limits.** Workers budget about 110–120 s per invocation and the queue visibility timeouts are 120 s
  (embed) and 400 s (connectors, curator). Keep the edge runtime's wall-clock limit above the budgets.
