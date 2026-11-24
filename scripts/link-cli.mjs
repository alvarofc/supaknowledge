#!/usr/bin/env node
// Makes the freshly built `kf` runnable from the repo: `npx kf ...` (or node_modules/.bin/kf).
// esbuild writes packages/cli/dist/kf.js without the executable bit, and on a fresh clone `npm install` ran
// before dist/ existed, so npm never linked the bin. Without the link, `npx kf` would look for an unrelated
// `kf` package on the registry.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "packages/cli/dist/kf.js");
if (!existsSync(bin)) {
  console.error("packages/cli/dist/kf.js is missing; run npm run build -w @supaknowledge/cli first");
  process.exit(1);
}
chmodSync(bin, 0o755);
const r = spawnSync("npm", ["rebuild", "@supaknowledge/cli"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log("kf is ready: npx kf --help");
