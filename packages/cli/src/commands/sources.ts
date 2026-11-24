import type { Command } from "commander";
import { CliError, must, UUID_RE, type Ctx } from "../context.ts";
import type { Runner } from "../program.ts";
import { ago, statusColor, table, truncate } from "../render.ts";

const CONNECTORS = ["notion", "slack", "github", "gdrive", "web", "upload"];
// secret_id is not readable through the API (column grant), so never select *
const COLS = "id, space_id, connector, name, config, audience, sync_interval, status, last_synced_at, last_error, created_at";

export async function groupIds(ctx: Ctx, slugs: string | undefined): Promise<string[]> {
  if (!slugs) return [];
  const want = slugs.split(",").map((s) => s.trim()).filter(Boolean);
  if (!want.length) return [];
  const sp = await ctx.space();
  const db = await ctx.db();
  const rows = (await must(db.from("groups").select("id, slug").eq("workspace_id", sp.workspace_id))) as { id: string; slug: string }[];
  return want.map((s) => {
    const g = rows.find((r) => r.slug === s || r.id === s);
    if (!g) throw new CliError(`unknown group "${s}"`, { hint: "kf groups list" });
    return g.id;
  });
}

async function sourceId(ctx: Ctx, ref: string): Promise<string> {
  if (UUID_RE.test(ref)) return ref;
  const sp = await ctx.space();
  const db = await ctx.db();
  const rows = (await must(db.from("sources").select("id").eq("space_id", sp.id).eq("name", ref))) as { id: string }[];
  if (!rows[0]) throw new CliError(`no source named "${ref}" in ${sp.ref}`, { hint: "kf sources list" });
  return rows[0].id;
}

export function registerSources(program: Command, run: Runner): void {
  const sources = program.command("sources").description("raw evidence the curator learns from: Notion, Slack, GitHub, Drive, web, uploads");

  sources
    .command("add")
    .description("connect a source (space admin)")
    .argument("<connector>", CONNECTORS.join(" | "))
    .requiredOption("--name <name>", "unique name in the space")
    .option("--config <json>", "connector config, e.g. '{\"repo\":\"acme/handbook\",\"paths\":[\"docs/\"]}'", "{}")
    .option("--audience <groups>", "comma-separated group slugs that may see this source's documents (default: everyone in the space)")
    .option("--interval <interval>", "sync interval (Postgres interval)", "1 hour")
    .addHelpText("after", "\nThen store its token: echo $TOKEN | kf sources secret <name>\nand start a sync:    kf sources sync <name>")
    .action(
      run(async (ctx: Ctx, connector: string, opts: { name: string; config: string; audience?: string; interval: string }) => {
        if (!CONNECTORS.includes(connector)) throw new CliError(`connector must be one of ${CONNECTORS.join(", ")}`, { exitCode: 2 });
        let config: unknown;
        try {
          config = JSON.parse(opts.config);
        } catch (e) {
          throw new CliError(`--config is not valid JSON: ${(e as Error).message}`, { exitCode: 2 });
        }
        if (!config || typeof config !== "object" || Array.isArray(config)) throw new CliError("--config must be a JSON object", { exitCode: 2 });
        const sp = await ctx.space();
        const db = await ctx.db();
        const audience = await groupIds(ctx, opts.audience);
        const res = await db
          .from("sources")
          .insert({ space_id: sp.id, connector, name: opts.name, config, audience, sync_interval: opts.interval })
          .select(COLS)
          .single();
        if (res.error?.code === "42501") {
          throw new CliError("not allowed to add this source", {
            hint: audience.length
              ? "you need the space admin role and must belong to one of the --audience groups (kf groups add <group> me)"
              : "space admins add sources",
          });
        }
        const row = (await must(Promise.resolve(res))) as { id: string; name: string };
        ctx.out(row, () => `${ctx.c.green("added")} ${connector} source ${row.name} ${ctx.c.dim(row.id)}\nnext: echo "$TOKEN" | kf sources secret ${row.name}`);
      }),
    );

  sources
    .command("secret")
    .description("store the connector token in Vault (read from stdin, or prompted)")
    .argument("<source>", "source id or name")
    .action(
      run(async (ctx: Ctx, ref: string) => {
        const id = await sourceId(ctx, ref);
        // prompt only when stdin is a terminal (stdout may be a pipe, e.g. `kf sources secret x | tee log`)
        let secret = ctx.io.stdinIsTTY ? "" : (await ctx.io.readStdin()).trim();
        if (!secret && ctx.io.stdinIsTTY) secret = (await ctx.io.prompt("Token: ", true)).trim();
        if (!secret) throw new CliError("no secret on stdin", { exitCode: 2, hint: 'echo "$TOKEN" | kf sources secret <source>' });
        const db = await ctx.db();
        await must(db.rpc("set_source_secret", { p_source: id, p_secret: secret }));
        ctx.out({ id, ok: true }, () => `${ctx.c.green("stored")} secret for ${ref} in Vault`);
      }),
    );

  sources
    .command("sync")
    .description("queue a full sync now (space admin)")
    .argument("<source>", "source id or name")
    .action(
      run(async (ctx: Ctx, ref: string) => {
        const id = await sourceId(ctx, ref);
        const db = await ctx.db();
        await must(db.rpc("request_source_sync", { p_source: id }));
        ctx.out({ id, queued: true }, () => `${ctx.c.green("queued")} sync for ${ref}`);
      }),
    );

  sources
    .command("list", { isDefault: true })
    .description("sources in the space (editors+)")
    .action(
      run(async (ctx: Ctx) => {
        const sp = await ctx.space();
        const db = await ctx.db();
        const rows = (await must(db.from("sources").select(COLS).eq("space_id", sp.id).order("name"))) as {
          id: string;
          connector: string;
          name: string;
          status: string;
          last_synced_at: string | null;
          last_error: string | null;
          audience: string[];
        }[];
        ctx.out(rows, () =>
          table(
            ["NAME", "CONNECTOR", "STATUS", "LAST SYNC", "AUDIENCE", "ERROR"],
            rows.map((s) => [s.name, s.connector, statusColor(s.status, ctx.c), s.last_synced_at ? ago(s.last_synced_at, ctx.io.now()) : ctx.c.dim("never"), s.audience.length ? `${s.audience.length} group(s)` : "all", truncate(s.last_error, 50)]),
            ctx.c,
          ),
        );
      }),
    );

  sources
    .command("remove")
    .description("delete a source and its documents (space admin)")
    .argument("<source>", "source id or name")
    .action(
      run(async (ctx: Ctx, ref: string) => {
        const id = await sourceId(ctx, ref);
        const db = await ctx.db();
        const rows = (await must(db.from("sources").delete().eq("id", id).select("id"))) as { id: string }[];
        if (!rows.length) throw new CliError("not deleted (space admin required)");
        ctx.out({ id, deleted: true }, () => `${ctx.c.red("removed")} ${ref}`);
      }),
    );
}
