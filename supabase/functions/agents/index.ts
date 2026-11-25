// Management API for headless agents (Studio / CLI, called with a human user's JWT).
//
// An agent is a Supabase Auth user with app_metadata.kind = 'agent'. Its API key `skn_<agent-id>_<secret>`
// is the Auth password, so RLS applies to everything it does. The database only lets an agent's password change
// when this function authorised it first (kf_allow_agent_password_change, see password.ts); createUser sets
// the first key on insert, which the guard does not cover. Creating, rotating and banning Auth users
// needs the Auth admin API (service role); we only call it after checking, through the CALLER's RLS
// client, that the caller is an owner/admin of the agent's workspace.
//
//   GET    /agents?workspace_id=<uuid>      list agents (RLS: workspace members)
//   GET    /agents/:id                      one agent
//   POST   /agents                          create -> { agent, key }   (key is shown once)
//   POST   /agents/:id/rotate               new key -> { agent, key }
//   POST   /agents/:id/revoke               revoked_at + Auth ban + delete all its sessions (key stops working)
//   POST   /agents/:id/restore              lift the ban
//   DELETE /agents/:id                      delete its sessions and the Auth user (cascades memberships)
//
// Management routes (everything but GET) require a human session: agent keys/JWTs and OAuth-client tokens
// (MCP clients, JWT `client_id` set) are refused, so a token handed to an MCP client can never mint agents.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { agentEmail, authenticate, type Caller, forgetAgent, formatAgentKey, keyPrefix, newAgentSecret } from "../_shared/auth.ts";
import { adminClient } from "../_shared/env.ts";
import { handler, HttpError, json, readJson } from "../_shared/http.ts";
import { auditActor, isUuid, must, subpath } from "../_lib/api.ts";
import { setAgentPassword } from "./password.ts";
import { parseCreateBody } from "./validate.ts";

const BAN_FOREVER = "876000h";

interface AgentRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  key_prefix: string | null;
  created_by: string | null;
  created_at: string;
  last_seen_at: string | null;
  /** set on revoke, cleared on restore (kept in sync with the Auth ban by this function) */
  revoked_at: string | null;
}

const AGENT_COLS = "id, workspace_id, name, description, key_prefix, created_by, created_at, last_seen_at, revoked_at";

async function requireHuman(req: Request): Promise<Caller> {
  const caller = await authenticate(req);
  if (caller.kind !== "human") throw new HttpError(403, "agents cannot manage agents");
  if (caller.clientId !== null) throw new HttpError(403, "OAuth client tokens cannot manage agents; use a Studio / CLI session");
  return caller;
}

/** Public shape of an agent row (never leak unknown future columns). */
function publicAgent(a: AgentRow) {
  return {
    id: a.id, workspace_id: a.workspace_id, name: a.name, description: a.description, key_prefix: a.key_prefix,
    created_by: a.created_by, created_at: a.created_at, last_seen_at: a.last_seen_at,
  };
}

/** RLS check: the caller is owner/admin of the workspace. Must run before any admin-client call. */
async function requireWorkspaceAdmin(caller: Caller, workspaceId: string): Promise<void> {
  const rows = must(
    await caller.db
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", caller.userId)
      .in("role", ["owner", "admin"])
      .limit(1),
    "check workspace role",
  ) as { role: string }[];
  if (!rows.length) throw new HttpError(403, "workspace owner or admin required");
}

/** Load an agent the caller can see (RLS) and check the caller administers its workspace. */
async function loadManagedAgent(caller: Caller, id: string): Promise<AgentRow> {
  if (!isUuid(id)) throw new HttpError(400, "invalid agent id");
  const rows = must(await caller.db.from("agents").select(AGENT_COLS).eq("id", id).limit(1), "load agent") as AgentRow[];
  if (!rows.length) throw new HttpError(404, "agent not found");
  await requireWorkspaceAdmin(caller, rows[0].workspace_id);
  return rows[0];
}

async function audit(workspaceId: string, caller: Caller, action: string, agentId: string, data: Record<string, unknown> = {}) {
  // Admin client: audit_log has no insert policy for users. Only called after requireWorkspaceAdmin().
  const { error } = await adminClient().from("audit_log").insert({
    workspace_id: workspaceId,
    actor_user_id: caller.userId,
    actor: auditActor(caller.userId),
    action,
    target_kind: "agent",
    target_id: agentId,
    data,
  });
  if (error) console.error("audit failed:", error.message);
}

