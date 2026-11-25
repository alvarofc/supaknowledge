import type { Command } from "commander";
import { isNotDeployed } from "@supaknowledge/sdk";
import { CliError, must, UUID_RE, type Ctx } from "../context.ts";
import type { Runner } from "../program.ts";
import { ago, table } from "../render.ts";

// agents never get admin (enforced by the agents function)
const ROLES = ["reader", "editor", "reviewer"];

interface AgentRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  key_prefix: string | null;
  created_at: string;
  last_seen_at: string | null;
  /** from the agents function (agents.revoked_at); null = unknown */
  revoked?: boolean | null;
  revoked_at?: string | null;
  spaces?: { space_id: string; role: string }[];
  [k: string]: unknown;
}

async function workspaceId(ctx: Ctx, slug?: string): Promise<string> {
  if (slug) {
    const db = await ctx.db();
    const ws = (await must(db.from("workspaces").select("id").eq("slug", slug).limit(1)))[0] as { id: string } | undefined;
    if (!ws) throw new CliError(`workspace "${slug}" not found`);
    return ws.id;
  }
  return (await ctx.space()).workspace_id;
}

async function agentId(ctx: Ctx, ref: string, ws?: string): Promise<string> {
  if (UUID_RE.test(ref)) return ref;
  const db = await ctx.db();
  const rows = (await must(db.from("agents").select("id").eq("workspace_id", await workspaceId(ctx, ws)).eq("name", ref))) as { id: string }[];
  if (!rows[0]) throw new CliError(`no agent named "${ref}"`, { hint: "kf agents list" });
  return rows[0].id;
}

function keyNotice(ctx: Ctx, key: string): string {
  const c = ctx.c;
  return [
    "",
    `${c.bold("API key")} ${c.dim("(shown once; store it in your secret manager)")}`,
    `  ${key}`,
    "",
    c.dim(`connect an MCP client:  kf mcp-config --agent-key ${key.slice(0, 12)}... --client claude-code`),
  ].join("\n");
}

export function registerAgents(program: Command, run: Runner): void {
  const agents = program.command("agents").description("register headless agents and manage their API keys (workspace admins)");

  agents
    .command("create")
    .description("create an agent and print its API key (skn_...)")
    .argument("<name>")
    .option("--description <text>")
    .option("--role <role>", `role on the current space: ${ROLES.join(" | ")}`, "reader")
    .option("--no-grant", "do not grant access to the current space")
    .option("-w, --workspace <slug>", "workspace (default: the current space's)")
    .action(
      run(async (ctx: Ctx, name: string, opts: { description?: string; role: string; grant: boolean; workspace?: string }) => {
        if (!ROLES.includes(opts.role)) throw new CliError(`--role must be one of ${ROLES.join(", ")}`, { exitCode: 2 });
        const ws = await workspaceId(ctx, opts.workspace);
        const spaces = opts.grant ? [{ space_id: (await ctx.space()).id, role: opts.role }] : [];
        const r = await ctx.fn<{ agent: AgentRow; key: string }>("agents", { body: { workspace_id: ws, name, description: opts.description, spaces } });
        ctx.out(r, () => `${ctx.c.green("created")} agent ${r.agent.name} ${ctx.c.dim(r.agent.id)}${spaces.length ? ctx.c.dim(` (${opts.role} on ${spaces.length} space)`) : ""}${keyNotice(ctx, r.key)}`);
      }),
    );

  agents
    .command("rotate")
    .description("issue a new API key (the old one stops working)")
    .argument("<agent>", "agent id or name")
    .option("-w, --workspace <slug>")
    .action(
      run(async (ctx: Ctx, ref: string, opts: { workspace?: string }) => {
        const id = await agentId(ctx, ref, opts.workspace);
        const r = await ctx.fn<{ key: string }>(`agents/${id}/rotate`, { method: "POST", body: {} });
        ctx.out({ id, ...r }, () => `${ctx.c.green("rotated")} ${id}${keyNotice(ctx, r.key)}`);
      }),
    );

  agents
    .command("revoke")
    .description("revoke the agent (its key stops working; history is kept)")
    .argument("<agent>", "agent id or name")
    .option("-w, --workspace <slug>")
    .action(
      run(async (ctx: Ctx, ref: string, opts: { workspace?: string }) => {
        const id = await agentId(ctx, ref, opts.workspace);
        const r = await ctx.fn<unknown>(`agents/${id}/revoke`, { method: "POST", body: {} });
        ctx.out(r ?? { id, revoked: true }, () => `${ctx.c.red("revoked")} ${id}`);
      }),
    );

  agents
    .command("restore")
    .description("lift a revocation (the current key works again)")
    .argument("<agent>", "agent id or name")
    .option("-w, --workspace <slug>")
    .action(
      run(async (ctx: Ctx, ref: string, opts: { workspace?: string }) => {
        const id = await agentId(ctx, ref, opts.workspace);
        const r = await ctx.fn<unknown>(`agents/${id}/restore`, { method: "POST", body: {} });
        ctx.out(r ?? { id, restored: true }, () => `${ctx.c.green("restored")} ${id}`);
      }),
    );

  agents
    .command("delete")
    .description("delete the agent and its Auth user")
    .argument("<agent>", "agent id or name")
    .option("-w, --workspace <slug>")
    .action(
      run(async (ctx: Ctx, ref: string, opts: { workspace?: string }) => {
        const id = await agentId(ctx, ref, opts.workspace);
        const r = await ctx.fn<unknown>(`agents/${id}`, { method: "DELETE" });
        ctx.out(r ?? { id, deleted: true }, () => `${ctx.c.red("deleted")} ${id}`);
      }),
    );

  agents
    .command("list")
    .description("agents in the workspace")
    .option("-w, --workspace <slug>")
    .action(
      run(async (ctx: Ctx, opts: { workspace?: string }) => {
        const ws = await workspaceId(ctx, opts.workspace);
        let rows: AgentRow[];
        try {
          const r = await ctx.fn<AgentRow[] | { agents: AgentRow[] }>("agents", { query: { workspace_id: ws } });
          rows = Array.isArray(r) ? r : (r?.agents ?? []);
        } catch (e) {
          if (!isNotDeployed(e)) throw e;
          const db = await ctx.db();
          rows = ((await must(db.from("agents").select("*").eq("workspace_id", ws).order("name"))) as AgentRow[]).map((a) => ({
            ...a,
            revoked: "revoked_at" in a ? !!a.revoked_at : null,
          }));
        }
        ctx.out(rows, () =>
          table(
            ["ID", "NAME", "KEY", "STATUS", "SPACES", "LAST SEEN", "DESCRIPTION"],
            rows.map((a) => [
              a.id,
              a.name,
              a.key_prefix ? `${a.key_prefix}…` : "",
              a.revoked ? ctx.c.red("revoked") : a.revoked === false ? ctx.c.green("active") : "",
              a.spaces?.map((s) => s.role).join(",") ?? "",
              a.last_seen_at ? ago(a.last_seen_at, ctx.io.now()) : ctx.c.dim("never"),
              a.description ?? "",
            ]),
            ctx.c,
          ),
        );
      }),
    );
}
