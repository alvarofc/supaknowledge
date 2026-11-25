import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { invitationStatus, parseInvite } from "../src/commands/members.ts";
import { skillFileLines } from "../src/commands/review.ts";
import { harness, json, spaceRoute, WS_ID } from "./helpers.ts";

const INV = "44444444-0000-4000-8000-000000000004";
const AGENT = "55555555-0000-4000-8000-000000000005";
const future = new Date(Date.now() + 86_400_000).toISOString();

describe("parseInvite", () => {
  it("normalizes the e-mail and defaults the role to member", () => {
    assert.deepEqual(parseInvite("  Ana@Acme.COM ", undefined), { email: "ana@acme.com", role: "member" });
    assert.deepEqual(parseInvite("ana@acme.com", "owner"), { email: "ana@acme.com", role: "owner" });
  });
  it("rejects bad e-mails, unknown roles and the agent domain", () => {
    assert.throws(() => parseInvite("not-an-email", "member"), /not an e-mail/);
    assert.throws(() => parseInvite("ana@acme.com", "reader"), /--role must be one of/);
    assert.throws(() => parseInvite(`agent-${AGENT}@agents.supaknowledge.internal`, "member"), /agents are not invited/);
  });
});

describe("invitationStatus", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  it("derives pending / expired / accepted / declined", () => {
    assert.equal(invitationStatus({ expires_at: "2026-12-01T00:00:00Z" }, now), "pending");
    assert.equal(invitationStatus({ expires_at: "2026-11-01T00:00:00Z" }, now), "expired");
    assert.equal(invitationStatus({ expires_at: "2026-11-01T00:00:00Z", accepted_at: "2026-10-30T00:00:00Z" }, now), "accepted");
    assert.equal(invitationStatus({ expires_at: "2026-12-01T00:00:00Z", declined_at: "2026-11-20T00:00:00Z" }, now), "declined");
  });
});

describe("skillFileLines", () => {
  it("lists inline and stripped (synced) files without needing content", () => {
    assert.deepEqual(
      skillFileLines([
        { path: "SKILL.md", content: "hello", encoding: "utf8" },
        { path: "img/logo.png", encoding: "base64", size_bytes: 2048, sha256: "ab", stripped: true },
        { path: "scripts/run.sh", stripped: true },
        { nope: true },
      ]),
      ["SKILL.md (5 B)", "img/logo.png (binary, 2048 B, synced to Storage)", "scripts/run.sh (synced to Storage)"],
    );
    assert.deepEqual(skillFileLines(undefined), []);
  });
});

describe("kf members invite", () => {
  it("calls invite_to_workspace with the space's workspace", async () => {
    const h = harness();
    h.routes.push(spaceRoute, (c) =>
      c.url.endsWith("/rpc/invite_to_workspace")
        ? json({ id: INV, workspace_id: WS_ID, email: "ana@acme.com", role: "admin", created_at: new Date().toISOString(), expires_at: future })
        : undefined,
    );
    const r = await h.run("members", "invite", "Ana@acme.com", "--role", "admin");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /invited ana@acme\.com as admin/);
    assert.deepEqual(h.calls.find((c) => c.url.endsWith("/rpc/invite_to_workspace"))!.body, { p_workspace: WS_ID, p_email: "ana@acme.com", p_role: "admin" });
  });

  it("refuses an invalid role before calling the API", async () => {
    const h = harness();
    h.routes.push(spaceRoute);
    const r = await h.run("members", "invite", "ana@acme.com", "--role", "editor");
    assert.equal(r.code, 2);
    assert.ok(!h.calls.some((c) => c.url.includes("invite_to_workspace")));
  });
});

