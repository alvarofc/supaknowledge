import type { Command } from "commander";
import { isNotDeployed, SupaknowledgeError } from "@supaknowledge/sdk";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { exportViaRest, importViaRest, lintLocal, type ImportResponse, type LintResponse } from "../bundle-rest.ts";
import { CliError, type Ctx, type SpaceRef } from "../context.ts";
import { readTree, toBuffer, writeManaged, type BundleFile, type WriteReport, type WriteTarget } from "../files.ts";
import type { Runner } from "../program.ts";

export function registerBundle(program: Command, run: Runner): void {
  program
    .command("import")
    .description("import an OKF bundle and/or Agent Skills directory as a proposal (binary files are sent as base64)")
    .argument("<dir>", "directory with concept .md files and/or skills/<name>/SKILL.md")
    .option("--apply", "apply the proposal right away (reviewer role required)")
    .option("--title <title>", "proposal title")
    .addHelpText("after", "\nHonors .gitignore and .kfignore in <dir>; always skips .git, node_modules and dotfiles.\n\nExample:\n  kf import ./knowledge --apply --title 'Initial import'")
    .action(run(importCmd));

  program
    .command("lint")
    .description("check a bundle / skills directory against OKF and Agent Skills rules (exit 1 on problems)")
    .argument("<dir>")
    .action(run(lintCmd));

  program
    .command("export")
    .description("export the space as an OKF bundle (+ skills/) into <dir>")
    .argument("<dir>")
    .option("--public", "only concepts without an audience restriction")
    .option("--force", "overwrite files kf did not write (or that were edited since)")
    .option("--dry-run", "show what would change without writing")
    .action(run(exportCmd));

  program
    .command("pull")
    .description("write skills where agents load them (Claude Code, Deep Agents) plus the OKF bundle; only touches files kf manages")
    .option("--skills-dir <dir>", "where skills go (one folder per skill)", ".claude/skills")
    .option("--bundle-dir <dir>", "where the OKF bundle goes", ".supaknowledge/knowledge")
    .option("--no-skills", "do not write skills")
    .option("--no-bundle", "do not write the OKF bundle")
    .option("--force", "overwrite files kf did not write (or that were edited since)")
    .option("--dry-run", "show what would change without writing")
    .addHelpText(
      "after",
      "\nDirectories are relative to the project root (where .supaknowledge.json is; else the current directory).\nFiles kf writes are tracked in .supaknowledge/manifest.json next to .supaknowledge.json (or in the current directory).\nExisting files that kf did not write, or that you edited, are left alone unless --force.\n\nExamples:\n  kf pull\n  kf pull --skills-dir .deepagents/skills --no-bundle",
    )
    .action(run(pullCmd));
}

function loadDir(ctx: Ctx, dir: string): BundleFile[] {
  const abs = resolve(ctx.io.cwd, dir);
  let r;
  try {
    r = readTree(abs);
  } catch (e) {
    throw new CliError((e as Error).message, { exitCode: 2 });
  }
  for (const s of r.skipped) ctx.warn(`skipped ${s.path}: ${s.reason}`);
  if (!r.files.length) throw new CliError(`no files found in ${dir}`, { exitCode: 2 });
  return r.files;
}

const count = (v: unknown): number => (Array.isArray(v) ? v.length : Number(v ?? 0));

