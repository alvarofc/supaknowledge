// Per-person limits for the Ask page, kept in this server process's memory: at most `perMinute` questions in any
// 60-second window, and one question at a time. Several Studio instances each keep their own counts.

export interface RateLimitOptions {
  perMinute: number;
  now?: () => number;
}

export type Acquired = { ok: true; release: () => void } | { ok: false; message: string; retryAfterSeconds: number };

export class AskRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly busy = new Set<string>();
  private readonly perMinute: number;
  private readonly now: () => number;

  constructor(opts: RateLimitOptions) {
    this.perMinute = Math.max(1, Math.floor(opts.perMinute));
    this.now = opts.now ?? Date.now;
  }

  /** Take a slot for `key` (a user id). Call `release()` when the answer is finished. */
  acquire(key: string): Acquired {
    const now = this.now();
    if (this.busy.has(key)) {
      return { ok: false, message: "Wait for the current answer to finish before asking again.", retryAfterSeconds: 1 };
    }
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= this.perMinute) {
      const retryAfterSeconds = Math.max(1, Math.ceil((recent[0] + 60_000 - now) / 1000));
      this.hits.set(key, recent);
      return { ok: false, message: `You can ask ${this.perMinute} questions per minute. Try again in ${retryAfterSeconds} s.`, retryAfterSeconds };
    }
    recent.push(now);
    this.hits.set(key, recent);
    this.busy.add(key);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.busy.delete(key);
      },
    };
  }

  /** Forget windows that have expired (keeps the map from growing with every person who ever asked). */
  sweep(): void {
    const now = this.now();
    for (const [k, v] of this.hits) if (!this.busy.has(k) && v.every((t) => now - t >= 60_000)) this.hits.delete(k);
  }
}

/** KF_ASK_MESSAGES_PER_MINUTE, default 10; anything that is not a positive integer falls back to the default. */
export function perMinuteFromEnv(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 10;
}
