# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is 0.x, minor releases may
contain breaking changes.

## [Unreleased]

First public release, planned as **0.1.0**. Highlights:

### Added

- **The knowledge-factory loop on Supabase.** Agents flag missing or wrong knowledge and send traces; a
  queue-driven curator (Edge Function + Supabase Queues + Cron) turns flags, traces and source documents into
  PR-style proposals with citations; people review them, or a per-space policy auto-applies low-risk changes.
- **Knowledge store** in Postgres with three kinds of knowledge (skills, domain, data access), revisions, trust
  tiers, staleness, an audit log, and hybrid search (pgvector + full-text) with gte-small embeddings computed in
  the Edge Runtime (no API key).
- **Access control in the database.** Humans, OAuth-connected MCP clients and headless agents are all Supabase
  Auth users; row level security enforces workspaces, spaces, roles and audience groups. 537 pgTAP tests.
- **Remote MCP server** (`mcp` Edge Function) with OAuth 2.1 through Supabase Auth, and agent API keys
  (`skn_...`) for headless agents.
- **Trace ingest** (JSON and OTLP) and correction mining from agent traces.
- **Source connectors** for Notion, Slack, GitHub, Google Drive, web pages and uploads, with tokens in Vault.
- **Studio** (TanStack Start): review inbox with live updates, knowledge browser and editor, sources, agents,
  activity, health dashboard and settings.
- **CLI** `@supaknowledge/cli` (`supaknowledge`, alias `kf`): login, init, import / export / lint / pull of
  [OKF](docs/okf.md) bundles and [Agent Skills](https://agentskills.io), proposal review, agents, sources,
  members and MCP client config.
- **SDKs**: `@supaknowledge/sdk` (TypeScript, dependency-free), `@supaknowledge/mastra` (tools, instructions and
  trace capture for Mastra agents) and `supaknowledge` for Python.
- **Curator models** through Mastra's model router: your own OpenAI-compatible endpoint, the Vercel AI Gateway
  or OpenRouter, with fallbacks and a fast model for bulk work.
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
  trace recorders back off after failures and respect `maxBuffer`; Python/TypeScript parity fixes (see
  [SDKs](docs/sdk.md)).
- Docs: `supaknowledge-title` is exported for skills whose title differs from their first heading, so titles
  round-trip.

[Unreleased]: https://github.com/alvarofc/supaknowledge/commits/main
