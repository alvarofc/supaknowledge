import assert from "node:assert/strict";
import { HttpError } from "../../_shared/http.ts";
import { parseCreateBody } from "../validate.ts";

const ws = "0b6f3c1e-1d2a-4c3b-9a8f-123456789abc";
const sp = "1b6f3c1e-1d2a-4c3b-9a8f-123456789abc";

function status(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpError) return e.status;
    throw e; // a TypeError here would have been a 500
  }
  return 200;
}

Deno.test("POST /agents body validation answers 400 for malformed input, never throws TypeError", () => {
  for (
    const b of [
      null, [], "x", {}, { workspace_id: ws }, { workspace_id: ws, name: 5 }, { workspace_id: ws, name: " " },
      { workspace_id: ws, name: "x".repeat(101) }, { workspace_id: ws, name: "a", description: 3 },
      { workspace_id: ws, name: "a", spaces: {} }, { workspace_id: ws, name: "a", spaces: "x" },
      { workspace_id: ws, name: "a", spaces: [null] }, { workspace_id: ws, name: "a", spaces: [{ space_id: "nope" }] },
      { workspace_id: ws, name: "a", spaces: [{ space_id: sp, role: "admin" }] },
      { workspace_id: ws, name: "a", spaces: [{ space_id: sp, role: 1 }] },
      { workspace_id: ws, name: "a", spaces: [{ space_id: sp }, { space_id: sp }] },
    ]
  ) assert.equal(status(() => parseCreateBody(b)), 400, JSON.stringify(b));
});

Deno.test("valid bodies parse with defaults", () => {
  const r = parseCreateBody({ workspace_id: ws, name: "  bot ", spaces: [{ space_id: sp }] });
  assert.deepEqual(r, { workspaceId: ws, name: "bot", description: null, grants: [{ space_id: sp, role: "reader" }] });
});