export async function importCmd(ctx: Ctx, dir: string, opts: { apply?: boolean; title?: string }): Promise<void> {
  const files = loadDir(ctx, dir);
  const sp = await ctx.space();
  let res: ImportResponse;
  let via = "function";
  let failure: string | null = null;
  try {
    res = await ctx.fn<ImportResponse>("bundle/import", { body: { space: sp.id, files, apply: Boolean(opts.apply), ...(opts.title ? { title: opts.title } : {}) } });
  } catch (e) {
    if (e instanceof SupaknowledgeError && e.details && typeof e.details === "object" && "proposal_id" in e.details) {
      // the proposal was created but applying it failed (permissions, conflict)
      res = e.details as ImportResponse;
      failure = e.message;
    } else if (isNotDeployed(e)) {
      ctx.note(ctx.c.dim("bundle function not deployed; importing through PostgREST"));
      via = "rest";
      res = await importViaRest(ctx, sp, files, opts);
      if (opts.apply && res.proposal_id && res.status !== "applied") {
        failure = res.apply_error ?? `proposal ${res.status ?? "not applied"}`;
      }
    } else throw e;
  }
  ctx.out({ ...res, files: files.length, via }, () => {
    const c = ctx.c;
    const lines = [
      `${files.length} files read from ${dir}`,
      `${c.green(String(count(res.created)))} new, ${c.yellow(String(count(res.updated)))} updated, ${c.dim(String(count(res.unchanged)))} unchanged`,
    ];
    for (const w of res.warnings ?? []) lines.push(`${c.yellow("warning:")} ${w}`);
    for (const p of ((res.problems as unknown[] | undefined) ?? []).flatMap(problemLines)) lines.push(`${c.yellow("lint:")} ${p}`);
    if (res.proposal_id) {
      lines.push(
        res.status === "applied"
          ? `${c.green("applied")} proposal ${res.proposal_id}${res.files_synced ? c.dim(` (${res.files_synced} skill files synced)`) : ""}`
          : `proposal ${c.bold(res.proposal_id)} is ${res.status ?? "pending"}: review with ${c.bold(`kf proposal ${res.proposal_id.slice(0, 8)}`)}`,
      );
    } else lines.push(c.dim("nothing to change"));
    return lines.join("\n");
  });
  if (failure) throw new CliError(`import created proposal ${res.proposal_id} but could not apply it: ${failure}`, { hint: `kf proposal ${res.proposal_id}`, reported: true });
}

function problemLines(p: unknown): string[] {
  if (typeof p === "string") return [p];
  if (p && typeof p === "object") {
    const o = p as { path?: string; problems?: string[]; problem?: string; message?: string };
    const msgs = o.problems ?? [o.problem ?? o.message ?? JSON.stringify(o)];
    return msgs.map((m) => (o.path ? `${o.path}: ${m}` : m));
  }
  return [String(p)];
}

async function lintCmd(ctx: Ctx, dir: string): Promise<void> {
  const files = loadDir(ctx, dir);
  let res: LintResponse | null = null;
  let via = "local";
  let sp: SpaceRef | null = null;
  try {
    sp = await ctx.space();
  } catch {
    sp = null; // lint works offline
  }
  if (sp) {
    try {
      res = await ctx.fn<LintResponse>("bundle/lint", { body: { space: sp.id, files } });
      via = "function";
    } catch (e) {
      if (!isNotDeployed(e)) throw e;
    }
  }
  res ??= lintLocal(files);
  // the function reports per-concept problems; the local linter a flat list
  const problems = [...(res.problems ?? []), ...(res.concepts ?? []).filter((c) => c.problems?.length).map((c) => ({ path: c.source ?? c.path, problems: c.problems }))].flatMap(problemLines);
  ctx.out({ ...res, via, ok: problems.length === 0 }, () => {
    const lines = [
      ...(res.warnings ?? []).map((w) => `${ctx.c.yellow("warning")} ${w}`),
      ...problems.map((p) => `${ctx.c.red("problem")} ${p}`),
    ];
    lines.push(problems.length ? ctx.c.red(`${problems.length} problem(s)`) : ctx.c.green(`ok: ${files.length} files`));
    return lines.join("\n");
  });
  if (problems.length) throw new CliError(`${problems.length} lint problem(s)`, { exitCode: 1, reported: true });
}

async function exportFiles(ctx: Ctx, sp: SpaceRef, publicOnly: boolean): Promise<BundleFile[]> {
  try {
    const r = await ctx.fn<{ files: BundleFile[] }>("bundle/export", { query: { space: sp.id, public: String(publicOnly) } });
    return r.files ?? [];
  } catch (e) {
    if (!isNotDeployed(e)) throw e;
    ctx.note(ctx.c.dim("bundle function not deployed; exporting through PostgREST"));
    return exportViaRest(ctx, sp, { publicOnly });
  }
}

function reportText(ctx: Ctx, r: WriteReport, dryRun: boolean, base = ""): string {
  const c = ctx.c;
  const p = (x: string) => (base ? posix.join(base, x) : x);
  const lines: string[] = [];
  for (const f of r.written) lines.push(`${c.green(dryRun ? "would write" : "wrote")}   ${p(f)}`);
  for (const f of r.deleted) lines.push(`${c.red(dryRun ? "would delete" : "deleted")} ${p(f)}`);
  for (const s of r.skipped) lines.push(`${c.yellow("skipped")} ${p(s.path)} ${c.dim(`(${s.reason}; --force to overwrite)`)}`);
  for (const s of r.kept) lines.push(`${c.yellow("kept")}    ${p(s.path)} ${c.dim(`(${s.reason})`)}`);
  lines.push(c.dim(`${r.written.length} written, ${r.unchanged.length} unchanged, ${r.deleted.length} deleted, ${r.skipped.length + r.kept.length} skipped`));
  return lines.join("\n");
}

