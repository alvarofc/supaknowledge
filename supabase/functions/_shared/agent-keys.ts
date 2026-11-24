// Agent API keys: format, secret generation and the small bounded caches auth.ts uses for key exchange.
// Pure helpers (no Supabase client) so they can be unit tested with `deno test`.

/** skn_<agent uuid>_<secret>. The agent id has a fixed length, so `_` inside the secret is unambiguous. */
export const AGENT_KEY_RE = /^skn_([0-9a-f-]{36})_([A-Za-z0-9_-]{32,})$/;

export function agentEmail(agentId: string): string {
  return `agent-${agentId}@agents.supaknowledge.internal`;
}

export function formatAgentKey(agentId: string, secret: string): string {
  return `skn_${agentId}_${secret}`;
}

/** What agents.key_prefix stores: the (non-secret) agent id plus 4 characters of the secret. */
export function keyPrefix(agentId: string, secret: string): string {
  return `skn_${agentId}_${secret.slice(0, 4)}`;
}

/**
 * True when the secret satisfies Supabase Auth's strictest password policy
 * (`lower_upper_letters_digits_symbols`): at least one lowercase, uppercase, digit and symbol.
 */
export function meetsPasswordPolicy(s: string): boolean {
  return /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s) && /[^A-Za-z0-9]/.test(s);
}

function randomBase64Url(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 256-bit random secret in the base64url alphabet ([A-Za-z0-9_-], so keys stay URL/env-safe and match
 * AGENT_KEY_RE) that always contains a lowercase letter, an uppercase letter, a digit and a symbol (`-` or `_`),
 * so `createUser` / `updateUserById` never fail on projects with a strict password policy.
 * Rejection sampling (expected ~1.3 draws) keeps the distribution uniform over the accepted set.
 */
export function newAgentSecret(): string {
  for (let i = 0; i < 64; i++) {
    const s = randomBase64Url(32);
    if (meetsPasswordPolicy(s)) return s;
  }
  // practically unreachable; still return a compliant secret
  const s = randomBase64Url(32);
  return `${s.slice(0, s.length - 4)}aZ9-`;
}

/** Map with a size bound (least recently used evicted first) and per-entry expiry. */
export class LruCache<V> {
  private map = new Map<string, { v: V; exp: number }>();
  constructor(private max: number, private now: () => number = Date.now) {}

  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (e.exp <= this.now()) {
      this.map.delete(k);
      return undefined;
    }
    // refresh recency
    this.map.delete(k);
    this.map.set(k, e);
    return e.v;
  }

  set(k: string, v: V, ttlMs: number): void {
    this.map.delete(k);
    this.map.set(k, { v, exp: this.now() + ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(k: string): void {
    this.map.delete(k);
  }

  get size(): number {
    return this.map.size;
  }
}

/** Coalesce concurrent calls with the same key into one in-flight promise. */
export class SingleFlight<V> {
  private inflight = new Map<string, Promise<V>>();
  run(k: string, fn: () => Promise<V>): Promise<V> {
    const hit = this.inflight.get(k);
    if (hit) return hit;
    const p = fn().finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }
  get size(): number {
    return this.inflight.size;
  }
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
