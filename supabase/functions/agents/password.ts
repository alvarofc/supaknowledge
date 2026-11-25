// Agent passwords are agent keys. The database refuses any password change of an agent user unless the service
// role authorised exactly one change right before it (public.kf_allow_agent_password_change, migration
// 20261125000021_round2.sql): an agent's own session cannot change its key with PUT /auth/v1/user.
import { HttpError } from "../_shared/http.ts";

/** The two Auth/RPC calls we need from an admin (service-role) client, typed loosely so tests can fake them. */
export interface PasswordAdmin {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: { message: string; code?: string } | null }>;
  auth: {
    admin: {
      updateUserById(id: string, attrs: { password: string }): PromiseLike<{ error: { message: string } | null }>;
    };
  };
}

/** Authorise one password change for the agent, then set it through the Auth admin API. */
export async function setAgentPassword(admin: PasswordAdmin, agentId: string, password: string): Promise<void> {
  const allow = await admin.rpc("kf_allow_agent_password_change", { p_agent: agentId });
  if (allow.error) {
    if (allow.error.code === "P0002") throw new HttpError(404, "agent not found");
    throw new HttpError(500, `could not authorise the key change: ${allow.error.message}`);
  }
  const { error } = await admin.auth.admin.updateUserById(agentId, { password });
  if (error) throw new HttpError(500, `could not rotate key: ${error.message}`);
}
