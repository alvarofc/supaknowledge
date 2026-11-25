import assert from "node:assert/strict";
import { HttpError } from "../../_shared/http.ts";
import { type PasswordAdmin, setAgentPassword } from "../password.ts";

const id = "0b6f3c1e-1d2a-4c3b-9a8f-123456789abc";

function fake(rpcError: { message: string; code?: string } | null = null, updateError: { message: string } | null = null) {
  const calls: string[] = [];
  const admin: PasswordAdmin = {
    rpc: (fn, args) => {
      calls.push(`rpc:${fn}:${JSON.stringify(args)}`);
      return Promise.resolve({ error: rpcError });
    },
    auth: {
      admin: {
        updateUserById: (uid, attrs) => {
          calls.push(`update:${uid}:${"password" in attrs}`);
          return Promise.resolve({ error: updateError });
        },
      },
    },
  };
  return { admin, calls };
}

Deno.test("rotation authorises the password change right before the Auth admin update", async () => {
  const { admin, calls } = fake();
  await setAgentPassword(admin, id, "secret");
  assert.deepEqual(calls, [`rpc:kf_allow_agent_password_change:{"p_agent":"${id}"}`, `update:${id}:true`]);
});

Deno.test("no password update when the authorisation fails", async () => {
  const { admin, calls } = fake({ message: "agent not found", code: "P0002" });
  await assert.rejects(setAgentPassword(admin, id, "s"), (e) => e instanceof HttpError && e.status === 404);
  assert.equal(calls.length, 1);
  const f2 = fake({ message: "boom" });
  await assert.rejects(setAgentPassword(f2.admin, id, "s"), (e) => e instanceof HttpError && e.status === 500);
  assert.equal(f2.calls.length, 1);
});

Deno.test("an Auth update failure is a 500", async () => {
  const { admin } = fake(null, { message: "nope" });
  await assert.rejects(setAgentPassword(admin, id, "s"), (e) => e instanceof HttpError && e.status === 500 && /rotate/.test(e.message));
});
