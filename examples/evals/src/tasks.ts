// The fixed task set. Each task is a question someone at Acme asks an agent, a deterministic check of the
// answer, optionally the correction that person gives when the answer misses (recorded as human feedback in the
// trace, like the finance lead in the revenue-report story), and the scripted agent's way of doing it.
//
// The scripted agent stands in for a model in offline mode (and in live mode without KF_LLM_MODEL). It does what
// the knowledge says, literally: it runs the documented example queries, follows the skill's steps, and recovers
// from an error only when the error itself says how (BigQuery's "Did you mean", a table found by list_tables).
import { parsePgError } from "@supaknowledge/core";
import { money, REVENUE_TABLE_PATH, STORY } from "@supaknowledge/example-revenue-report/lib";
import { ACTIVE_SUBSCRIPTIONS, type McpResult, resultRows } from "./worlds.ts";

export const SUBSCRIPTIONS_PATH = "data/supabase/subscriptions";

/** What an agent can do in a task. Every call is recorded on the task's trace by the harness. */
export interface AgentEnv {
  read(path: string): Promise<{ path: string; body: string } | null>;
  loadSkill(name: string): Promise<{ path: string; body: string } | null>;
  search(query: string): Promise<{ path: string; title: string }[]>;
  flag(input: { kind: "missing" | "incorrect" | "outdated" | "unclear"; conceptPath?: string; observation: string; suggestedFix?: string; query?: string }): Promise<void>;
  /** BigQuery (revenue-report's simulated warehouse): rows, or an error message */
  warehouse(sql: string): Promise<{ rows: { region: string; revenue_usd: number }[] } | { error: string }>;
  /** Supabase app database, through a tool named like the Supabase MCP server's */
  executeSql(query: string): Promise<McpResult>;
  listTables(): Promise<McpResult>;
}

export interface EvalTask {
  id: string;
  title: string;
  /** what the person asks */
  prompt: string;
  /** does the answer do what was asked? */
  check(answer: string): boolean;
  /** what the person says when the answer misses, recorded as human feedback on the trace */
  correction?: string;
  scripted(env: AgentEnv): Promise<string>;
}

// ---------------------------------------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------------------------------------

/** Does the text state this USD amount in a common format ($2.1M, $2.14M, 2,140,000, $640K...)? */
export function mentionsAmount(text: string, n: number): boolean {
  const t = text.replace(/ /g, " ");
  const forms = new Set([money(n), String(n), n.toLocaleString("en-US")]);
  if (n >= 1_000_000) {
    forms.add(`${(n / 1_000_000).toFixed(2)}M`);
    forms.add(`${(n / 1_000_000).toFixed(1)}M`);
    forms.add(`${(n / 1_000_000).toFixed(1)} million`);
  } else {
    forms.add(`${Math.round(n / 1000)}K`);
    forms.add(`${Math.round(n / 1000)}k`);
  }
  return [...forms].some((f) => t.includes(f));
}

const REGION_TOTALS: [string, number][] = [["NA", 2_140_000], ["EMEA", 1_310_000], ["APAC", 640_000], ["LATAM", 210_000]];
const NOVEMBER_TOTAL = REGION_TOTALS.reduce((n, [, v]) => n + v, 0);

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

// ---------------------------------------------------------------------------------------------------------
// the scripted agent's building blocks
// ---------------------------------------------------------------------------------------------------------

function sqlBlock(body: string | undefined): string | null {
  return body ? /```sql\n([\s\S]*?)```/.exec(body)?.[1]?.trim() ?? null : null;
}

/** Run the documented revenue query; on BigQuery's "Did you mean", retry with the suggestion and flag the doc. */
async function revenueByRegion(env: AgentEnv): Promise<{ region: string; revenue_usd: number }[] | null> {
  const doc = await env.read(REVENUE_TABLE_PATH);
  let sql = sqlBlock(doc?.body);
  if (!sql) return null;
  let res = await env.warehouse(sql);
  if ("error" in res) {
    const m = /Unrecognized name: (\w+); Did you mean (\w+)\?/.exec(res.error);
    if (!m) return null;
    sql = sql.replace(new RegExp(`\\b${m[1]}\\b`, "g"), m[2]!);
    res = await env.warehouse(sql);
    if ("error" in res) return null;
    await env.flag({
      kind: "outdated",
      conceptPath: REVENUE_TABLE_PATH,
      query: STORY.flag.query,
      observation: `The documented query failed with \`${m[0]}\`; it worked with \`${m[2]}\`.`,
      suggestedFix: `Document \`${m[2]}\` instead of \`${m[1]}\` and update the example query.`,
    });
  }
  return res.rows;
}

function regionLines(rows: { region: string; revenue_usd: number }[]): string {
  return rows.map((r) => `| ${r.region} | ${money(r.revenue_usd)} |`).join("\n");
}

function errorText(r: McpResult): string {
  return r.content.map((p) => p.text).join("\n");
}

// ---------------------------------------------------------------------------------------------------------
// the tasks
// ---------------------------------------------------------------------------------------------------------

