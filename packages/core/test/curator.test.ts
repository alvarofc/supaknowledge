// End-to-end curator run on the knowledge-factory post's revenue-report story, with a scripted model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ScriptedLLM, type GenerateRequest } from "../src/llm.ts";
import { runTask, CORRECTIONS_SYSTEM, DRAFT_SYSTEM, REVIEW_SYSTEM, CLUSTER_SYSTEM } from "../src/curator/index.ts";
import type { Concept } from "../src/types.ts";
import { MemoryStore } from "./memory-store.ts";

function concept(p: Partial<Concept> & { path: string }): Concept {
  return {
    id: `c-${p.path}`, space_id: "s", kind: "domain", type: "Reference", title: p.path, description: "", body: "",
    frontmatter: {}, tags: [], status: "stable", audience: [], revision: 1, generated_by: null, generated_at: "",
    created_at: "", updated_at: "", ...p,
  };
}

function scripted() {
  return new ScriptedLLM((req: GenerateRequest<unknown>) => {
    const input = Array.isArray(req.input) ? req.input.join("\n") : req.input;
    if (req.system.startsWith(CORRECTIONS_SYSTEM.slice(0, 40))) {
      return {
        lessons: [{
          seqs: [3], kind: "missing", knowledge_kind: "skill",
          lesson: "Every report must start with the header 'ACME CONFIDENTIAL'.",
          observation: "Agent drafted the report without the company header.",
          evidence_quote: "from now on every doc needs the ACME CONFIDENTIAL header",
          concept_path: "skills/revenue-report", durable: true,
        }],
      };
    }
    if (req.system.startsWith(CLUSTER_SYSTEM.slice(0, 40))) throw new Error("no loose signals expected");
    if (req.system.startsWith(DRAFT_SYSTEM.slice(0, 40))) {
      const flagId = /### flag:(\S+)/.exec(input)![1]!;
      if (input.includes("### concept:data/bigquery/revenue")) {
        return {
          decision: "propose", title: "Use revenue_usd_net in the revenue table guide", rationale: "Column was renamed.", risk: "low",
          ops: [{
            op: "update", path: "data/bigquery/revenue", new_path: null, kind: null, type: null, title: null, description: null,
            body: "# Revenue\n\nQuery `finance.revenue`, column `revenue_usd_net`.[^rename]\n", tags: null, superseded_by: null,
            stale_after: null, citation_labels: ["rename"], rationale: "renamed column",
          }],
          citations: [{ label: "rename", ref: `flag:${flagId}`, quote: "revenue_usd_net exists" }],
          resolves_flags: [flagId], dismiss_flags: [],
        };
      }
      return {
        decision: "propose", title: "Add the confidential header to revenue reports", rationale: "Finance lead asked for it.", risk: "medium",
        ops: [{
          op: "update", path: "skills/revenue-report", new_path: null, kind: null, type: null, title: null, description: null,
          body: "# Revenue report\n\n1. Start with the header `ACME CONFIDENTIAL`.[^hdr]\n2. Pull data.\n", tags: null,
          superseded_by: null, stale_after: null, citation_labels: ["hdr"], rationale: "new header",
        }],
        citations: [{ label: "hdr", ref: `flag:${flagId}`, quote: "ACME CONFIDENTIAL" }, { label: "bogus", ref: "doc:nope", quote: "" }],
        resolves_flags: [flagId], dismiss_flags: [],
      };
    }
    if (req.system.startsWith(REVIEW_SYSTEM.slice(0, 40))) return { ok: true, issues: [], risk: "low" };
    throw new Error("unexpected prompt");
  });
}

