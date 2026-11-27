// Offline mode: an in-memory store, the scripted agent and a scripted curator model. Deterministic, no stack and
// no key, so it runs in CI. Everything except the two scripts is production code: correction mining (including
// the SQL-error flags), triage, drafting checks, citations, the auto-apply policy and the escalation guard come
// from @supaknowledge/core's curator engine, and each trace goes through the same sanitising as the traces
// function. The numbers it prints are produced by the scripts, so they show that the harness and the loop work,
// not how well any model does.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { importBundle, sanitizeToolEvent, ScriptedLLM, type Concept, type GenerateRequest, type TraceEvent } from "@supaknowledge/core";
import { CLUSTER_SYSTEM, CORRECTIONS_SYSTEM, DRAFT_SYSTEM, REVIEW_SYSTEM, runTask } from "@supaknowledge/core/curator";
import { readBundle, REVENUE_TABLE_PATH } from "@supaknowledge/example-revenue-report/lib";
import { MemoryStore } from "@supaknowledge/example-revenue-report/memory-store";
import { type EvalResults, summarize, TaskLog, type TaskRun } from "./harness.ts";
import { type AgentEnv, type EvalTask, SUBSCRIPTIONS_PATH, TASKS } from "./tasks.ts";
import { executeSql, listTables, runWarehouseQuery, WarehouseError } from "./worlds.ts";

export const EVAL_KNOWLEDGE_DIR = join(fileURLToPath(new URL("..", import.meta.url)), "knowledge");
const SPACE = "acme";
const FINANCE_GROUP = "g-finance";

export const OFFLINE_NOTE =
  "Offline mode: a scripted agent and a scripted curator model on simulated data sources. These numbers come from " +
  "the scripts and show that the harness and the curator loop work end to end; they are not a measurement of any model.";

/** The revenue-report bundle plus the eval's own concepts (data/supabase/subscriptions). */
export function evalBundle() {
  return [...readBundle(), ...readBundle(EVAL_KNOWLEDGE_DIR)];
}

function loadStore(): MemoryStore {
  // the revenue-report space policy: low-risk data_access fixes backed by real agent work apply themselves
  const store = new MemoryStore({ auto_apply: { enabled: true, kinds: ["data_access"], max_risk: "low", require_observed_evidence: true } });
  const parsed = importBundle(evalBundle(), { toId: (slug) => (slug === "finance" ? FINANCE_GROUP : undefined), toSlug: (id) => (id === FINANCE_GROUP ? "finance" : undefined) });
  for (const ic of parsed.concepts) {
    store.concepts.push({
      ...ic.draft, id: `concept:${ic.draft.path}`, space_id: SPACE, revision: 1, generated_by: "import:okf",
      generated_at: "2026-11-01T00:00:00.000Z", created_at: "", updated_at: "",
    } satisfies Concept);
  }
  return store;
}

/** The agent's view of the store: only concepts without an audience (the agent is in no group), stable ones. */
function offlineEnv(store: MemoryStore, log: TaskLog, traceId: string): AgentEnv {
  const visible = () => store.concepts.filter((c) => !c.audience.length && c.status !== "draft");
  const read = async (tool: string, path: string, input: unknown) => {
    const c = visible().find((x) => x.path === path);
    log.tool(tool, input, c ? c.body : `No concept at ${path}`, !c);
    return c ? { path: c.path, body: c.body } : null;
  };
  return {
    read: (path) => read("read_concept", path, { path }),
    loadSkill: (name) => read("load_skill", `skills/${name}`, { name }),
    async search(query) {
      const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const hits = visible().filter((c) => words.some((w) => `${c.path} ${c.title} ${c.body}`.toLowerCase().includes(w))).slice(0, 5);
      log.tool("search_knowledge", { query }, hits.map((h) => h.path), false);
      return hits.map((h) => ({ path: h.path, title: h.title }));
    },
    async flag(f) {
      log.agentFlags++;
      log.tool("flag_knowledge", f, "ok", false);
      store.flags.push({
        id: store.id("flag"), space_id: SPACE, created_by: "agent:eval", trace_id: traceId, kind: f.kind,
        concept_id: f.conceptPath ? `concept:${f.conceptPath}` : null, concept_path: f.conceptPath ?? null, query: f.query ?? null,
        observation: f.observation, suggested_fix: f.suggestedFix ?? null, evidence: {}, audience: [], status: "open", synthetic: false,
        created_at: "2026-11-27T00:00:00.000Z",
      });
    },
    async warehouse(sql) {
      try {
        const r = runWarehouseQuery(sql);
        log.tool("bigquery.query", { sql }, r.rows, false);
        return { rows: r.rows };
      } catch (e) {
        if (!(e instanceof WarehouseError)) throw e;
        log.tool("bigquery.query", { sql }, e.message, true);
        return { error: e.message };
      }
    },
    async executeSql(query) {
      const r = executeSql(query);
      log.tool("mcp__supabase__execute_sql", { query }, r, r.isError === true);
      return r;
    },
    async listTables() {
      const r = listTables();
      log.tool("mcp__supabase__list_tables", { schemas: ["public", "billing"] }, r, false);
      return r;
    },
  };
}

