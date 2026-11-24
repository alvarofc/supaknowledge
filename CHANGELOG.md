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
  Auth users; row level security enforces workspaces, spaces, roles and audience groups. 329 pgTAP tests.
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

[Unreleased]: https://github.com/alvarofc/supaknowledge/commits/main