test("curator turns a flag and a trace correction into proposals; policy auto-applies only the safe one", async () => {
  const store = new MemoryStore({ auto_apply: { enabled: true, kinds: ["data_access"], max_risk: "low" } });
  store.concepts.push(
    concept({ path: "data/bigquery/revenue", kind: "data_access", type: "BigQuery Table", title: "Revenue table", body: "# Revenue\n\nQuery `finance.revenue`, column `revenue_usd`.\n" }),
    concept({ path: "skills/revenue-report", kind: "skill", type: "Skill", title: "Revenue report", description: "Build the monthly revenue report.", body: "# Revenue report\n\n1. Pull data.\n" }),
  );
  store.flags.push({
    id: "flag-renamed", space_id: "s", created_by: "agent", trace_id: null, kind: "incorrect", concept_id: "c-data/bigquery/revenue",
    concept_path: "data/bigquery/revenue", query: "monthly revenue", observation: "column revenue_usd not found; revenue_usd_net exists",
    suggested_fix: "use revenue_usd_net", evidence: {}, audience: [], status: "open", synthetic: false, created_at: "",
  });
  store.traces.push({
    id: "trace-1", space_id: "s", principal_id: "agent", name: "monthly revenue report", outcome: "corrected", audience: [], metadata: {}, started_at: "",
    events: [
      { seq: 1, role: "user", content: "Draft the November revenue report" },
      { seq: 2, role: "assistant", content: "Here is the draft..." },
      { seq: 3, role: "user", content: "Actually, from now on every doc needs the ACME CONFIDENTIAL header at the top." },
      { seq: 4, role: "assistant", content: "Added the header." },
    ],
  });

  const llm = scripted();
  const first = store.createRun("s");
  const runId = first.run_id;
  for (let i = 0; i < 20 && store.queue.length; i++) await runTask({ store, llm }, store.queue.shift()!);

  assert.equal(store.runs.get(runId)!.status, "succeeded");
  assert.equal(store.proposals.length, 2);

  const dataFix = store.proposals.find((p) => p.ops[0]!.path === "data/bigquery/revenue")!;
  assert.equal(dataFix.status, "applied", "low-risk data_access fix backed by a flag is auto-applied");
  assert.match(store.concepts.find((c) => c.path === "data/bigquery/revenue")!.body, /revenue_usd_net/);
  assert.ok(dataFix.ops[0]!.after.stale_after, "data_access concepts get a stale_after");
  assert.deepEqual((dataFix.ops[0]!.after.frontmatter!.sources as { id: string }[]).map((s) => s.id), ["rename"]);
  assert.equal(store.flags.find((f) => f.id === "flag-renamed")!.status, "resolved");

  const skillFix = store.proposals.find((p) => p.ops[0]!.path === "skills/revenue-report")!;
  assert.equal(skillFix.status, "pending", "skill changes wait for a human");
  assert.match(skillFix.rationale, /unknown evidence/, "dropped citations are reported to the reviewer");
  const synthetic = store.flags.find((f) => f.synthetic)!;
  assert.equal(synthetic.status, "in_proposal");
  assert.equal(synthetic.trace_id, "trace-1");
  assert.ok(store.traces[0]!.curated);
  assert.equal(store.runs.get(runId)!.stats.proposals, 2);
  assert.equal(store.runs.get(runId)!.stats.auto_applied, 1);
});

test("restricted evidence never auto-applies into a wider audience", async () => {
  const store = new MemoryStore({ auto_apply: { enabled: true, kinds: ["data_access", "domain"], max_risk: "medium", allow_create: true } });
  store.flags.push({
    id: "flag-secret", space_id: "s", created_by: "agent", trace_id: null, kind: "missing", concept_id: "c-metrics/arr",
    concept_path: "metrics/arr", query: "ARR definition", observation: "ARR excludes services revenue (from the finance-only channel)",
    suggested_fix: null, evidence: {}, audience: ["g-finance"], status: "open", synthetic: false, created_at: "",
  });
  store.concepts.push({ ...concept({ path: "metrics/arr", title: "ARR", body: "# ARR\n" }), audience: [] });
  const llm = new ScriptedLLM((req) => {
    const input = Array.isArray(req.input) ? req.input.join("\n") : req.input;
    if (req.system.startsWith(DRAFT_SYSTEM.slice(0, 40))) {
      return {
        decision: "propose", title: "Clarify ARR", rationale: "", risk: "low",
        ops: [{ op: "update", path: "metrics/arr", new_path: null, kind: null, type: null, title: null, description: null, body: "# ARR\n\nExcludes services.[^f]\n", tags: null, superseded_by: null, stale_after: null, citation_labels: ["f"], rationale: "" }],
        citations: [{ label: "f", ref: `flag:${/### flag:(\S+)/.exec(input)![1]}`, quote: "excludes services" }],
        resolves_flags: ["flag-secret"], dismiss_flags: [],
      };
    }
    return { ok: true, issues: [], risk: "low" };
  });
  const t = store.createRun("s");
  for (let i = 0; i < 10 && store.queue.length; i++) await runTask({ store, llm }, store.queue.shift()!);
  const p = store.proposals[0]!;
  assert.equal(p.escalation, true);
  assert.equal(p.status, "pending");
  assert.equal(store.runs.get(t.run_id)!.stats.escalations, 1);
});

