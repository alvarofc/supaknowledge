import { deepStrictEqual as assertEquals } from "node:assert/strict";
import { collectGarbage, type GcRow, type GcStore, MAX_ATTEMPTS } from "../gc.ts";

function fakeStore(objects: Record<string, string[]>, rows: GcRow[], failRemove?: (bucket: string) => boolean) {
  const removed: string[] = [];
  const done: number[] = [];
  const failures: { id: number; attempts: number; error: string }[] = [];
  const pages: string[] = [];
  const store: GcStore = {
    queued: (limit, max) => Promise.resolve(rows.filter((r) => r.attempts < max).slice(0, limit)),
    objects(bucket, prefix, after, limit) {
      pages.push(`${bucket}:${prefix}:${after}`);
      const all = (objects[bucket] ?? []).filter((n) => !removed.includes(`${bucket}/${n}`)).sort();
      const match = all.filter((n) => (prefix.endsWith("/") ? n.startsWith(prefix) : n === prefix) && n > after);
      return Promise.resolve(match.slice(0, limit));
    },
    remove(bucket, names) {
      if (failRemove?.(bucket)) return Promise.reject(new Error("storage down"));
      removed.push(...names.map((n) => `${bucket}/${n}`));
      return Promise.resolve();
    },
    done: (id) => (done.push(id), Promise.resolve()),
    failed: (id, attempts, error) => (failures.push({ id, attempts, error }), Promise.resolve()),
  };
  return { store, removed, done, failures, pages };
}

Deno.test("removes every object under a folder prefix across pages, then dequeues", async () => {
  const many = Array.from({ length: 1234 }, (_, i) => `s1/src/${String(i).padStart(5, "0")}.md`);
  const f = fakeStore({ sources: [...many, "s2/src/keep.md", "s1/srcX/keep.md"] }, [{ id: 1, bucket: "sources", prefix: "s1/src/", attempts: 0 }]);
  const r = await collectGarbage(f.store);
  assertEquals(r, { rows: 1, removed: 1234, failed: [] });
  assertEquals(f.done, [1]);
  assertEquals(f.removed.includes("sources/s2/src/keep.md") || f.removed.includes("sources/s1/srcX/keep.md"), false);
  assertEquals(f.pages.length, 3); // 500 + 500 + 234
});

Deno.test("an exact object name removes only that object", async () => {
  const f = fakeStore({ sources: ["s1/a/doc.md", "s1/a/doc.md.bak"] }, [{ id: 7, bucket: "sources", prefix: "s1/a/doc.md", attempts: 0 }]);
  const r = await collectGarbage(f.store);
  assertEquals(r.removed, 1);
  assertEquals(f.removed, ["sources/s1/a/doc.md"]);
});

Deno.test("an empty prefix is dequeued without removing anything", async () => {
  const f = fakeStore({}, [{ id: 2, bucket: "concept-files", prefix: "s9/", attempts: 0 }]);
  assertEquals(await collectGarbage(f.store), { rows: 1, removed: 0, failed: [] });
  assertEquals(f.done, [2]);
});

Deno.test("failures are recorded and the row stays queued; other rows continue", async () => {
  const f = fakeStore(
    { sources: ["s1/x/a"], "concept-files": ["s1/c/f"] },
    [{ id: 3, bucket: "sources", prefix: "s1/x/", attempts: 2 }, { id: 4, bucket: "concept-files", prefix: "s1/c/", attempts: 0 }],
    (b) => b === "sources",
  );
  const r = await collectGarbage(f.store);
  assertEquals(r.rows, 1);
  assertEquals(r.failed.map((x) => x.id), [3]);
  assertEquals(f.failures, [{ id: 3, attempts: 3, error: "storage down" }]);
  assertEquals(f.done, [4]);
});

Deno.test("rows that failed MAX_ATTEMPTS times are skipped; the deadline stops early", async () => {
  const f = fakeStore({ sources: ["a/1", "b/1"] }, [
    { id: 5, bucket: "sources", prefix: "a/", attempts: MAX_ATTEMPTS },
    { id: 6, bucket: "sources", prefix: "b/", attempts: 0 },
  ]);
  let t = 0;
  const r = await collectGarbage(f.store, { deadline: 0, now: () => ++t });
  assertEquals(r.rows, 0);
  assertEquals(f.done, []);
  const r2 = await collectGarbage(f.store);
  assertEquals(r2.rows, 1);
  assertEquals(f.done, [6]);
});