async function runPhase(store: MemoryStore, phase: "before" | "after"): Promise<TaskRun[]> {
  const runs: TaskRun[] = [];
  for (const task of TASKS) {
    const traceId = `trace-${phase}-${task.id}`;
    const log = new TaskLog();
    const answer = await task.scripted(offlineEnv(store, log, traceId));
    const success = task.check(answer);
    const corrected = !success && !!task.correction;
    // what the traces function would store: tool payloads sanitised (Supabase MCP SQL: no literals, no rows)
    const events: Omit<TraceEvent, "seq">[] = [
      { role: "user", content: task.prompt },
      ...log.calls.map((c) => sanitizeToolEvent({ role: "tool" as const, tool_name: c.name, tool_input: c.input, tool_output: c.output, is_error: c.isError })),
      { role: "assistant", content: answer },
      ...(corrected ? [{ role: "feedback" as const, content: task.correction! }] : []),
    ];
    store.traces.push({
      id: traceId, space_id: SPACE, principal_id: "agent:eval", name: task.title, outcome: corrected ? "corrected" : success ? "success" : "failure",
      audience: [], metadata: { eval_phase: phase, task: task.id }, started_at: "2026-11-27T00:00:00.000Z",
      events: events.map((e, i) => ({ seq: i + 1, ...e })) as TraceEvent[],
      // the second phase is only measured; no curator run follows it
      ...(phase === "after" ? { curated: true } : {}),
    });
    runs.push(log.result(task, answer, success, corrected, traceId));
  }
  return runs;
}

