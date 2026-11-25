import assert from "node:assert/strict";
import { flagEvidence } from "../evidence.ts";

Deno.test("flag evidence: caller cannot set trace_ref, via or client_id", () => {
  const spoof = { trace_ref: "other-trace", via: "ui", client_id: "evil", query: "select 1" };
  // no trace_id: the caller's trace_ref is dropped, not stored
  assert.deepEqual(flagEvidence(spoof, "c1", undefined, null), { query: "select 1", via: "mcp", client_id: "c1" });
  // resolved trace_id: the trace is linked by id, so no trace_ref at all
  assert.deepEqual(flagEvidence(spoof, "c1", "t-1", "00000000-0000-0000-0000-000000000001"), { query: "select 1", via: "mcp", client_id: "c1" });
  // unresolved trace_id: the server records the id the agent cited
  assert.deepEqual(flagEvidence(spoof, null, " t-1 ", null), { query: "select 1", via: "mcp", client_id: null, trace_ref: "t-1" });
  assert.deepEqual(flagEvidence(undefined, "c1", "  ", null), { via: "mcp", client_id: "c1" });
});
