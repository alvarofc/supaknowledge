import assert from "node:assert/strict";
import { INVALID_AUDIENCE, mustWrite, traceDbError } from "../errors.ts";

Deno.test("an invalid audience group (SQLSTATE 22023 from the audience trigger) is a 400 with a clear message", () => {
  const e = traceDbError({ code: "22023", message: "traces.audience names a group that does not exist in this workspace" }, "create trace");
  assert.equal(e.status, 400);
  assert.equal(e.message, `create trace: ${INVALID_AUDIENCE}`);
  assert.throws(
    () => mustWrite({ data: null, error: { code: "22023", message: "traces.audience names a group that does not exist in this workspace" } }, "update trace"),
    (x) => (x as { status: number }).status === 400,
  );
});

Deno.test("other trace write errors keep the shared mapping", () => {
  assert.equal(traceDbError({ code: "22023", message: "something else" }, "x").status, 400);
  assert.equal(traceDbError({ code: "42501", message: "new row violates row-level security policy" }, "x").status, 403);
  assert.equal(traceDbError({ code: "XX000", message: "boom" }, "x").status, 500);
  assert.equal(mustWrite({ data: 1, error: null }, "x"), 1);
});
