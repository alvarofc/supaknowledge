// Storage garbage collection: removes the objects queued in public.kf_storage_gc (deleted spaces, sources,
// concepts and soft-deleted documents; the database cannot delete Storage bytes itself).
// For each queued (bucket, prefix): list the objects (public.kf_storage_gc_objects, paginated by name), remove
// them through the Storage API in batches, then delete the queue row. The database orders names byte-wise
// (COLLATE "C"); the keyset cursor is always the last name it returned, never compared or sorted here (JS string
// order / localeCompare differ from byte order). The deadline is checked between pages and remove batches: a
// row cut short stays queued (not done, no failure recorded) and the next run lists what is left from the start. Failures bump attempts / last_error and
// the row is retried on the next run (rows with 10 failed attempts are left for an operator).
// Pure over a small client interface so it can be unit tested without a database.

export interface GcRow {
  id: number;
  bucket: string;
  prefix: string;
  attempts: number;
}

export interface GcStore {
  /** oldest queued rows with attempts < maxAttempts */
  queued(limit: number, maxAttempts: number): Promise<GcRow[]>;
  /** object names under `prefix` (folder when it ends in "/", else one exact name), name > after, ascending */
  objects(bucket: string, prefix: string, after: string, limit: number): Promise<string[]>;
  /** remove objects (Storage API: deletes the bytes and the storage.objects rows) */
  remove(bucket: string, names: string[]): Promise<void>;
  done(id: number): Promise<void>;
  failed(id: number, attempts: number, error: string): Promise<void>;
}

export interface GcResult {
  rows: number;
  removed: number;
  failed: { id: number; error: string }[];
  /** the deadline stopped the run; remaining work continues on the next run */
  stopped: boolean;
}

export const MAX_ATTEMPTS = 10;
const PAGE = 500;
/** Storage's remove() accepts up to 1000 names; smaller batches keep each request quick */
const REMOVE_BATCH = 100;

export async function collectGarbage(
  store: GcStore,
  opts: { maxRows?: number; deadline?: number; now?: () => number } = {},
): Promise<GcResult> {
  const now = opts.now ?? Date.now;
  const rows = await store.queued(opts.maxRows ?? 50, MAX_ATTEMPTS);
  const out: GcResult = { rows: 0, removed: 0, failed: [], stopped: false };
  const late = () => opts.deadline !== undefined && now() > opts.deadline;
  for (const row of rows) {
    if (late()) {
      out.stopped = true; // the next cron run continues
      break;
    }
    try {
      let after = "";
      let complete = false;
      while (!late()) {
        const names = await store.objects(row.bucket, row.prefix, after, PAGE);
        let i = 0;
        for (; i < names.length; i += REMOVE_BATCH) {
          if (i > 0 && late()) break;
          await store.remove(row.bucket, names.slice(i, i + REMOVE_BATCH));
          out.removed += Math.min(REMOVE_BATCH, names.length - i);
        }
        if (i < names.length) break; // deadline in the middle of a page
        if (names.length < PAGE) {
          complete = true;
          break;
        }
        // keyset cursor in the database's (byte) order: the last name it returned
        after = names[names.length - 1]!;
      }
      if (!complete) {
        out.stopped = true; // the row stays queued; the next run lists what is left
        break;
      }
      await store.done(row.id);
      out.rows++;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      out.failed.push({ id: row.id, error });
      await store.failed(row.id, row.attempts + 1, error.slice(0, 1000)).catch(() => {});
    }
  }
  return out;
}
