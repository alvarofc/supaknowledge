import assert from "node:assert/strict";
import { errorResponse, HttpError } from "../http.ts";

async function body(r: Response): Promise<{ error: string; request_id?: string }> {
  return await r.json();
}

Deno.test("errorResponse: client and transient errors keep their message", async () => {
  const r = errorResponse(new HttpError(403, "workspace owner or admin required"));
  assert.deepEqual(r.status, 403);
  assert.deepEqual((await body(r)).error, "workspace owner or admin required");
  const t = errorResponse(new HttpError(503, "could not verify agent; retry", { "Retry-After": "1" }));
  assert.deepEqual([t.status, t.headers.get("Retry-After")], [503, "1"]);
  assert.deepEqual((await body(t)).error, "could not verify agent; retry");
});

Deno.test("errorResponse: internal errors never echo diagnostics, only a request id", async () => {
  const quiet = console.error;
  const logged: unknown[][] = [];
  console.error = (...a: unknown[]) => void logged.push(a);
  try {
    for (const e of [new Error('relation "private.secret_table" does not exist'), new HttpError(500, "upload x: duplicate key value violates unique constraint"), "boom"]) {
      const r = errorResponse(e);
      assert.deepEqual(r.status, 500);
      const b = await body(r);
      assert(b.request_id && b.error === `internal error (request id ${b.request_id})`, b.error);
      assert(String(logged.at(-1)?.[0]).includes(b.request_id), "the log line carries the request id");
      assert.deepEqual(logged.at(-1)?.[1], e);
    }
  } finally {
    console.error = quiet;
  }
});
