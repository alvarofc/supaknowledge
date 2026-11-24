// Release consistency checks (run by CI and the release workflow):
//   - every published package has the same version: the 3 npm packages, SDK_VERSION in the TS SDK, the Python
//     package version (pyproject.toml) and supaknowledge.__version__;
//   - @supaknowledge/mastra's peer range on @supaknowledge/sdk accepts that version;
//   - with --tag vX.Y.Z (or GITHUB_REF_TYPE=tag), the tag matches;
//   - LICENSE and NOTICE copies shipped inside each package are identical to the repository root ones.
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const errors = [];

const versions = {
  "packages/sdk/package.json": JSON.parse(read("packages/sdk/package.json")).version,
  "packages/mastra/package.json": JSON.parse(read("packages/mastra/package.json")).version,
  "packages/cli/package.json": JSON.parse(read("packages/cli/package.json")).version,
  "packages/sdk/src/client.ts SDK_VERSION": /export const SDK_VERSION = "([^"]+)"/.exec(read("packages/sdk/src/client.ts"))?.[1],
  "sdks/python/pyproject.toml": /^version = "([^"]+)"$/m.exec(read("sdks/python/pyproject.toml"))?.[1],
  "sdks/python/src/supaknowledge/client.py __version__": /^__version__ = "([^"]+)"$/m.exec(read("sdks/python/src/supaknowledge/client.py"))?.[1],
};
const version = versions["packages/sdk/package.json"];
for (const [where, v] of Object.entries(versions)) {
  if (!v) errors.push(`${where}: version not found`);
  else if (v !== version) errors.push(`${where} is ${v}, expected ${version}`);
}

// ^X.Y.Z (the only range form we use) must accept the release version
const peer = JSON.parse(read("packages/mastra/package.json")).peerDependencies?.["@supaknowledge/sdk"];
const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(peer ?? "");
const [maj, min, pat] = (version ?? "").split(".").map(Number);
if (!m) errors.push(`packages/mastra peerDependencies["@supaknowledge/sdk"] should be a caret range, got ${peer}`);
else {
  const [M, N, P] = m.slice(1).map(Number);
  const ok = M > 0 ? maj === M && (min > N || (min === N && pat >= P)) : maj === 0 && min === N && pat >= P;
  if (!ok) errors.push(`packages/mastra peer range ${peer} does not accept @supaknowledge/sdk ${version}`);
}

const tagArg = process.argv.indexOf("--tag");
const tag = tagArg > 0 ? process.argv[tagArg + 1] : process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
if (tag && tag !== `v${version}`) errors.push(`tag ${tag} does not match package version v${version}`);

for (const file of ["LICENSE", "NOTICE"]) {
  const root = read(file);
  for (const dir of ["packages/sdk", "packages/mastra", "packages/cli", "sdks/python"]) {
    let copy;
    try {
      copy = read(`${dir}/${file}`);
    } catch {
      errors.push(`${dir}/${file} is missing (copy it from the repository root)`);
      continue;
    }
    if (copy !== root) errors.push(`${dir}/${file} differs from the root ${file} (copy it again)`);
  }
}

if (errors.length) {
  for (const e of errors) console.error(process.env.GITHUB_ACTIONS ? `::error::${e}` : `error: ${e}`);
  process.exit(1);
}
console.log(`release check ok: version ${version}${tag ? ` (tag ${tag})` : ""}`);
if (process.env.GITHUB_OUTPUT) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
