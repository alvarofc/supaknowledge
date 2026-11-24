// Helpers for functions invoked by util.process_queue (cron). Payload:
//   { queue: "kf_embed", jobs: [{ msg_id, read_ct, message }] }
// Ack (delete) on success; leave failures to reappear after the visibility timeout; archive poison
// messages after MAX_READS so they do not loop forever.
import type { SupabaseClient } from "@supabase/supabase-js";

export interface QueueJob<T> {
  msg_id: number;
  read_ct: number;
  message: T;
}

export interface QueueBatch<T> {
  queue: string;
  jobs: QueueJob<T>[];
}

export const MAX_READS = 5;

export async function processBatch<T>(
  db: SupabaseClient,
  batch: QueueBatch<T>,
  work: (msg: T, job: QueueJob<T>) => Promise<void>,
  opts: { concurrency?: number } = {},
): Promise<{ completed: number[]; failed: { msg_id: number; error: string }[]; archived: number[] }> {
  const completed: number[] = [];
  const failed: { msg_id: number; error: string }[] = [];
  const archived: number[] = [];
  const queue = [...batch.jobs];
  const workers = Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try {
        await work(job.message, job);
        completed.push(job.msg_id);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.error(`[${batch.queue}] job ${job.msg_id} failed (read ${job.read_ct}):`, error);
        if (job.read_ct >= MAX_READS) archived.push(job.msg_id);
        else failed.push({ msg_id: job.msg_id, error });
      }
    }
  });
  await Promise.all(workers);
  if (completed.length) {
    const { error } = await db.rpc("kf_queue_ack", { p_queue: batch.queue, p_msg_ids: completed });
    if (error) console.error("ack failed", error.message);
  }
  if (archived.length) {
    const { error } = await db.rpc("kf_queue_archive", { p_queue: batch.queue, p_msg_ids: archived });
    if (error) console.error("archive failed", error.message);
  }
  return { completed, failed, archived };
}
