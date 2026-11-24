#!/usr/bin/env node
// Fails when supabase/functions/_shared/core is not an exact copy of packages/core/src (run `npm run sync:shared`).
// CI does the same with git (`npm run sync:shared && git diff --exit-code`); this version also works before the
// first commit and does not touch the working tree.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "packages/core/src");
const dest = join(root, "supabase/functions/_shared/core");

function files(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

const a = files(src);
const b = files(dest).filter((f) => f !== "README.md");
const problems = [
  ...a.filter((f) => !b.includes(f)).map((f) => `missing in _shared/core: ${f}`),
  ...b.filter((f) => !a.includes(f)).map((f) => `extra in _shared/core: ${f}`),
  ...a.filter((f) => b.includes(f) && !readFileSync(join(src, f)).equals(readFileSync(join(dest, f)))).map((f) => `differs: ${f}`),
];
if (problems.length) {
  console.error(`supabase/functions/_shared/core is out of date with packages/core/src:\n  ${problems.join("\n  ")}\nRun: npm run sync:shared`);
  process.exit(1);
}
console.log(`_shared/core matches packages/core/src (${a.length} files)`);
