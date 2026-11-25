import assert from "node:assert/strict";
import { HttpError } from "../../_shared/http.ts";
import { assertQueueBatch } from "../../_shared/queue.ts";
import { Budget, type ChunkWrite, embedWithReuse, OutOfBudget, parseEmbedJob, sha256Hex, writeChunks } from "../lib.ts";

const id = "0b6f3c1e-1d2a-4c3b-9a8f-123456789abc";
const row = (ord: number, embedding: string | null = "[1]"): ChunkWrite => ({ ord, heading: null, content: `c${ord}`, embedding });

Deno.test("queue batches without a jobs array are a 400, not a TypeError", () => {
  for (const b of [null, [], "x", 5, {}, { queue: "kf_embed" }, { queue: "kf_embed", jobs: {} }, { jobs: [] }]) {
    assert.throws(() => assertQueueBatch(b), (e) => e instanceof HttpError && e.status === 400, JSON.stringify(b));
  }
  assertQueueBatch({ queue: "kf_embed", jobs: [] });
});

Deno.test("embed messages are validated (malformed ones are dropped, not retried 5 times)", () => {
  assert.deepEqual(parseEmbedJob({ table: "concepts", id }), { table: "concepts", id });
  assert.deepEqual(parseEmbedJob({ table: "source_documents", id, extra: 1 }), { table: "source_documents", id });
  for (const m of [null, "x", { table: "users", id }, { table: "concepts" }, { table: "concepts", id: "nope" }, { table: "concepts", id: 5 }]) {
    assert.equal(parseEmbedJob(m), null);
  }
});

Deno.test("embedWithReuse reuses identical chunks and stops at the budget", async () => {
  const budget = new Budget(1);
  let calls = 0;
  const out = await embedWithReuse(["a", "b", "c"], [{ ord: 0, content: "b", embedding: "[b]" }], budget, (t) => {
    calls++;
    return Promise.resolve(`[${t}]`);
  });
  assert.deepEqual(out, ["[a]", "[b]", null]);
  assert.equal(calls, 1);
  assert.equal(budget.left, 0);
});

type Call = { ords: number[]; total: number | null; first: boolean };
function recorder(answer = true) {
  const calls: Call[] = [];
  const write = (chunks: ChunkWrite[], total: number | null, first: boolean) => {
    calls.push({ ords: chunks.map((c) => c.ord), total, first });
    return Promise.resolve(answer);
  };
  return { calls, write };
}

Deno.test("writeChunks: batches, total only on the completing call, links (first) on the first call", async () => {
  const r = recorder();
  assert.equal(await writeChunks([0, 1, 2, 3, 4].map((i) => row(i)), r.write, 2), true);
  assert.deepEqual(r.calls, [
    { ords: [0, 1], total: null, first: true },
    { ords: [2, 3], total: null, first: false },
    { ords: [4], total: 5, first: false },
  ]);
});

Deno.test("writeChunks: an empty entity still trims (total 0) and writes links", async () => {
  const r = recorder();
  assert.equal(await writeChunks([], r.write), true);
  assert.deepEqual(r.calls, [{ ords: [], total: 0, first: true }]);
});

Deno.test("writeChunks: out of budget writes the ready chunks and links, never trims, then throws", async () => {
  const r = recorder();
  await assert.rejects(writeChunks([row(0), row(1, null), row(2)], r.write), OutOfBudget);
  assert.deepEqual(r.calls, [{ ords: [0, 2], total: null, first: true }]);
  // nothing ready at all: links still follow the body
  const r2 = recorder();
  await assert.rejects(writeChunks([row(0, null)], r2.write), OutOfBudget);
  assert.deepEqual(r2.calls, [{ ords: [], total: null, first: true }]);
});

Deno.test("writeChunks: a stale version (CAS says no) stops at once and does not re-queue", async () => {
  const r = recorder(false);
  assert.equal(await writeChunks([0, 1, 2].map((i) => row(i, i === 2 ? null : "[1]")), r.write, 1), false);
  assert.equal(r.calls.length, 1);
});

Deno.test("sha256Hex matches Postgres encode(sha256(convert_to(body,'UTF8')),'hex')", async () => {
  assert.equal(await sha256Hex("héllo"), "3c48591d8d098a4538f5e013dfcf406e948eac4d3277b10bf614e295d6068179");
  assert.equal(await sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});
