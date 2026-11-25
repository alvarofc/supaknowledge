// Release consistency checks (run by CI and the release workflow; `node scripts/check-release.mjs [--tag vX.Y.Z]`):
//   - every published package has the same version: the 3 npm packages, SDK_VERSION in the TS SDK, the Python
//     package version (pyproject.toml) and supaknowledge.__version__;
//   - @supaknowledge/mastra's peer range on @supaknowledge/sdk accepts that version, and the exact SDK pins (CLI
//     and mastra devDependencies) equal it;
//   - with --tag vX.Y.Z (or GITHUB_REF_TYPE=tag), the tag matches;
//   - LICENSE and NOTICE copies shipped inside each package are identical to the repository root ones.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// --- semver (the subset releases use: X.Y.Z[-prerelease][+build]) ------------------------------------------------

/** Parse a semver version; null when it is not one. */
export function parseSemver(v) {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v ?? "");
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : [] } : null;
}

/** Semver precedence: <0, 0, >0. Build metadata is ignored; a prerelease sorts before its release. */
export function compareSemver(a, b) {
  for (const k of ["major", "minor", "patch"]) if (a[k] !== b[k]) return a[k] - b[k];
  if (!a.pre.length || !b.pre.length) return (a.pre.length ? -1 : 0) + (b.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1; // numeric identifiers sort before alphanumeric ones
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Does the caret range `^X.Y.Z[-pre]` accept `version`, with npm's rules: below the next breaking version, and a
 * prerelease version only when the range names a prerelease of the same X.Y.Z.
 */
export function caretAccepts(range, version) {
  const r = /^\^(.+)$/.exec(range ?? "");
  const base = r && parseSemver(r[1]);
  const v = parseSemver(version);
  if (!base || !v) return false;
  if (compareSemver(v, base) < 0) return false;
  const same = (k) => v[k] === base[k];
  const belowUpper = base.major > 0 ? same("major") : base.minor > 0 ? same("major") && same("minor") : same("major") && same("minor") && same("patch");
  if (!belowUpper) return false;
  if (v.pre.length) return base.pre.length > 0 && same("major") && same("minor") && same("patch");
  return true;
}

/** The PEP 440 spelling of a semver version (0.1.0-rc.1 -> 0.1.0rc1); null when it has none. */
export function pep440(version) {
  const v = parseSemver(version);
  if (!v) return null;
  const core = `${v.major}.${v.minor}.${v.patch}`;
  if (!v.pre.length) return core;
  const m = /^(alpha|a|beta|b|rc|c)\.?(\d+)?$/.exec(v.pre.join("."));
  if (!m) return null;
  const tag = { alpha: "a", a: "a", beta: "b", b: "b", rc: "rc", c: "rc" }[m[1]];
  return `${core}${tag}${m[2] ?? "0"}`;
}

function main() {

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
  if (!parseSemver(version)) errors.push(`packages/sdk/package.json version ${version} is not a semver version`);
  // the Python package spells prereleases the PEP 440 way (0.1.0-rc.1 on npm is 0.1.0rc1 on PyPI)
  const pyVersion = pep440(version);
  if (version && parseSemver(version) && !pyVersion) errors.push(`version ${version} has no PEP 440 equivalent (use -alpha.N, -beta.N or -rc.N)`);
  for (const [where, v] of Object.entries(versions)) {
    const expected = where.startsWith("sdks/python/") ? pyVersion ?? version : version;
    if (!v) errors.push(`${where}: version not found`);
    else if (v !== expected) errors.push(`${where} is ${v}, expected ${expected}`);
  }

  // ^X.Y.Z[-pre] (the only range form we use) must accept the release version
  const peer = JSON.parse(read("packages/mastra/package.json")).peerDependencies?.["@supaknowledge/sdk"];
  if (!/^\^/.test(peer ?? "") || !parseSemver(peer.slice(1))) errors.push(`packages/mastra peerDependencies["@supaknowledge/sdk"] should be a caret range, got ${peer}`);
  else if (!caretAccepts(peer, version)) errors.push(`packages/mastra peer range ${peer} does not accept @supaknowledge/sdk ${version}`);

  // exact pins on the SDK (the CLI bundles it; mastra develops against it) must exist and be the release version
  for (const [file, field] of [["packages/cli/package.json", "devDependencies"], ["packages/mastra/package.json", "devDependencies"]]) {
    const pin = JSON.parse(read(file))[field]?.["@supaknowledge/sdk"];
    if (pin !== version) errors.push(`${file} ${field}["@supaknowledge/sdk"] is ${pin}, expected ${version}`);
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
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  }
}

// importable (for its semver helpers) without running the checks
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
