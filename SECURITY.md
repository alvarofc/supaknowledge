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
[docs/access-control.md](docs/access-control.md) and enforced by row level security, with 329 pgTAP tests in
`supabase/tests/database`.

1. **RLS is the single enforcement point.** People, OAuth-connected MCP clients and agents query with their own
   JWT. No client (Studio, `kf`, the SDKs) holds a secret or service-role key.
2. **Tenancy.** Nothing in a workspace or space is readable or writable by principals without a role there.
3. **Audiences are never bypassed by role.** Knowledge, revisions, chunks, links, files, sources, documents,
   traces and flags restricted to groups are invisible to everyone outside those groups, including space and
   workspace admins.
4. **Proposals.** A proposal is visible to, and can be approved or rejected by, only people who can see all the
   evidence it cites and every audience it touches. Escalations (restricted material into a wider audience) need a
   space admin and are never applied automatically.
5. **One audited write path.** Knowledge changes only through `apply_proposal()`, which records revisions,
   verifications and the audit log.
6. **Agents** are Auth users limited to the spaces they were granted; they cannot create workspaces, manage
   agents or hold the space admin role. Revoking an agent (ban) stops new sessions immediately and cached sessions
   in Edge Functions within five minutes.
7. **Secrets.** Connector tokens live in Vault and are never readable through the API; the internal cron secret is
   compared in constant time.
8. **Storage** reads follow the rows the files belong to; there are no direct writes.

## Out of scope, and known limitations

- The curator and connectors run with the service role by design (they must read evidence across audiences); the
  database guards what they can publish.
- A JWT issued before an agent was revoked stays valid until it expires (`jwt_expiry`, one hour by default).
- Importing a bundle whose `x-supaknowledge-audience` names a group that does not exist imports that concept without
  the restriction (with a warning). Create groups before importing; a fail-closed fix is planned.
- Prompt injection: knowledge, documents and traces are untrusted text that reaches models (agents and the
  curator). Human review and the auto-apply policy are the controls; keep auto-apply narrow.
- Self-hosted deployments are responsible for their own Supabase configuration (TLS, Auth settings, secrets).
