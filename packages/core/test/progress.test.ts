// Live progress events of the curator engine (CuratorDeps.progress) and the Realtime sink.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ScriptedLLM, type GenerateRequest } from "../src/llm.ts";
import {
  CORRECTIONS_SYSTEM,
  DRAFT_SYSTEM,
  REVIEW_SYSTEM,
  type CuratorProgress,
  progressEmitter,
  rpcProgressSink,
  runTask,
} from "../src/curator/index.ts";
import type { Concept } from "../src/types.ts";
import { MemoryStore } from "./memory-store.ts";

const SECRET = "SECRET-ARR-42M";

function concept(p: Partial<Concept> & { path: string }): Concept {
  return {
    id: `c-${p.path}`, space_id: "s", kind: "domain", type: "Reference", title: p.path, description: "", body: "",
    frontmatter: {}, tags: [], status: "stable", audience: [], revision: 1, generated_by: null, generated_at: "",
    created_at: "", updated_at: "", ...p,
  };
}

/** A space with one public data-access fix (auto-applied) and one finance-only correction mined from a trace. */
function world() {
  const store = new MemoryStore({ auto_apply: { enabled: true, kinds: ["data_access"], max_risk: "low" } });
  store.concepts.push(
    concept({ path: "data/bigquery/revenue", kind: "data_access", type: "BigQuery Table", title: "Revenue table", body: "# Revenue\n\nQuery `finance.revenue`, column `revenue_usd`.\n" }),
    concept({ path: "finance/arr", title: `ARR ${SECRET}`, body: `# ARR\n\n${SECRET}\n`, audience: ["g-finance"] }),
  );
  store.flags.push({
    id: "flag-renamed", space_id: "s", created_by: "agent", trace_id: null, kind: "incorrect", concept_id: "c-data/bigquery/revenue",
    concept_path: "data/bigquery/revenue", query: "monthly revenue", observation: "column revenue_usd not found; revenue_usd_net exists",
    suggested_fix: "use revenue_usd_net", evidence: {}, audience: [], status: "open", synthetic: false, created_at: "",
  });
  store.traces.push({
    id: "trace-1", space_id: "s", principal_id: "agent", name: `finance ${SECRET}`, outcome: "corrected", audience: ["g-finance"], metadata: {}, started_at: "",
    events: [
      { seq: 1, role: "user", content: "What is ARR?" },
      { seq: 2, role: "assistant", content: "ARR is 40M." },
      { seq: 3, role: "user", content: `Actually, ARR is ${SECRET}, from now on use that.` },
    ],
  });
  const llm = new ScriptedLLM((req: GenerateRequest<unknown>) => {
    const input = Array.isArray(req.input) ? req.input.join("\n") : req.input;
    if (req.system.startsWith(CORRECTIONS_SYSTEM.slice(0, 40))) {
      return {
        lessons: [{
          seqs: [3], kind: "incorrect", knowledge_kind: "domain", lesson: `ARR is ${SECRET}.`, observation: `Agent said 40M; it is ${SECRET}.`,
          evidence_quote: SECRET, concept_path: "finance/arr", durable: true,
        }],
      };
    }
    if (req.system.startsWith(DRAFT_SYSTEM.slice(0, 40))) {
      const flagId = /### flag:(\S+)/.exec(input)![1]!;
      const finance = input.includes("### concept:finance/arr");
      const path = finance ? "finance/arr" : "data/bigquery/revenue";
      return {
        decision: "propose", title: finance ? `Set ARR to ${SECRET}` : "Use revenue_usd_net", rationale: finance ? SECRET : "renamed", risk: finance ? "medium" : "low",
        ops: [{
          op: "update", path, new_path: null, kind: null, type: null, title: null, description: null,
          body: finance ? `# ARR\n\n${SECRET}[^f]\n` : "# Revenue\n\nColumn `revenue_usd_net`.[^f]\n", tags: null, superseded_by: null,
          stale_after: null, citation_labels: ["f"], rationale: finance ? SECRET : "renamed",
        }],
        citations: [{ label: "f", ref: `flag:${flagId}`, quote: finance ? SECRET : "revenue_usd_net exists" }],
        resolves_flags: [flagId], dismiss_flags: [],
      };
    }
    if (req.system.startsWith(REVIEW_SYSTEM.slice(0, 40))) {
      return input.includes(SECRET)
        ? { ok: false, issues: [{ kind: "unsupported", severity: "warning", detail: `check ${SECRET}` }], risk: "medium" }
        : { ok: true, issues: [], risk: "low" };
    }
    throw new Error("unexpected prompt");
  });
  return { store, llm };
}