export const TASKS: EvalTask[] = [
  {
    id: "revenue-by-region",
    title: "November revenue by region",
    prompt: "What was Acme's recognized revenue by region in November 2026? Query the warehouse.",
    check: (a) => REGION_TOTALS.every(([region, v]) => a.includes(region) && mentionsAmount(a, v)),
    async scripted(env) {
      const rows = await revenueByRegion(env);
      if (!rows) return "I could not query November revenue by region.";
      return `November 2026 recognized revenue by region:\n\n| Region | Revenue |\n|---|---|\n${regionLines(rows)}`;
    },
  },
  {
    id: "revenue-report",
    title: "Monthly revenue report in the house format",
    prompt: STORY.ask,
    check: (a) => firstLine(a) === "ACME CONFIDENTIAL" && mentionsAmount(a, NOVEMBER_TOTAL),
    correction: STORY.correction,
    async scripted(env) {
      const skill = await env.loadSkill("revenue-report");
      const rows = await revenueByRegion(env);
      if (!rows) return "I could not build the report: the revenue query failed.";
      const total = rows.reduce((n, r) => n + r.revenue_usd, 0);
      const report = [
        "# Revenue report: November 2026",
        "",
        `Total recognized revenue: ${money(total)}`,
        "",
        "| Region | Revenue |",
        "|---|---|",
        regionLines(rows),
        "",
        "Sources: acme-prod.finance.revenue_daily, data as of 2026-12-01.",
      ].join("\n");
      // the skill's steps are followed literally: a header rule is only applied when the skill states it
      return skill?.body.includes("ACME CONFIDENTIAL") ? `ACME CONFIDENTIAL\n\n${report}` : report;
    },
  },
  {
    id: "active-subscriptions",
    title: "Active subscriptions (Supabase app database)",
    prompt: "How many active subscriptions does Acme have, per plan and in total? Use the app database.",
    check: (a) => mentionsAmount(a, ACTIVE_SUBSCRIPTIONS) || a.includes(String(ACTIVE_SUBSCRIPTIONS)),
    correction:
      "Active subscriptions are the rows of billing.subscriptions with status 'live'. The table moved to the billing schema " +
      "and the 'active' label became 'live' in the billing migration.",
    async scripted(env) {
      const doc = await env.read(SUBSCRIPTIONS_PATH);
      let sql = sqlBlock(doc?.body);
      if (!sql) return "There is no documented way to count subscriptions.";
      let res = await env.executeSql(sql);
      const missing = res.isError ? parsePgError(errorText(res)) : null;
      if (missing?.condition === "undefined_table" && missing.identifiers.relation) {
        // look for a table with the same name in another schema
        const leaf = missing.identifiers.relation.split(".").pop()!;
        const tables = JSON.parse((await env.listTables()).content[0]!.text) as { name: string }[];
        const found = tables.find((t) => t.name.split(".").pop() === leaf);
        if (found) {
          sql = sql.replace(missing.identifiers.relation, found.name);
          res = await env.executeSql(sql);
        }
      }
      if (res.isError) return `I could not count active subscriptions: ${errorText(res)}`;
      const rows = resultRows(res) as { plan?: string; active: number }[];
      const total = rows.reduce((n, r) => n + Number(r.active), 0);
      return `Active subscriptions: ${rows.map((r) => `${r.plan} ${r.active}`).join(", ")}; ${total.toLocaleString("en-US")} in total.`;
    },
  },
  {
    id: "arr-definition",
    title: "ARR definition (control: the knowledge is right)",
    prompt: "How does Acme define ARR, and does it include services revenue?",
    check: (a) => /\b12\b|twelve/i.test(a) && /recurring/i.test(a) && /services/i.test(a) && /\b(never|not|exclud)/i.test(a),
    async scripted(env) {
      const doc = await env.read("metrics/arr");
      if (!doc) return "There is no ARR definition in the knowledge base.";
      const keep = doc.body.split("\n").filter((l) => /multiplied by 12|Services|recurring revenue/i.test(l));
      return keep.join("\n").replace(/\[\^[^\]]+\]/g, "").trim();
    },
  },
  {
    id: "arr-board-pack",
    title: "Why the board pack's ARR differs (needs finance-only knowledge)",
    prompt: "The board pack says ARR is $50.9M but the revenue report says $48.3M. Why do they differ?",
    check: (a) => /committed ARR/i.test(a),
    async scripted(env) {
      await env.search("board pack ARR");
      const doc = await env.read("metrics/arr");
      const para = doc?.body.split("\n\n").find((p) => /committed ARR/i.test(p));
      if (para) return para.replace(/\[\^[^\]]+\]/g, "").trim();
      await env.flag({
        kind: "unclear",
        conceptPath: "metrics/arr",
        query: "board pack ARR vs revenue report ARR",
        observation: "Asked why the board pack's ARR ($50.9M) differs from the revenue report's ($48.3M); the ARR concept does not mention a second ARR.",
      });
      return "The knowledge I can read does not explain the difference.";
    },
  },
];
