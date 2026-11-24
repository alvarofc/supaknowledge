// Who is calling? Every principal is a Supabase Auth user, so access control is always RLS.
//
//   1. Bearer <Supabase JWT>  - a human session, an OAuth 2.1 token issued by Supabase Auth to an MCP
//                               client (carries client_id), or a session an SDK obtained for an agent.
//   2. Bearer skn_<agent>_<secret> - a headless agent API key. The key is the agent's Auth password; we
//                               check it against public.agents (key_prefix / revoked_at), then exchange it
//                               for a short-lived session (cached per worker) so RLS applies.
//                               Revoke an agent with POST /agents/:id/revoke (revoked_at + Auth ban + sessions deleted).
//   3. x-kf-internal: <secret> - cron / queue invocations (see util.invoke_edge_function).
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { AGENT_KEY_RE, agentEmail, keyPrefix, LruCache, sha256Hex, SingleFlight } from "./agent-keys.ts";
import { adminClient, publishableKey, SUPABASE_URL, userClient } from "./env.ts";
import { HttpError } from "./http.ts";

export { AGENT_KEY_RE, agentEmail, formatAgentKey, keyPrefix, newAgentSecret } from "./agent-keys.ts";

export interface Caller {
  userId: string;
  kind: "human" | "agent";
  accessToken: string;
  /** OAuth client that obtained the token, when it came from the OAuth 2.1 server (null otherwise) */
  clientId: string | null;
  /** RLS-scoped client acting as the caller */
  db: SupabaseClient;
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
  verifiedAt: number; // epoch seconds of the last successful sign-in/refresh (a banned agent fails both)
}

// Agent-key exchange: how stale can a warm worker be?
//   * Every request re-checks the agents row (cached AGENT_ROW_TTL_MS): a rotated key (key_prefix changed),
//     a deleted agent or a revoked one (agents.revoked_at) stops the old key within ~15 s on every worker,
//     without a GoTrue sign-in.
//   * The GoTrue session is refreshed every REVERIFY_SECONDS, which is what notices an Auth ban (revoke).
//     Refreshes count against GoTrue's per-IP `token_refresh` limit (150 / 5 min), so this is not per request.
const REVERIFY_SECONDS = 120;
const AGENT_ROW_TTL_MS = 15_000;
const BAD_KEY_TTL_MS = 60_000;
const REVOKED_KEY_TTL_MS = 10_000;
const agentSessions = new LruCache<CachedSession>(500);
const badKeys = new LruCache<string>(5000); // sha256(key) -> reason; stops repeated GoTrue sign-ins for bad keys
const agentRows = new LruCache<AgentRow | null>(1000);
const exchanges = new SingleFlight<CachedSession>();

interface AgentRow {
  id: string;
  key_prefix: string | null;
  revoked_at: string | null;
}

function authClient() {
  return createClient(SUPABASE_URL(), publishableKey(), { auth: { persistSession: false, autoRefreshToken: false } }).auth;
}

/** The agents row for an Auth user (service role, read-only, cached briefly). null = not an agent / deleted. */
async function agentRow(id: string, fresh = false): Promise<AgentRow | null> {
  const hit = fresh ? undefined : agentRows.get(id);
  if (hit !== undefined) return hit;
  // Admin client: the agents row is the source of truth for "this key is current"; read-only, by primary key.
  const admin = adminClient();
  const { data, error } = await admin.from("agents").select("id, key_prefix, revoked_at").eq("id", id).maybeSingle();
  if (error) throw new HttpError(503, "could not verify agent; retry");
  const row = (data as AgentRow | null) ?? null;
  agentRows.set(id, row, AGENT_ROW_TTL_MS);
  return row;
}

function isRevoked(row: AgentRow): boolean {
  return !!row.revoked_at && Date.parse(row.revoked_at) <= Date.now();
}

/** The presented key must belong to a live agent whose current key starts like this one. */
/** "ok", "revoked" (may be restored later: not negatively cached) or "unknown" (no such agent / not its key). */
async function checkAgentKey(agentId: string, secret: string): Promise<"ok" | "revoked" | "unknown"> {
  const verdict = (row: AgentRow | null) =>
    !row || row.key_prefix !== keyPrefix(agentId, secret) ? "unknown" : isRevoked(row) ? "revoked" : "ok";
  const first = verdict(await agentRow(agentId));
  if (first === "ok") return first;
  // the cached row may be a few seconds old (key rotated / agent restored a moment ago): re-read once
  return verdict(await agentRow(agentId, true));
}

