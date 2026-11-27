// Schema drift: after a `schema` source synced, compare its new snapshot with the previous one and open a flag on
// every data-access concept that still refers to a dropped, renamed or retyped identifier (or to a table whose
// RLS policies changed). The rules live in packages/core/src/schema.ts; the database dedupes against live drift
// flags, picks the flag audience and starts a curator run (kf_record_schema_drift()).
import {
  type DriftConcept,
  type DriftFlag,
  describeChange,
  diffSchemas,
  driftFlags,
  isBreakingChange,
  parseSchemaSnapshot,
  type SchemaChange,
  type SchemaSnapshot,
} from "../../_shared/core/schema.ts";
import type { Cursor, Logger } from "./types.ts";

export interface DriftDeps {
  /** live data-access concepts of the space */
  concepts(): Promise<DriftConcept[]>;
  /** kf_record_schema_drift(): returns how many flags were opened */
  record(flags: DriftFlag[]): Promise<number>;
}

export interface DriftResult {
  changes: SchemaChange[];
  flags: DriftFlag[];
  opened: number;
}

interface SnapshotCursor {
  project_ref: string | null;
  schemas: string[];
  snapshot: SchemaSnapshot;
}

function readCursor(c: Cursor | null | undefined): SnapshotCursor | null {
  if (!c || typeof c !== "object" || !c.snapshot) return null;
  try {
    return {
      project_ref: typeof c.project_ref === "string" ? c.project_ref : null,
      schemas: Array.isArray(c.schemas) ? c.schemas.filter((s): s is string => typeof s === "string") : [],
      snapshot: parseSchemaSnapshot(c.snapshot),
    };
  } catch {
    return null;
  }
}

function only(s: SchemaSnapshot, schemas: Set<string>): SchemaSnapshot {
  return { tables: s.tables.filter((t) => schemas.has(t.schema)), functions: s.functions.filter((f) => schemas.has(f.schema)) };
}

/**
 * Compare two cursors of a schema source. Nothing is flagged on the first sync, when the source now points at
 * another project, or for schemas that were added to or removed from the config (those are not drift).
 */
export function schemaChanges(previous: Cursor | null | undefined, next: Cursor | null | undefined): SchemaChange[] {
  const a = readCursor(previous);
  const b = readCursor(next);
  if (!a || !b || a.project_ref !== b.project_ref) return [];
  const shared = new Set(a.schemas.filter((s) => b.schemas.includes(s)));
  return diffSchemas(only(a.snapshot, shared), only(b.snapshot, shared));
}

export async function detectSchemaDrift(previous: Cursor | null | undefined, next: Cursor | null | undefined, deps: DriftDeps, log: Logger): Promise<DriftResult> {
  const changes = schemaChanges(previous, next);
  const breaking = changes.filter(isBreakingChange);
  if (!breaking.length) {
    if (changes.length) log(`schema changed: ${changes.map(describeChange).join("; ")}`);
    return { changes, flags: [], opened: 0 };
  }
  log(`schema drift: ${breaking.map(describeChange).join("; ")}`);
  const flags = driftFlags(breaking, await deps.concepts());
  const opened = flags.length ? await deps.record(flags) : 0;
  log(`schema drift: ${flags.length} concept reference(s) affected, ${opened} new flag(s)`);
  return { changes, flags, opened };
}
