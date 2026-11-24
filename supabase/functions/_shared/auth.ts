// Who is calling? Every principal is a Supabase Auth user, so access control is always RLS.
//
//   1. Bearer <Supabase JWT>  - a human session, an OAuth 2.1 token issued by Supabase Auth to an MCP
//                               client (carries client_id), or a session an SDK obtained for an agent.
//   2. Bearer skn_<agent>_<secret> - a headless agent API key. The key is the agent's Auth password; we
//                               exchange it for a short-lived session (cached per worker) so RLS applies.
//                               Revoke an agent by banning or deleting its Auth user.
//   3. x-kf-internal: <secret> - cron / queue invocations (see util.invoke_edge_function).
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { adminClient, publishableKey, SUPABASE_URL, userClient } from "./env.ts";
import { HttpError } from "./http.ts";

export interface Caller {
  userId: string;
  kind: "human" | "agent";
  accessToken: string;
  /** OAuth client that obtained the token, when it came from the OAuth 2.1 server */
  clientId: string | null;
  /** RLS-scoped client acting as the caller */
  db: SupabaseClient;
}

export const AGENT_KEY_RE = /^skn_([0-9a-f-]{36})_([A-Za-z0-9_-]{32,})$/;

export function agentEmail(agentId: string): string {
  return `agent-${agentId}@agents.supaknowledge.internal`;
}

export function newAgentSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function formatAgentKey(agentId: string, secret: string): string {
  return `skn_${agentId}_${secret}`;
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() ?? null;
}

interface CachedSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch seconds
  userId: string;
  verifiedAt: number; // epoch seconds of the last sign-in/refresh (a banned agent fails both)
}

/** Re-check cached agent sessions this often so revoking an agent takes effect within minutes. */
const REVERIFY_SECONDS = 300;
const agentSessions = new Map<string, CachedSession>();

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function exchangeAgentKey(key: string): Promise<CachedSession> {
  const m = AGENT_KEY_RE.exec(key);
  if (!m) throw new HttpError(401, "malformed agent key");
  const [, agentId, secret] = m as unknown as [string, string, string];
  const cacheKey = await sha256(key);
  const cached = agentSessions.get(cacheKey);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt - 60 > now && cached.verifiedAt + REVERIFY_SECONDS > now) return cached;

  const auth = createClient(SUPABASE_URL(), publishableKey(), { auth: { persistSession: false, autoRefreshToken: false } }).auth;
  if (cached) {
    const { data, error } = await auth.refreshSession({ refresh_token: cached.refreshToken });
    if (error) agentSessions.delete(cacheKey); // banned / rotated: fall through to a fresh sign-in
    if (!error && data.session) {
      const s = { accessToken: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt: data.session.expires_at ?? now + 3000, userId: agentId, verifiedAt: now };
      agentSessions.set(cacheKey, s);
      return s;
    }
  }
  const { data, error } = await auth.signInWithPassword({ email: agentEmail(agentId), password: secret });
  if (error || !data.session) throw new HttpError(401, "invalid or revoked agent key");
  const s = { accessToken: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt: data.session.expires_at ?? now + 3000, userId: data.user!.id, verifiedAt: now };
  agentSessions.set(cacheKey, s);
  // best effort bookkeeping
  adminClient().from("agents").update({ last_seen_at: new Date().toISOString() }).eq("id", s.userId).then(() => {}, () => {});
  return s;
}

/** Authenticate a request as a user or agent. Throws HttpError(401) otherwise. */
export async function authenticate(req: Request): Promise<Caller> {
  const token = bearer(req);
  if (!token) throw new HttpError(401, "missing bearer token");

  if (token.startsWith("skn_")) {
    const s = await exchangeAgentKey(token);
    return { userId: s.userId, kind: "agent", accessToken: s.accessToken, clientId: null, db: userClient(s.accessToken) };
  }

  const db = userClient(token);
  const { data, error } = await db.auth.getClaims(token);
  if (error || !data?.claims?.sub) throw new HttpError(401, "invalid or expired token");
  const claims = data.claims as Record<string, unknown> & { sub: string; app_metadata?: { kind?: string } };
  if (claims.role !== "authenticated") throw new HttpError(401, "a user token is required");
  return {
    userId: claims.sub,
    kind: claims.app_metadata?.kind === "agent" ? "agent" : "human",
    accessToken: token,
    clientId: typeof claims.client_id === "string" ? claims.client_id : null,
    db,
  };
}

/** Cron / queue calls: constant-time compare of the shared internal secret. */
export function requireInternal(req: Request): void {
  const expected = Deno.env.get("KF_INTERNAL_SECRET");
  const got = req.headers.get("x-kf-internal");
  if (!expected || !got) throw new HttpError(401, "internal secret required");
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(got);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  if (diff !== 0) throw new HttpError(401, "invalid internal secret");
}
