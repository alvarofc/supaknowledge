import { Command, CommanderError, Option } from "commander";
import { SupaknowledgeError } from "@supaknowledge/sdk";
import { CliError, Ctx, type GlobalOpts, type Io } from "./context.ts";
import { registerAuth } from "./commands/auth.ts";
import { registerInit } from "./commands/init.ts";
import { registerBundle } from "./commands/bundle.ts";
import { registerKnowledge } from "./commands/knowledge.ts";
import { registerReview } from "./commands/review.ts";
import { registerCurator } from "./commands/curator.ts";
import { registerAgents } from "./commands/agents.ts";
import { registerMcp } from "./commands/mcp.ts";
import { registerSources } from "./commands/sources.ts";
import { registerMembers } from "./commands/members.ts";
import { registerDeploy } from "./commands/deploy.ts";
import { registerDemo } from "./commands/demo.ts";

declare const __KF_VERSION__: string | undefined;
export const VERSION = typeof __KF_VERSION__ === "string" ? __KF_VERSION__ : "0.0.0-dev";

/** Wraps a command body: builds the context from global options and passes positional args + options. */
export type Runner = <A extends unknown[]>(fn: (ctx: Ctx, ...args: A) => Promise<void>) => (...args: unknown[]) => Promise<void>;

export function buildProgram(io: Io): Command {
  const program = new Command("kf");
  const runner: Runner =
    (fn) =>
    async (...args) => {
      const cmd = args[args.length - 1] as Command;
      const ctx = new Ctx(io, cmd.optsWithGlobals() as GlobalOpts);
      await fn(ctx, ...(args.slice(0, -1) as never));
    };

  program
    .description("Supaknowledge command line (`kf`, also installed as `supaknowledge`): knowledge for your agents, kept current by a curator.")
    .version(VERSION, "-v, --version")
    .option("--json", "machine-readable JSON output")
    .option("-s, --space <space>", "space as <workspace>/<space> or uuid (default: SUPAKNOWLEDGE_SPACE or .supaknowledge.json)")
    .option("-p, --profile <name>", "config profile (default: SUPAKNOWLEDGE_PROFILE or the last login)")
    .addOption(new Option("--url <url>", "Supaknowledge (Supabase) URL; overrides the profile").hideHelp())
    .option("--no-color", "disable colors")
    .showHelpAfterError("(run with --help for usage)")
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .exitOverride()
    .addHelpText(
      "after",
      `
Environment:
  SUPAKNOWLEDGE_URL, SUPAKNOWLEDGE_PUBLISHABLE_KEY  project URL and publishable key (override the profile)
  SUPAKNOWLEDGE_TOKEN                              access token or agent key (skn_...) instead of the saved session
  SUPAKNOWLEDGE_SPACE                              default space (<workspace>/<space>)
  SUPAKNOWLEDGE_PROFILE, SUPAKNOWLEDGE_CONFIG_DIR  profile name, config directory (default ~/.config/supaknowledge)

Getting started:
  kf login --url http://127.0.0.1:54321 --publishable-key sb_publishable_... --email you@example.com
  kf init --workspace acme --space finance
  kf import ./knowledge --apply
  kf pull                     # writes .claude/skills and .supaknowledge/knowledge
  kf mcp-config --client claude-code`,
    );

  registerAuth(program, runner);
  registerInit(program, runner);
  registerBundle(program, runner);
  registerKnowledge(program, runner);
  registerReview(program, runner);
  registerCurator(program, runner);
  registerAgents(program, runner);
  registerMcp(program, runner);
  registerSources(program, runner);
  registerMembers(program, runner);
  registerDeploy(program, runner);
  registerDemo(program, runner);

  // every subcommand reports errors through the same path
  const configure = (cmd: Command) => {
    cmd.exitOverride().configureOutput({ writeOut: io.stdout, writeErr: io.stderr }).showHelpAfterError("(run with --help for usage)");
    cmd.commands.forEach(configure);
  };
  program.commands.forEach(configure);
  return program;
}

/** Run the CLI. Returns the process exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
  const program = buildProgram(io);
  const wantsJson = argv.includes("--json");
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) {
      // help / version are "errors" in exitOverride mode
      if (e.code === "commander.helpDisplayed" || e.code === "commander.version" || e.code === "commander.help") return 0;
      return e.exitCode === 0 ? 0 : 2;
    }
    const err = e as Error & { hint?: string; exitCode?: number; status?: number };
    const message = err?.message ?? String(e);
    if (wantsJson && e instanceof CliError && e.reported) {
      // result JSON (with the failure details) was already printed
    } else if (wantsJson) {
      const data = e instanceof CliError ? e.data : undefined;
      io.stdout(JSON.stringify({ error: message, ...(err.hint ? { hint: err.hint } : {}), ...(err.status ? { status: err.status } : {}), ...data }, null, 2) + "\n");
    } else {
      io.stderr(`error: ${message}\n`);
      if (err.hint) io.stderr(`hint: ${err.hint}\n`);
      if (io.env.SUPAKNOWLEDGE_DEBUG && err.stack) io.stderr(err.stack + "\n");
    }
    if (e instanceof CliError) return e.exitCode;
    if (e instanceof SupaknowledgeError && e.status === 401) return 3;
    return 1;
  }
}
