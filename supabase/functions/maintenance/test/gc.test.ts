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
  assertEquals(r, { rows: 1, removed: 1234, failed: [], stopped: false });
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
  assertEquals(await collectGarbage(f.store), { rows: 1, removed: 0, failed: [], stopped: false });
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

/** byte-wise (COLLATE "C") comparison, like the database */
function byteCmp(a: string, b: string): number {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

Deno.test("pagination follows the database's byte order: the cursor is the last name returned", async () => {
  // names whose byte order differs from localeCompare / case-insensitive order
  const base = ["Z.md", "a.md", "_x", "é.md", "\u{1F600}.md", "\uFF5E.md", "B.md", "b.md"];
  const names = Array.from({ length: 1100 }, (_, i) => `p/${base[i % base.length]}${i}`);
  const sorted = [...names].sort(byteCmp);
  const afters: string[] = [];
  const removed = new Set<string>();
  const store: GcStore = {
    queued: () => Promise.resolve([{ id: 1, bucket: "b", prefix: "p/", attempts: 0 }]),
    objects(_b, _p, after, limit) {
      afters.push(after);
      return Promise.resolve(sorted.filter((n) => !removed.has(n) && (after === "" || byteCmp(n, after) > 0)).slice(0, limit));
    },
    remove: (_b, ns) => (ns.forEach((n) => removed.add(n)), Promise.resolve()),
    done: () => Promise.resolve(),
    failed: () => Promise.reject(new Error("unexpected")),
  };
  const r = await collectGarbage(store);
  assertEquals(r, { rows: 1, removed: 1100, failed: [], stopped: false });
  assertEquals(removed.size, 1100);
  assertEquals(afters, ["", sorted[499], sorted[999]]);
});

Deno.test("the deadline is checked inside the pagination loop: a long row is left queued, not marked done", async () => {
  const many = Array.from({ length: 1500 }, (_, i) => `s/${String(i).padStart(5, "0")}`);
  const f = fakeStore({ sources: many }, [{ id: 9, bucket: "sources", prefix: "s/", attempts: 0 }]);
  let calls = 0;
  // deadline passes after the first page's objects() call
  let t = 0;
  const wrapped: GcStore = {
    ...f.store,
    objects: (...a) => {
      calls++;
      t = 100;
      return f.store.objects(...a);
    },
  };
  const r = await collectGarbage(wrapped, { deadline: 50, now: () => t });
  assertEquals(r.stopped, true);
  assertEquals(r.rows, 0);
  assertEquals(f.done, []);
  assertEquals(f.failures, []);
  assertEquals(calls, 1);
  assertEquals(r.removed, 100); // one remove batch, then the deadline stopped the page
  // the next run resumes and finishes
  const r2 = await collectGarbage(f.store);
  assertEquals(r2, { rows: 1, removed: 1400, failed: [], stopped: false });
  assertEquals(f.done, [9]);
});