async function drain(store: MemoryStore, deps: Omit<Parameters<typeof runTask>[0], "store">) {
  for (let i = 0; i < 20 && store.queue.length; i++) {
    const t = store.queue.shift()!;
    // a retryable failure rethrows; the queue redelivers the message
    await runTask({ store, ...deps }, t).catch(() => store.queue.push(t));
  }
}

test("the engine reports each task step by step, ending with the proposals it created and applied", async () => {
  const { store, llm } = world();
  const events: CuratorProgress[] = [];
  const first = store.createRun("s");
  await drain(store, { llm, progress: (e) => void events.push(e) });

  assert.equal(store.runs.get(first.run_id)!.status, "succeeded");
  assert.ok(events.every((e) => e.v === 1 && e.run_id === first.run_id && typeof e.at === "string"));

  // every task starts and finishes, and seq counts within a task
  const tasks = [...new Set(events.map((e) => e.task_id))];
  assert.equal(tasks.length, store.tasks.size);
  for (const t of tasks) {
    const own = events.filter((e) => e.task_id === t);
    assert.equal(own[0]!.type, "task_started");
    assert.equal(own.at(-1)!.type, "task_finished");
    assert.deepEqual(own.map((e) => e.seq), own.map((_, i) => i + 1));
  }

  const gather = events.filter((e) => e.task_id === first.id).map((e) => e.type);
  assert.deepEqual(gather.slice(0, 5), ["task_started", "evidence", "model_call_started", "model_call_finished", "lessons"]);
  assert.ok(gather.includes("clusters"), "triage ran inline in the gather task");

  const drafts = events.filter((e) => e.step === "draft");
  const types = (task: string) => drafts.filter((e) => e.task_id === task).map((e) => e.type);
  for (const t of new Set(drafts.map((e) => e.task_id))) {
    assert.deepEqual(
      types(t).filter((x) => x !== "proposal_applied"),
      ["task_started", "evidence", "model_call_started", "model_call_finished", "draft_ops", "model_call_started", "model_call_finished", "self_review", "proposal_created", "task_finished"],
    );
  }
  const purposes = drafts.filter((e) => e.type === "model_call_finished").map((e) => (e.type === "model_call_finished" ? e.purpose : ""));
  assert.deepEqual([...new Set(purposes)].sort(), ["draft", "review"]);

  const created = events.flatMap((e) => (e.type === "proposal_created" ? [e.proposal_id] : []));
  assert.deepEqual(created.sort(), store.proposals.map((p) => p.id).sort());
  const applied = events.flatMap((e) => (e.type === "proposal_applied" ? [e.proposal_id] : []));
  assert.deepEqual(applied, store.proposals.filter((p) => p.status === "applied").map((p) => p.id));
  assert.equal(applied.length, 1);

  const ops = drafts.find((e) => e.type === "draft_ops");
  assert.ok(ops && ops.type === "draft_ops");
  assert.deepEqual(ops.ops, { update: 1 });
  assert.equal(ops.citations, 1);
});

test("progress events carry ids, counts and timings only: no evidence, titles, paths or model output", async () => {
  const { store, llm } = world();
  const events: CuratorProgress[] = [];
  store.createRun("s");
  await drain(store, { llm, progress: (e) => void events.push(e) });
  const json = JSON.stringify(events);
  for (const leak of [SECRET, "finance/arr", "data/bigquery", "revenue_usd", "ARR", "trace-1", "flag-renamed", "c-finance", "g-finance"]) {
    assert.ok(!json.includes(leak), `events mention ${leak}`);
  }
  // every string in an event is an envelope field, an event type or step, a model purpose, or a proposal id
  const proposalIds = new Set(store.proposals.map((p) => p.id));
  for (const e of events) {
    for (const [k, v] of Object.entries(e)) {
      if (typeof v !== "string") continue;
      assert.ok(["type", "at", "run_id", "task_id", "step", "purpose"].includes(k) || (k === "proposal_id" && proposalIds.has(v)), `unexpected string field ${k}`);
    }
  }
});