/** What a model would answer at each curator step, written by hand for these tasks. */
export function scriptedCurator(store: MemoryStore): ScriptedLLM {
  const body = (path: string) => store.concepts.find((x) => x.path === path)!.body;
  const starts = (req: GenerateRequest<unknown>, prompt: string) => req.system.startsWith(prompt.slice(0, 60));
  const op = (path: string, newBody: string, labels: string[], rationale: string) => ({
    op: "update", path, new_path: null, kind: null, type: null, title: null, description: null, body: newBody, tags: null,
    superseded_by: null, stale_after: null, citation_labels: labels, rationale,
  });
  const propose = (title: string, risk: "low" | "medium", rationale: string, path: string, newBody: string, label: string, flagIds: string[], quote: string) => ({
    decision: "propose", title, risk, rationale, ops: [op(path, newBody, [label], rationale)],
    citations: [{ label, ref: `flag:${flagIds[0]}`, quote }], resolves_flags: flagIds, dismiss_flags: [],
  });

  return new ScriptedLLM((req: GenerateRequest<unknown>) => {
    const input = Array.isArray(req.input) ? req.input.join("\n") : req.input;

    // 1. correction mining: one lesson per human correction the scripts know about
    if (starts(req, CORRECTIONS_SYSTEM)) {
      const seq = Number(/\[(\d+)\] feedback/.exec(input)?.[1] ?? 0);
      if (input.includes("ACME CONFIDENTIAL")) {
        return { lessons: [{
          seqs: [seq], kind: "missing", knowledge_kind: "skill", lesson: "Every report must start with the line 'ACME CONFIDENTIAL', above the title.",
          observation: "The agent sent the revenue report without the ACME CONFIDENTIAL header.", evidence_quote: "every report needs the ACME CONFIDENTIAL header",
          concept_path: "skills/revenue-report", durable: true,
        }] };
      }
      if (input.includes("status 'live'")) {
        return { lessons: [{
          seqs: [seq], kind: "outdated", knowledge_kind: "data_access", lesson: "Active subscriptions are billing.subscriptions rows with status 'live'.",
          observation: "The documented table public.subscriptions and status 'active' no longer exist.", evidence_quote: "billing.subscriptions with status 'live'",
          concept_path: SUBSCRIPTIONS_PATH, durable: true,
        }] };
      }
      return { lessons: [] };
    }

    // 2. triage of signals that are not attached to a concept
    if (starts(req, CLUSTER_SYSTEM)) {
      const ids = [...input.matchAll(/^(f:\S+|d:\S+):/gm)].map((m) => m[1]!);
      return { clusters: [{ topic: "Loose signals", signal_ids: ids, concept_paths: [], research_query: "revenue", priority: "low" }], ignored: [] };
    }

    // 3. drafting, one target concept at a time
    if (starts(req, DRAFT_SYSTEM)) {
      const flagIds = [...input.matchAll(/### flag:(\S+)/g)].map((m) => m[1]!);
      const has = (path: string) => input.includes(`### concept:${path}\n`);
      if (has(REVENUE_TABLE_PATH)) {
        const next = body(REVENUE_TABLE_PATH)
          .replace(/\| `revenue_usd` \|[^\n]*\n/, "| `revenue_usd_net` | NUMERIC | Recognized revenue in USD, net of discounts and credits. Renamed from `revenue_usd`.[^renamed-column] |\n")
          .replace(/revenue_usd\)/g, "revenue_usd_net)")
          .trimEnd() + "\n[^renamed-column]: BigQuery rejected `revenue_usd` and suggested `revenue_usd_net`, which worked.\n";
        return propose("Revenue table: revenue_usd was renamed to revenue_usd_net", "low", "The documented query fails on `revenue_usd`; `revenue_usd_net` works.", REVENUE_TABLE_PATH, next, "renamed-column", flagIds, "Did you mean revenue_usd_net?");
      }
      if (has(SUBSCRIPTIONS_PATH)) {
        const next = body(SUBSCRIPTIONS_PATH)
          .replaceAll("public.subscriptions", "billing.subscriptions")
          .replace("`trial`, `active` or `cancelled`.", "`trialing`, `live` or `canceled`; active subscriptions are `live`.")
          .replace("status = 'active'", "status = 'live'")
          .trimEnd() + "\n[^billing-migration]: The data owner's correction: the table moved to the billing schema and 'active' became 'live'.\n";
        const withRef = next.replace("customer subscription in `billing.subscriptions`.", "customer subscription in `billing.subscriptions`.[^billing-migration]");
        return propose("Subscriptions: billing.subscriptions, active means status 'live'", "low", "execute_sql failed on public.subscriptions and on status 'active'; the data owner gave the new names.", SUBSCRIPTIONS_PATH, withRef, "billing-migration", flagIds, "billing.subscriptions with status 'live'");
      }
      if (has("skills/revenue-report")) {
        const next = body("skills/revenue-report")
          .replace("5. Check before sending:", "6. Check before sending:\n   - the first line is `ACME CONFIDENTIAL`;")
          .replace("4. Fill in", "5. Fill in").replace("3. Compute", "4. Compute").replace("2. Query", "3. Query")
          .replace("1. Read the [report formatting policy]", "1. Start the report with the line `ACME CONFIDENTIAL`, above the title.[^confidential-header]\n2. Read the [report formatting policy]")
          .trimEnd() + "\n\n[^confidential-header]: The finance lead's correction on the November 2026 revenue report.\n";
        return propose("Revenue report skill: start every report with ACME CONFIDENTIAL", "medium", "The finance lead asked for the header on every report.", "skills/revenue-report", next, "confidential-header", flagIds, "every report needs the ACME CONFIDENTIAL header");
      }
      // metrics/arr: the explanation lives in finance-only material the drafter may not use for this concept
      return { decision: "no_change", title: "No change", rationale: "The evidence does not say why the two ARR numbers differ.", risk: "low", ops: [], citations: [], resolves_flags: [], dismiss_flags: [] };
    }

    // 4. self-review
    if (starts(req, REVIEW_SYSTEM)) return { ok: true, issues: [], risk: "low" };
    throw new Error(`unexpected prompt: ${req.system.slice(0, 80)}`);
  });
}

export interface OfflineOptions {
  /** approve pending proposals that are not escalations before the second phase (the simulated reviewer). Default true. */
  review?: boolean;
}

export async function runOfflineEval(opts: OfflineOptions = {}): Promise<{ results: EvalResults; store: MemoryStore }> {
  const review = opts.review ?? true;
  const store = loadStore();
  const before = await runPhase(store, "before");

  const llm = scriptedCurator(store);
  const first = store.createRun(SPACE);
  for (let i = 0; i < 100 && store.queue.length; i++) await runTask({ store, llm }, store.queue.shift()!);
  const run = store.runs.get(first.run_id)!;

  let approved = 0;
  if (review) {
    for (const p of store.proposals) {
      if (p.status !== "pending" || p.escalation) continue;
      await store.applyProposal(p.id, "human:reviewer");
      approved++;
    }
  }
  const after = await runPhase(store, "after");

  const results: EvalResults = {
    mode: "offline",
    agent: "scripted",
    curator_model: "scripted",
    note: OFFLINE_NOTE,
    generated_at: new Date().toISOString(),
    tasks: TASKS.map((t: EvalTask, i) => ({ id: t.id, title: t.title, before: before[i]!, after: after[i]! })),
    summary: { before: summarize(before), after: summarize(after) },
    curator: {
      run_status: run.status,
      stats: run.stats,
      proposals: store.proposals.map((p) => ({
        title: p.title, risk: p.risk, status: p.status, auto_applied: p.auto_applied, escalation: p.escalation, paths: p.ops.map((o) => o.path),
      })),
      review: review ? `simulated reviewer approved ${approved} pending proposal(s); escalations wait for a space admin` : "no review: pending proposals stay pending",
    },
  };
  return { results, store };
}