describe("kf members add --workspace", () => {
  it("only updates the role of an existing member (never inserts)", async () => {
    const h = harness();
    const uid = "66666666-0000-4000-8000-000000000006";
    h.routes.push(spaceRoute, (c) => (c.method === "PATCH" && c.url.includes("/rest/v1/workspace_members?") ? json([]) : undefined));
    const r = await h.run("members", "add", uid, "--workspace", "--role", "admin");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /kf members invite/);
    assert.ok(!h.calls.some((c) => c.method === "POST" && c.url.includes("workspace_members")));
  });
});

describe("kf members invitations / uninvite", () => {
  it("lists the workspace's open invitations with a status", async () => {
    const h = harness();
    h.routes.push(spaceRoute, (c) =>
      c.url.includes("/rest/v1/workspace_invitations?")
        ? json([{ id: INV, email: "ana@acme.com", role: "member", created_at: new Date().toISOString(), expires_at: future, accepted_at: null, declined_at: null }])
        : undefined,
    );
    const r = await h.run("members", "invitations", "--json");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout)[0].status, "pending");
    const url = h.calls.find((c) => c.url.includes("workspace_invitations"))!.url;
    assert.match(url, /workspace_id=eq\./);
    assert.match(url, /accepted_at=is\.null/);
  });

  it("uninvite deletes the row and reports RLS no-ops", async () => {
    const h = harness();
    h.routes.push((c) => (c.method === "DELETE" && c.url.includes("/rest/v1/workspace_invitations?") ? json([]) : undefined));
    const r = await h.run("members", "uninvite", INV);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /nothing revoked/);
  });
});

describe("kf invitations", () => {
  it("lists mine through list_my_invitations", async () => {
    const h = harness();
    h.routes.push((c) =>
      c.url.endsWith("/rpc/list_my_invitations")
        ? json([{ id: INV, workspace_id: WS_ID, workspace_slug: "acme", workspace_name: "Acme", role: "member", invited_by_name: "Owner", created_at: new Date().toISOString(), expires_at: future }])
        : undefined,
    );
    const r = await h.run("invitations");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /acme \(Acme\)/);
  });

  it("accept prints the workspace slug", async () => {
    const h = harness();
    h.routes.push((c) => (c.url.endsWith("/rpc/accept_invitation") ? json({ id: WS_ID, slug: "acme", name: "Acme" }) : undefined));
    const r = await h.run("invitations", "accept", INV);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /joined acme/);
    assert.deepEqual(h.calls.find((c) => c.url.endsWith("/rpc/accept_invitation"))!.body, { p_id: INV });
  });

  it("decline calls decline_invitation; bad ids are usage errors", async () => {
    const h = harness();
    h.routes.push((c) => (c.url.endsWith("/rpc/decline_invitation") ? new Response(null, { status: 204 }) : undefined));
    const r = await h.run("invitations", "decline", INV);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /declined/);
    const bad = await h.run("invitations", "accept", "nope");
    assert.equal(bad.code, 2);
  });
});

describe("kf members remove --workspace", () => {
  it("refuses headless agents (they would be stranded) without deleting anything", async () => {
    const h = harness();
    h.routes.push(spaceRoute, (c) => (c.url.includes("/rest/v1/profiles?") ? json([{ kind: "agent" }]) : undefined));
    const r = await h.run("members", "remove", AGENT, "--workspace");
    assert.equal(r.code, 2);
    assert.match(r.stderr, /agents can't be removed from the workspace/);
    assert.match(r.stderr, /kf agents revoke/);
    assert.equal(h.calls.some((c) => c.method === "DELETE"), false);
  });

  it("removes people", async () => {
    const h = harness();
    const UID = "66666666-0000-4000-8000-000000000006";
    h.routes.push(
      spaceRoute,
      (c) => (c.url.includes("/rest/v1/profiles?") ? json([{ kind: "human" }]) : undefined),
      (c) => (c.method === "DELETE" && c.url.includes("/rest/v1/workspace_members?") ? json([{ user_id: UID }]) : undefined),
    );
    const r = await h.run("members", "remove", UID, "--workspace");
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /removed/);
  });
});
