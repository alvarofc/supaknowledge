// Request validation for the agents function (unit tested in agents/test/validate.test.ts).
import { HttpError } from "../_shared/http.ts";
import { isUuid } from "../_lib/api.ts";

export type SpaceRole = "reader" | "editor" | "reviewer";
export const GRANTABLE: SpaceRole[] = ["reader", "editor", "reviewer"];
const MAX_NAME = 100;
const MAX_DESCRIPTION = 2000;
const MAX_GRANTS = 100;

export interface CreateInput {
  workspaceId: string;
  name: string;
  description: string | null;
  grants: { space_id: string; role: SpaceRole }[];
}

/** Validate POST /agents bodies: every malformed field is a 400, never a 500. */
export function parseCreateBody(body: unknown): CreateInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (!isUuid(b.workspace_id)) throw new HttpError(400, "workspace_id (uuid) is required");
  if (typeof b.name !== "string" || !b.name.trim() || b.name.trim().length > MAX_NAME) {
    throw new HttpError(400, `name is required (string, max ${MAX_NAME} characters)`);
  }
  if (b.description != null && (typeof b.description !== "string" || b.description.length > MAX_DESCRIPTION)) {
    throw new HttpError(400, `description must be a string (max ${MAX_DESCRIPTION} characters)`);
  }
  const spaces = b.spaces ?? [];
  if (!Array.isArray(spaces)) throw new HttpError(400, "spaces must be an array of {space_id, role?}");
  if (spaces.length > MAX_GRANTS) throw new HttpError(400, `at most ${MAX_GRANTS} space grants`);
  const grants = spaces.map((s, i) => {
    if (!s || typeof s !== "object" || Array.isArray(s)) throw new HttpError(400, `spaces[${i}] must be an object {space_id, role?}`);
    const { space_id, role } = s as Record<string, unknown>;
    if (!isUuid(space_id)) throw new HttpError(400, `spaces[${i}].space_id must be a uuid`);
    const r = role ?? "reader";
    if (typeof r !== "string" || !GRANTABLE.includes(r as SpaceRole)) {
      throw new HttpError(400, `spaces[${i}].role must be one of ${GRANTABLE.join(", ")} (agents never get admin)`);
    }
    return { space_id, role: r as SpaceRole };
  });
  if (new Set(grants.map((g) => g.space_id)).size !== grants.length) throw new HttpError(400, "spaces[] lists the same space twice");
  return { workspaceId: b.workspace_id, name: b.name.trim(), description: (b.description as string | null | undefined) ?? null, grants };
}
