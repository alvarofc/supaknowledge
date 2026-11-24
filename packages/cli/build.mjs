// Bundles src/bin.ts (+ the workspace packages @supaknowledge/core and @supaknowledge/sdk, which ship as TS source) into
// dist/kf.js. Third-party runtime dependencies stay external and are installed from package.json.
import { build } from "esbuild";
import { chmodSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// The CLI only needs core's format code (OKF / Agent Skills import, export, lint). Resolve @supaknowledge/core to
// that module so the curator's LLM dependencies (@mastra/core, zod) are not bundled.
const coreSrc = dirname(createRequire(import.meta.url).resolve("@supaknowledge/core"));
const coreFormatsOnly = {
  name: "core-formats-only",
  setup(b) {
    b.onResolve({ filter: /^@supaknowledge\/core$/ }, () => ({ path: join(coreSrc, "okf.ts") }));
  },
};

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
rmSync("dist", { recursive: true, force: true });
const result = await build({
  entryPoints: ["src/bin.ts"],
  outfile: "dist/kf.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  conditions: ["supaknowledge-source"],
  external: Object.keys(pkg.dependencies),
  banner: { js: "#!/usr/bin/env node" },
  define: { __KF_VERSION__: JSON.stringify(pkg.version) },
  sourcemap: true,
  metafile: true,
  plugins: [coreFormatsOnly],
  legalComments: "none",
});
// guard: nothing outside the declared dependencies may be imported at runtime
const allowed = new Set([...Object.keys(pkg.dependencies)]);
const bad = new Set();
for (const out of Object.values(result.metafile.outputs)) {
  for (const imp of out.imports) {
    if (!imp.external || imp.path.startsWith("node:")) continue;
    const name = imp.path.startsWith("@") ? imp.path.split("/").slice(0, 2).join("/") : imp.path.split("/")[0];
    if (!allowed.has(name)) bad.add(imp.path);
  }
}
if (bad.size) {
  console.error(`dist/kf.js imports undeclared packages: ${[...bad].join(", ")}`);
  process.exit(1);
}
console.log("built @supaknowledge/cli -> dist/kf.js");

// keep the binary executable across rebuilds
chmodSync("dist/kf.js", 0o755);
