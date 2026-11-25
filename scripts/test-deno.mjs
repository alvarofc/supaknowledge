#!/usr/bin/env node
// Runs every Edge Function Deno test suite (supabase/functions/<fn>/test and _shared/test), each against its
// function's own deno.json (import map) so tests resolve dependencies exactly like the deployed function.
//   node scripts/test-deno.mjs [name...]      e.g. node scripts/test-deno.mjs connectors _shared
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnNpx } from "./npx.mjs";

const DENO = process.env.DENO ?? "deno@2.9.6";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fnDir = join(root, "supabase/functions");
const wanted = process.argv.slice(2);
const suites = readdirSync(fnDir)
  .filter((n) => existsSync(join(fnDir, n, "test")))
  .filter((n) => !wanted.length || wanted.includes(n))
  .sort()
  .map((n) => ({
    name: n,
    // _shared has no function config of its own: its base import map covers every shared dependency
    config: n === "_shared" ? "supabase/functions/_shared/deno.base.json" : `supabase/functions/${n}/deno.json`,
  }));

if (!suites.length) {
  console.error("no Deno test suites found");
  process.exit(1);
}
let failed = 0;
for (const s of suites) {
  console.log(`\n=== ${s.name}`);
  const r = spawnNpx(
    ["--yes", DENO, "test", "--no-lock", "--minimum-dependency-age", "0", "--allow-read", "--allow-env", "--config", s.config, `supabase/functions/${s.name}/test/`],
    { cwd: root, stdio: "inherit" },
  );
  if (r.error) console.error(r.error.message);
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} Deno suite(s) failed` : `\nall ${suites.length} Deno suites passed`);
process.exit(failed ? 1 : 0);
