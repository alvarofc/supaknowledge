# `kf`: the Supaknowledge command line

`kf` (package `@supaknowledge/cli`, which installs the same binary as both `supaknowledge` and `kf`) is how people and CI work with a Supaknowledge space from a terminal: sign in, load
knowledge from an OKF bundle or an Agent Skills folder, review what the curator proposes, pull skills to where
coding agents look for them, and connect agents over MCP.

```bash
npm install -g @supaknowledge/cli        # Node 22.12+ (once published)
kf --help
kf <command> --help
```

From a clone of the repository: `npm install && npm run build:cli`, then `npx kf …` (or
`npm install -g ./packages/cli` for a global `kf`).

Every command takes `--json` for machine-readable output (errors become `{"error": ..., "hint": ...}` on
stdout). Progress and warnings go to stderr, so stdout stays clean for pipes.

## Configuration

| Where | What |
|---|---|
| `~/.config/supaknowledge/config.json` | Profiles: project URL, publishable key, and the session (access + refresh token). Written with mode 0600. `kf` refreshes the session when it is about to expire. Override the folder with `SUPAKNOWLEDGE_CONFIG_DIR` (or `XDG_CONFIG_HOME`). |
| `.supaknowledge.json` (written by `kf init`) | The default space for a directory: `{ "space": "acme/finance", "space_id": "...", "url": "..." }`. `kf` looks for it in the current directory and its parents. Safe to commit. |

Precedence: command-line flags, then environment variables, then `.supaknowledge.json` / the profile.

| Variable | Meaning |
|---|---|
| `SUPAKNOWLEDGE_URL` | Supabase project URL, e.g. `https://abc.supabase.co` or `http://127.0.0.1:54321` |
| `SUPAKNOWLEDGE_PUBLISHABLE_KEY` | Project publishable key (`sb_publishable_...`) |
| `SUPAKNOWLEDGE_TOKEN` | Use this access token, or an agent key `skn_...`, instead of the saved session (handy in CI) |
| `SUPAKNOWLEDGE_SPACE` | Default space, `<workspace>/<space>` |
| `SUPAKNOWLEDGE_PROFILE` | Profile name (default: the profile of the last `kf login`) |
| `SUPAKNOWLEDGE_TRANSPORT` | `auto` (default), `mcp` or `rest`: how `search` / `flag` reach the server (see below) |
| `NO_COLOR`, `FORCE_COLOR` | Color control. Colors are also off with `--json`, `--no-color` and when stdout is not a terminal. |

Global options: `--json`, `-s, --space <workspace/space|uuid>`, `-p, --profile <name>`, `--no-color`.

## Getting started

```bash
# 1. sign in (prompts for the password; or --password-stdin)
kf login --url https://abc.supabase.co --publishable-key sb_publishable_... --email you@acme.com

# 2. create (or select) a workspace and space; writes .supaknowledge.json
kf init --workspace acme --space finance --name "Finance agents"

# 3. load existing knowledge: OKF concepts and/or skills/<name>/SKILL.md folders
kf lint ./knowledge
kf import ./knowledge --apply          # --apply needs the reviewer role; otherwise it stays a proposal

# 4. give agents the knowledge
kf pull                                # .claude/skills/<name>/ + .supaknowledge/knowledge/
kf mcp-config --client claude-code     # or connect over MCP
```

## Commands

### Account

| Command | What it does |
|---|---|
| `kf login [--url] [--publishable-key] [--email --password \| --password-stdin] [--token <jwt\|skn_...> \| --token-stdin]` | Signs in and saves the session in the profile. An agent key is exchanged for a refreshable agent session. |
| `kf logout` | Revokes the session (`/auth/v1/logout`) and removes it from the profile. |
| `kf whoami` | User or agent, workspaces with roles, and your role on the current space. |
| `kf init --workspace <slug> --space <slug> [--name] [--workspace-name] [--description] [--visibility workspace\|private] [--dir]` | Creates the workspace (`create_workspace`) and space (`create_space`) when missing, then writes `.supaknowledge.json`. Re-running it only selects. `--space acme/finance` works too. |

### Knowledge in and out

