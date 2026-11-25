import assert from "node:assert/strict";
import { test } from "node:test";
import { invitationErrorMessage, invitationState, normalizeEmail } from "../src/lib/invitations.ts";

test("normalizeEmail lowercases, trims and rejects junk", () => {
  assert.equal(normalizeEmail("  Ana@Example.COM "), "ana@example.com");
  assert.equal(normalizeEmail("ana@example"), null);
  assert.equal(normalizeEmail("ana example@x.com"), null);
  assert.equal(normalizeEmail(""), null);
  assert.equal(normalizeEmail(`${"a".repeat(320)}@x.com`), null);
});

test("invitationErrorMessage maps database errors", () => {
  assert.match(invitationErrorMessage({ code: "PT429", message: "too many invitations" }), /Too many/);
  assert.match(invitationErrorMessage({ code: "23505", message: "already a member" }), /already a member/);
  assert.equal(invitationErrorMessage({ code: "42501", message: "only owners can invite owners" }), "only owners can invite owners");
  assert.match(invitationErrorMessage({ code: "42501", message: "new row violates row-level security policy" }), /Only workspace admins/);
  assert.match(invitationErrorMessage({ code: "P0002", message: "invitation not found" }), /different e-mail/);
  assert.equal(invitationErrorMessage({ code: "22023", message: "invitation expired; ask for a new one" }), "invitation expired; ask for a new one");
});

test("invitationState", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  assert.equal(invitationState({ expires_at: "2026-11-25T00:00:00Z" }, now), "pending");
  assert.equal(invitationState({ expires_at: "2026-11-24T11:00:00Z" }, now), "expired");
  assert.equal(invitationState({ expires_at: "2026-11-25T00:00:00Z", accepted_at: "2026-11-24T10:00:00Z" }, now), "accepted");
  assert.equal(invitationState({ expires_at: "2026-11-25T00:00:00Z", declined_at: "2026-11-24T10:00:00Z" }, now), "declined");
});
