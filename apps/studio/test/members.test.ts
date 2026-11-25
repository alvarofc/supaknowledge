import assert from "node:assert/strict";
import { test } from "node:test";
import { addableSpaceRoles, canRevokeInvitation, workspaceMemberLock } from "../src/lib/members.ts";

const admin = { canManage: true, isOwner: false, owners: 2 };
const owner = { canManage: true, isOwner: true, owners: 2 };

test("agents are never removable or editable from workspace members", () => {
  assert.match(workspaceMemberLock({ kind: "agent", role: "member" }, owner) ?? "", /Agents page/);
  assert.match(workspaceMemberLock({ kind: "agent", role: "member" }, admin) ?? "", /Agents page/);
});

test("owner rows: only owners manage them, and the last owner is locked", () => {
  assert.equal(workspaceMemberLock({ kind: "human", role: "member" }, admin), null);
  assert.equal(workspaceMemberLock({ kind: "human", role: "owner" }, owner), null);
  assert.match(workspaceMemberLock({ kind: "human", role: "owner" }, admin) ?? "", /Only owners/);
  assert.match(workspaceMemberLock({ kind: "human", role: "owner" }, { ...owner, owners: 1 }) ?? "", /last owner/);
  assert.equal(workspaceMemberLock({ kind: "human", role: "member" }, { canManage: false, isOwner: false, owners: 2 }), "");
});

test("only owners revoke owner invitations", () => {
  assert.equal(canRevokeInvitation({ role: "owner" }, admin), false);
  assert.equal(canRevokeInvitation({ role: "owner" }, owner), true);
  assert.equal(canRevokeInvitation({ role: "admin" }, admin), true);
  assert.equal(canRevokeInvitation({ role: "member" }, { canManage: false, isOwner: false }), false);
});

test("agents are never offered the space admin role", () => {
  assert.deepEqual(addableSpaceRoles("agent"), ["reader", "editor", "reviewer"]);
  assert.deepEqual(addableSpaceRoles("human"), ["reader", "editor", "reviewer", "admin"]);
  assert.deepEqual(addableSpaceRoles(undefined), ["reader", "editor", "reviewer", "admin"]);
});