async function withStatus(db: SupabaseClient, agents: AgentRow[]) {
  if (!agents.length) return [];
  const ids = agents.map((a) => a.id);
  // space grants the caller can see (RLS: space readers)
  const grants = (await db.from("space_members").select("space_id, user_id, role").in("user_id", ids)).data ?? [];
  return agents.map((a) => ({
    ...publicAgent(a),
    revoked: !!a.revoked_at && Date.parse(a.revoked_at) <= Date.now(),
    revoked_at: a.revoked_at,
    spaces: grants.filter((g: { user_id: string }) => g.user_id === a.id).map((g: { space_id: string; role: string }) => ({ space_id: g.space_id, role: g.role })),
  }));
}

/**
 * Delete every Auth session + refresh token of an agent (service-role RPC public.kf_revoke_user_sessions), so
 * nothing minted from an old key can be refreshed. Banning or changing the password does not do this in GoTrue.
 * Access tokens already issued stay valid until they expire (JWT exp); auth.ts additionally refuses agent JWTs
 * once agents.revoked_at is set or the agent is deleted, and refuses keys whose prefix no longer matches.
 */
async function revokeSessions(id: string): Promise<number | null> {
  // Admin client: the RPC is service-role only; every caller verified the workspace admin first.
  const { data, error } = await adminClient().rpc("kf_revoke_user_sessions", { p_user: id });
  if (error) {
    console.warn(`could not revoke sessions of agent ${id}:`, error.message);
    return null;
  }
  return data as number;
}

/** agents.revoked_at (not user-writable). */
async function setRevokedAt(id: string, at: string | null): Promise<void> {
  // Admin client: the column is not user-writable; caller verified as workspace admin.
  const { error } = await adminClient().from("agents").update({ revoked_at: at }).eq("id", id);
  if (error) throw new HttpError(500, `could not record the revocation: ${error.message}`);
}

// ---------------------------------------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------------------------------------
async function createAgent(req: Request): Promise<Response> {
  const caller = await requireHuman(req);
  const { workspaceId, name, description, grants } = parseCreateBody(await readJson<unknown>(req));

  // 1. permission + validation through RLS, before touching the admin client
  await requireWorkspaceAdmin(caller, workspaceId);
  if (grants.length) {
    const spaces = must(
      await caller.db.from("spaces").select("id").eq("workspace_id", workspaceId).in("id", grants.map((g) => g.space_id)),
      "check spaces",
    ) as { id: string }[];
    const missing = grants.filter((g) => !spaces.some((s) => s.id === g.space_id));
    if (missing.length) throw new HttpError(400, `space(s) not in this workspace: ${missing.map((m) => m.space_id).join(", ")}`);
  }
  const dup = must(await caller.db.from("agents").select("id").eq("workspace_id", workspaceId).eq("name", name).limit(1), "check name") as unknown[];
  if (dup.length) throw new HttpError(409, `an agent named "${name}" already exists in this workspace`);

  // 2. Auth user. Admin client: creating users needs the Auth admin API; the caller is a workspace admin.
  const admin = adminClient();
  const id = crypto.randomUUID();
  const secret = newAgentSecret();
  const created = await admin.auth.admin.createUser({
    id,
    email: agentEmail(id),
    password: secret,
    email_confirm: true,
    app_metadata: { kind: "agent", workspace_id: workspaceId },
    user_metadata: { display_name: name },
  });
  if (created.error || !created.data.user) throw new HttpError(500, `could not create agent user: ${created.error?.message ?? "unknown error"}`);

  try {
    // 3. agents row. Admin client: there is no insert policy (rows must match an Auth user we created).
    const agent = must(
      await admin
        .from("agents")
        .insert({ id, workspace_id: workspaceId, name, description, key_prefix: keyPrefix(id, secret), created_by: caller.userId })
        .select(AGENT_COLS)
        .single(),
      "create agent",
    ) as AgentRow;

    // 4. memberships. Workspace: admin client (nobody can add other users to a workspace directly, people are
    // invited; an agent is created by a verified workspace admin, step 1). Space grants: the caller's RLS client
    // (space admins manage them).
    must(await admin.from("workspace_members").insert({ workspace_id: workspaceId, user_id: id, role: "member" }), "add workspace member");
    if (grants.length) {
      must(await caller.db.from("space_members").insert(grants.map((g) => ({ space_id: g.space_id, user_id: id, role: g.role }))), "grant spaces");
    }

    await audit(workspaceId, caller, "agent.created", id, { name, spaces: grants });
    const [withMeta] = await withStatus(caller.db, [agent]);
    return json({ agent: { ...withMeta, revoked: false }, key: formatAgentKey(id, secret) }, 201);
  } catch (e) {
    // roll back: deleting the Auth user cascades to agents + memberships
    await admin.auth.admin.deleteUser(id).catch(() => {});
    throw e;
  }
}

