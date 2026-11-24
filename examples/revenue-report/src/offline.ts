// The revenue-report story without a Supabase stack or an API key.
//
//   npm run offline -w @supaknowledge/example-revenue-report
//
// It loads the same knowledge bundle as the live demo into an in-memory store, replays what the working agent
// and the people around it do (a flag, a trace with a human correction, a question about ARR), and runs the
// real curator engine (@supaknowledge/core runTask) with a scripted model instead of a real one. Everything except the
// model's answers is the production code path: triage, evidence rendering, citations -> OKF sources, the
// auto-apply policy and the escalation guard.
import { fileURLToPath } from "node:url";
import { createTwoFilesPatch } from "diff";
import { importBundle, ScriptedLLM, type Concept, type GenerateRequest } from "@supaknowledge/core";
import { CLUSTER_SYSTEM, CORRECTIONS_SYSTEM, DRAFT_SYSTEM, REVIEW_SYSTEM, runTask } from "@supaknowledge/core/curator";
import { MemoryStore, type StoredProposal } from "./memory-store.ts";
import { c, FINANCE_ONLY_PATH, readBundle, REVENUE_TABLE_PATH, runWarehouseQuery, say, STORY, WarehouseError } from "./lib.ts";

const SPACE = "acme";
const FINANCE_GROUP = "g-finance";
const AGENT = "agent:revenue-report";

