// npm run eval             live: against the local stack (`npx supabase start`)
// npm run eval:offline     offline: in-memory store, scripted agent and scripted curator model (deterministic, CI)
//
// Options (after `--`): --out <file> (default examples/evals/results/<mode>.json), --no-review,
// --agent scripted|model (live; default: a model when KF_LLM_MODEL is set), --reset (live: delete eval workspaces).
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";
import { c } from "@supaknowledge/example-revenue-report/lib";
import { type EvalResults, renderTable, writeResults } from "./harness.ts";
import { runOfflineEval } from "./offline.ts";
import { EvalError, resetLive, runLiveEval } from "./live.ts";

const RESULTS_DIR = join(fileURLToPath(new URL("..", import.meta.url)), "results");
const USAGE = "usage: npm run eval [-- --offline] [--out <file>] [--no-review] [--agent scripted|model] [--reset]";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function curatorLine(r: EvalResults): string {
  const ps = r.curator.proposals;
  const count = (f: (p: EvalResults["curator"]["proposals"][number]) => boolean) => ps.filter(f).length;
  const parts = [
    `${count((p) => p.auto_applied)} auto-applied by policy`,
    `${count((p) => p.status === "applied" && !p.auto_applied)} approved in review`,
    `${count((p) => p.status === "pending" && !p.escalation)} pending`,
    `${count((p) => p.escalation && p.status === "pending")} escalations pending`,
  ];
  const noChange = Number(r.curator.stats.no_change ?? 0);
  return `curator run ${r.curator.run_status}: ${ps.length} proposal(s), ${parts.join(", ")}${noChange ? `; ${noChange} draft(s) proposed no change` : ""}`;
}

async function main(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const offline = args.includes("--offline");
  if (args.includes("--reset")) {
    await resetLive();
    return;
  }
  const review = !args.includes("--no-review");
  const agent = arg(args, "--agent");
  if (agent && agent !== "scripted" && agent !== "model") throw new EvalError(`--agent must be scripted or model\n${USAGE}`);

  let results: EvalResults;
  if (offline) {
    console.log(c.bold("Supaknowledge evals, offline: scripted agent, scripted curator model, simulated data sources"));
    results = (await runOfflineEval({ review })).results;
  } else {
    console.log(c.bold("Supaknowledge evals, live"));
    results = await runLiveEval({ review, agent: (agent as "scripted" | "model" | undefined) ?? "auto", log: (l) => console.log(c.dim(l)) });
  }
  console.log(c.dim(results.note));
  console.log("");
  console.log(renderTable(results));
  console.log("");
  console.log(curatorLine(results));
  console.log(results.curator.review);
  // npm runs workspace scripts in the workspace; INIT_CWD is where `npm run eval` was typed
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const outArg = arg(args, "--out");
  const out = outArg ? resolve(cwd, outArg) : join(RESULTS_DIR, `${results.mode}.json`);
  writeResults(out, results);
  console.log(`results: ${relative(cwd, out) || out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(`${c.red("error:")} ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof EvalError && e.hint) console.error(`${c.yellow("hint:")} ${e.hint}`);
    process.exit(1);
  });
}