test("a failing task reports the failure, and whether a retry follows", async () => {
  const { store } = world();
  const events: CuratorProgress[] = [];
  const llm = new ScriptedLLM(() => {
    throw new Error(`model down ${SECRET}`);
  });
  store.createRun("s");
  await drain(store, { llm, progress: (e) => void events.push(e) });
  const failures = events.filter((e) => e.type === "task_failed");
  assert.ok(failures.length >= 2);
  assert.deepEqual(failures.map((e) => (e.type === "task_failed" ? e.final : null)).at(-1), true);
  assert.ok(failures.slice(0, -1).every((e) => e.type === "task_failed" && !e.final), "earlier attempts are retried");
  const calls = events.filter((e) => e.type === "model_call_finished");
  assert.ok(calls.length && calls.every((e) => e.type === "model_call_finished" && !e.ok));
  assert.ok(!JSON.stringify(events).includes(SECRET), "error messages are not sent");
});

test("a sink that throws or rejects never changes what the curator does", async () => {
  const plain = world();
  plain.store.createRun("s");
  await drain(plain.store, { llm: plain.llm });

  for (const progress of [
    () => {
      throw new Error("sink down");
    },
    () => Promise.reject(new Error("sink down")),
  ]) {
    const w = world();
    const t = w.store.createRun("s");
    await drain(w.store, { llm: w.llm, progress });
    assert.equal(w.store.runs.get(t.run_id)!.status, "succeeded");
    assert.deepEqual(
      w.store.proposals.map((p) => [p.title, p.status]),
      plain.store.proposals.map((p) => [p.title, p.status]),
    );
  }
});

test("progressEmitter is a no-op without a sink", () => {
  const emit = progressEmitter(undefined, { id: "t", run_id: "r", step: "draft" });
  assert.doesNotThrow(() => emit({ type: "task_finished" }));
});

test("rpcProgressSink sends events in order, batching what piles up while a call is in flight", async () => {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const db = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return (calls.length === 1 ? gate : Promise.resolve()).then(() => ({ error: null }));
    },
  };
  const sink = rpcProgressSink(db, "space-1");
  const emit = progressEmitter(sink, { id: "t", run_id: "r", step: "draft" });
  emit({ type: "task_started", attempt: 1 });
  await Promise.resolve();
  emit({ type: "evidence", counts: { flags: 1 } });
  emit({ type: "task_finished" });
  release();
  await sink.flush();
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.fn === "kf_curator_progress" && c.args.p_space === "space-1"));
  const sent = calls.flatMap((c) => c.args.p_events as CuratorProgress[]);
  assert.deepEqual(sent.map((e) => e.type), ["task_started", "evidence", "task_finished"]);
  assert.deepEqual(sent.map((e) => e.seq), [1, 2, 3]);
});

test("rpcProgressSink logs database errors and keeps going; flush gives up after its timeout", async () => {
  const logged: string[] = [];
  let n = 0;
  const db = {
    rpc() {
      n++;
      return Promise.resolve(n === 1 ? { error: { message: "permission denied" } } : { error: null });
    },
  };
  const sink = rpcProgressSink(db, "s", (m, d) => logged.push(`${m}: ${String(d?.error)}`));
  const emit = progressEmitter(sink, { id: "t", run_id: "r", step: "gather" });
  emit({ type: "task_started", attempt: 1 });
  await sink.flush();
  emit({ type: "task_finished" });
  await sink.flush();
  assert.equal(n, 2);
  assert.deepEqual(logged, ["curator progress not sent: permission denied"]);

  const stuck = rpcProgressSink({ rpc: () => new Promise(() => {}) }, "s");
  progressEmitter(stuck, { id: "t", run_id: "r", step: "gather" })({ type: "task_finished" });
  const started = Date.now();
  await stuck.flush(50);
  assert.ok(Date.now() - started < 1_000);
});