async function rotateKey(caller: Caller, id: string): Promise<Response> {
  const agent = await loadManagedAgent(caller, id);
  const secret = newAgentSecret();
  // Admin client: changing a password needs the Auth admin API; caller verified as workspace admin.
  const admin = adminClient();
  // The database refuses agent password changes unless authorised just before (kf_allow_agent_password_change).
  await setAgentPassword(admin, id, secret);
  // key_prefix is what auth.ts checks on every request (cross-worker, ~5 s cache): the old key stops working
  // as soon as this row changes. Admin client: caller verified as workspace admin by loadManagedAgent().
  const updated = must(
    await admin.from("agents").update({ key_prefix: keyPrefix(id, secret) }).eq("id", id).select(AGENT_COLS).single(),
    "update agent",
  ) as AgentRow;
  forgetAgent(id);
  // A password change does not revoke refresh tokens, so sessions minted from the OLD key could keep
  // refreshing: delete them. Already-issued access tokens expire on their own (JWT exp).
  const sessions = await revokeSessions(id);
  await audit(agent.workspace_id, caller, "agent.key_rotated", id, { sessions_revoked: sessions });
  const [withMeta] = await withStatus(caller.db, [updated]);
  return json({ agent: withMeta, key: formatAgentKey(id, secret) });
}

async function setBan(caller: Caller, id: string, revoke: boolean): Promise<Response> {
  const agent = await loadManagedAgent(caller, id);
  // Revoke: record it first (auth.ts refuses the key / agent JWTs once revoked_at is set), ban so no new
  // session can be created, then delete the existing sessions (no refresh possible).
  if (revoke) await setRevokedAt(id, new Date().toISOString());
  // Admin client: banning needs the Auth admin API; caller verified as workspace admin.
  const { error } = await adminClient().auth.admin.updateUserById(id, { ban_duration: revoke ? BAN_FOREVER : "none" });
  if (error) throw new HttpError(500, `could not ${revoke ? "revoke" : "restore"} agent: ${error.message}`);
  const sessions = revoke ? await revokeSessions(id) : null;
  if (!revoke) await setRevokedAt(id, null);
  forgetAgent(id);
  await audit(agent.workspace_id, caller, revoke ? "agent.revoked" : "agent.restored", id, revoke ? { sessions_revoked: sessions } : {});
  const fresh = must(await caller.db.from("agents").select(AGENT_COLS).eq("id", id).limit(1), "load agent") as AgentRow[];
  const [withMeta] = await withStatus(caller.db, fresh.length ? fresh : [agent]);
  return json({ agent: withMeta });
}

async function deleteAgent(caller: Caller, id: string): Promise<Response> {
  const agent = await loadManagedAgent(caller, id);
  await audit(agent.workspace_id, caller, "agent.deleted", id, { name: agent.name });
  // Deleting the Auth user cascades its sessions too; revoke them first anyway so a failed delete still
  // cuts the agent off.
  await setRevokedAt(id, new Date().toISOString());
  await revokeSessions(id);
  // Admin client: deleting Auth users needs the admin API; caller verified as workspace admin.
  const { error } = await adminClient().auth.admin.deleteUser(id);
  if (error) throw new HttpError(500, `could not delete agent: ${error.message}`);
  forgetAgent(id);
  return json({ deleted: id });
}

Deno.serve(handler(async (req) => {
  const path = subpath(req, "agents");
  const parts = path.split("/").filter(Boolean);

  if (req.method === "GET" && parts.length === 0) {
    const caller = await authenticate(req);
    const ws = new URL(req.url).searchParams.get("workspace_id");
    let q = caller.db.from("agents").select(AGENT_COLS).order("name");
    if (ws) {
      if (!isUuid(ws)) throw new HttpError(400, "workspace_id must be a uuid");
      q = q.eq("workspace_id", ws);
    }
    const agents = must(await q.limit(500), "list agents") as AgentRow[];
    return json({ agents: await withStatus(caller.db, agents) });
  }
  if (req.method === "GET" && parts.length === 1) {
    const caller = await authenticate(req);
    if (!isUuid(parts[0])) throw new HttpError(400, "invalid agent id");
    const rows = must(await caller.db.from("agents").select(AGENT_COLS).eq("id", parts[0]).limit(1), "load agent") as AgentRow[];
    if (!rows.length) throw new HttpError(404, "agent not found");
    return json({ agent: (await withStatus(caller.db, rows))[0] });
  }
  if (req.method === "POST" && parts.length === 0) return await createAgent(req);
  if (req.method === "POST" && parts.length === 2) {
    const caller = await requireHuman(req);
    if (parts[1] === "rotate") return await rotateKey(caller, parts[0]);
    if (parts[1] === "revoke") return await setBan(caller, parts[0], true);
    if (parts[1] === "restore") return await setBan(caller, parts[0], false);
  }
  if (req.method === "DELETE" && parts.length === 1) return await deleteAgent(await requireHuman(req), parts[0]);
  throw new HttpError(404, `no route for ${req.method} ${path}`);
}));
