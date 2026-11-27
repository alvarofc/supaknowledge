// Errors around trace ingest: database errors of trace writes -> HTTP, and the errors agents hit in the tool calls
// they report (Supabase MCP SQL calls, sanitised before they are stored).
//
// Database errors of trace writes -> HTTP. The database validates trace audiences itself (migration
// 20261125000021: every group must belong to the space's workspace, SQLSTATE 22023); that is the caller's
// mistake (400) with a message that says what to fix, never a 500.
import { HttpError } from "../_shared/http.ts";
import { dbError } from "../_lib/api.ts";
import { sanitizeToolEvent, type ToolEventLike } from "../_shared/core/sql-errors.ts";

export const INVALID_AUDIENCE = "invalid audience: every group must be a group of this space's workspace (use group slugs from `kf groups`)";

export function traceDbError(e: { message: string; code?: string; details?: string | null; hint?: string | null }, what: string): HttpError {
  if (e.code === "22023" && /audience/i.test(e.message)) return new HttpError(400, `${what}: ${INVALID_AUDIENCE}`);
  return dbError(e, what);
}

/** Unwrap a supabase-js result of a trace write, mapping errors with traceDbError. */
export function mustWrite<T>(res: { data: T | null; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) throw traceDbError(res.error, what);
  return res.data as T;
}

/**
 * Sanitise tool events before they are stored. The Supabase MCP server's SQL tools (`execute_sql`,
 * `apply_migration`, whatever prefix the client gives them: `mcp__supabase__execute_sql`, `supabase_execute_sql`...)
 * keep their SQL with literals redacted, a successful result becomes `{ omitted: "row data", rows }`, and a failed
 * one keeps only the parsed Postgres error (SQLSTATE, message, hint; values redacted), with `metadata.sql_tool`.
 * Any tool whose MCP result says `isError: true` is stored as an error. Other events are unchanged.
 */
export function sanitizeEvents<E extends ToolEventLike>(events: E[]): (E & ToolEventLike)[] {
  return events.map((e) => sanitizeToolEvent(e));
}
