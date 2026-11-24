// Helpers shared by the caller-facing functions (mcp, agents, traces, bundle, curator).
// Candidates to move into _shared once the lead is happy with them.
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "../_shared/http.ts";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}

/** Path after the function name: "/functions/v1/agents/x/rotate" and "/agents/x/rotate" both give "/x/rotate". */
export function subpath(req: Request, fn: string): string {
  const p = new URL(req.url).pathname;
  const i = p.indexOf(`/${fn}`);
  const rest = i >= 0 ? p.slice(i + fn.length + 1) : p;
  return ("/" + rest.replace(/^\/+/, "")).replace(/\/+$/, "") || "/";
}

interface PgError {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

/** Map a PostgREST / Postgres error to an HttpError with a sensible status. */
export function dbError(e: PgError, what?: string): HttpError {
  const status = (() => {
    switch (e.code) {
      case "42501": // insufficient_privilege (RLS / role checks in RPCs)
        return 403;
      case "28000":
      case "PGRST301":
      case "PGRST303":
        return 401;
      case "P0002":
      case "PGRST116":
        return 404;
      case "23505":
        return 409;
      case "22023":
      case "22P02":
      case "23502":
      case "23503":
      case "23514":
      case "22007":
      case "22008":
        return 400;
      default:
        return 500;
    }
  })();
  const msg = e.code === "42501" && /row-level security/i.test(e.message) ? "permission denied" : e.message;
  return new HttpError(status, what ? `${what}: ${msg}` : msg);
}

/** Unwrap a supabase-js result or throw a mapped HttpError. */
export function must<T>(res: { data: T | null; error: PgError | null }, what?: string): T {
  if (res.error) throw dbError(res.error, what);
  return res.data as T;
}

export interface SpaceInfo {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  workspace_id: string;
  workspace_slug: string;
  /** "<workspace-slug>/<space-slug>" */
  ref: string;
  settings: Record<string, unknown>;
}

const SPACE_COLS = "id, slug, name, description, workspace_id, settings, workspaces!inner(slug)";

// deno-lint-ignore no-explicit-any
function toSpace(row: any): SpaceInfo {
  const ws = Array.isArray(row.workspaces) ? row.workspaces[0] : row.workspaces;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    workspace_id: row.workspace_id,
    workspace_slug: ws?.slug ?? "",
    ref: `${ws?.slug ?? "?"}/${row.slug}`,
    settings: row.settings ?? {},
  };
}

/**
 * Resolve a space reference (uuid or "<workspace-slug>/<space-slug>") through the CALLER's RLS client, so a
 * space the caller cannot read is indistinguishable from one that does not exist.
 */
export async function resolveSpace(db: SupabaseClient, ref: unknown): Promise<SpaceInfo> {
  if (typeof ref !== "string" || !ref.trim()) throw new HttpError(400, "space is required (uuid or \"<workspace>/<space>\")");
  const r = ref.trim();
  let q = db.from("spaces").select(SPACE_COLS);
  if (isUuid(r)) q = q.eq("id", r);
  else {
    const m = /^([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/.exec(r);
    if (!m) throw new HttpError(400, `invalid space reference "${r}" (use a uuid or "<workspace>/<space>")`);
    q = q.eq("slug", m[2]).eq("workspaces.slug", m[1]);
  }
  const rows = must(await q.limit(1), "resolve space") as unknown[];
  if (!rows.length) throw new HttpError(404, `space "${r}" not found or not accessible`);
  return toSpace(rows[0]);
}

/** Spaces the caller can read (RLS). */
export async function listSpaces(db: SupabaseClient): Promise<SpaceInfo[]> {
  const rows = must(await db.from("spaces").select(SPACE_COLS).order("slug").limit(500), "list spaces") as unknown[];
  return rows.map(toSpace).sort((a, b) => a.ref.localeCompare(b.ref));
}

/** Map group slugs (or ids) of a workspace to ids through the caller's RLS client. Unknown entries throw 400. */
export async function resolveGroups(db: SupabaseClient, workspaceId: string, slugsOrIds: unknown): Promise<string[]> {
  if (slugsOrIds === undefined || slugsOrIds === null) return [];
  if (!Array.isArray(slugsOrIds) || slugsOrIds.some((s) => typeof s !== "string")) {
    throw new HttpError(400, "audience must be an array of group slugs");
  }
  const wanted = [...new Set(slugsOrIds as string[])];
  if (!wanted.length) return [];
  const groups = must(await db.from("groups").select("id, slug").eq("workspace_id", workspaceId), "groups") as { id: string; slug: string }[];
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const s of wanted) {
    const g = groups.find((x) => x.slug === s || x.id === s);
    if (g) ids.push(g.id);
    else unknown.push(s);
  }
  if (unknown.length) throw new HttpError(400, `unknown audience group(s): ${unknown.join(", ")}`);
  return [...new Set(ids)];
}

export function auditActor(userId: string): string {
  return `user:${userId}`;
}
