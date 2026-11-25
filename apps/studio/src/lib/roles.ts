import type { Database } from "@/lib/database.types";

export type SpaceRole = Database["public"]["Enums"]["space_role"];
export type WorkspaceRole = Database["public"]["Enums"]["workspace_role"];

const RANK: Record<SpaceRole, number> = { reader: 1, editor: 2, reviewer: 3, admin: 4 };

/** Mirrors private.role_rank: does `role` meet `min`? Hiding actions is UX only; RLS enforces. */
export function atLeast(role: SpaceRole | null | undefined, min: SpaceRole): boolean {
  return role ? RANK[role] >= RANK[min] : false;
}

export function isWorkspaceAdmin(role: WorkspaceRole | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

export const ROLE_HELP: Record<SpaceRole, string> = {
  reader: "Search, read and flag knowledge",
  editor: "Also suggest edits, see sources and proposals",
  reviewer: "Also approve proposals, verify knowledge, see traces",
  admin: "Also manage sources, members and settings",
};
