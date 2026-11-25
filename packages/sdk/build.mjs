// Builds dist/index.js (ESM, platform-neutral: Node 18+, Deno, browsers, edge runtimes) and .d.ts files.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
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
});
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.build.json"], { stdio: "inherit" });
// tsc keeps the ".ts" specifiers of the sources in .d.ts files; point them at the emitted .js/.d.ts pairs
for (const f of readdirSync("dist").filter((f) => f.endsWith(".d.ts"))) {
  const p = `dist/${f}`;
  writeFileSync(p, readFileSync(p, "utf8").replace(/(from\s+["']\.{1,2}\/[^"']+)\.ts(["'])/g, "$1.js$2"));
}
console.log("built @supaknowledge/sdk -> dist/");