async function exportCmd(ctx: Ctx, dir: string, opts: { public?: boolean; force?: boolean; dryRun?: boolean }): Promise<void> {
  const sp = await ctx.space();
  const files = await exportFiles(ctx, sp, Boolean(opts.public));
  const root = resolve(ctx.io.cwd, dir);
  const report = writeManaged(root, join(root, ".supaknowledge-manifest.json"), files.map((f) => ({ path: f.path, data: toBuffer(f) })), {
    force: opts.force,
    dryRun: opts.dryRun,
    space: sp.ref,
  });
  ctx.out({ dir: root, files: files.length, ...report }, () => reportText(ctx, report, Boolean(opts.dryRun)));
}

/** Map an exported bundle to the skills layout agents scan: <skills-dir>/<name>/SKILL.md (+ files). */
export function skillTargets(files: BundleFile[], skillsDir: string): WriteTarget[] {
  const skillDirs = files.filter((f) => /(^|\/)SKILL\.md$/.test(f.path)).map((f) => f.path.replace(/\/?SKILL\.md$/, ""));
  const out: WriteTarget[] = [];
  for (const d of skillDirs) {
    const name = d.split("/").pop() || "skill";
    for (const f of files) {
      if (d ? f.path.startsWith(d + "/") : f.path === "SKILL.md") {
        out.push({ path: posix.join(skillsDir, name, d ? f.path.slice(d.length + 1) : f.path), data: toBuffer(f) });
      }
    }
  }
  return out;
}

/**
 * A `kf pull` target directory as a POSIX path relative to the project root. Relative paths are relative to the
 * project root (where .supaknowledge.json lives), not the current directory, so `kf pull` writes to the same place
 * from any subdirectory. The root itself is refused: pruning is scoped to these directories.
 */
export function projectSubdir(root: string, dir: string, flag: string): string {
  const rel = relative(root, resolve(root, dir)).split("\\").join("/");
  if (rel === "" || rel === ".") throw new CliError(`${flag} must be a subdirectory of the project, not its root`, { exitCode: 2 });
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new CliError(`${flag} must be inside the project (${root})`, { exitCode: 2 });
  return rel.replace(/\/+$/, "");
}

async function pullCmd(
  ctx: Ctx,
  opts: { skillsDir: string; bundleDir: string; skills: boolean; bundle: boolean; force?: boolean; dryRun?: boolean },
): Promise<void> {
  const project = ctx.project();
  const root = project ? dirname(project.path) : resolve(ctx.io.cwd);
  const skillsDir = projectSubdir(root, opts.skillsDir, "--skills-dir");
  const bundleDir = projectSubdir(root, opts.bundleDir, "--bundle-dir");
  if (opts.skills && opts.bundle && (skillsDir === bundleDir || skillsDir.startsWith(bundleDir + "/") || bundleDir.startsWith(skillsDir + "/"))) {
    throw new CliError("--skills-dir and --bundle-dir must not overlap", { exitCode: 2 });
  }

  const sp = await ctx.space();
  const files = await exportFiles(ctx, sp, false);
  const targets: WriteTarget[] = [];
  if (opts.skills) targets.push(...skillTargets(files, skillsDir));
  if (opts.bundle) targets.push(...files.map((f) => ({ path: posix.join(bundleDir, f.path), data: toBuffer(f) })));
  const scopes = [opts.skills ? skillsDir + "/" : null, opts.bundle ? bundleDir + "/" : null].filter((x): x is string => Boolean(x));

  const report = writeManaged(root, join(root, ".supaknowledge", "manifest.json"), targets, {
    force: opts.force,
    dryRun: opts.dryRun,
    space: sp.ref,
    scope: (p) => scopes.some((s) => p.startsWith(s)),
  });
  const skillCount = files.filter((f) => /(^|\/)SKILL\.md$/.test(f.path)).length;
  ctx.out({ root, space: sp.ref, skills_dir: opts.skills ? skillsDir : null, bundle_dir: opts.bundle ? bundleDir : null, skills: skillCount, ...report }, () =>
    [
      reportText(ctx, report, Boolean(opts.dryRun)),
      opts.skills ? ctx.c.dim(`${skillCount} skill(s) in ${skillsDir}`) : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}
