// Settings → Members: pure rules for which controls a row gets (unit tested in test/members.test.ts).
// Hiding controls is UX only; the database enforces every rule (RLS, triggers).

type Kind = "human" | "agent";
type SpaceRole = "reader" | "editor" | "reviewer" | "admin";
type WorkspaceRole = "owner" | "admin" | "member";

/**
 * Why a workspace member row is read-only, or null when the viewer may change its role / remove it.
 * Headless agents are managed on the Agents page: removing their workspace membership would strand them (the
 * database refuses it), and they can only ever be plain members.
 */
export function workspaceMemberLock(
  m: { kind: Kind; role: WorkspaceRole },
  viewer: { canManage: boolean; isOwner: boolean; owners: number },
): string | null {
  if (m.kind === "agent") return "Agents are managed on the Agents page (revoke or delete the agent there)";
  if (m.role === "owner" && viewer.owners <= 1) return "The last owner can't be changed or removed";
  if (!viewer.canManage) return "";
  if (m.role === "owner" && !viewer.isOwner) return "Only owners can change or remove other owners";
  return null;
}

/** Only owners may change or revoke an owner invitation. */
export function canRevokeInvitation(i: { role: WorkspaceRole }, viewer: { canManage: boolean; isOwner: boolean }): boolean {
  return viewer.canManage && (i.role !== "owner" || viewer.isOwner);
}

const SPACE_ROLES: SpaceRole[] = ["reader", "editor", "reviewer", "admin"];

/** Space roles offered when adding someone: agents can never be space admins. Unknown (pasted) ids get every role. */
export function addableSpaceRoles(kind: Kind | undefined): SpaceRole[] {
  return kind === "agent" ? SPACE_ROLES.filter((r) => r !== "admin") : SPACE_ROLES;
}