/** What a model would answer at each curator step, written by hand for this story. */
function scriptedCurator(store: MemoryStore) {
  const body = (path: string) => store.concepts.find((x) => x.path === path)!.body;
  const prefix = (s: string) => s.slice(0, 60);

  return new ScriptedLLM((req: GenerateRequest<unknown>) => {
    const input = Array.isArray(req.input) ? req.input.join("\n") : req.input;
    const flagId = /### flag:(\S+)/.exec(input)?.[1];
    const traceId = /### trace:(\S+)/.exec(input)?.[1];

    // 1. correction mining: the finance lead's "from now on ..." becomes a lesson
    if (req.system.startsWith(prefix(CORRECTIONS_SYSTEM))) {
      return {
        lessons: [{
          seqs: [9, 10], kind: "missing", knowledge_kind: "skill",
          lesson: "Every report must start with the line 'ACME CONFIDENTIAL', above the title.",
          observation: "The agent sent the revenue report without the ACME CONFIDENTIAL header and the finance lead had to ask for it.",
          evidence_quote: "from now on every report needs the ACME CONFIDENTIAL header at the very top",
          concept_path: "skills/revenue-report", durable: true,
        }],
      };
    }

    // 2. triage of signals that are not attached to a concept (none in this story: every flag names one)
    if (req.system.startsWith(prefix(CLUSTER_SYSTEM))) {
      const ids = [...input.matchAll(/^(f:\S+|d:\S+):/gm)].map((m) => m[1]!);
      return { clusters: [{ topic: "Loose signals", signal_ids: ids, concept_paths: [], research_query: "revenue report", priority: "low" }], ignored: [] };
    }

    // 3. drafting, one cluster at a time
    if (req.system.startsWith(prefix(DRAFT_SYSTEM))) {
      const op = (path: string, newBody: string, labels: string[], rationale: string) => ({
        op: "update", path, new_path: null, kind: null, type: null, title: null, description: null, body: newBody, tags: null,
        superseded_by: null, stale_after: null, citation_labels: labels, rationale,
      });

      if (input.includes(`### concept:${REVENUE_TABLE_PATH}\n`)) {
        const next = body(REVENUE_TABLE_PATH)
          .replace(
            /\| `revenue_usd` \|[^\n]*\n/,
            "| `revenue_usd_net` | NUMERIC | Recognized revenue in USD, net of discounts and credits. Renamed from `revenue_usd` in November 2026.[^renamed-column] |\n" +
              "| `revenue_usd_gross` | NUMERIC | Recognized revenue in USD before discounts and credits.[^renamed-column] |\n",
          )
          .replace("sum(revenue_usd)", "sum(revenue_usd_net)")
          .trimEnd() + "\n[^renamed-column]: BigQuery rejected `revenue_usd` during the November 2026 revenue report; `revenue_usd_net` worked.\n";
        return {
          decision: "propose", title: "Revenue table: revenue_usd was renamed to revenue_usd_net", risk: "low",
          rationale: "The working agent's query failed on `revenue_usd` and succeeded with `revenue_usd_net`; the trace shows the error and the fix.",
          ops: [op(REVENUE_TABLE_PATH, next, ["renamed-column", ...(traceId ? ["renamed-column-trace"] : [])], "Column renamed upstream")],
          citations: [
            { label: "renamed-column", ref: `flag:${flagId}`, quote: "Unrecognized name: revenue_usd; Did you mean revenue_usd_net?" },
            ...(traceId ? [{ label: "renamed-column-trace", ref: `trace:${traceId}`, quote: STORY.fixedQuery.split("\n")[0]! }] : []),
          ],
          resolves_flags: flagId ? [flagId] : [], dismiss_flags: [],
        };
      }

      if (input.includes("### concept:skills/revenue-report\n")) {
        const next = body("skills/revenue-report")
          .replace("5. Check before sending:", "6. Check before sending:\n   - the first line is `ACME CONFIDENTIAL`;")
          .replace("4. Fill in", "5. Fill in")
          .replace("3. Compute", "4. Compute")
          .replace("2. Query", "3. Query")
          .replace(
            "1. Read the [report formatting policy]",
            "1. Start the report with the line `ACME CONFIDENTIAL`, above the title. Finance requires it on every report.[^confidential-header]\n2. Read the [report formatting policy]",
          )
          .trimEnd() + "\n\n[^confidential-header]: The finance lead's correction in the November 2026 revenue report trace.\n";
        return {
          decision: "propose", title: "Revenue report skill: start every report with ACME CONFIDENTIAL", risk: "medium",
          rationale: "The finance lead corrected the agent: every report needs the ACME CONFIDENTIAL header. That is a durable rule, so the skill should apply it.",
          ops: [op("skills/revenue-report", next, ["confidential-header"], "New house rule from finance")],
          citations: [{ label: "confidential-header", ref: `flag:${flagId}`, quote: "from now on every report needs the ACME CONFIDENTIAL header at the very top" }],
          resolves_flags: flagId ? [flagId] : [], dismiss_flags: [],
        };
      }

      if (input.includes("### concept:metrics/arr\n")) {
        const next = body("metrics/arr").replace(
          "Related: ",
          "## ARR is not committed ARR\n\nOperational reports use ARR as defined above. The board pack uses a different, finance-only " +
            "\"committed ARR\" that also counts signed contracts that are not live yet; do not use or quote it in other reports.[^board-pack]\n\nRelated: ",
        ).trimEnd() + "\n[^board-pack]: Board pack revenue adjustments (finance).\n";
        return {
          decision: "propose", title: "ARR: explain why the board pack number differs", risk: "medium",
          rationale: "An engineer asked why two ARR numbers circulate. The finance-only board pack concept explains it.",
          ops: [op("metrics/arr", next, ["board-pack", "arr-question"], "Disambiguate ARR and committed ARR")],
          citations: [
            { label: "board-pack", ref: `concept:${FINANCE_ONLY_PATH}`, quote: "The board pack reports committed ARR" },
            { label: "arr-question", ref: `flag:${flagId}`, quote: "Which ARR should reports use?" },
          ],
          resolves_flags: flagId ? [flagId] : [], dismiss_flags: [],
        };
      }
      return { decision: "no_change", title: "Nothing to change", rationale: "No evidence for a change.", risk: "low", ops: [], citations: [], resolves_flags: [], dismiss_flags: [] };
    }

    // 4. self-review
    if (req.system.startsWith(prefix(REVIEW_SYSTEM))) {
      if (input.includes("committed ARR")) {
        return { ok: true, risk: "medium", issues: [{ severity: "warning", kind: "other", detail: "Summarises a finance-only concept in a concept everyone can read." }] };
      }
      return { ok: true, issues: [], risk: "low" };
    }
    throw new Error(`unexpected prompt: ${req.system.slice(0, 80)}`);
  });
}

function printDiff(path: string, before: string, after: string) {
  const patch = createTwoFilesPatch(`${path} (before)`, `${path} (after)`, before, after, "", "", { context: 1 });
  for (const line of patch.split("\n").slice(3)) {
    if (!line || line.startsWith("\\")) continue;
    const colored = line.startsWith("+") ? c.green(line) : line.startsWith("-") ? c.red(line) : line.startsWith("@@") ? c.dim(line) : line;
    console.log(`      ${colored}`);
  }
}

export interface OfflineResult {
  store: MemoryStore;
  runStatus: string;
  proposals: StoredProposal[];
}

