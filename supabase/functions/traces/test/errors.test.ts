import assert from "node:assert/strict";
import { INVALID_AUDIENCE, mustWrite, sanitizeEvents, traceDbError } from "../errors.ts";

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

Deno.test("Supabase MCP SQL events are sanitised before they are stored", () => {
  const [ok, failed, other] = sanitizeEvents([
    { role: "tool", tool_name: "mcp__supabase__execute_sql", tool_input: { query: "select email from users where id = 42" }, tool_output: { result: '<untrusted-data-x>[{"email":"bob@example.com"}]</untrusted-data-x>' } },
    { role: "tool", tool_name: "supabase_execute_sql", tool_input: { query: "select revenue_usd from orders" }, tool_output: { content: [{ type: "text", text: 'ERROR:  42703: column "revenue_usd" does not exist' }], isError: true } },
    { role: "tool", tool_name: "run_sql", tool_input: { sql: "select 1" }, tool_output: "1" },
  ]);
  assert.deepEqual(ok!.tool_input, { query: "select email from users where id = ?" });
  assert.deepEqual(ok!.tool_output, { omitted: "row data", rows: 1 });
  assert.equal(failed!.is_error, true);
  assert.deepEqual(failed!.tool_output, { error: 'column "revenue_usd" does not exist', sqlstate: "42703" });
  assert.equal(other!.tool_output, "1");
});
