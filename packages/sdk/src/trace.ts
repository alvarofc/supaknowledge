// TraceRecorder: buffers what an agent did and ships it to the `traces` Edge Function.
//
// Contract with the host app: recording methods are synchronous and never throw; network work happens in
// flush()/end(), which never reject either. Errors go to `onError`.
import { SupaknowledgeError } from "./http.ts";
import type { FlagInput, FlagResult, TraceEventInput, TraceOutcome } from "./types.ts";

export interface TraceOptions {
  name?: string;
  /** Your id for this run (OTel trace id, LangSmith run id, request id...). Makes re-sends idempotent. */
  externalId?: string;
  metadata?: Record<string, unknown>;
  /** Flush automatically after this many ms of buffered events (0 disables). Default 2000. */
  flushIntervalMs?: number;
  /** Flush as soon as this many events are buffered. Default 50. */
  maxBatch?: number;
  /** Hard cap on buffered events while the server is unreachable; oldest are dropped. Default 1000. */
  maxBuffer?: number;
  /**
   * Backoff after a failed flush: automatic flushes (batch full, interval timer) wait `retryBaseMs * 2^(failures-1)`,
   * capped at `retryMaxMs`, before trying again. Explicit flush() / end() / start() always try. Defaults 1000 / 60000.
   */
  retryBaseMs?: number;
  retryMaxMs?: number;
  onError?: (error: unknown) => void;
}

export interface TraceTransport {
  create(body: Record<string, unknown>): Promise<{ trace_id: string }>;
  update(id: string, body: Record<string, unknown>): Promise<void>;
  flag(input: FlagInput): Promise<FlagResult>;
}

export interface ToolEvent {
  name: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

function retryable(e: unknown): boolean {
  if (!(e instanceof SupaknowledgeError)) return true;
  return e.status === undefined || e.status === 408 || e.status === 429 || e.status >= 500;
}

export class TraceRecorder {
  /** Server-side trace id, known after the first successful flush. */
  id: string | null = null;
  readonly name?: string;
  readonly externalId?: string;

  private buffer: TraceEventInput[] = [];
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ended = false;
  private failures = 0;
  private retryAt = 0;
  private readonly t: TraceTransport;
  private readonly opts: TraceOptions;
  private readonly onError: (e: unknown) => void;

  constructor(transport: TraceTransport, opts: TraceOptions = {}, onError?: (e: unknown) => void) {
    this.t = transport;
    this.opts = opts;
    this.name = opts.name;
    this.externalId = opts.externalId;
    this.onError = (e) => {
      try {
        (opts.onError ?? onError ?? ((err) => console.warn("[supaknowledge] trace:", err)))(e);
      } catch {
        /* never throw into the host app */
      }
    };
  }

  system(content: string, metadata?: Record<string, unknown>): this {
    return this.event({ role: "system", content, metadata });
  }

  user(content: string, metadata?: Record<string, unknown>): this {
    return this.event({ role: "user", content, metadata });
  }

  assistant(content: string, metadata?: Record<string, unknown>): this {
    return this.event({ role: "assistant", content, metadata });
  }

  tool(t: ToolEvent): this {
    return this.event({
      role: "tool",
      tool_name: t.name,
      tool_input: t.input,
      tool_output: t.output,
      is_error: t.isError ?? false,
      metadata: t.metadata,
    });
  }

  /** Human feedback or a correction ("no, use revenue_usd_net"). The curator mines these. */
  feedback(content: string, metadata?: Record<string, unknown>): this {
    return this.event({ role: "feedback", content, metadata });
  }

  event(e: TraceEventInput): this {
    try {
      if (this.ended) {
        this.onError(new SupaknowledgeError("trace already ended; event dropped"));
        return this;
      }
      const ev: TraceEventInput = { ...e, at: e.at ?? new Date().toISOString() };
      for (const k of Object.keys(ev) as (keyof TraceEventInput)[]) if (ev[k] === undefined) delete ev[k];
      this.buffer.push(ev);
      this.trimBuffer();
      // a full batch flushes right away, unless the server just failed: then wait for the backoff (no retry storm)
      if (this.buffer.length >= this.maxBatch() && this.backoffRemaining() === 0) void this.flush();
      else this.schedule();
    } catch (err) {
      this.onError(err);
    }
    return this;
  }

  /** Send buffered events now. Never rejects. */
  flush(): Promise<void> {
    this.clearTimer();
    this.chain = this.chain.then(() => this.doFlush()).catch((e) => this.onError(e));
    return this.chain;
  }