export async function runOfflineDemo(opts: { quiet?: boolean } = {}): Promise<OfflineResult> {
  const log = console.log;
  if (opts.quiet) console.log = () => {};
  try {
    return await story();
  } finally {
    console.log = log;
  }
}

async function story(): Promise<OfflineResult> {
  console.log(c.bold("Supaknowledge revenue-report demo (offline: in-memory store, scripted model)"));

  // ------------------------------------------------------------------------------------------------------
  say.step("Load the Acme Analytics knowledge bundle (OKF concepts + an Agent Skill)");
  const store = new MemoryStore({
    // the space policy: low-risk data_access fixes backed by real agent work apply themselves
    auto_apply: { enabled: true, kinds: ["data_access"], max_risk: "low", require_observed_evidence: true },
  });
  const parsed = importBundle(readBundle(), { toId: (slug) => (slug === "finance" ? FINANCE_GROUP : undefined), toSlug: (id) => (id === FINANCE_GROUP ? "finance" : undefined) });
  for (const ic of parsed.concepts) {
    store.concepts.push({
      ...ic.draft, id: `concept:${ic.draft.path}`, space_id: SPACE, revision: 1, generated_by: "import:okf",
      generated_at: new Date().toISOString(), created_at: "", updated_at: "",
    } satisfies Concept);
    say.info(`${ic.draft.path.padEnd(32)} ${ic.draft.kind.padEnd(12)} ${ic.draft.type}${ic.draft.audience.length ? c.yellow("  (audience: finance)") : ""}`);
  }
  const before = new Map(store.concepts.map((x) => [x.path, x.body]));

  // ------------------------------------------------------------------------------------------------------
  say.step("The working agent writes the November revenue report and hits a renamed column");
  const traceId = "trace-november-report";
  const events: { role: "user" | "assistant" | "tool" | "feedback"; content?: string; tool_name?: string; tool_input?: unknown; tool_output?: unknown; is_error?: boolean }[] = [];
  events.push({ role: "user", content: STORY.ask });
  events.push({ role: "tool", tool_name: "load_skill", tool_input: { name: "revenue-report" }, tool_output: "skills/revenue-report (6 steps)" });
  events.push({ role: "tool", tool_name: "read_concept", tool_input: { path: REVENUE_TABLE_PATH }, tool_output: "column revenue_usd ..." });
  say.actor("agent", `reads ${REVENUE_TABLE_PATH}: it documents \`revenue_usd\``);
  try {
    runWarehouseQuery(STORY.firstQuery);
  } catch (e) {
    const msg = (e as WarehouseError).message;
    events.push({ role: "tool", tool_name: "bigquery.query", tool_input: { sql: STORY.firstQuery }, tool_output: msg, is_error: true });
    say.actor("warehouse", c.red(msg));
  }
  const result = runWarehouseQuery(STORY.fixedQuery);
  events.push({ role: "tool", tool_name: "bigquery.query", tool_input: { sql: STORY.fixedQuery }, tool_output: result.rows });
  say.actor("agent", `retries with \`revenue_usd_net\`: ${result.rows.length} rows`);
  const dataFlag = {
    id: "flag-renamed-column", space_id: SPACE, created_by: AGENT, trace_id: traceId, kind: STORY.flag.kind,
    concept_id: `concept:${REVENUE_TABLE_PATH}`, concept_path: REVENUE_TABLE_PATH, query: STORY.flag.query,
    observation: STORY.flag.observation, suggested_fix: STORY.flag.suggestedFix, evidence: { via: "mcp" }, audience: [],
    status: "open" as const, synthetic: false, created_at: new Date().toISOString(),
  };
  store.flags.push(dataFlag);
  say.actor("agent", `flag_knowledge(kind=${dataFlag.kind}, concept_path=${REVENUE_TABLE_PATH}, suggested_fix=...)`);

  // ------------------------------------------------------------------------------------------------------
  say.step("The finance lead corrects the report format (recorded in the agent's trace)");
  events.push({ role: "assistant", content: STORY.draftWithoutHeader });
  events.push({ role: "feedback", content: STORY.correction });
  events.push({ role: "assistant", content: STORY.draftWithHeader + STORY.draftWithoutHeader });
  say.actor("finance lead", `"${STORY.correction.split(". ")[0]}."`);
  store.traces.push({
    id: traceId, space_id: SPACE, principal_id: AGENT, name: "November revenue report", outcome: "corrected", audience: [], metadata: {},
    started_at: new Date().toISOString(),
    events: events.map((e, i) => ({ seq: i + 1, ...e })),
  });
  say.info(`trace "${c.bold("November revenue report")}" with ${events.length} events, outcome = corrected`);

  say.step("An engineer is confused by two different ARR numbers");
  store.flags.push({
    id: "flag-arr-question", space_id: SPACE, created_by: "human:engineer", trace_id: null, kind: "unclear",
    concept_id: "concept:metrics/arr", concept_path: "metrics/arr", query: "ARR for the leadership deck",
    observation: "The leadership deck says ARR is $50.9M but the revenue report says $48.3M. Which ARR should reports use?",
    suggested_fix: null, evidence: {}, audience: [], status: "open", synthetic: false, created_at: new Date().toISOString(),
  });
  say.actor("engineer", "flag_knowledge(kind=unclear, concept_path=metrics/arr)");
  say.info(`the engineer is not in ${c.bold("finance")}, so ${FINANCE_ONLY_PATH} is invisible to them`);

  // ------------------------------------------------------------------------------------------------------
  say.step("The curator runs (same engine as the `curator` Edge Function, scripted model)");
  const llm = scriptedCurator(store);
  const first = store.createRun(SPACE);
  while (store.queue.length) {
    const task = store.queue.shift()!;
    const out = await runTask({ store, llm }, task);
    const label = task.step === "draft" ? `draft: ${(task.input as { topic?: string }).topic}` : task.step;
    say.info(`${c.bold(label.padEnd(44))} ${c.dim(JSON.stringify(out))}`);
  }
  const run = store.runs.get(first.run_id)!;
  say.ok(`run ${run.status}: ${JSON.stringify(run.stats)}`);
  say.info(`model calls: ${llm.calls.length} (correction mining, 3 drafts, 3 self-reviews)`);

  // ------------------------------------------------------------------------------------------------------
  say.step("Proposals: the policy decides what applies itself, people review the rest");
  for (const p of store.proposals) {
    const status = p.status === "applied" ? c.green(p.auto_applied ? "auto-applied" : "applied") : c.yellow("pending review");
    console.log(`\n    ${c.bold(p.title)}`);
    say.info(`risk ${p.risk}${p.escalation ? c.red(" · ESCALATION (restricted evidence into a wider audience)") : ""} · ${status}`);
    say.info(`citations: ${p.citations.map((x) => `[^${x.label}] ${x.ref_kind}${x.audience.length ? c.yellow(" (finance only)") : ""}`).join(", ")}`);
    for (const o of p.ops) printDiff(o.path, before.get(o.path) ?? "", o.after.body ?? before.get(o.path) ?? "");
  }

  // ------------------------------------------------------------------------------------------------------
  say.step("Human review");
  const skillFix = store.proposals.find((p) => p.ops[0]?.path === "skills/revenue-report");
  if (skillFix) {
    await store.applyProposal(skillFix.id, "human:finance-lead");
    say.actor("finance lead", `approves "${skillFix.title}"`);
  }
  const escalation = store.proposals.find((p) => p.escalation);
  if (escalation) {
    say.actor("engineer", "cannot see the ARR proposal at all: it cites a finance-only concept");
    say.info(`"${escalation.title}" waits for a space admin in finance (escalations never auto-apply)`);
  }

  // ------------------------------------------------------------------------------------------------------
  say.step("Next month: the agent reads the updated knowledge and gets it right the first time");
  const table = store.concepts.find((x) => x.path === REVENUE_TABLE_PATH)!;
  const skill = store.concepts.find((x) => x.path === "skills/revenue-report")!;
  say.info(`${REVENUE_TABLE_PATH} is at revision ${table.revision} (by ${table.generated_by})`);
  const query = /```sql\n([\s\S]*?)```/.exec(table.body)?.[1] ?? "";
  const rerun = runWarehouseQuery(query);
  say.ok(`the documented query runs: ${rerun.rows.length} rows`);
  say.ok(`skill step 1: ${/1\. (.*)/.exec(skill.body)?.[1]?.replace(/\[\^.*$/, "")}`);
  console.log(`\n${c.dim("Run the same story against a real stack with your model as the curator: npm run demo -w @supaknowledge/example-revenue-report")}`);

  return { store, runStatus: run.status, proposals: store.proposals };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runOfflineDemo().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
