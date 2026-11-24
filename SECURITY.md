# Security

Supaknowledge stores company knowledge, raw source documents and agent traces, and decides who may read them. We take
reports seriously.

## Supported versions

Supaknowledge is alpha software (0.x). Security fixes land on `main` and in the latest release only.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting (Security → Report a
vulnerability) on this repository, with:

- what an attacker can do, and as whom (anonymous, reader, agent key, editor, …);
- steps to reproduce against `npx supabase start`, ideally as a SQL snippet or a pgTAP test;
- the commit you tested.

We aim to acknowledge reports within three working days and to agree on a fix and disclosure timeline with you.
Please give us a reasonable time to ship a fix before disclosing.

## What Supaknowledge guarantees

These are the properties we treat as security bugs when broken. They are described in
[docs/access-control.md](docs/access-control.md) and enforced by row level security, with 537 pgTAP tests in
`supabase/tests/database`.

1. **RLS is the single enforcement point.** People, OAuth-connected MCP clients and agents query with their own
   JWT. No client (Studio, `kf`, the SDKs) holds a secret or service-role key.
2. **Tenancy.** Nothing in a workspace or space is readable or writable by principals without a role there.
3. **Audiences are never bypassed by role.** Knowledge, revisions, chunks, links, files, sources, documents,
   traces and flags restricted to groups are invisible to everyone outside those groups, including space and
   workspace admins.
4. **Proposals.** A proposal is created atomically by `create_proposal()` (ops and citations in one transaction),
   so nobody sees it before its access is computed. It is visible to, and can be approved or rejected by, only
   people who can see all the evidence it cites or that the curator consulted while drafting, and every audience
   it touches; evidence audiences are always read from the live rows. Escalations (restricted material into a
   wider audience) need a human space admin and are never applied automatically.
5. **One audited write path.** Proposals are written only through `create_proposal()`, and knowledge changes only
   through `apply_proposal()`, which records revisions, verifications and the audit log.
6. **Agents** are Auth users limited to the spaces they were granted; they cannot create workspaces, manage
   agents, hold the space `admin` or workspace `admin`/`owner` role, or approve escalations. What an agent applies
   or verifies is recorded as `agent:<id>` and counts as `machine_confirmed`, never `human_reviewed`. Agent Auth
   emails cannot be registered through sign-up, and agents are deleted only through the `agents` function.
   Revoking an agent sets `agents.revoked_at`, bans its Auth user and deletes all its sessions and refresh tokens:
   no new session can be created or refreshed, and the Edge Functions refuse its key and its JWTs within about
   15 seconds. Rotating or deleting an agent deletes its sessions too.
   Nobody joins a workspace without accepting an invitation addressed to their verified e-mail.
7. **OAuth-connected MCP clients** act for a person but with a narrower reach: they can read and search what that
   person can read, log usage, flag knowledge and send traces. They cannot administer anything (workspaces,
   members, groups, spaces, sources, secrets, agents), create, apply or reject proposals, or verify and revert
   knowledge.
8. **Secrets.** Connector tokens live in Vault and are never readable through the API; the internal cron secret is
   compared in constant time.
9. **Storage** reads follow the rows the files belong to; there are no direct writes.

## Out of scope, and known limitations

- The curator and connectors run with the service role by design (they must read evidence across audiences); the
  database guards what they can publish.
- An access token (JWT) issued before an agent was revoked is refused by the Supaknowledge functions, but stays a
  valid JWT for direct PostgREST calls until it expires (`jwt_expiry`, one hour by default).
- Prompt injection: knowledge, documents and traces are untrusted text that reaches models (agents and the
  curator). Human review and the auto-apply policy are the controls; keep auto-apply narrow.
- Self-hosted deployments are responsible for their own Supabase configuration (TLS, Auth settings, secrets).
