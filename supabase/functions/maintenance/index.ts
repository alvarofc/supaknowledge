// Internal maintenance tasks, invoked by pg_cron with the internal secret (util.invoke_edge_function).
//
//   POST /maintenance  {"task": "storage_gc"}   remove Storage objects queued in public.kf_storage_gc
//                                               (cron kf-storage-gc, every 10 minutes while the queue is not empty)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireInternal } from "../_shared/auth.ts";
import { adminClient } from "../_shared/env.ts";
import { handler, HttpError, json, readJson } from "../_shared/http.ts";
import { collectGarbage, type GcRow, type GcStore } from "./gc.ts";

/** wall-clock budget per invocation (Edge Functions are cut off at ~150 s) */
const BUDGET_MS = 100_000;

function store(db: SupabaseClient): GcStore {
  const check = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
    if (r.error) throw new Error(`${what}: ${r.error.message}`);
    return r.data;
  };
  return {
    async queued(limit, maxAttempts) {
      return check(
        await db.from("kf_storage_gc").select("id, bucket, prefix, attempts").lt("attempts", maxAttempts).order("id").limit(limit),
        "load queue",
      ) as GcRow[];
    },
    async objects(bucket, prefix, after, limit) {
      const rows = check(
        await db.rpc("kf_storage_gc_objects", { p_bucket: bucket, p_prefix: prefix, p_after: after, p_limit: limit }),
        "list objects",
      ) as { name: string }[];
      return rows.map((r) => r.name);
    },
    async remove(bucket, names) {
      const { error } = await db.storage.from(bucket).remove(names);
      if (error) throw new Error(`remove from ${bucket}: ${error.message}`);
    },
    async done(id) {
      check(await db.from("kf_storage_gc").delete().eq("id", id), "dequeue");
    },
    async failed(id, attempts, error) {
      check(await db.from("kf_storage_gc").update({ attempts, last_error: error }).eq("id", id), "record failure");
    },
  };
}

Deno.serve(handler(async (req) => {
  requireInternal(req);
  if (req.method !== "POST") throw new HttpError(405, "POST only");
  const body = await readJson<{ task?: string }>(req);
  if (body.task === "storage_gc") {
    // Service role: Storage objects of deleted rows are not reachable through anyone's RLS any more.
    const result = await collectGarbage(store(adminClient()), { deadline: Date.now() + BUDGET_MS });
    if (result.failed.length) console.warn("storage gc failures:", JSON.stringify(result.failed));
    return json(result);
  }
  throw new HttpError(400, `unknown task ${JSON.stringify(body.task)}`);
}));