| Command | What it does |
|---|---|
| `kf lint <dir>` | Checks a bundle or skills folder against OKF and Agent Skills rules. Exit 1 on problems. Works offline (local linter) when you are not signed in. |
| `kf import <dir> [--apply] [--title]` | Reads `<dir>` recursively and sends it to `bundle/import`, which creates **one proposal** (the single audited write path). Text files go as UTF-8, binary files as base64. Never uploads dotfiles or dot-directories (`.env`, `.github/`, ...: they are listed as skipped), `.git`, `node_modules`, files over 10 MB, or anything matched by `.gitignore` / `.kfignore` in `<dir>`. The proposal is created with the atomic `create_proposal` RPC: its ops and citations commit together or not at all. With `--apply`, exit 1 if applying failed or conflicted (the proposal stays in the inbox). |
| `kf export <dir> [--public] [--force] [--dry-run]` | Writes the space as an OKF bundle (`index.md`, `log.md`, concepts, `skills/<name>/SKILL.md` + files). `--public` leaves out audience-restricted concepts. |
| `kf pull [--skills-dir .claude/skills] [--bundle-dir .supaknowledge/knowledge] [--no-skills] [--no-bundle] [--force] [--dry-run]` | Writes every skill to `<skills-dir>/<name>/` (where Claude Code and Deep Agents load skills from) and the full OKF bundle to `<bundle-dir>`. Both directories are relative to the project root (the folder with `.supaknowledge.json`, else the current directory), so `kf pull` writes to the same place from any subdirectory; they must be subdirectories of it and must not overlap. |
| `kf search <query...> [-k skill,domain,data_access] [-n 8]` | Hybrid search over the space. |
| `kf read <path> [--body]` | A concept with metadata, links, backlinks and files. `--body` prints only the markdown. |
| `kf flag <missing\|incorrect\|outdated\|conflicting\|unclear> <observation...> [--path <concept>] [--fix <text>] [--query <text>]` | Raises a flag for the curator. |

**Safe writes (`export`, `pull`).** `kf` records every file it writes, with its SHA-256, in a manifest
(`.supaknowledge/manifest.json` for `pull`, `<dir>/.supaknowledge-manifest.json` for `export`). On the next run it:

- overwrites a file only if it wrote it and nobody edited it since;
- leaves files it did not write alone (your own skills in `.claude/skills/` are safe);
- leaves files you edited alone and says so (`--force` overwrites both);
- deletes files it wrote earlier that are no longer exported, unless you edited them.

Paths are resolved against the project root (the folder holding `.supaknowledge.json`). For Deep Agents:
`kf pull --skills-dir .deepagents/skills --no-bundle`.

### Review

| Command | What it does |
|---|---|
| `kf proposals [--status pending\|approved\|applied\|rejected\|conflicted\|superseded\|all] [-n 50]` | Proposals in the space (default: pending). Escalations show as `high!`. |
| `kf proposal <id>` | Title, rationale, citations (and, separately, evidence the curator consulted without citing), reviews, and a colored unified diff of every op against the current concept, rendered as the OKF / SKILL.md file it would export to. For a pending proposal it warns when an op was drafted against an older revision (it will conflict); an applied proposal is diffed against the revision it replaced. |
| `kf approve <id> [--note]` | `apply_proposal`, then syncs skill files into Storage (`bundle/sync-files`). Exit 1 with the conflict list if it conflicted. |
| `kf reject <id> --note <why>` | `reject_proposal`. The note is context for the next curator run. |
| `kf flags [--status open\|in_proposal\|resolved\|dismissed\|all]` | Flags raised by agents and people (default: open). |
| `kf dismiss <flag-id> --reason <why>` | `dismiss_flag`. |

Ids can be shortened to any unique prefix (`kf approve 3f2a91c0`), as shown in the tables.

### Curator and health

| Command | What it does |
|---|---|
| `kf curate [--watch] [--interval 3] [--timeout 900]` | `request_curator_run` (reviewer+; one active run per space). `--watch` polls the run and prints its stats when it finishes; exit 1 if it failed or was cancelled (with `--json`, the run is the only JSON printed). |
| `kf runs [list] [-n 20]` | Recent curator runs. |
| `kf runs cancel <id>` | `cancel_curator_run` (reviewer+): stop a queued or running run, e.g. one that is stuck. The database also fails runs that made no progress for `curator.stuck_after_minutes` (default 30). |
| `kf health [--days 30]` | `knowledge_health`: concepts by kind and trust, stale and never-used counts, open flags, pending and applied proposals, most-flagged concepts, last run. |

### Agents and MCP

| Command | What it does |
|---|---|
| `kf agents create <name> [--description] [--role reader\|editor\|reviewer] [--no-grant] [-w <workspace>]` | Registers a headless agent with access to the current space and prints its API key once. |
| `kf agents rotate <agent>` | New key; the old one stops working within about 15 seconds and the agent's sessions are deleted. |
| `kf agents revoke <agent>` / `kf agents restore <agent>` | Revoke: marks the agent revoked, bans its Auth user and deletes its sessions (key and JWTs refused within about 15 seconds). Restore undoes it. |
| `kf agents delete <agent>` | Deletes the agent (sessions first, then the Auth user). |
| `kf agents list [-w <workspace>]` | Agents with key prefix, status, space roles and last use. `<agent>` is an id or a name. |
| `kf mcp-config [--oauth \| --agent-key [skn_...]] [--client claude-code\|cursor\|claude-desktop\|generic] [--name supaknowledge] [--key-env SUPAKNOWLEDGE_API_KEY]` | Prints the MCP endpoint, a `claude mcp add` command (Claude Code) and the JSON for the client's config file. Without a key value, the config references an environment variable instead of inlining the secret. |

