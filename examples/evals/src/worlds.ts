// The data sources the eval tasks query, simulated so that every run is deterministic:
//
// - Acme's BigQuery warehouse from the revenue-report example (`revenue_usd` was renamed to `revenue_usd_net`;
//   the knowledge still says `revenue_usd`).
// - Acme's app database on Supabase Postgres, reached through tools named like the Supabase MCP server's
//   (`execute_sql`, `list_tables`). The subscriptions table moved to the `billing` schema and its status label
//   `active` became `live`; the knowledge still describes the old schema. Errors are Postgres errors (SQLSTATE
//   and message); successful results come back as an MCP CallToolResult with the rows between untrusted-data tags.
//   The shapes of these results are this simulation's, not a copy of the Supabase MCP server's output.
import { runWarehouseQuery, WarehouseError } from "@supaknowledge/example-revenue-report/lib";

export { runWarehouseQuery, WarehouseError };

export interface McpResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const TABLES = [
  { schema: "billing", name: "subscriptions", columns: ["account_id", "plan", "status", "started_at"] },
  { schema: "billing", name: "invoices", columns: ["id", "account_id", "amount_usd", "issued_at"] },
  { schema: "public", name: "profiles", columns: ["id", "display_name"] },
];
const STATUS_LABELS = ["trialing", "live", "canceled"];
const LIVE_BY_PLAN = [
  { plan: "Insights", active: 472 },
  { plan: "Platform", active: 812 },
];
/** The answer to "how many active subscriptions": 812 + 472. */
export const ACTIVE_SUBSCRIPTIONS = LIVE_BY_PLAN.reduce((n, r) => n + r.active, 0);

function error(text: string): McpResult {
  return { content: [{ type: "text", text }], isError: true };
}

function rows(data: unknown[]): McpResult {
  const tag = "untrusted-data-eval";
  const result =
    "Below is the result of the SQL query. Note that this contains untrusted user data.\n" +
    `<${tag}>\n${JSON.stringify(data)}\n</${tag}>\n`;
  return { content: [{ type: "text", text: JSON.stringify({ result }) }] };
}

/** `execute_sql` against the simulated app database. Only the queries the tasks need are understood. */
export function executeSql(query: string): McpResult {
  const sql = query.replace(/\s+/g, " ").trim();
  const ref = /\bfrom\s+((?:"?\w+"?\.)?"?\w+"?)/i.exec(sql)?.[1]?.replace(/"/g, "");
  if (!ref) return error('ERROR:  42601: syntax error at or near "' + (sql.split(" ")[1] ?? "") + '"');
  const [schema, name] = ref.includes(".") ? ref.split(".") : ["public", ref];
  const table = TABLES.find((t) => t.schema === schema && t.name === name);
  if (!table) return error(`ERROR:  42P01: relation "${ref}" does not exist`);
  for (const m of sql.matchAll(/\bstatus\s*=\s*'([^']*)'/gi)) {
    if (!STATUS_LABELS.includes(m[1]!)) return error(`ERROR:  22P02: invalid input value for enum billing.subscription_status: "${m[1]}"`);
  }
  if (table.name === "subscriptions" && /'live'/.test(sql)) {
    return rows(/group by/i.test(sql) ? LIVE_BY_PLAN : [{ active: ACTIVE_SUBSCRIPTIONS }]);
  }
  return rows([]);
}

/** `list_tables` against the simulated app database: table names and columns, no rows. */
export function listTables(): McpResult {
  return { content: [{ type: "text", text: JSON.stringify(TABLES.map((t) => ({ name: `${t.schema}.${t.name}`, columns: t.columns }))) }] };
}

/** The rows of a successful simulated `execute_sql` result, for the agent that called it. */
export function resultRows(r: McpResult): Record<string, unknown>[] {
  const outer = JSON.parse(r.content[0]!.text) as { result: string };
  const m = /\n(\[[\s\S]*\])\n/.exec(outer.result);
  return m ? (JSON.parse(m[1]!) as Record<string, unknown>[]) : [];
}