test("a model-proposed stale_after in the past is rejected, never applied", async () => {
  const { buildProposal } = await import("../src/curator/engine.ts");
  const { parseSettings } = await import("../src/settings.ts");
  const existing = concept({ path: "data/bigquery/revenue", kind: "data_access", type: "BigQuery Table", stale_after: "2027-03-01T00:00:00.000Z" });
  const ev = { flags: new Map(), traces: new Map(), documents: new Map(), sourceHits: [], targets: new Map([[existing.path, existing]]), related: [] };
  const op = { op: "update" as const, path: existing.path, new_path: null, kind: null, type: null, title: null, description: null, body: "# Revenue\n", tags: null, superseded_by: null, stale_after: "2026-03-01", citation_labels: [], rationale: "" };
  const out = { decision: "propose" as const, title: "t", rationale: "", risk: "low" as const, ops: [op], citations: [], resolves_flags: [], dismiss_flags: [] };
  const { draft, problems } = buildProposal(out, ev as never, new Map(), parseSettings({}), new Date("2026-11-24T00:00:00Z"));
  assert.equal(draft.ops[0]!.after.stale_after, undefined, "the existing future review date is kept");
  assert.match(problems.join("\n"), /not a future date/);
});

test("a failed Supabase MCP execute_sql becomes a synthetic flag on the concept the agent followed, without a model call", async () => {
  const store = new MemoryStore();
  store.concepts.push(concept({ path: "data/orders", kind: "data_access", type: "Postgres Table", title: "Orders", body: "# Orders\n\nRevenue is `public.orders.revenue_usd`.\n" }));
  store.traces.push({
    id: "trace-sql", space_id: "s", principal_id: "agent", name: "orders", outcome: "success", audience: [], metadata: {}, started_at: "",
    events: [
      { seq: 1, role: "tool", tool_name: "mcp__supaknowledge__read_concept", tool_input: { path: "data/orders" }, tool_output: "Revenue is `public.orders.revenue_usd`." },
      { seq: 2, role: "tool", tool_name: "mcp__supabase__execute_sql", tool_input: { query: "select sum(revenue_usd) from orders" }, tool_output: { error: 'column "revenue_usd" does not exist', sqlstate: "42703" }, is_error: true },
    ],
  });
  const prompts: string[] = [];
  const llm = new ScriptedLLM((req) => {
    prompts.push(req.system.slice(0, 40));
    if (req.system.startsWith(DRAFT_SYSTEM.slice(0, 40))) return { decision: "no_change", title: "n", rationale: "r", risk: "low", ops: [], citations: [], resolves_flags: [], dismiss_flags: [] };
    return { ok: true, issues: [], risk: "low" };
  });
  const t = store.createRun("s");
  for (let i = 0; i < 10 && store.queue.length; i++) await runTask({ store, llm }, store.queue.shift()!);
  const flag = store.flags.find((f) => f.synthetic)!;
  assert.equal(flag.kind, "incorrect");
  assert.equal(flag.concept_path, "data/orders");
  assert.equal(flag.evidence.sqlstate, "42703");
  assert.equal(store.runs.get(t.run_id)!.stats.sql_errors, 1);
  assert.equal(store.runs.get(t.run_id)!.stats.traces_mined, 0, "no correction-mining call for this trace");
  assert.ok(!prompts.includes(CORRECTIONS_SYSTEM.slice(0, 40)));
  assert.ok(prompts.includes(DRAFT_SYSTEM.slice(0, 40)), "the flag was drafted against its concept");
});
