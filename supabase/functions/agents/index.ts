// Management API for headless agents (Studio / CLI, called with a human user's JWT).
//
// An agent is a Supabase Auth user with app_metadata.kind = 'agent'. Its API key `skn_<agent-id>_<secret>`
// is the Auth password, so RLS applies to everything it does. Creating, rotating and banning Auth users
// needs the Auth admin API (service role); we only call it after checking, through the CALLER's RLS
// client, that the caller is an owner/admin of the agent's workspace.
//
//   GET    /agents?workspace_id=<uuid>      list agents (RLS: workspace members)
//   GET    /agents/:id                      one agent
//   POST   /agents                          create -> { agent, key }   (key is shown once)
//   POST   /agents/:id/rotate               new key -> { agent, key }
//   POST   /agents/:id/revoke               ban the Auth user (key stops working)
//   POST   /agents/:id/restore              lift the ban
//   DELETE /agents/:id                      delete the Auth user (cascades memberships)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { agentEmail, authenticate, type Caller, formatAgentKey, newAgentSecret } from "../_shared/auth.ts";
import { adminClient, publishableKey, SUPABASE_URL } from "../_shared/env.ts";
import { handler, HttpError, json, readJson } from "../_shared/http.ts";
import { auditActor, isUuid, must, subpath } from "../_lib/api.ts";

type SpaceRole = "reader" | "editor" | "reviewer";
const GRANTABLE: SpaceRole[] = ["reader", "editor", "reviewer"];
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
}

const AGENT_COLS = "id, workspace_id, name, description, key_prefix, created_by, created_at, last_seen_at";

function keyPrefix(agentId: string, secret: string): string {
  // the agent id is not secret; 4 chars of the secret help tell keys apart after a rotation
  return `skn_${agentId}_${secret.slice(0, 4)}`;
}

async function requireHuman(req: Request): Promise<Caller> {
  const caller = await authenticate(req);
  if (caller.kind !== "human") throw new HttpError(403, "agents cannot manage agents");
  return caller;
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
  // Admin client, read-only: ban state lives in auth.users. The agents were already filtered by RLS to
  // ones the caller may see, and we only expose a boolean.
  const admin = adminClient();
  const banned = await Promise.all(agents.map(async (a) => {
    const { data } = await admin.auth.admin.getUserById(a.id);
    const until = (data?.user as { banned_until?: string | null } | undefined)?.banned_until;
    return !!until && Date.parse(until) > Date.now();
  }));
  return agents.map((a, i) => ({
    ...a,
    revoked: banned[i],
    spaces: grants.filter((g: { user_id: string }) => g.user_id === a.id).map((g: { space_id: string; role: string }) => ({ space_id: g.space_id, role: g.role })),
  }));
}

// ---------------------------------------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------------------------------------
interface CreateBody {
  workspace_id?: string;
  name?: string;
  description?: string | null;
  spaces?: { space_id: string; role?: string }[];
}

async function createAgent(req: Request): Promise<Response> {
  const caller = await requireHuman(req);
  const body = await readJson<CreateBody>(req);
  const workspaceId = body.workspace_id;
  const name = body.name?.trim();
  if (!isUuid(workspaceId)) throw new HttpError(400, "workspace_id (uuid) is required");
  if (!name || name.length > 100) throw new HttpError(400, "name is required (max 100 characters)");
  if (body.description != null && typeof body.description !== "string") throw new HttpError(400, "description must be a string");
  const grants = (body.spaces ?? []).map((s) => ({ space_id: s.space_id, role: (s.role ?? "reader") as SpaceRole }));
  if (!Array.isArray(body.spaces ?? [])) throw new HttpError(400, "spaces must be an array");
  for (const g of grants) {
    if (!isUuid(g.space_id)) throw new HttpError(400, "spaces[].space_id must be a uuid");
    if (!GRANTABLE.includes(g.role)) throw new HttpError(400, `spaces[].role must be one of ${GRANTABLE.join(", ")} (agents never get admin)`);
  }

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
        .insert({ id, workspace_id: workspaceId, name, description: body.description ?? null, key_prefix: keyPrefix(id, secret), created_by: caller.userId })
        .select(AGENT_COLS)
        .single(),
      "create agent",
    ) as AgentRow;

    // 4. memberships through the caller's RLS client (workspace/space admins manage them)
    must(await caller.db.from("workspace_members").insert({ workspace_id: workspaceId, user_id: id, role: "member" }), "add workspace member");
    if (grants.length) {
      must(await caller.db.from("space_members").insert(grants.map((g) => ({ space_id: g.space_id, user_id: id, role: g.role }))), "grant spaces");
    }

    await audit(workspaceId, caller, "agent.created", id, { name, spaces: grants });
    const [withMeta] = await withStatus(caller.db, [agent]);
    return json({ agent: withMeta, key: formatAgentKey(id, secret) }, 201);
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
  const { error } = await admin.auth.admin.updateUserById(id, { password: secret });
  if (error) throw new HttpError(500, `could not rotate key: ${error.message}`);
  // A password change does not revoke refresh tokens, so sessions minted from the OLD key (e.g. cached by
  // auth.ts in a warm worker) could keep refreshing. Sign in once with the new key and sign out globally,
  // which revokes every refresh token of the agent. Already-issued access tokens expire on their own (JWT exp).
  const anon = createClient(SUPABASE_URL(), publishableKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const s = await anon.auth.signInWithPassword({ email: agentEmail(id), password: secret });
  if (s.data.session) {
    const out = await admin.auth.admin.signOut(s.data.session.access_token, "global");
    if (out.error) console.warn("revoke old sessions failed:", out.error.message);
  } else if (s.error && !/banned/i.test(s.error.message)) {
    console.warn("could not revoke old sessions:", s.error.message);
  }
  const updated = must(
    await caller.db.from("agents").update({ key_prefix: keyPrefix(id, secret) }).eq("id", id).select(AGENT_COLS).single(),
    "update agent",
  ) as AgentRow;
  await audit(agent.workspace_id, caller, "agent.key_rotated", id);
  const [withMeta] = await withStatus(caller.db, [updated]);
  return json({ agent: withMeta, key: formatAgentKey(id, secret) });
}

async function setBan(caller: Caller, id: string, revoke: boolean): Promise<Response> {
  const agent = await loadManagedAgent(caller, id);
  // Admin client: banning needs the Auth admin API; caller verified as workspace admin.
  const { error } = await adminClient().auth.admin.updateUserById(id, { ban_duration: revoke ? BAN_FOREVER : "none" });
  if (error) throw new HttpError(500, `could not ${revoke ? "revoke" : "restore"} agent: ${error.message}`);
  await audit(agent.workspace_id, caller, revoke ? "agent.revoked" : "agent.restored", id);
  const [withMeta] = await withStatus(caller.db, [agent]);
  return json({ agent: withMeta });
}

async function deleteAgent(caller: Caller, id: string): Promise<Response> {
  const agent = await loadManagedAgent(caller, id);
  await audit(agent.workspace_id, caller, "agent.deleted", id, { name: agent.name });
  // Admin client: deleting Auth users needs the admin API; caller verified as workspace admin.
  const { error } = await adminClient().auth.admin.deleteUser(id);
  if (error) throw new HttpError(500, `could not delete agent: ${error.message}`);
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