```bash
kf mcp-config
# claude mcp add --transport http supaknowledge 'https://abc.supabase.co/functions/v1/mcp?space=acme/finance'
# then /mcp in Claude Code -> Authenticate (OAuth through Supabase Auth)

kf agents create ci-bot --role reader
kf mcp-config --client cursor --agent-key          # uses ${env:SUPAKNOWLEDGE_API_KEY}
```

### Sources

| Command | What it does |
|---|---|
| `kf sources add <notion\|slack\|github\|gdrive\|web\|upload> --name <name> [--config <json>] [--audience group,...] [--interval "1 hour"]` | Adds a source (space admin). `--audience` restricts who can see its documents. |
| `kf sources secret <source>` | Reads the connector token from piped stdin (or prompts when stdin is a terminal) and stores it in Vault (`set_source_secret`). The token never reaches the API again. |
| `kf sources sync <source>` | Queues a full sync now (`request_source_sync`). |
| `kf sources list` / `kf sources remove <source>` | Sources with status and last sync; delete one. |

```bash
kf sources add github --name handbook --config '{"repo":"acme/handbook","paths":["docs/"]}'
echo "$GITHUB_TOKEN" | kf sources secret handbook
kf sources sync handbook
```

### Members and groups

Membership goes straight through the RLS-protected tables, so the database decides what you may change.
Users are referenced by Auth user id (`me` means you). Nobody can be added to a workspace directly: workspace
admins invite people by e-mail and the invitee accepts (see
[access control](access-control.md#joining-a-workspace-invitations)).

| Command | What it does |
|---|---|
| `kf members [list] [--workspace]` | Direct space members, group grants and the space visibility; or workspace members. |
| `kf members add <user-id> [--role ...]` / `kf members remove <user-id>` | Add a workspace member (or agent) to the current space, or remove them. Space roles: reader, editor, reviewer, admin. Agents can't be space admins. |
| `kf members add <user-id> --workspace --role ...` / `kf members remove <user-id> --workspace` | Change an **existing** workspace member's role (member, admin, owner), or remove them from the workspace. New people are invited instead. Agents can't be workspace admins/owners, and a workspace always keeps at least one owner. |
| `kf members invite <email> [--role member\|admin\|owner]` | Invite someone to the current space's workspace by e-mail (workspace owners and admins; only owners invite owners; 30 per hour; expires after 14 days). No e-mail is sent: tell them to sign in with that address and accept. |
| `kf members invitations [--all]` / `kf members uninvite <invitation-id>` | The workspace's open invitations (`--all`: also accepted, declined and expired), and revoking one. |
| `kf invitations [list]`, `kf invitations accept <id>`, `kf invitations decline <id>` | Invitations addressed to the verified e-mail of your account; accepting joins the workspace (prints its slug). |
| `kf groups [list]`, `kf groups create <slug> [--name] [--description]`, `kf groups delete <slug>` | Access groups (audiences). A group that is still used as an audience can't be deleted. |
| `kf groups members <slug>`, `kf groups add <slug> <user-id>`, `kf groups remove <slug> <user-id>` | Group membership. |
| `kf groups grant <slug> [--role reader]`, `kf groups revoke <slug>` | Give a group a role on the current space. |

## How `kf` talks to Supaknowledge

| Commands | Path |
|---|---|
| `search`, `flag` | The `mcp` Edge Function (semantic + full-text search; usage is logged). If the function is not deployed (404/501), `kf` falls back to the `search_knowledge` / `flag_knowledge` RPCs, which do **full-text search only** because the CLI cannot compute the gte-small query embedding. Force either with `SUPAKNOWLEDGE_TRANSPORT=mcp\|rest`. |
| `import`, `lint`, `export`, `pull`, `approve` (file sync) | The `bundle` Edge Function. When it is not deployed, `kf` runs the same `@supaknowledge/core` import / export / lint code itself over PostgREST: imports still become one proposal (through `create_proposal`), and skill files travel in the ops until the proposal is applied (copying them into Storage needs the function). |
| `agents ...` | The `agents` Edge Function (it needs the Auth admin API). `agents list` falls back to the `agents` table. |
| everything else | PostgREST tables and RPCs with your session, so RLS applies exactly as in Studio. |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | The command failed (permission denied, not found, nothing changed because RLS filtered the row, lint problems, conflicted proposal, failed or cancelled run) |
| 2 | Usage error (unknown command, bad option value, missing argument) |
| 3 | Authentication rejected by an Edge Function (401) |

Set `SUPAKNOWLEDGE_DEBUG=1` to print stack traces.

## Development

```bash
npm run build:cli                   # esbuild -> packages/cli/dist/kf.js (bundles @supaknowledge/core formats + @supaknowledge/sdk), then links `kf`
npm run typecheck -w @supaknowledge/cli
npm test -w @supaknowledge/cli             # node:test, mocked fetch
npm run smoke -w @supaknowledge/cli        # live checks against `supabase start` (creates and deletes throwaway users)
```
