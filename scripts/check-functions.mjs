#!/usr/bin/env node
// Type-checks every Edge Function with Deno, against its own deno.json import map and lockfile.
//   node scripts/check-functions.mjs [name...]
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DENO = process.env.DENO ?? "deno@2.9.6";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fnDir = join(root, "supabase/functions");
const wanted = process.argv.slice(2);
const names = readdirSync(fnDir)
  .filter((n) => !n.startsWith("_") && existsSync(join(fnDir, n, "index.ts")) && existsSync(join(fnDir, n, "deno.json")))
  .filter((n) => !wanted.length || wanted.includes(n))
  .sort();

let failed = 0;
for (const name of names) {
  const r = spawnSync(
    "npx",
    ["--yes", DENO, "check", "--frozen", "--minimum-dependency-age", "0", "--config", `supabase/functions/${name}/deno.json`, `supabase/functions/${name}/index.ts`],
    { cwd: root, encoding: "utf8" },
  );
  if (r.status === 0) console.log(`ok   ${name}`);
  else {
    failed++;
    console.log(`FAIL ${name}\n${r.stdout}${r.stderr}`);
  }
}
if (!names.length) {
  console.error("no functions found");
  process.exit(1);
}
process.exit(failed ? 1 : 0);
