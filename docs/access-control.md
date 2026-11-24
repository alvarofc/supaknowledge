# Access control

Supaknowledge has one enforcement point: **Postgres row level security**. Every principal (a person in Studio, an MCP
client acting for a person, a headless agent) is a Supabase Auth user, and everything they do runs with their own
JWT. Edge Functions do not re-implement permissions; they call the database as the caller. UI checks in Studio
and the CLI only hide buttons.

The model was designed in [DESIGN.md §5a](DESIGN.md#5a-access-control-supabase-auth--rls) and is pinned down by
329 pgTAP tests ([below](#tests)).

## Principals

| Principal | How it authenticates | What it can see |
|---|---|---|
| **Person** | Supabase Auth (password or email link) in Studio; `kf login` | Their memberships, roles and groups |
| **MCP client acting for a person** (Claude Code, Cursor, Claude Desktop…) | OAuth 2.1 through Supabase Auth's authorization server; consent in Studio | Exactly what that person can see. The token carries the OAuth `client_id`, which the `mcp` function records on flags |
| **Headless agent** (CI job, service, bot) | API key `skn_<agent-id>_<secret>` | Only the spaces it was granted (usually as `reader`), filtered by the groups it belongs to |
| **Internal workers** (cron → embed, connectors, curator) | Shared secret `x-kf-internal`, then the service role | Everything; see [service role](#service-role-and-internal-calls) |

Agents are Auth users with `app_metadata.kind = 'agent'` (mirrored into `profiles.kind`, which users cannot edit).
Agents cannot create workspaces, cannot manage agents, and are never granted the space `admin` role.

## Roles

**Workspace** roles: `owner`, `admin`, `member`. Owners and admins administer every space of the workspace, its
groups, members and agents. Only owners can create or demote owners, and delete the workspace.

**Space** roles form a ladder: `reader` < `editor` < `reviewer` < `admin`. A person gets the highest of:

- a direct grant (`space_members`);
- a grant to a group they belong to (`space_group_grants`);
- `reader`, when the space has `visibility = 'workspace'` and they are a workspace member;
- `admin`, when they are a workspace owner or admin.

`my_space_role(space)` returns the effective role.

| Role | Adds |
|---|---|
| reader | Search and read knowledge (concepts, revisions, links, skill files); raise flags; send traces and log usage; see their own flags and traces |
| editor | Read flags, raw sources and documents, curator runs and proposals (see [proposal visibility](#proposal-visibility)); write human proposals and reverts; upload documents |
| reviewer | Approve and reject proposals, triage and dismiss flags, verify concepts, read everyone's traces and concept usage, start curator runs |
| admin | Approve escalations; manage sources and their Vault secrets, members, group grants and space settings (curator and auto-apply policy); see curator task status and the audit log |

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
  restriction. **Create the groups before importing:** an unknown group slug is ignored with a warning, and the
  concept is then imported without that restriction.
- **Connectors** map upstream ACLs (private Slack channels, private repos, Drive sharing) to groups through
  `groups.external_ref`, and never make a document wider than its source. See
  [connectors](connectors.md#access-control-audiences).
- **Traces** take `audience: ["<group-slug>"]` in the `traces` function.
- **Flags** inherit the audience of the concept they are about, so a flag never shows restricted content to a
  reviewer who cannot read the concept. A flag on a concept the caller cannot see is stored as if the concept did
  not exist, without confirming that it does.

## Proposal visibility

A proposal is visible to editors and up only if they can see **every** piece of evidence it cites, every audience
it writes to, and every concept it changes. Reviewing something you cannot fully see is not a review, so
`apply_proposal()` and `reject_proposal()` check the same rule.

## The escalation guard

Publishing material from a restricted audience into a wider one is an **escalation**:

```
is_escalation(source, target) = source is restricted and not (target is restricted and target ⊆ source)
```

Triggers on `proposal_ops` and `proposal_citations` compute it for every proposal, from audiences the database
reads itself (a citation's audience comes from the cited row, never from the client), and `apply_proposal()`
computes it again at apply time. Two cases count: cited evidence would reach a wider audience than it has, or an
existing concept would be widened. An escalated proposal:

- gets `escalation = true` and `risk = 'high'`;
- can only be applied by a **space admin** who can see all of its evidence;
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

## Agent keys

- **Format:** `skn_<agent-id>_<secret>`, 32 random bytes base64url. The secret is the agent's Auth password, so
  Supaknowledge stores no key material of its own; `agents.key_prefix` keeps the first characters for display. The key
  is shown once, at creation or rotation.
- **Use:** send it as `Authorization: Bearer skn_...` to the Edge Functions (`mcp`, `traces`, `bundle`,
  `connectors/upload`). The function signs in as the agent's Auth user and uses that session, so RLS applies. The
  session is cached per worker and re-verified every 5 minutes. `kf login --token skn_...` exchanges a key for a
  refreshable agent session.
- **Create:** `kf agents create <name> --role reader` or Studio → Agents (workspace owners and admins; the
  `agents` function checks this through the caller's RLS client before it touches the Auth admin API).
- **Rotate:** `kf agents rotate <agent>` sets a new password and signs the agent out globally, which revokes every
  refresh token issued for the old key.
- **Revoke:** `kf agents revoke <agent>` bans the Auth user; `kf agents restore` lifts the ban. Warm function
  workers re-check within 5 minutes; an access token issued before the ban lives until it expires (`jwt_expiry`,
  one hour by default) and cannot be refreshed.
- **Delete:** `kf agents delete <agent>` deletes the Auth user, which cascades to its memberships.

## Service role and internal calls

pg_cron calls the `embed`, `connectors` and `curator` functions with the `x-kf-internal` secret (Vault
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
- Storage reads follow the rows the files belong to; there are no direct writes.

## Tests

`supabase/tests/database` holds the pgTAP suite. `_fixture.psql` builds two workspaces with people at every role,
an agent, finance and other groups, restricted and public knowledge, evidence and a proposal citing finance-only
material; every test file runs inside a transaction that is rolled back.

| File | Tests | Covers |
|---|---|---|
| `01_tenancy.test.sql` | 62 | Workspace isolation, the space role ladder, visibility, group grants, owners, agents |
| `02_audience.test.sql` | 112 | Restricted knowledge is invisible outside its groups for every role, across concepts, revisions, chunks, links, files, search, flags and health |
| `03_evidence.test.sql` | 45 | Sources and documents (editors+), traces (own or reviewers+), connector secrets, service-only queue RPCs |
| `04_proposals.test.sql` | 78 | Authoring rules, proposal visibility, the escalation guard, apply / reject / verify / revert, conflicts, trust tiers |
| `05_storage.test.sql` | 18 | `concept-files` follows concept visibility, `sources` follows document visibility, no direct writes |
| `06_hardening.test.sql` | 14 | Grants, `search_path` on functions, RLS enabled on every table, service-role detection |

Run them against a running local stack:

```bash
npx supabase start
npx supabase test db          # or: npm run test:db
```

CI runs the same suite on every push (`.github/workflows/ci.yml`).
