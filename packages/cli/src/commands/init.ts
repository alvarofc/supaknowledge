import type { Command } from "commander";
import { resolve } from "node:path";
import { writeProjectFile } from "../config.ts";
import { CliError, must, type Ctx } from "../context.ts";
import type { Runner } from "../program.ts";

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

interface InitOpts {
  workspace?: string;
  name?: string;
  workspaceName?: string;
  visibility?: "workspace" | "private";
  description?: string;
  dir?: string;
}

export function registerInit(program: Command, run: Runner): void {
  program
    .command("init")
    .description("create the workspace and space if missing, and write .supaknowledge.json (default space for this directory)")
    .option("-w, --workspace <slug>", "workspace slug (created if it does not exist)")
    .addHelpText("before", "Uses the global --space <slug> (or --space <workspace>/<space>) for the space to create or select.\n")
    .option("--name <name>", "space display name (default: the slug)")
    .option("--workspace-name <name>", "workspace display name (default: the slug)")
    .option("--description <text>", "space description")
    .option("--visibility <v>", "workspace (every member can read) | private", "workspace")
    .option("--dir <dir>", "where to write .supaknowledge.json", ".")
    .addHelpText("after", "\nExample:\n  kf init --workspace acme --space finance --name 'Finance agents'")
    .action(run(init));
}

async function init(ctx: Ctx, opts: InitOpts): Promise<void> {
  // --space is a global option; accept "<space>" with --workspace, or "<workspace>/<space>"
  const spec = ctx.g.space ?? "";
  const [wsPart, spPart] = spec.includes("/") ? spec.split("/", 2) : [undefined, spec];
  opts.workspace ??= wsPart;
  const space = spPart ?? "";
  if (!opts.workspace || !space) throw new CliError("usage: kf init --workspace <slug> --space <slug>", { exitCode: 2 });
  if (!SLUG.test(opts.workspace)) throw new CliError(`invalid workspace slug "${opts.workspace}" (lowercase letters, digits, hyphens; 2-63 chars)`, { exitCode: 2 });
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(space)) throw new CliError(`invalid space slug "${space}"`, { exitCode: 2 });
  if (opts.visibility !== "workspace" && opts.visibility !== "private") throw new CliError("--visibility must be workspace or private", { exitCode: 2 });
  const db = await ctx.db();

  let createdWorkspace = false;
  let createdSpace = false;
  let ws = (await must(db.from("workspaces").select("id, slug, name").eq("slug", opts.workspace).limit(1)))[0] as { id: string; slug: string; name: string } | undefined;
  if (!ws) {
    const res = await db.rpc("create_workspace", { p_slug: opts.workspace, p_name: opts.workspaceName ?? opts.workspace });
    if (res.error?.code === "23505") throw new CliError(`workspace "${opts.workspace}" exists but you are not a member`, { hint: "ask a workspace admin to add you, or pick another slug" });
    ws = (await must(Promise.resolve(res))) as { id: string; slug: string; name: string };
    createdWorkspace = true;
  }

  let sp = (await must(db.from("spaces").select("id, slug, name").eq("workspace_id", ws.id).eq("slug", space).limit(1)))[0] as { id: string; slug: string; name: string } | undefined;
  if (!sp) {
    const res = await db.rpc("create_space", {
      p_workspace: ws.id,
      p_slug: space,
      p_name: opts.name ?? space,
      p_description: opts.description ?? null,
      p_visibility: opts.visibility,
    });
    if (res.error?.code === "42501") throw new CliError(`you cannot create spaces in "${ws.slug}"`, { hint: "workspace admins create spaces" });
    if (res.error?.code === "23505") throw new CliError(`space "${space}" exists in "${ws.slug}" but you cannot see it`, { hint: "ask a space admin to add you" });
    sp = (await must(Promise.resolve(res))) as { id: string; slug: string; name: string };
    createdSpace = true;
  }

  const ref = `${ws.slug}/${sp.slug}`;
  const file = writeProjectFile(resolve(ctx.io.cwd, opts.dir ?? "."), { space: ref, space_id: sp.id, workspace_id: ws.id, url: ctx.url() });
  ctx.out({ workspace: ws, space: { ...sp, ref }, created_workspace: createdWorkspace, created_space: createdSpace, file }, () =>
    [
      `${createdWorkspace ? ctx.c.green("created") : ctx.c.dim("found")}   workspace ${ws.slug}`,
      `${createdSpace ? ctx.c.green("created") : ctx.c.dim("found")}   space ${ref}`,
      `${ctx.c.green("wrote")}     ${file}`,
      "",
      `Next: ${ctx.c.bold("kf import <dir> --apply")} to load knowledge, or ${ctx.c.bold("kf mcp-config")} to connect an agent.`,
    ].join("\n"),
  );
}
