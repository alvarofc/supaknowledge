# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is 0.x, minor releases may
contain breaking changes.

## [Unreleased]

## [0.1.0] - YYYY-MM-DD

First public release. Highlights:

### Added

- **The knowledge-factory loop on Supabase.** Agents flag missing or wrong knowledge and send traces; a
  queue-driven curator (Edge Function + Supabase Queues + Cron) turns flags, traces and source documents into
  PR-style proposals with citations; people review them, or a per-space policy auto-applies low-risk changes.
- **Knowledge store** in Postgres with three kinds of knowledge (skills, domain, data access), revisions, trust
  tiers, staleness, an audit log, and hybrid search (pgvector + full-text) with gte-small embeddings computed in
  the Edge Runtime (no API key).
- **Access control in the database.** Humans, OAuth-connected MCP clients and headless agents are all Supabase
  Auth users; row level security enforces workspaces, spaces, roles and audience groups. 784 pgTAP tests.
- **Remote MCP server** (`mcp` Edge Function) with OAuth 2.1 through Supabase Auth, and agent API keys
  (`skn_...`) for headless agents.
- **Trace ingest** (JSON and OTLP) and correction mining from agent traces.
- **Source connectors** for Notion, Slack, GitHub, Google Drive, web pages and uploads, with tokens in Vault.
- **Studio** (TanStack Start): review inbox with live updates, knowledge browser and editor, sources, agents,
  activity, health dashboard and settings.
