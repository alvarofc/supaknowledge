// Shared pieces of the revenue-report demo: the knowledge bundle on disk, the simulated warehouse, the working
// agent's script and console narration.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const EXAMPLE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const KNOWLEDGE_DIR = join(EXAMPLE_DIR, "knowledge");

// ---------------------------------------------------------------------------------------------------------
// the bundle
// ---------------------------------------------------------------------------------------------------------

export interface BundleFile {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}

/** Every file of an OKF bundle / Agent Skills tree, as the `bundle` function and @supaknowledge/core expect it. */
export function readBundle(dir = KNOWLEDGE_DIR): BundleFile[] {
  const out: BundleFile[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith(".")) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ path: relative(dir, p).split(sep).join("/"), content: readFileSync(p, "utf8"), encoding: "utf8" });
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// the story
// ---------------------------------------------------------------------------------------------------------

/** The finance-only concept (x-supaknowledge-audience: [finance]). */
export const FINANCE_ONLY_PATH = "finance/board-pack";
export const REVENUE_TABLE_PATH = "data/bigquery/revenue";
export const SKILL_NAME = "revenue-report";

export const STORY = {
  ask: "Draft the November 2026 revenue report for Monday's leadership sync.",
  firstQuery: [
    "select region, sum(revenue_usd) as revenue_usd",
    "from `acme-prod.finance.revenue_daily`",
    "where invoice_date between '2026-11-01' and '2026-11-30'",
    "group by region order by 2 desc",
  ].join("\n"),
  fixedQuery: [
    "select region, sum(revenue_usd_net) as revenue_usd",
    "from `acme-prod.finance.revenue_daily`",
    "where invoice_date between '2026-11-01' and '2026-11-30'",
    "group by region order by 2 desc",
  ].join("\n"),
  flag: {
    kind: "outdated" as const,
    query: "monthly revenue by region for the November 2026 revenue report",
    observation:
      "Querying `acme-prod.finance.revenue_daily` as documented failed with `Unrecognized name: revenue_usd; Did you mean revenue_usd_net?`. " +
      "The table guide still lists `revenue_usd`. Re-running with `revenue_usd_net` worked and the November total matched finance's close numbers.",
    suggestedFix:
      "Document `revenue_usd_net` (recognized revenue in USD, net of discounts and credits) instead of `revenue_usd`, update the example query, " +
      "and note that `revenue_usd_gross` now holds the pre-discount amount.",
  },
  draftWithoutHeader: [
    "# Revenue report: November 2026",
    "",
    "| Metric | November | vs. October | vs. Nov 2025 |",
    "|---|---|---|---|",
    "| Revenue | $4.3M | +3% | +21% |",
    "",
    "Sources: acme-prod.finance.revenue_daily, data as of 2026-12-01.",
  ].join("\n"),
  correction:
    "The numbers look right, but from now on every report needs the ACME CONFIDENTIAL header at the very top. " +
    "Legal asked for it after last quarter's deck leaked. Please fix this one too.",
  draftWithHeader: "ACME CONFIDENTIAL\n\n",
};

// ---------------------------------------------------------------------------------------------------------
// a tiny simulated warehouse: the column was renamed upstream, the knowledge still has the old name
// ---------------------------------------------------------------------------------------------------------

const REVENUE_DAILY_COLUMNS = ["invoice_date", "account_id", "region", "product_line", "revenue_usd_net", "revenue_usd_gross", "is_recurring"];

export class WarehouseError extends Error {}

export interface QueryResult {
  rows: { region: string; revenue_usd: number }[];
  bytes_processed: number;
}

/** BigQuery-flavoured: rejects identifiers that are not columns of finance.revenue_daily. */
export function runWarehouseQuery(sql: string): QueryResult {
  // column references only: drop aliases ("as revenue_usd") and ORDER BY, which may name aliases
  const refs = sql.replace(/\border\s+by[\s\S]*$/i, "").replace(/\bas\s+\w+/gi, "");
  for (const m of refs.matchAll(/\b(revenue_usd\w*)\b/gi)) {
    const col = m[1]!;
    if (!REVENUE_DAILY_COLUMNS.includes(col)) {
      const suggestion = REVENUE_DAILY_COLUMNS.find((x) => x.startsWith(col));
      throw new WarehouseError(`Unrecognized name: ${col}${suggestion ? `; Did you mean ${suggestion}?` : ""} at [1:23]`);
    }
  }
  return {
    rows: [
      { region: "NA", revenue_usd: 2_140_000 },
      { region: "EMEA", revenue_usd: 1_310_000 },
      { region: "APAC", revenue_usd: 640_000 },
      { region: "LATAM", revenue_usd: 210_000 },
    ],
    bytes_processed: 18_400_000,
  };
}

// ---------------------------------------------------------------------------------------------------------
// narration
// ---------------------------------------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  bold: paint("1"),
  dim: paint("2"),
  red: paint("31"),
  green: paint("32"),
  yellow: paint("33"),
  blue: paint("34"),
  magenta: paint("35"),
  cyan: paint("36"),
};

let stepNo = 0;
export const say = {
  step(title: string) {
    stepNo++;
    console.log(`\n${c.bold(c.cyan(`[${stepNo}] ${title}`))}`);
  },
  info(msg: string) {
    console.log(`    ${msg}`);
  },
  ok(msg: string) {
    console.log(`    ${c.green("✓")} ${msg}`);
  },
  warn(msg: string) {
    console.log(`    ${c.yellow("!")} ${msg}`);
  },
  no(msg: string) {
    console.log(`    ${c.red("✗")} ${msg}`);
  },
  actor(who: string, msg: string) {
    console.log(`    ${c.magenta(who.padEnd(14))} ${msg}`);
  },
  block(text: string, max = 14) {
    const lines = text.trimEnd().split("\n");
    for (const l of lines.slice(0, max)) console.log(`      ${c.dim("│")} ${l}`);
    if (lines.length > max) console.log(`      ${c.dim(`│ … ${lines.length - max} more lines`)}`);
  },
};

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function money(n: number): string {
  return n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : `$${Math.round(n / 1000)}K`;
}
