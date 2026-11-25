// Workspace invitations: pure helpers shared by Settings → Members and the Home banner
// (unit tested in test/invitations.test.ts).

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Same normalization and shape check as public.invite_to_workspace(). */
export function normalizeEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  return EMAIL_RE.test(e) && e.length <= 320 ? e : null;
}

/** Friendly message for invite_to_workspace / accept / decline errors (PostgREST error objects). */
export function invitationErrorMessage(e: unknown): string {
  const err = (e ?? {}) as { code?: string; status?: number; message?: string };
  if (err.code === "PT429" || err.status === 429) return "Too many invitations in the last hour. Try again later.";
  if (err.code === "23505") return "That person is already a member of this workspace.";
  if (err.code === "42501") return err.message && !/row-level security/.test(err.message) ? err.message : "Only workspace admins can invite people.";
  if (err.code === "P0002") return "This invitation no longer exists, or it was sent to a different e-mail address.";
  return err.message ?? "Something went wrong";
}

export type InvitationState = "pending" | "expired" | "accepted" | "declined";

export function invitationState(i: { expires_at: string; accepted_at?: string | null; declined_at?: string | null }, now = Date.now()): InvitationState {
  if (i.accepted_at) return "accepted";
  if (i.declined_at) return "declined";
  return Date.parse(i.expires_at) <= now ? "expired" : "pending";
}