- **CLI** `@supaknowledge/cli` (`supaknowledge`, alias `kf`): login, init, import / export / lint / pull of
  [OKF](docs/okf.md) bundles and [Agent Skills](https://agentskills.io), proposal review, agents, sources,
  members and MCP client config.
- **`kf deploy`** deploys a clone of this repository to a hosted Supabase project: migrations, the Vault secrets
  cron needs, function secrets through the Management API (so a local `supabase/.env` can no longer overwrite
  hosted values), Edge Functions from a clean copy, Auth (OAuth 2.1 server, Before User Created hook, and the Site URL and
  redirect URLs when `--studio-url` is given) and a post-deploy check that the functions accept the internal secret cron sends. `--dry-run`
  prints the plan. See [deploy](docs/deploy.md#deploy-with-kf-deploy-recommended).
- **SDKs**: `@supaknowledge/sdk` (TypeScript, dependency-free), `@supaknowledge/mastra` (tools, instructions and
  trace capture for Mastra agents) and `supaknowledge` for Python.
- **Curator models** through Mastra's model router: your own OpenAI-compatible endpoint, the Vercel AI Gateway
  or OpenRouter, with fallbacks and a fast model for bulk work.
- **`kf deploy --login`** signs in with Supabase's OAuth for integrations (authorization code with PKCE, a
  `127.0.0.1` callback) instead of a personal access token, lets you pick an organization and project or create one
  (`--create-project`, `--org`, `--region`), and saves the tokens like other kf credentials (`kf logout --supabase`
  forgets them). The OAuth app's client secret stays in a token broker Edge Function (`oauth-broker`), or in your
  environment with your own OAuth app. `kf deploy` never deploys the broker.
- **Public read-only demo** (`KF_DEMO`): Studio's sign-in page offers **Try the demo**, an anonymous Supabase Auth
  session that joins one demo space as a reader. The database restricts visitors like OAuth clients (no
  administration, review, knowledge writes or traces), rate-limits their flags per visitor and per day, and the cron
  job `kf-demo-reset` clears what they left every night. `kf demo enable|status|reset|disable` manage it; Studio shows
  the demo's MCP command on the inbox. The Edge Functions refuse anonymous sessions unless `KF_DEMO=true`. See
  [deploy](docs/deploy.md#host-a-public-demo).
- **Studio on Cloudflare Workers**: `apps/studio/wrangler.jsonc`, `npm run build:cloudflare` and
  `npm run deploy:cloudflare`.
- **Example**: `examples/revenue-report`, the end-to-end demo story (`npm run demo`, `npm run demo:offline`).

### Security

Fixes from the pre-release security review:

- Proposals are created only through the atomic `create_proposal()` RPC (proposal, ops and citations in one
  transaction); direct inserts are revoked, so a half-written proposal can no longer be seen (or broadcast over
  Realtime) before its access and escalation are computed.
- Citation audiences are always read from the live evidence rows; `url` citations that match a source document
  resolve to that document. Restricted evidence the curator consulted while drafting is recorded
  (`proposal_citations.consulted`) and counts for visibility and escalation.
- OAuth-connected MCP clients are limited to reading, searching, usage logging, flags and traces: they can no
  longer administer workspaces, create, apply or reject proposals, or verify knowledge with the person's role.
- Agents can never hold the space `admin` or workspace `admin`/`owner` role, cannot approve escalations, and their
  approvals and verifications are recorded as `agent:<id>` (`machine_confirmed`, never `human_reviewed`). Agent
  rows are deleted only through the `agents` function, and agent Auth emails cannot be registered by sign-up.
- Bundle import is fail-closed: a concept whose audience names a group that does not exist is skipped instead of
  being imported unrestricted.
- Groups cannot be deleted while an audience references them, and the last owner of a workspace cannot leave or
  be demoted. Membership keys are immutable, groups only count inside their own workspace, and access requires
  current workspace membership (removing someone also removes their space and group memberships).
- Nobody can be added to a workspace without consent: admins invite by e-mail (`invite_to_workspace()`, rate
  limited, 14-day expiry) and only the invitee, matched on the verified e-mail of their account, can accept or
  decline (Studio banner, `kf invitations`). Direct inserts into `workspace_members` are revoked and
  `find_user_by_email()` is gone.
- Revoking an agent sets `agents.revoked_at`, bans its Auth user and deletes all its sessions and refresh tokens
  (`kf_revoke_user_sessions()`, service role only); rotating or deleting it also deletes its sessions. Functions
  refuse a revoked or rotated key and the agent's JWTs within about 15 seconds. `revoked_at` and `key_prefix` are
  no longer writable by users.
- Connectors: an SSRF guard limits every outbound request to public addresses (redirects re-checked, credentials
  dropped across origins; `KF_CONNECTORS_ALLOW_PRIVATE_NETWORK=true` for intranet setups), response bodies are
  capped (`KF_CONNECTOR_MAX_BYTES`, default 20 MiB), the deployment's `GITHUB_TOKEN` is only sent to
  `api.github.com`, and Google credentials are only ever exchanged at Google's token endpoint (`token_uri` locked).
- The MCP server advertises only a configured public URL (`KF_PUBLIC_URL` / `SUPABASE_PUBLIC_URL`) or a validated
  request host (then `Cache-Control: no-store`), never an internal Docker host.
- `spaces.settings` is validated on write for every key of the settings schema, and operators can restrict the
  models space admins may pick (`KF_LLM_ALLOWED_MODELS`). The curator's research is limited to material readable
  by the target audience by default (`curator.research_scope`), and runs have a token budget
  (`curator.max_tokens_per_run`).
- Supabase's default grants no longer expose new tables or functions to `anon`; Storage objects of deleted spaces,
  sources, concepts and documents are removed (the new `maintenance` function, cron `kf-storage-gc`).
- Studio: stricter redirect (`next`) validation (control characters, backslashes, anything resolving to another
  origin) and request-origin handling (`SITE_URL`; `X-Forwarded-*` only with `TRUST_PROXY=1`), untrusted links
  (sources, citations, OAuth client sites, frontmatter) rendered as links only when http(s), and a same-origin
  check on sign-out. `kf import` never uploads dotfiles such as `.env` (they are listed as skipped).

Fixes from the second (verification) review round:

- **Curator taint.** A draft carries the audiences of every triage pass that shaped it, and the review notes of
  earlier rejections on the same paths (`kf_rejected_proposals()`, service role) are shown to the model only within
  its research scope and taint the new proposal with the audiences of what those rejections touched. Material
  without a row still escalates (one rowless consulted citation per audience). Searches filter by audience and
  similarity in SQL before the limit (`p_visible_to`, `p_min_similarity`), so restricted results cannot starve or
  leak into a wider draft. Topics written by the model from untrusted signals are treated as data, and untrusted
  sources are never pre-fetched.
- **Citation audiences never relax.** Client-supplied citation audiences are ignored for people, every audience
  group must belong to the space's workspace (also for traces and sources), snapshots of open proposals follow the
  evidence when it changes audience (a cited row deleted later keeps its last, not a stale wider, audience), URL
  citations resolve only to visible, live documents, and `apply_proposal` no longer clears the escalation of the
  proposal it applies.
- **Revoked agents lose database access immediately**: they hold no role, space, workspace or group, so an access
  token minted before the revoke reads nothing. Agent passwords (their keys) change only through key rotation (a
  trigger refuses any other password change), `agents.last_seen_at` is not client-writable, and an agent's
  workspace membership cannot be deleted on its own. Repeated failed agent-key sign-ins get HTTP 429 with
  `Retry-After`.
- People removed from a space or workspace no longer read their old restricted traces, flags or usage, nor append
  trace events.
- **SSRF hardening.** Connector hostnames are resolved and refused when any address is non-public (fail closed,
  IPv4-mapped / NAT64 / 6to4 / Teredo ranges included), re-checked after the response arrives against DNS
  rebinding, and `KF_CONNECTORS_EGRESS_PROXY` routes every connector request through an egress proxy that
  enforces the policy on the address it connects to.
- **Invitation owner protection**: only owners refresh or revoke owner invitations, the hourly invitation limit
  survives the workspace, and removing or demoting an owner locks the workspace row (two owners cannot leave at
  once).
- **Storage GC safety**: the GC never removes live objects (revived or re-uploaded documents, existing concept
  files). Groups still referenced by revisions or open proposal citations cannot be deleted; `retire_group()`
  (Studio: Settings → Groups → Retire group…) replaces a group by another group of the same workspace everywhere,
  then deletes it.
- `bundle/sync-files` requires a space reviewer or admin and refuses OAuth-client tokens. Manual curator runs
  through `POST /curator/run` have a per-space cooldown (`KF_CURATOR_RUN_COOLDOWN_S`, default 120 s) and a
  per-caller limit (429 with `Retry-After`); operators can cap tokens per run (`KF_LLM_MAX_TOKENS_PER_RUN`).
- Settings have length limits (model ids 200 characters, at most 5 fallback models, house rules 8000 characters;
  `curator.stuck_after_minutes` at least 10), enforced by the database, the core schema and the Studio form.
- Apply / reject / revert authorise before taking locks and answer one uniform 42501 for "not found" and "not
  allowed"; service-only RPCs check the service role themselves; `usage_counts()` only counts visible concepts;
  `flag_knowledge()` normalizes concept paths so a flag through REST attaches to (and takes the audience of) its
  concept. The `embed` worker writes chunks compare-and-swap, so an older embedding cannot overwrite a newer
  version, and duplicate re-queues collapse.

### Changed

- Curator runs fail when any of their tasks failed (instead of succeeding and skipping that evidence), at most
  one run per space can be active, stuck runs are failed by a reaper after `curator.stuck_after_minutes`
  (default 30), and reviewers can cancel a run (Studio Activity, `kf runs cancel`, `cancel_curator_run()`).
  Staleness runs no longer move the documents watermark, and traces are curated again after new events.
- The Python SDK accepts `httpx>=0.27,<1`, and `@supaknowledge/mastra` takes `@supaknowledge/sdk` as a peer
  dependency (`^0.1.0`) instead of pinning an exact version.
- Published npm packages no longer ship sourcemaps; every package (npm and PyPI) includes `NOTICE`. The release
  workflow runs the Python tests and checks that all package versions match the tag.
- Studio: approving a proposal with skill files syncs them into Storage (like `kf approve`); connector forms write
  the keys the connectors read (GitHub `ref`, Web `follow_links` / `sitemap` / `max_pages` / `same_origin_only`;
  older `branch` / `crawl_depth` configs are read and migrated on save); dates no longer cause hydration
  mismatches and show in the viewer's locale and time zone; consulted evidence is listed on the review page;
  revoked agents are marked and can be restored; RLS-filtered changes (0 rows) are reported as errors; "Switch
  account" on the OAuth consent page returns to the same request.
- Applied proposals no longer keep skill files inline: once `bundle/sync-files` has copied them into Storage, only
  their paths, size and sha256 stay in the proposal.
- Studio settings expose every space setting (research scope, token budget, flag cooldown, stuck-run timeout,
  auto-dismissing flags, untrusted source kinds, trace and usage retention).
- `kf-embed` sends 4 jobs per request (matching `KF_EMBEDS_PER_REQUEST`); daily `kf-cleanup` prunes job history,
  queue archives, old task payloads and, when configured, traces and usage; `kf-invitations-cleanup` removes old
  invitations.
- `npm run test:deno` runs every Edge Function Deno suite (connectors, agents, bundle, maintenance, mcp, traces,
  `_shared`), and `npm run test:all` also runs the Studio tests and lint.
- CLI: `kf members invite`, `kf members invitations`, `kf members uninvite`, `kf invitations [accept|decline]`;
  `kf members add --workspace` only changes an existing member's role; `kf runs cancel <id>`; `kf curate --watch --json` prints a single JSON document; `kf pull` directories are
  relative to the project root; `kf proposal` diffs applied proposals against the revision they replaced;
  `kf import --apply` exits 1 when the proposal conflicts on the PostgREST fallback; membership and group commands
  fail when RLS changed nothing; `kf sources secret` prompts only when stdin is a terminal.
- SDKs: the first knowledge call of a tool loop is linked to its trace, and `read` / `loadSkill` accept a trace id;
  trace recorders back off after failures (at least the server's `Retry-After`) and respect `maxBuffer`;
  Python/TypeScript parity fixes (see [SDKs](docs/sdk.md)). Both SDKs retry idempotent requests (reads, read-only
  MCP tools) on HTTP 429, honouring `Retry-After`, at most twice and never waiting more than 30 s; writes (flags,
  traces) are never retried automatically (`retry` / `max_retries` options).
- CLI: `kf curate` goes through `POST /curator/run` (RPC fallback when the function is not deployed) and on a 429
  prints `curator was run recently; try again in N s` (exit 1; one JSON document with `--json`).
- Studio: the curator settings form checks the settings limits before saving and shows the server's field errors;
  a 403 from skill-file sync explains that a space reviewer or admin has to sync them; Settings → Groups can retire
  a group.
- Docs: `supaknowledge-title` is exported for skills whose title differs from their first heading, so titles
  round-trip.

[Unreleased]: https://github.com/alvarofc/supaknowledge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/alvarofc/supaknowledge/releases/tag/v0.1.0
