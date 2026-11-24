// Curator worker (queue-driven). Two entry points:
//
//   POST /curator          internal (cron via util.process_queue('kf_curator','curator',1,3,400)), x-kf-internal
//                          body { queue, jobs: [{ msg_id, read_ct, message: { task_id, run_id, space_id } }] }
//   POST /curator/run      a human (reviewer+) asks for a run now: { space } -> { run }
//
// Each queue message is one curator task (gather | triage | draft | sweep). The engine (core runTask) records
// attempts and failures on the task itself; we ack on success and let failures reappear after the
// visibility timeout until the task is marked failed. A message delivered more often than MAX_TASK_ATTEMPTS
// (the worker was killed mid-task, e.g. by the platform wall-clock limit, so no attempt was recorded) fails
// the task for good BEFORE any model is called: a killed task never loops and never burns tokens again.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { LLMConfigError, MastraLLM, llmConfigFromEnv } from "../_shared/core/index.ts";
import { type CuratorTask, MAX_TASK_ATTEMPTS, runTask, SupabaseCuratorStore } from "../_shared/core/curator/index.ts";
import { authenticate, requireInternal } from "../_shared/auth.ts";
import { adminClient } from "../_shared/env.ts";
import { embed } from "../_shared/embed.ts";
import { handler, HttpError, json, readJson } from "../_shared/http.ts";
import { processBatch, type QueueBatch, type QueueJob } from "../_shared/queue.ts";
import { dbError, resolveSpace, subpath } from "../_lib/api.ts";

interface CuratorMessage {
  task_id: string;
  run_id: string;
  space_id: string;
}

/**
 * Wall-clock budget per task. Supabase's Edge Function limit is 150 s on the free plan (400 s on paid plans);
 * the engine aborts model calls when the budget runs out and keeps a reserve to record the result.
 * Override with KF_CURATOR_TASK_BUDGET_MS (e.g. 300000 on a paid plan).
 */
const BUDGET_MS = Math.min(Math.max(Number(Deno.env.get("KF_CURATOR_TASK_BUDGET_MS") ?? "") || 110_000, 30_000), 380_000);
const DONE = ["succeeded", "failed", "cancelled"];

// Admin client: this is an internal worker (requireInternal) and the curator must see all evidence;
// access is preserved by the engine recording audiences and by the DB escalation guard on proposals.
const db = adminClient();
const store = new SupabaseCuratorStore(db, embed);

/** Fail a task permanently (no retries) and close its run if nothing else is outstanding (kf_maybe_finish_run). */
async function failPermanently(task: { id: string; run_id: string }, error: string) {
  await store.failTask(task.id, error, { permanent: true });
  await store.maybeFinishRun(task.run_id);
}

async function work(msg: CuratorMessage, job: QueueJob<CuratorMessage>) {
  const { data: row, error } = await db
    .from("curator_tasks")
    .select("id, run_id, space_id, step, input, attempts, status")
    .eq("id", msg.task_id)
    .maybeSingle();
  if (error) throw new Error(`load task: ${error.message}`);
  if (!row) return; // run deleted since enqueue: ack
  if (DONE.includes(row.status)) return; // already handled (duplicate delivery): ack

  const run = await db.from("curator_runs").select("status").eq("id", row.run_id).maybeSingle();
  if (run.error) throw new Error(`load run: ${run.error.message}`);
  if (!run.data || ["cancelled", "failed", "succeeded"].includes(run.data.status)) {
    // cancelled (cancel_curator_run), reaped as stuck, or already closed: nothing to do for this task
    await db.from("curator_tasks").update({ status: "cancelled", finished_at: new Date().toISOString() }).eq("id", row.id).in("status", ["queued", "running"]);
    return;
  }

  // Delivered more times than a task may be attempted: earlier deliveries died without recording a failure
  // (wall-clock kill, crash before runTask). Fail it now, before spending anything on a model.
  if (job.read_ct > MAX_TASK_ATTEMPTS) {
    await failPermanently(row, `task was delivered ${job.read_ct} times without finishing (likely killed by the Edge Function time limit); giving up`);
    return;
  }

  // Any model through Mastra: your OpenAI-compatible endpoint (KF_LLM_BASE_URL), Vercel AI Gateway
  // (AI_GATEWAY_API_KEY + vercel/... ids), OpenRouter, ... Space settings may override model ids only.
  const settings = await store.getSettings(row.space_id);
  let llm: MastraLLM;
  try {
    llm = new MastraLLM(llmConfigFromEnv((n) => Deno.env.get(n), {
      model: settings.curator.model,
      fastModel: settings.curator.fast_model,
      fallbackModels: settings.curator.fallback_models,
    }));
  } catch (e) {
    if (!(e instanceof LLMConfigError)) throw e;
    await failPermanently(row, `${e.message}. Local: set it in supabase/.env and restart the stack; hosted: supabase secrets set ... (see docs/curator.md).`);
    return; // ack: retrying cannot succeed
  }

  const mark = await db.from("curator_tasks").update({ status: "running" }).eq("id", row.id);
  if (mark.error) throw new Error(`mark running: ${mark.error.message}`);

  const task: CuratorTask = { id: row.id, run_id: row.run_id, space_id: row.space_id, step: row.step, input: row.input ?? {}, attempts: row.attempts };
  // runTask records success/failure + attempts on the task and closes the run when it was the last one.
  // It rethrows on failure, so processBatch leaves the message for a retry after the visibility timeout.
  await runTask({
    store,
    llm,
    budgetMs: BUDGET_MS,
    log: (m, d) => console.log(`[curator] ${m}`, d ? JSON.stringify(d) : ""),
  }, task);
}

Deno.serve(handler(async (req) => {
  const path = subpath(req, "curator");

  if (req.method === "POST" && path === "/run") {
    const caller = await authenticate(req);
    const body = await readJson<{ space?: string }>(req);
    const space = await resolveSpace(caller.db, body.space);
    // as the caller: the RPC requires reviewer+ on the space
    const { data, error } = await caller.db.rpc("request_curator_run", { p_space: space.id });
    if (error) throw dbError(error, "request_curator_run");
    return json({ run: data, space: { id: space.id, ref: space.ref } }, 202);
  }

  if (req.method === "POST" && (path === "/" || path === "/process")) {
    requireInternal(req);
    const batch = await readJson<QueueBatch<CuratorMessage>>(req);
    if (!batch || !Array.isArray(batch.jobs)) throw new HttpError(400, "expected { queue, jobs: [...] }");
    const result = await processBatch(db, batch, (m, job) => work(m, job), { concurrency: 1 });
    return json(result, 200, { "x-completed-jobs": String(result.completed.length), "x-failed-jobs": String(result.failed.length) });
  }

  throw new HttpError(404, `no route for ${req.method} ${path}`);
}));