  /** Flush and close the trace. Resolves to the trace id (null if it never reached the server). */
  async end(opts: { outcome?: TraceOutcome; metadata?: Record<string, unknown> } = {}): Promise<string | null> {
    if (this.ended) {
      await this.chain;
      return this.id;
    }
    this.ended = true;
    this.clearTimer();
    this.chain = this.chain
      .then(() => this.doFlush({ outcome: opts.outcome ?? "unknown", ended_at: new Date().toISOString(), ...(opts.metadata ? { metadata: opts.metadata } : {}) }))
      .catch((e) => this.onError(e));
    await this.chain;
    return this.id;
  }

  /** Make sure the trace exists on the server (creating it, even if empty) and resolve to its id. Never rejects. */
  async start(): Promise<string | null> {
    this.clearTimer();
    this.chain = this.chain.then(() => this.doFlush(this.id ? null : {})).catch((e) => this.onError(e));
    await this.chain;
    return this.id;
  }

  /**
   * The server-side trace id, creating the (possibly empty) trace when it does not exist yet, so searches and reads
   * can be attributed to it. Resolves null without a request while the recorder is backing off after failures.
   * Never rejects.
   */
  async ensureId(): Promise<string | null> {
    if (this.id) return this.id;
    if (this.ended || this.backoffRemaining() > 0) return null;
    return this.start();
  }

  /** Raise a flag linked to this trace (creates/flushes it first so the flag carries the trace id). Never rejects. */
  async flag(input: Omit<FlagInput, "traceId">): Promise<FlagResult | null> {
    await this.start();
    try {
      return await this.t.flag({ ...input, traceId: this.id ?? undefined });
    } catch (e) {
      this.onError(e);
      return null;
    }
  }

  private maxBatch(): number {
    return this.opts.maxBatch ?? 50;
  }

  private trimBuffer(): void {
    const max = this.opts.maxBuffer ?? 1000;
    if (this.buffer.length > max) this.buffer.splice(0, this.buffer.length - max);
  }

  /** ms left before automatic flushes may hit the server again (0 when not backing off). */
  private backoffRemaining(): number {
    return this.failures > 0 ? Math.max(0, this.retryAt - Date.now()) : 0;
  }

  private schedule(): void {
    if (this.timer || this.ended) return;
    const interval = this.opts.flushIntervalMs ?? 2000;
    const wait = this.backoffRemaining();
    let ms: number;
    if (wait > 0 && this.buffer.length >= this.maxBatch()) ms = wait; // full batch: retry once the backoff expires
    else if (interval > 0) ms = Math.max(interval, wait);
    else return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
    // do not keep Node / Deno processes alive just for a pending flush
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async doFlush(extra: Record<string, unknown> | null = null): Promise<void> {
    if (this.buffer.length === 0 && !extra) return;
    const events = this.buffer.splice(0, this.buffer.length);
    try {
      if (!this.id) {
        const body: Record<string, unknown> = { events, ...(extra ?? {}) };
        if (this.opts.name) body.name = this.opts.name;
        if (this.opts.externalId) body.external_id = this.opts.externalId;
        if (this.opts.metadata || extra?.metadata) body.metadata = { ...(this.opts.metadata ?? {}), ...((extra?.metadata as object) ?? {}) };
        delete body.ended_at;
        const r = await this.t.create(body);
        if (!r?.trace_id) throw new SupaknowledgeError("traces endpoint returned no trace_id");
        this.id = r.trace_id;
        if (extra?.ended_at) await this.t.update(this.id, { ended_at: extra.ended_at, ...(extra.outcome ? { outcome: extra.outcome } : {}) });
      } else {
        await this.t.update(this.id, { ...(events.length ? { events } : {}), ...(extra ?? {}) });
      }
      this.failures = 0;
    } catch (e) {
      // keep events for the next attempt when the failure is transient (bounded by maxBuffer, oldest dropped) and
      // back off; drop them on 4xx so a bad payload cannot wedge the recorder
      if (retryable(e)) {
        this.failures++;
        const base = this.opts.retryBaseMs ?? 1000;
        // a 429 means nothing was written; wait at least as long as its Retry-After asks
        const asked = e instanceof SupaknowledgeError ? (e.retryAfterMs ?? 0) : 0;
        this.retryAt = Date.now() + Math.min(this.opts.retryMaxMs ?? 60000, Math.max(asked, base * 2 ** Math.min(this.failures - 1, 30)));
        if (!this.ended) {
          this.buffer.unshift(...events);
          this.trimBuffer();
          this.schedule();
        }
      }
      throw e;
    }
  }
}
