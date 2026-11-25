// Follow-ups from the PR #1 bot review: markdown fences, frontmatter key order, trace rendering, self-review
// verdicts and the per-run cluster cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown, extractLinks, orderKeys, parseMarkdown, serializeMarkdown } from "../src/formats.ts";
import { fencedLines } from "../src/fences.ts";
import { ScriptedLLM, type GenerateRequest } from "../src/llm.ts";
import { DRAFT_SYSTEM, renderTrace, REVIEW_SYSTEM, runTask } from "../src/curator/index.ts";
import type { Concept, Flag, SourceDocument, Trace, TraceEvent } from "../src/types.ts";
import { MemoryStore } from "./memory-store.ts";

// ---------------------------------------------------------------------------------------------------------
// fences (chunking + link extraction)
// ---------------------------------------------------------------------------------------------------------

test("fences close only on the same character with at least the opener's length; unclosed fences run to EOF", () => {
  const lines = ["````md", "```", "~~~", "inside", "````", "after", "~~~", "``` still open", "```x`y", "tail"];
  assert.deepEqual(fencedLines(lines), [true, true, true, true, true, false, true, true, true, true]);
  // a backtick fence's info string cannot contain a backtick: "```x`y" alone is not an opener
  assert.deepEqual(fencedLines(["```x`y", "# h"]), [false, false]);
});

test("chunking: headings inside fences are not section breaks, including mixed and unclosed fences", () => {
  const md = ["# Real", "text", "```", "~~~", "# not a heading (still in the ``` block)", "```", "# Second", "````", "```", "# nor this", "````", "## Third", "~~~", "# unclosed"].join("\n");
  const headings = chunkMarkdown(md).map((c) => c.heading);
  assert.deepEqual(headings, ["Real", "Second", "Second > Third"]);
  assert.match(chunkMarkdown(md).at(-1)!.content, /# unclosed/);
});

test("links: no edges from tilde fences, nested fence markers or an unclosed fence", () => {
  const md = [
    "[a](a.md)",
    "~~~",
    "[tilde](no1.md)",
    "~~~",
    "````",
    "```",
    "[nested](no2.md)",
    "```",
    "[still fenced](no3.md)",
    "````",
    "[b](b.md)",
    "```",
    "[unclosed](no4.md)",
  ].join("\n");
  assert.deepEqual(extractLinks("x/y", md).map((l) => l.path), ["x/a", "x/b"]);
});

// ---------------------------------------------------------------------------------------------------------
// frontmatter key order
// ---------------------------------------------------------------------------------------------------------

test("orderKeys keeps keys named like Object.prototype members and never touches the prototype", () => {
  const fm = parseMarkdown("---\ntype: Metric\nconstructor: c\ntoString: t\n__proto__: p\ntitle: T\n---\n\nbody\n").frontmatter!;
  const out = orderKeys(fm);
  assert.deepEqual(Object.keys(out), ["type", "title", "constructor", "toString", "__proto__"]);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(out.constructor, "c");
  const again = parseMarkdown(serializeMarkdown(fm, "body")).frontmatter!;
  assert.equal(again.toString, "t");
  assert.equal(Object.getOwnPropertyDescriptor(again, "__proto__")?.value, "p");
});

// ---------------------------------------------------------------------------------------------------------
// trace rendering
// ---------------------------------------------------------------------------------------------------------

function trace(events: TraceEvent[]): Trace {
  return { id: "t1", space_id: "s", principal_id: null, name: "long", outcome: "corrected", audience: [], metadata: {}, started_at: "", events };
}

test("renderTrace keeps a late correction (and the turn before it) when the transcript is over budget", () => {
  const events: TraceEvent[] = [{ seq: 0, role: "user", content: "build the revenue report" }];
  for (let i = 1; i <= 60; i++) events.push({ seq: i, role: i % 2 ? "assistant" : "tool", tool_name: i % 2 ? null : "sql", content: `step ${i} ${"x".repeat(400)}` });
  events.push({ seq: 61, role: "assistant", content: "here is the report using revenue_usd" });
  events.push({ seq: 62, role: "user", content: "actually, the column was renamed to revenue_usd_net" });
  for (let i = 63; i <= 120; i++) events.push({ seq: i, role: "assistant", content: `more ${i} ${"y".repeat(400)}` });
  const out = renderTrace(trace(events), 6000);
  assert.ok(out.length <= 6000, `${out.length}`);
  assert.match(out, /^Trace t1/);
  assert.match(out, /\[62\] user: actually, the column was renamed/);
  assert.match(out, /\[61\] assistant: here is the report/);
  assert.match(out, /\[120\] assistant/, "the end of the trace is kept");
  assert.match(out, /events omitted\]/);
  // a short trace is rendered in full, unchanged
  assert.equal(renderTrace(trace(events.slice(0, 2)), 6000).includes("omitted"), false);
});

