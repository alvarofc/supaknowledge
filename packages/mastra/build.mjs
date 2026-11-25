// Builds dist/index.js (ESM; @mastra/core, zod and @supaknowledge/sdk stay external) and .d.ts files.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** The `tsc` bin of the installed TypeScript (resolved through package.json: TypeScript 7 does not export bin/). */
function tscBin() {
  const pkgPath = require.resolve("typescript/package.json");
  const bin = JSON.parse(readFileSync(pkgPath, "utf8")).bin;
  return join(dirname(pkgPath), typeof bin === "string" ? bin : bin.tsc);
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
// declarations import @supaknowledge/sdk's published types; (re)build them first inside the monorepo
if (existsSync("../sdk/build.mjs")) {
  execFileSync(process.execPath, ["build.mjs"], { cwd: "../sdk", stdio: "inherit" });
}
rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  sourcemap: false,
  legalComments: "none",
  external: [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {}), "@mastra/core/*"],
});
execFileSync(process.execPath, [tscBin(), "-p", "tsconfig.build.json"], { stdio: "inherit" });
for (const f of readdirSync("dist").filter((f) => f.endsWith(".d.ts"))) {
  const p = `dist/${f}`;
  writeFileSync(p, readFileSync(p, "utf8").replace(/(from\s+["']\.{1,2}\/[^"']+)\.ts(["'])/g, "$1.js$2"));
}
console.log("built @supaknowledge/mastra -> dist/");
