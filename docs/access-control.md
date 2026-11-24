# Access control

Supaknowledge has one enforcement point: **Postgres row level security**. Every principal (a person in Studio, an MCP
client acting for a person, a headless agent) is a Supabase Auth user, and everything they do runs with their own
JWT. Edge Functions do not re-implement permissions; they call the database as the caller. UI checks in Studio
and the CLI only hide buttons.

The model was designed in [DESIGN.md §5a](DESIGN.md#5a-access-control-supabase-auth--rls) and is pinned down by
537 pgTAP tests ([below](#tests)).

## Principals

| Principal | How it authenticates | What it can see |
|---|---|---|
| **Person** | Supabase Auth (password or email link) in Studio; `kf login` | Their memberships, roles and groups |
| **MCP client acting for a person** (Claude Code, Cursor, Claude Desktop…) | OAuth 2.1 through Supabase Auth's authorization server; consent in Studio | Exactly what that person can see, but it can only read, search, log usage, flag and send traces ([below](#what-oauth-clients-can-do)). The token carries the OAuth `client_id`, which the `mcp` function records on flags |
| **Headless agent** (CI job, service, bot) | API key `skn_<agent-id>_<secret>` | Only the spaces it was granted (usually as `reader`), filtered by the groups it belongs to |
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
added by the `agents` function). Owners and admins can still change members' roles and remove them.

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
  not exist, without confirming that it does.

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
proposal page.

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

## Agent keys

- **Format:** `skn_<agent-id>_<secret>`, 32 random bytes base64url. The secret is the agent's Auth password, so
  Supaknowledge stores no key material of its own; `agents.key_prefix` keeps the first characters for display. The key
  is shown once, at creation or rotation.
- **Use:** send it as `Authorization: Bearer skn_...` to the Edge Functions (`mcp`, `traces`, `bundle` export and
  lint, `connectors/upload`). Agents cannot create proposals, so they cannot import bundles. The function signs in
  as the agent's Auth user and uses that session, so RLS applies. Every request re-checks the `agents` row
  (`key_prefix`, `revoked_at`; cached for 15 seconds per worker) and the session is refreshed with GoTrue every
  2 minutes. `kf login --token skn_...` exchanges a key for a refreshable agent session.
- **Create:** `kf agents create <name> --role reader` or Studio → Agents (workspace owners and admins; the
  `agents` function checks this through the caller's RLS client before it touches the Auth admin API).
- **Rotate:** `kf agents rotate <agent>` sets a new password, updates `agents.key_prefix` and deletes every Auth
  session and refresh token of the agent (`kf_revoke_user_sessions()`, service role only). The old key is refused
  by every function worker within about 15 seconds.
- **Revoke:** `kf agents revoke <agent>` sets `agents.revoked_at`, bans the Auth user and deletes all its sessions
  and refresh tokens; `kf agents restore` clears `revoked_at` and lifts the ban. Within about 15 seconds every
  Supaknowledge function refuses both the key and any agent JWT (they check `revoked_at`), and no session can be
  refreshed. Be aware that an access token issued before the revoke remains a valid JWT until it expires
  (`jwt_expiry`, one hour by default): someone holding one can still call PostgREST directly with it until then.
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
| `06_hardening.test.sql` | 19 | Grants, `search_path` on functions, RLS enabled on every table, service-role detection, privileges of future objects |
| `07_review_fixes.test.sql` | 93 | Tenancy invariants, OAuth client tokens, agents, data lifecycle, traces/flags column rules, settings safety, the curator run lifecycle, search, maintenance |
| `08_followups.test.sql` | 64 | `agents.revoked_at` / `key_prefix` not user-writable, session revocation (service role only), validation of every settings key, Storage GC listing, stripping synced skill files, workspace invitations (no consent bypass, invitee-only acceptance, expiry, rate limit) |

Run them against a running local stack:

```bash
npx supabase start
npx supabase test db          # or: npm run test:db
```

CI runs the same suite on every push (`.github/workflows/ci.yml`).
