// Reading bundle directories and writing exported files safely (only files we manage get overwritten).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface BundleFile {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}

/** Always skipped silently, whatever .gitignore says (every other dotfile is skipped too, and reported). */
const ALWAYS_SKIP = new Set([".git", "node_modules", ".DS_Store", "Thumbs.db", ".supaknowledge-manifest.json", ".supaknowledge.json", ".supaknowledge"]);
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // concept-files bucket limit

// -------------------------------------------------------------------------------------------------------
// .gitignore-ish matching (enough for bundle trees: globs, **, dir/ patterns, anchors and negation)
// -------------------------------------------------------------------------------------------------------

interface IgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

function globToRegex(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // "**/" = any number of directories, trailing "**" = everything
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (ch === "[") {
      const end = glob.indexOf("]", i);
      if (end > i) {
        re += glob.slice(i, end + 1);
        i = end;
      } else re += "\\[";
    } else re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return re;
}

export function parseIgnore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    }
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith("/") || line.slice(0, -1).includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    const body = globToRegex(line);
    rules.push({ re: new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`), negate, dirOnly });
  }
  return rules;
}

export function isIgnored(rules: IgnoreRule[], relPath: string, isDir: boolean): boolean {
  let ignored = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.re.test(relPath)) ignored = !r.negate;
  }
  return ignored;
}

/** Text if it decodes as UTF-8 and has no NUL bytes; base64 otherwise. */
export function encodeFile(buf: Buffer): { content: string; encoding: "utf8" | "base64" } {
  if (!buf.subarray(0, 8192).includes(0)) {
    try {
      return { content: new TextDecoder("utf-8", { fatal: true }).decode(buf), encoding: "utf8" };
    } catch {
      /* binary */
    }
  }
  return { content: buf.toString("base64"), encoding: "base64" };
}

export interface ReadTreeResult {
  files: BundleFile[];
  skipped: { path: string; reason: string }[];
}

/** Read a bundle / skills directory recursively into bundle files (POSIX paths relative to `root`). */
export function readTree(root: string): ReadTreeResult {
  const abs = resolve(root);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`${root} is not a directory`);
  const files: BundleFile[] = [];
  const skipped: ReadTreeResult["skipped"] = [];
  const rules: IgnoreRule[] = [];
  for (const name of [".gitignore", ".kfignore"]) {
    const p = join(abs, name);
    if (existsSync(p)) rules.push(...parseIgnore(readFileSync(p, "utf8")));
  }

  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, ent.name);
      const rel = relative(abs, full).split(sep).join("/");
      if (ALWAYS_SKIP.has(ent.name) || ent.name === ".gitignore" || ent.name === ".kfignore") continue;
      // dotfiles and dot-directories (.env, .github, .vscode, ...) are never uploaded: they hold secrets and tooling
      // config, not knowledge. Reported so nobody wonders where a file went.
      if (ent.name.startsWith(".")) {
        if (!isIgnored(rules, rel, ent.isDirectory())) skipped.push({ path: ent.isDirectory() ? `${rel}/` : rel, reason: "dotfile" });
        continue;
      }
      if (ent.isSymbolicLink()) {
        skipped.push({ path: rel, reason: "symlink" });
        continue;
      }
      if (ent.isDirectory()) {
        if (isIgnored(rules, rel, true)) continue;
        walk(full);
      } else if (ent.isFile()) {
        if (isIgnored(rules, rel, false)) continue;
        const size = statSync(full).size;
        if (size > MAX_FILE_BYTES) {
          skipped.push({ path: rel, reason: `larger than ${MAX_FILE_BYTES / 1024 / 1024} MB` });
          continue;
        }
        files.push({ path: rel, ...encodeFile(readFileSync(full)) });
      }
    }
  };
  walk(abs);
  return { files, skipped };
}

// -------------------------------------------------------------------------------------------------------
// managed writes
// -------------------------------------------------------------------------------------------------------

export interface Manifest {
  version: 1;
  space?: string;
  written_at?: string;
  /** path relative to the manifest's root -> sha256 of the bytes we wrote */
  files: Record<string, string>;
}

export function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function readManifest(path: string): Manifest {
  if (!existsSync(path)) return { version: 1, files: {} };
  try {
    const m = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    return { ...m, version: 1, files: m.files ?? {} };
  } catch {
    return { version: 1, files: {} };
  }
}

export interface WriteTarget {
  /** path relative to `root` */
  path: string;
  data: Buffer;
}

export interface WriteReport {
  written: string[];
  unchanged: string[];
  /** existed and was not ours, or was edited locally since we wrote it */
  skipped: { path: string; reason: string }[];
  deleted: string[];
  kept: { path: string; reason: string }[];
}

export function toBuffer(f: BundleFile): Buffer {
  return f.encoding === "base64" ? Buffer.from(f.content, "base64") : Buffer.from(f.content, "utf8");
}

/** Reject absolute paths and `..` segments coming from the server. */
export function safeRelPath(p: string): string | null {
  const norm = p.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!norm || norm.startsWith("/") || /^[A-Za-z]:/.test(norm) || norm.split("/").some((s) => s === ".." || s === "")) return null;
  return norm;
}

/**
 * Write `targets` under `root`, tracked in the manifest at `manifestPath` (keys relative to `root`).
 *  - a file we never wrote is only overwritten with `force`
 *  - a file we wrote but that was edited locally since is only overwritten with `force`
 *  - files we wrote earlier that are no longer exported are deleted (unless edited locally)
 */
export function writeManaged(
  root: string,
  manifestPath: string,
  targets: WriteTarget[],
  opts: { force?: boolean; dryRun?: boolean; space?: string; prune?: boolean; scope?: (path: string) => boolean } = {},
): WriteReport {
  const report: WriteReport = { written: [], unchanged: [], skipped: [], deleted: [], kept: [] };
  const prev = readManifest(manifestPath);
  const next: Manifest = { version: 1, space: opts.space ?? prev.space, written_at: new Date().toISOString(), files: {} };
  // entries outside this write's scope are carried over untouched
  for (const [p, h] of Object.entries(prev.files)) if (opts.scope && !opts.scope(p)) next.files[p] = h;

  const seen = new Set<string>();
  for (const t of targets) {
    const rel = safeRelPath(t.path);
    if (!rel) {
      report.skipped.push({ path: t.path, reason: "unsafe path" });
      continue;
    }
    seen.add(rel);
    const full = join(root, rel);
    const hash = sha256(t.data);
    if (existsSync(full)) {
      const current = sha256(readFileSync(full));
      if (current === hash) {
        report.unchanged.push(rel);
        next.files[rel] = hash;
        continue;
      }
      const ours = prev.files[rel];
      if (!opts.force && (!ours || ours !== current)) {
        report.skipped.push({ path: rel, reason: ours ? "edited locally" : "not managed by kf" });
        if (ours) next.files[rel] = ours;
        continue;
      }
    }
    if (!opts.dryRun) {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, t.data);
    }
    report.written.push(rel);
    next.files[rel] = hash;
  }

  if (opts.prune !== false) {
    for (const [rel, hash] of Object.entries(prev.files)) {
      if (seen.has(rel) || (opts.scope && !opts.scope(rel))) continue;
      const full = join(root, rel);
      if (!existsSync(full)) continue;
      if (sha256(readFileSync(full)) !== hash && !opts.force) {
        report.kept.push({ path: rel, reason: "edited locally" });
        continue;
      }
      if (!opts.dryRun) {
        rmSync(full);
        pruneEmptyDirs(dirname(full), root);
      }
      report.deleted.push(rel);
    }
  }

  if (!opts.dryRun) {
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(next, null, 2) + "\n");
  }
  return report;
}

function pruneEmptyDirs(dir: string, stop: string): void {
  const top = resolve(stop);
  let d = resolve(dir);
  while (d.startsWith(top) && d !== top) {
    try {
      if (readdirSync(d).length) return;
      rmdirSync(d);
    } catch {
      return;
    }
    d = dirname(d);
  }
}