// ---------------------------------------------------------------------------------------------------------
// self-review verdict
// ---------------------------------------------------------------------------------------------------------

function concept(p: Partial<Concept> & { path: string }): Concept {
  return {
    id: `c-${p.path}`, space_id: "s", kind: "data_access", type: "Table", title: p.path, description: "", body: "# x\n",
    frontmatter: {}, tags: [], status: "stable", audience: [], revision: 1, generated_by: null, generated_at: "",
    created_at: "", updated_at: "", ...p,
  };
}

function flag(p: Partial<Flag> & { id: string }): Flag {
  return {
    space_id: "s", created_by: "agent", trace_id: null, kind: "incorrect", concept_id: null, concept_path: null, query: null,
    observation: "something is wrong", suggested_fix: null, evidence: {}, audience: [], status: "open", synthetic: false, created_at: "", ...p,
  };
}

const is = (req: GenerateRequest<unknown>, system: string) => req.system.startsWith(system.slice(0, 40));

async function drain(store: MemoryStore, llm: ScriptedLLM) {
  for (let i = 0; i < 50 && store.queue.length; i++) {
    const t = store.queue.shift()!;
    if (store.tasks.get(t.id)!.status !== "queued") continue;
    await runTask({ store, llm }, t);
  }
}

const AUTO = { auto_apply: { enabled: true, kinds: ["data_access"], max_risk: "low", require_observed_evidence: true } };

test("a self-review that does not approve (ok=false) blocks auto-apply even without a blocker issue", async () => {
  const run = async (ok: boolean) => {
    const store = new MemoryStore(AUTO);
    store.concepts.push(concept({ path: "data/rev", body: "# Revenue\n\nUse `revenue_usd`.\n" }));
    store.flags.push(flag({ id: "f1", concept_id: "c-data/rev", concept_path: "data/rev", observation: "column renamed to revenue_usd_net" }));
    const llm = new ScriptedLLM((req) => {
      if (is(req, DRAFT_SYSTEM)) {
        return {
          decision: "propose", title: "t", rationale: "r", risk: "low",
          ops: [{ op: "update", path: "data/rev", new_path: null, kind: null, type: null, title: null, description: null, body: "# Revenue\n\nUse `revenue_usd_net`.[^a]\n", tags: null, superseded_by: null, stale_after: null, citation_labels: ["a"], rationale: "fix" }],
          citations: [{ label: "a", ref: "flag:f1", quote: "renamed" }], resolves_flags: ["f1"], dismiss_flags: [],
        };
      }
      if (is(req, REVIEW_SYSTEM)) return { ok, issues: ok ? [] : [{ severity: "warning", kind: "other", detail: "not convinced" }], risk: "low" };
      throw new Error("unexpected prompt");
    });
    store.createRun("s");
    await drain(store, llm);
    return store.proposals[0]!;
  };
  assert.equal((await run(true)).status, "applied");
  const p = await run(false);
  assert.equal(p.status, "pending");
  assert.match(p.rationale, /self-review did not approve/);
});

// ---------------------------------------------------------------------------------------------------------
// cluster cap
// ---------------------------------------------------------------------------------------------------------

function doc(id: string): SourceDocument {
  return { id, source_id: "src", space_id: "s", external_id: id, title: id, url: null, content: "content", audience: [], author: null, changed_at: "2026-11-01T00:00:00Z" };
}

test("changed documents of clusters over max_clusters_per_run are counted, not silently dropped", async () => {
  const store = new MemoryStore({ curator: { max_clusters_per_run: 1 } });
  for (const n of ["a", "b"]) {
    store.concepts.push(concept({ path: `data/${n}`, frontmatter: { sources: [{ id: n, resource: `supaknowledge://documents/d-${n}` }] } }));
    store.docs.push(doc(`d-${n}`));
  }
  const llm = new ScriptedLLM((req) => {
    if (is(req, DRAFT_SYSTEM)) return { decision: "no_change", title: "", rationale: "up to date", risk: "low", ops: [], citations: [], resolves_flags: [], dismiss_flags: [] };
    throw new Error("unexpected prompt");
  });
  const task = store.createRun("s");
  await drain(store, llm);
  const stats = store.runs.get(task.run_id)!.stats;
  assert.equal(stats.clusters, 1);
  assert.equal(stats.documents_over_cap, 1);
});