// deno-lint-ignore no-explicit-any
function isAgentUser(user: any, agentId: string): boolean {
  return !!user && user.id === agentId && user.app_metadata?.kind === "agent";
}

function transient(error: { status?: number } | null): boolean {
  const s = error?.status;
  return s === undefined || s === 0 || s === 429 || s >= 500;
}

async function exchangeAgentKey(key: string): Promise<CachedSession> {
  const m = AGENT_KEY_RE.exec(key);
  if (!m) throw new HttpError(401, "malformed agent key");
  const [, agentId, secret] = m as unknown as [string, string, string];
  const cacheKey = await sha256Hex(key);
  if (badKeys.get(cacheKey)) throw new HttpError(401, "invalid or revoked agent key");

  // cheap DB check first: rotated / deleted / revoked keys and keys for unknown agents never reach GoTrue
  const verdict = await checkAgentKey(agentId, secret);
  if (verdict !== "ok") {
    agentSessions.delete(cacheKey);
    // revoked agents can be restored: remember that only briefly
    badKeys.set(cacheKey, verdict, verdict === "unknown" ? BAD_KEY_TTL_MS : REVOKED_KEY_TTL_MS);
    throw new HttpError(401, "invalid or revoked agent key");
  }

  const now = Math.floor(Date.now() / 1000);
  const cached = agentSessions.get(cacheKey);
  if (cached && cached.expiresAt - 60 > now && cached.verifiedAt + REVERIFY_SECONDS > now) return cached;

  // one GoTrue round-trip per key per worker at a time (refresh tokens are single-use)
  return await exchanges.run(cacheKey, async () => {
    const again = agentSessions.get(cacheKey);
    const t = Math.floor(Date.now() / 1000);
    if (again && again.expiresAt - 60 > t && again.verifiedAt + REVERIFY_SECONDS > t) return again;
    const auth = authClient();
    const keep = (s: CachedSession) => {
      agentSessions.set(cacheKey, s, Math.max(1, s.expiresAt - t) * 1000);
      return s;
    };

    if (again) {
      const { data, error } = await auth.refreshSession({ refresh_token: again.refreshToken });
      if (!error && data.session && isAgentUser(data.user, agentId)) {
        return keep({ accessToken: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt: data.session.expires_at ?? t + 3000, userId: data.user!.id, verifiedAt: t });
      }
      if (error && transient(error) && again.expiresAt - 60 > t) {
        // GoTrue busy / rate limited: keep the still-valid token a little longer instead of failing the agent
        return keep({ ...again, verifiedAt: t - REVERIFY_SECONDS + 15 });
      }
      agentSessions.delete(cacheKey); // banned / rotated / wrong user: fall through to a fresh sign-in
    }

    const { data, error } = await auth.signInWithPassword({ email: agentEmail(agentId), password: secret });
    if (error && transient(error)) throw new HttpError(503, "agent sign-in temporarily unavailable; retry");
    if (error || !data.session || !isAgentUser(data.user, agentId)) {
      badKeys.set(cacheKey, "rejected", BAD_KEY_TTL_MS);
      throw new HttpError(401, "invalid or revoked agent key");
    }
    const s = keep({ accessToken: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt: data.session.expires_at ?? t + 3000, userId: data.user!.id, verifiedAt: t });
    // best effort bookkeeping
    adminClient().from("agents").update({ last_seen_at: new Date().toISOString() }).eq("id", s.userId).then(() => {}, () => {});
    return s;
  });
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
  const kind = claims.app_metadata?.kind === "agent" ? "agent" : "human";
  if (kind === "agent") {
    // A JWT an agent minted itself (e.g. via /auth/v1/token with its key) is valid until it expires; at least
    // refuse it once the agent is deleted or revoked.
    const row = await agentRow(claims.sub);
    if (!row || isRevoked(row)) throw new HttpError(401, "agent is revoked or deleted");
  }
  return {
    userId: claims.sub,
    kind,
    accessToken: token,
    clientId: typeof claims.client_id === "string" && claims.client_id ? claims.client_id : null,
    db,
  };
}

/** Drop this worker's cached state for an agent (after rotate / revoke / delete in the same worker). */
export function forgetAgent(agentId: string): void {
  agentRows.delete(agentId);
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
