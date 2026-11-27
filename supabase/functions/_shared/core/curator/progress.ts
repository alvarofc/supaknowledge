// Live progress of curator tasks. The engine reports what it is doing through an optional sink (CuratorDeps.progress);
// without one nothing is emitted, so Node, tests and the offline demo run exactly as before.
//
// Events go to everyone who may watch the space's curator (Studio: editors and up, through a private Realtime channel),
// which is a wider audience than the evidence a task reads. So events carry ids of curator rows, counts and timings
// only: never evidence text, titles, concept paths, cluster topics, model output or error messages. Studio resolves a
// proposal id to its title through RLS, so a viewer who cannot see the proposal never learns its title.
//
// Type-only imports: Studio imports this module (through `@supaknowledge/core/progress`) and must not pull in the engine.
import type { CuratorTask } from "./store.ts";

/** What a model call is for. */
export type ModelPurpose = "mine" | "triage" | "draft" | "repair" | "review";

export type ProposalOpKind = "create" | "update" | "deprecate" | "move";

export type CuratorProgressEvent =
  /** a worker picked the task up (`attempt` counts from 1) */
  | { type: "task_started"; attempt: number }
  /** what the task is working from, as counts (keys depend on the step: traces, flags, documents, concepts...) */
  | { type: "evidence"; counts: Record<string, number> }
  | { type: "model_call_started"; purpose: ModelPurpose }
  | { type: "model_call_finished"; purpose: ModelPurpose; ok: boolean; ms: number; tokens: number }
  /** gather: traces scanned and lessons mined into synthetic flags */
  | { type: "lessons"; traces_scanned: number; traces_mined: number; lessons: number }
  /** triage: drafts queued, clusters left for the next run, flags dismissed */
  | { type: "clusters"; clusters: number; deferred: number; dismissed: number }
  /** staleness sweep: concepts queued for re-validation */
  | { type: "stale"; concepts: number }
  /** the checked changeset: ops by kind, citations, problems the check found */
  | { type: "draft_ops"; ops: Partial<Record<ProposalOpKind, number>>; citations: number; problems: number }
  | { type: "self_review"; ok: boolean; issues: number; blockers: number; skipped: boolean }
  | { type: "no_change"; dismissed: number }
  /** the draft had no valid op left after the check */
  | { type: "draft_invalid"; problems: number }
  | { type: "proposal_created"; proposal_id: string }
  | { type: "proposal_applied"; proposal_id: string }
  | { type: "task_finished" }
  /** `final`: no retry will follow (a retryable failure is redelivered by the queue) */
  | { type: "task_failed"; final: boolean };

export interface ProgressEnvelope {
  v: 1;
  /** order within one task attempt, from 1 */
  seq: number;
  at: string;
  run_id: string;
  task_id: string;
  step: string;
}

export type CuratorProgress = CuratorProgressEvent & ProgressEnvelope;

/** Receives progress events. It may be async; failures are ignored and never slow the engine down. */
export type ProgressSink = (event: CuratorProgress) => void | Promise<unknown>;

export type Emit = (event: CuratorProgressEvent) => void;

/**
 * An emitter for one task: adds the envelope, never throws, never waits for the sink. Without a sink it is a no-op.
 */
export function progressEmitter(sink: ProgressSink | undefined, task: Pick<CuratorTask, "id" | "run_id" | "step">, now: () => Date = () => new Date()): Emit {
  if (!sink) return () => {};
  let seq = 0;
  return (event) => {
    try {
      const out = sink({ ...event, v: 1, seq: ++seq, at: now().toISOString(), run_id: task.run_id, task_id: task.id, step: task.step } as CuratorProgress);
      if (out && typeof (out as Promise<unknown>).catch === "function") (out as Promise<unknown>).catch(() => {});
    } catch {
      // progress is best effort
    }
  };
}

/** The part of a Supabase client the Realtime sink needs. */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
}

/** events per kf_curator_progress call (the function refuses more) */
const BATCH = 50;
/** events kept while the database is slow; older ones are dropped first */
const MAX_PENDING = 500;

export interface FlushableSink extends ProgressSink {
  /** wait (at most `timeoutMs`) until every event handed over so far was sent */
  flush(timeoutMs?: number): Promise<void>;
}

/**
 * Sends progress to Realtime Broadcast through `kf_curator_progress()` (service role), which calls `realtime.send()`
 * on the private topic `curator:<space id>`. Events are sent in order, one call at a time, batching whatever piled
 * up while the previous call was in flight. Errors are logged and dropped.
 */
export function rpcProgressSink(db: RpcClient, spaceId: string, log?: (msg: string, data?: Record<string, unknown>) => void): FlushableSink {
  const pending: CuratorProgress[] = [];
  let chain: Promise<void> = Promise.resolve();
  let scheduled = false;
  let dropped = 0;

  const drain = async () => {
    while (pending.length) {
      const batch = pending.splice(0, BATCH);
      try {
        const { error } = await db.rpc("kf_curator_progress", { p_space: spaceId, p_events: batch });
        if (error) log?.("curator progress not sent", { error: error.message, events: batch.length });
      } catch (e) {
        log?.("curator progress not sent", { error: (e as Error).message, events: batch.length });
      }
    }
    scheduled = false;
    if (dropped) {
      log?.("curator progress dropped", { events: dropped });
      dropped = 0;
    }
  };

  const sink = ((event: CuratorProgress) => {
    pending.push(event);
    if (pending.length > MAX_PENDING) {
      pending.shift();
      dropped++;
    }
    if (!scheduled) {
      scheduled = true;
      chain = chain.then(drain);
    }
  }) as FlushableSink;

  sink.flush = async (timeoutMs = 3_000) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([chain, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
    clearTimeout(timer);
  };
  return sink;
}
