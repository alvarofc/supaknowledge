# Access control

Supaknowledge has one enforcement point: **Postgres row level security**. Every principal (a person in Studio, an MCP
client acting for a person, a headless agent) is a Supabase Auth user, and everything they do runs with their own
JWT. Edge Functions do not re-implement permissions; they call the database as the caller. UI checks in Studio
and the CLI only hide buttons.

The model was designed in [DESIGN.md §5a](DESIGN.md#5a-access-control-supabase-auth--rls) and is pinned down by
879 pgTAP tests ([below](#tests)).

## Principals

| Principal | How it authenticates | What it can see |
|---|---|---|
| **Person** | Supabase Auth (password or email link) in Studio; `kf login` | Their memberships, roles and groups |
| **MCP client acting for a person** (Claude Code, Cursor, Claude Desktop…) | OAuth 2.1 through Supabase Auth's authorization server; consent in Studio | Exactly what that person can see, but it can only read, search, log usage, flag and send traces ([below](#what-oauth-clients-can-do)). The token carries the OAuth `client_id`, which the `mcp` function records on flags |
| **Headless agent** (CI job, service, bot) | API key `skn_<agent-id>_<secret>` | Only the spaces it was granted (usually as `reader`), filtered by the groups it belongs to |
| **Demo visitor** (public demo only) | Anonymous Supabase Auth session from Studio's **Try the demo**, joined to the demo space by `join_demo()` | Knowledge without an audience in the demo space; read, search and rate-limited flags only ([below](#demo-visitors)) |
| **Internal workers** (cron → embed, connectors, curator) | Shared secret `x-kf-internal`, then the service role | Everything; see [service role](#service-role-and-internal-calls) |

Agents are Auth users with `app_metadata.kind = 'agent'` (mirrored into `profiles.kind`, which users cannot edit).
Agents cannot create workspaces and cannot manage agents. The database refuses to give an agent the space `admin`
role or the workspace `admin` / `owner` role, by any route (direct grant, group grant, workspace membership).
An agent with the reviewer role can approve ordinary proposals and verify concepts, but never an escalation, and
what it does is recorded as `agent:<id>`: the concept's trust tier becomes `machine_confirmed`, never
`human_reviewed`. Agent Auth emails (`agent-<uuid>@agents.supaknowledge.internal`) cannot be registered through
sign-up.

## Roles

**Workspace** roles: `owner`, `admin`, `member`. Owners and admins administer every space of the workspace, its
groups, members and agents. Only owners can create or demote owners, and delete the workspace. A workspace always
keeps at least one owner: the last owner cannot leave or be demoted (promote someone else first).

### Joining a workspace: invitations

Nobody is added to a workspace without consent. API roles cannot insert into `workspace_members` at all; people
join only by accepting an invitation (and the creator becomes owner through `create_workspace()`; agents are
added by the `agents` function). Owners and admins can still change members' roles and remove them, except
headless agents: an agent's workspace membership is refused for direct deletion (it would leave the agent active
but unable to rejoin), so revoke or delete the agent instead (Studio → Agents, `kf agents revoke|delete`).

- **Invite:** `invite_to_workspace(workspace, email, role)` (Studio → Settings → Members → *Invite by e-mail*, or
  `kf members invite <email> --role member|admin|owner`). Workspace owners and admins only, from a Studio / CLI
  session (agents and OAuth client tokens are refused); only owners can invite owners. Limits: 30 invitations
  per admin per hour (SQLSTATE `PT429`); an invitation expires after 14 days; inviting the same e-mail again
  refreshes the open invitation; the agent e-mail domain and existing members are refused. Every invitation is
  written to the audit log.
- **Accept / decline:** `list_my_invitations()`, `accept_invitation(id)`, `decline_invitation(id)` (Studio shows a
  *You've been invited* banner on Home and in onboarding; CLI: `kf invitations`, `kf invitations accept <id>`,
  `kf invitations decline <id>`). An invitation is matched to the **verified e-mail of the signed-in Auth
  account** (`auth.users.email_confirmed_at` must be set); anyone else gets "invitation not found", and there is no
  shareable token. Expired or already answered invitations are refused. Agents and OAuth client tokens cannot
  answer invitations.
- **No e-mail is sent.** Acceptance is in-app: tell the person to sign up / sign in with that address, then
  accept in Studio or with `kf`.
- **Revoke:** admins delete a pending invitation (Studio → Members → *Revoke*, `kf members uninvite <id>`).
  Owner invitations can only be changed (re-invited with another role) or revoked by owners.
  Admins see their workspace's invitations; invitees see their own. Answered and expired invitations are deleted
  30 days later (cron `kf-invitations-cleanup`).

There is no lookup of accounts by e-mail (`find_user_by_email()` was removed): inviting never reveals whether
an address has an account.

**Space** roles form a ladder: `reader` < `editor` < `reviewer` < `admin`. A person gets the highest of:

- a direct grant (`space_members`);
- a grant to a group they belong to (`space_group_grants`);
- `reader`, when the space has `visibility = 'workspace'` and they are a workspace member;
- `admin`, when they are a workspace owner or admin.

`my_space_role(space)` returns the effective role.

| Role | Adds |
|---|---|
| reader | Search and read knowledge (concepts, revisions, links, skill files); raise flags; send traces and log usage; see their own flags and traces |
| editor | Read flags, raw sources and documents, curator runs and proposals (see [proposal visibility](#proposal-visibility)); write human proposals (`create_proposal()`) and reverts; upload documents |
| reviewer | Approve and reject proposals, triage and dismiss flags, verify concepts, read everyone's traces and concept usage, start and cancel curator runs |
| admin | Approve escalations (people only); manage sources and their Vault secrets, members, group grants and space settings (curator and auto-apply policy); see curator task status and the audit log |

Agents are usually readers: they read knowledge and report problems, but never see raw source documents or other
principals' traces.

## Audiences

An **audience** is a list of group ids (`uuid[]`) on a row. Empty means everyone who can read the space; otherwise
only members of **any** listed group. Audiences are on concepts and their revisions, sources and source documents,
traces, flags, proposal ops (target audience) and proposal citations.

**No role bypasses an audience.** A space admin, a workspace owner or the agent that raised a flag outside
`finance` cannot read finance-only knowledge, search hits for it, its links, files, chunks or revisions.

Where audiences come from:

- **Bundles.** `x-supaknowledge-audience: [finance]` in an OKF concept, or `metadata.supaknowledge-audience` in a SKILL.md,
  names group slugs; `kf export` writes them back. On import you cannot write into an audience you are not part
  of (those concepts are skipped with a warning), and an update without an audience keeps the concept's current
  restriction. **Create the groups before importing:** a concept that names a group slug that does not exist in
  the workspace is skipped with a warning (fail-closed), never imported without its restriction.
- **Connectors** map upstream ACLs (private Slack channels, private repos, Drive sharing) to groups through
  `groups.external_ref`, and never make a document wider than its source. See
  [connectors](connectors.md#access-control-audiences).
- **Traces** take `audience: ["<group-slug>"]` in the `traces` function.
- **Flags** inherit the audience of the concept they are about, so a flag never shows restricted content to a
  reviewer who cannot read the concept. A flag on a concept the caller cannot see is stored as if the concept did
  not exist, without confirming that it does. `flag_knowledge()` normalizes the concept path first
  (`/finance/board-pack.md`, `./skills/x/SKILL.md` → `finance/board-pack`, `skills/x`), so a flag raised with a
  file-style path still attaches to the concept and takes its audience.

A group cannot be deleted while any audience (on knowledge, revisions, sources, documents, traces, flags or
proposals) still names it: deleting it would lock that material away from everyone, owners included. Remove the
group from those audiences first; Studio and `kf groups delete` show the database's error.

Removing someone from a workspace also removes their space memberships and group memberships in that workspace
(a database trigger), so a former member keeps no access through a leftover grant. Space members and group members
must be members of the workspace in the first place. Membership changes are written to the audit log.

## Proposal visibility

A proposal is visible to editors and up only if they can see **every** piece of evidence it cites, every audience
it writes to, and every concept it changes. Reviewing something you cannot fully see is not a review, so
`apply_proposal()` and `reject_proposal()` check the same rule.

Proposals are created only by `create_proposal()`, which writes the proposal, its ops and its citations in one
transaction and computes access and escalation before anything is committed; direct inserts into `proposals`,
`proposal_ops` and `proposal_citations` are not allowed. Nobody (and no Realtime subscriber) ever sees a proposal
half-written.

Evidence is more than what a proposal cites. While drafting, the curator records every restricted item it
**consulted** (read through its research tools or was shown) as a citation with `consulted = true`. Consulted
evidence counts for visibility and escalation exactly like a cited one; Studio lists it separately on the
proposal page. Material that is not a row, such as the restricted signals the triage step saw while writing a
cluster's topic or the review note of a rejected restricted proposal, is recorded as a consulted citation without
a `ref_id` that carries its audience (only the service role may state such an audience, and its groups must belong
to the workspace). The curator's triage clusters signals one audience at a time, and flag dismissal reasons are
replaced by a fixed code when the model's context held material the flag's readers cannot see; see
[the curator](curator.md#the-invariant-everything-a-model-saw-is-evidence).

## The escalation guard

Publishing material from a restricted audience into a wider one is an **escalation**:

```
is_escalation(source, target) = source is restricted and not (target is restricted and target ⊆ source)
```

The database computes it for every proposal from audiences it reads itself: a citation's audience always comes
from the live cited row, never from the client or a stored snapshot, so reclassifying evidence after a proposal
was drafted is taken into account. A `url` citation whose URL matches a source document of the space is resolved
to that document (and its audience). `apply_proposal()` computes it again at apply time. Two cases count: cited evidence would reach a wider audience than it has, or an
existing concept would be widened. An escalated proposal:

- gets `escalation = true` and `risk = 'high'`;
- can only be applied by a **space admin** (a person, never an agent) who can see all of its evidence;
- is **never** auto-applied: the service role is refused even if a space policy would allow it.

The curator works with this: when it creates a concept, it gives it the narrowest audience that does not leak any
cited material (the intersection of the restricted citation audiences); when the citations do not overlap, it says
so in the proposal and leaves the decision to an admin. `propose_revert()` cites the old revision's audience, so
restoring restricted content into a wider concept is an escalation too.

## OAuth 2.1 for MCP clients

Supabase Auth runs the authorization server; Studio hosts the consent page.

```jsonc
// supabase/config.jsonc
"auth": {
  "site_url": "http://127.0.0.1:3000",
  "oauth_server": { "enabled": true, "authorization_url_path": "/oauth/consent", "allow_dynamic_registration": true }
}
```

1. The client calls `…/functions/v1/mcp?space=<ws>/<space>` without a token and gets `401` with
   `WWW-Authenticate: Bearer resource_metadata="…/functions/v1/mcp/.well-known/oauth-protected-resource"`.
2. That metadata names `<project>/auth/v1` as the authorization server. The client registers itself (dynamic client
   registration) and opens the authorization URL with PKCE.
3. Supabase Auth sends the person to Studio's `/oauth/consent`, which requires sign-in and shows the client, the
   account, the scopes and the redirect URI. Allow or deny.
4. The client exchanges the code for tokens. The `mcp` function verifies them like any session (`getClaims`) and
   queries as that person.

People see and revoke the applications they approved in Studio under **Agents → Connected applications**. Behind a
proxy, set the `KF_PUBLIC_URL` secret on the functions so the metadata advertises the public URL.

### What OAuth clients can do

An OAuth access token is a normal `authenticated` JWT for the person, plus the OAuth `client_id` claim. The
database (`private.is_oauth_client()`) and the Edge Functions give such tokens a narrower reach than the person
signed in to Studio or the CLI:

| Allowed (as the person, under RLS) | Refused |
|---|---|
| Read and search knowledge (`search_knowledge`, `read_concept`, `load_skill`), log concept usage, flag knowledge, send and append to their own traces | Creating or changing workspaces, members, groups, grants, spaces, sources, secrets and agents; creating, applying or rejecting proposals (including bundle import); verifying or reverting concepts |

So connecting Claude Code with OAuth lets it use and improve knowledge through flags, but never review or
administer on your behalf. Use Studio or `kf` (signed in as yourself) for that.

## Demo visitors

A [public demo](deploy.md#host-a-public-demo) lets people try one space without an account. A workspace owner lists
the space with `kf_demo_enable()` (`kf demo enable`); Studio's **Try the demo** signs the visitor in anonymously
(Supabase Auth, JWT claim `is_anonymous`) and calls `join_demo()`, which makes them a workspace `member` and a space
`reader` and records them in `private.demo_visitors`.

- `private.is_oauth_client()` is also true for demo visitors (an anonymous session, or a user who joined through
  `join_demo()` and later converted the account), so every rule above for OAuth clients applies to them. On top of
  that they cannot send traces.
- Flags from visitors are limited per visitor per hour and per demo space per day (`PT429` beyond that), and their
  text is length-limited.
- `kf_demo_enable()` refuses a workspace that has another space every member can read (visitors are workspace
  members), and turns auto-apply off in the space.
- `kf_demo_reset()` (`kf demo reset`, and the nightly cron `kf-demo-reset`) deletes visitor flags, traces and usage,
  unapplied proposals created since the demo was enabled, visitor memberships and the anonymous users.
- The Edge Functions refuse anonymous sessions with HTTP 403 unless `KF_DEMO=true` is set on them.

## Agent keys

- **Format:** `skn_<agent-id>_<secret>`: the agent id is a lowercase UUID, the secret 32 random bytes base64url. The
  secret is the agent's Auth password, so Supaknowledge stores no key material of its own; `agents.key_prefix` keeps
  the first characters for display. The key is shown once, at creation or rotation. Anything else that starts with
  `skn_` is refused with 401 before any lookup.
- **Use:** send it as `Authorization: Bearer skn_...` to the Edge Functions (`mcp`, `traces`, `bundle` export, lint
  and `sync-files` when the agent is a space reviewer, `connectors/upload`). Agents cannot create proposals, so
  they cannot import bundles. The function signs in as the agent's Auth user and uses that session, so RLS
  applies. Every request re-checks the `agents` row (`key_prefix`, `revoked_at`; cached for 5 seconds per worker)
  and the session is refreshed with GoTrue every 2 minutes. `kf login --token skn_...` exchanges a key for a
  refreshable agent session.
- **Failed sign-ins:** the key prefix is visible to workspace members, so a guessed secret with a valid prefix
  reaches GoTrue. Each function worker allows 10 failed sign-ins per agent per minute and then answers 429 (with
  `Retry-After`) for keys that have not signed in on that worker; a key with a working session is not affected.
  The limit is per worker (isolate), so several warm workers allow proportionally more; GoTrue's own per-IP
  sign-in rate limit and bcrypt cost back it up.
- **Create:** `kf agents create <name> --role reader` or Studio → Agents (workspace owners and admins; the
  `agents` function checks this through the caller's RLS client before it touches the Auth admin API).
- **Rotate:** `kf agents rotate <agent>` sets a new password, updates `agents.key_prefix` and deletes every Auth
  session and refresh token of the agent (`kf_revoke_user_sessions()`, service role only). The old key is refused
  by every function worker within about 5 seconds. An agent's password is its key, so the database refuses any
  other password change of an agent user (for example `PUT /auth/v1/user` with the agent's own session): the
  `agents` function authorises exactly one change with `kf_allow_agent_password_change()` (service role only)
  right before it calls the Auth admin API.
- **Revoke:** `kf agents revoke <agent>` sets `agents.revoked_at`, bans the Auth user and deletes all its sessions
  and refresh tokens; `kf agents restore` clears `revoked_at` and lifts the ban. From the moment `revoked_at` is set
  a revoked agent holds no role, space, workspace or group in the database, so even an access token issued before
  the revoke (valid as a JWT until it expires, one hour by default) reads and writes nothing through PostgREST or
  RLS. Within about 5 seconds every Supaknowledge function also refuses the key and any agent JWT outright, and no
  session can be refreshed.
- **Delete:** `kf agents delete <agent>` (or Studio → Agents) calls the `agents` function, which marks the agent
  revoked, deletes its sessions and then deletes the Auth user (cascading to its memberships). Deleting the
  `agents` row directly is not allowed, so an agent can never disappear from the list while its key keeps working.
- **List:** the `agents` function lists agents with their `revoked` state (from `agents.revoked_at`); Studio and
  `kf agents` show revoked agents, Studio with a Restore action. `revoked_at` and `key_prefix` are not writable by
  users; only the `agents` function (service role, after checking that the caller administers the workspace)
  changes them.

## Service role and internal calls

pg_cron calls the `embed`, `connectors`, `curator` and `maintenance` functions with the `x-kf-internal` secret (Vault
`kf_internal_secret` on the database side, the `KF_INTERNAL_SECRET` function secret on the other; compared in
constant time). Those workers use the service role, because the curator has to read evidence from every audience.
It keeps access intact by carrying each piece of evidence's audience into its proposals, and the database refuses
to let a proposal widen access without a space admin.

Other hardening worth knowing:

- RLS decides which rows; column grants decide which columns. Reviewers can triage a flag but not rewrite who
  raised it or its audience; proposal status, escalation and review fields are written only by the RPCs; senders
  can close their traces but not move them to another space.
- `sources.secret_id` is not selectable; connector tokens go into Vault through `set_source_secret()` and are
  read only by the service role.
- `anon` has no table privileges, nobody but the owner can `TRUNCATE`, and the `private` and `util` schemas are
  not exposed through the Data API.
- Storage reads follow the rows the files belong to; there are no direct writes. Objects of deleted spaces,
  sources, concepts and documents are queued in `kf_storage_gc` (not readable by API roles) and removed by the
  `maintenance` function.

## Realtime channels

Studio's Presence and Broadcast channels are private: Realtime authorizes each join with the user's JWT against RLS
policies on `realtime.messages` (migration `20261127000300_realtime_review`). Clients can only use these topics:

| Topic | Joined by | Sent by |
|---|---|---|
| `proposal:<proposal id>` (Presence: who is viewing or reviewing) | People who can see the proposal (the `proposals` SELECT policy decides, so every cited and consulted audience applies). Never agents (`app_metadata.kind = 'agent'`) or OAuth client tokens | The same people, presence only; nobody can broadcast |
| `curator:<space id>` (Broadcast: curator progress) | Whoever may read the space's curator runs: editors and up | Only the curator, through `kf_curator_progress()` (service role); there is no INSERT policy |

Presence payloads are written by clients, so a member who can join a proposal's channel could claim to be another
member. Studio uses presence only to help people coordinate, and resolves names from `profiles` through RLS.
Curator progress events carry ids and counts, never evidence (see [the curator](curator.md#live-progress)).

## Tests

`supabase/tests/database` holds the pgTAP suite. `_fixture.psql` builds two workspaces with people at every role,
an agent, finance and other groups, restricted and public knowledge, evidence and a proposal citing finance-only
material; every test file runs inside a transaction that is rolled back.

| File | Tests | Covers |
|---|---|---|
| `01_tenancy.test.sql` | 62 | Workspace isolation, the space role ladder, visibility, group grants, owners, agents |
| `02_audience.test.sql` | 112 | Restricted knowledge is invisible outside its groups for every role, across concepts, revisions, chunks, links, files, search, flags and health |
| `03_evidence.test.sql` | 45 | Sources and documents (editors+), traces (own or reviewers+), connector secrets, service-only queue RPCs |
| `04_proposals.test.sql` | 124 | Authoring rules (`create_proposal()`), proposal visibility, the escalation guard, consulted evidence, apply / reject / verify / revert, conflicts, trust tiers, agents |
| `05_storage.test.sql` | 18 | `concept-files` follows concept visibility, `sources` follows document visibility, no direct writes |
| `06_hardening.test.sql` | 20 | Grants, `search_path` on functions, RLS enabled on every table, service-role detection, privileges of future objects, private bookkeeping tables closed to API roles |
| `07_review_fixes.test.sql` | 93 | Tenancy invariants, OAuth client tokens, agents, data lifecycle, traces/flags column rules, settings safety, the curator run lifecycle, search, maintenance |
| `08_followups.test.sql` | 64 | `agents.revoked_at` / `key_prefix` not user-writable, session revocation (service role only), validation of every settings key, Storage GC listing, stripping synced skill files, workspace invitations (no consent bypass, invitee-only acceptance, expiry, rate limit) |
| `09_round2.test.sql` | 106 | Current reader access for own-row branches, revoked agents losing every role at once, locked agent passwords, `last_seen_at`, citation audiences that never relax (client audiences ignored, snapshots follow the evidence), URL citations, group deletion guard and `retire_group()`, Storage GC liveness, agent memberships, invitation owner protection, uniform 42501s |
| `10_round2_functions.test.sql` | 30 | `flag_knowledge()` path normalization, audience-scoped search (`p_visible_to`) and the similarity floor, `kf_rejected_proposals()` (service role, audiences of what a rejection touched), rowless consulted evidence escalating, settings length limits |
| `11_round2_embed.test.sql` | 28 | The `embed` worker's compare-and-swap chunk writes (`kf_embed_write_concept()` / `kf_embed_write_document()`, service role only) and once-per-entity re-queueing (`kf_embed_requeue()`) |
| `12_pr1_followups.test.sql` | 11 | `traces.on_behalf_of` updates (workspace members only, sender only, needs current space access), soft-deleted restricted documents hidden with their chunks and files, agents never recorded as human reviewers |
| `13_pr1_db_followups.test.sql` | 8 | `search_sources(p_source)` filtering before the limit without widening visibility, concept paths without empty or `.` segments |
| `14_pr5_followups.test.sql` | 12 | `p_source` finding a source's documents outside the space-wide candidate sets (text, vector, hybrid), proposal path validation |
| `15_settings_cas.test.sql` | 6 | `update_space_settings()` compare-and-swap: saved, conflict, forbidden for non-admins, not found |
| `16_schema_drift.test.sql` | 18 | Schema drift: `kf_record_schema_drift()` is service-role only, keeps one live drift flag per concept and identifier, gives the flag the narrower of the concept and source audiences and opens none when they don't overlap |
| `17_realtime.test.sql` | 39 | Realtime Authorization: presence on `proposal:<id>` follows proposal visibility (audiences, roles, workspaces), never agents or OAuth client tokens, no broadcast; curator progress on `curator:<space>` for editors and up, sent only through `kf_curator_progress()` (service role, validated events) |
| `18_graph_recap.test.sql` | 38 | `knowledge_graph()` and `knowledge_recap()` run as the caller: restricted concepts, flags, proposals and evidence are neither drawn nor counted for people outside their audience or role |
| `19_demo_mode.test.sql` | 45 | Public demo: only workspace owners enable it, anonymous visitors join as readers, read unrestricted knowledge, flag within the limits, and cannot create workspaces, send traces, add sources, run the curator, verify, invite, change settings or reset; converted visitors stay restricted; the reset clears visitor data |

Run them against a running local stack:

```bash
npx supabase start
npx supabase test db          # or: npm run test:db
```

CI runs the same suite on every push (`.github/workflows/ci.yml`).
