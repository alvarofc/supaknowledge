import type { Command } from "commander";
import { buildMcpConfig, type McpClientKind } from "@supaknowledge/sdk";
import { CliError, UUID_RE, type Ctx } from "../context.ts";
import type { Runner } from "../program.ts";

const CLIENTS: McpClientKind[] = ["claude-code", "cursor", "claude-desktop", "generic"];

export function registerMcp(program: Command, run: Runner): void {
  program
    .command("mcp-config")
    .description("print ready-to-paste MCP config for Claude Code, Cursor, Claude Desktop or any MCP client")
    .option("--agent-key [key]", "authenticate with an agent key (inline it, or omit the value to reference $SUPAKNOWLEDGE_API_KEY)")
    .option("--oauth", "authenticate as the user through OAuth (default)")
    .option("--client <client>", CLIENTS.join(" | "), "claude-code")
    .option("--name <name>", "server name in the client config", "supaknowledge")
    .option("--key-env <var>", "env var that holds the agent key when it is not inlined", "SUPAKNOWLEDGE_API_KEY")
    .addHelpText(
      "after",
      "\nExamples:\n  kf mcp-config                                   # Claude Code, OAuth sign-in\n  kf mcp-config --client cursor --agent-key       # Cursor, key from ${env:SUPAKNOWLEDGE_API_KEY}\n  kf mcp-config --agent-key skn_... --client claude-desktop",
    )
    .action(
      run(async (ctx: Ctx, opts: { agentKey?: string | boolean; oauth?: boolean; client: string; name: string; keyEnv: string }) => {
        if (!CLIENTS.includes(opts.client as McpClientKind)) throw new CliError(`--client must be one of ${CLIENTS.join(", ")}`, { exitCode: 2 });
        if (opts.agentKey && opts.oauth) throw new CliError("use either --agent-key or --oauth", { exitCode: 2 });
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.keyEnv)) throw new CliError("--key-env must be an environment variable name (letters, digits and _, not starting with a digit)", { exitCode: 2 });
        const spec = ctx.spaceSpec();
        const space = UUID_RE.test(spec) ? (await ctx.space()).ref : spec;
        const apiKey = typeof opts.agentKey === "string" ? opts.agentKey : undefined;
        if (apiKey && !apiKey.startsWith("skn_")) throw new CliError("agent keys start with skn_", { exitCode: 2 });
        const cfg = buildMcpConfig({
          url: ctx.url(),
          space,
          client: opts.client as McpClientKind,
          name: opts.name,
          auth: opts.agentKey ? "agent-key" : "oauth",
          apiKey,
          apiKeyEnv: opts.keyEnv,
        });
        ctx.out(cfg, () => {
          const c = ctx.c;
          const out: string[] = [`${c.dim("endpoint")} ${cfg.url}`];
          if (cfg.command) out.push("", c.bold("Run:"), `  ${cfg.command}`);
          if (cfg.config) out.push("", c.bold(cfg.command ? "Or add to " + (cfg.file ?? "the config") + ":" : `Add to ${cfg.file ?? "the client config"}:`), JSON.stringify(cfg.config, null, 2));
          if (cfg.notes.length) out.push("", ...cfg.notes.map((n) => c.dim(`note: ${n}`)));
          return out.join("\n");
        });
      }),
    );
}
