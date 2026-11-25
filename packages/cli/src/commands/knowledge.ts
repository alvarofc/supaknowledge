import type { Command } from "commander";
import { CONCEPT_KINDS, FLAG_KINDS, type Concept, type ConceptKind, type FlagKind } from "@supaknowledge/sdk";
import { CliError, must, type Ctx } from "../context.ts";
import type { Runner } from "../program.ts";
import { statusColor, truncate } from "../render.ts";

function parseKinds(v: string[] | undefined): ConceptKind[] | undefined {
  if (!v?.length) return undefined;
  const kinds = v.flatMap((x) => x.split(",")).map((x) => x.trim().replace("-", "_")).filter(Boolean);
  for (const k of kinds) if (!CONCEPT_KINDS.includes(k as ConceptKind)) throw new CliError(`unknown kind "${k}" (${CONCEPT_KINDS.join(", ")})`, { exitCode: 2 });
  return kinds as ConceptKind[];
}

export function registerKnowledge(program: Command, run: Runner): void {
  program
    .command("search")
    .description("search knowledge in the space (semantic + full-text through MCP; full-text when only PostgREST is available)")
    .argument("<query...>")
    .option("-k, --kind <kinds...>", `filter by kind: ${CONCEPT_KINDS.join(", ")} (repeat or comma-separate)`)
    .option("-n, --limit <n>", "max results", "8")
    .action(
      run(async (ctx: Ctx, query: string[], opts: { kind?: string[]; limit: string }) => {
        const q = query.join(" ");
        const kinds = parseKinds(opts.kind);
        const kf = await ctx.sdk();
        const results = await kf.search(q, { kinds, limit: Number(opts.limit) || 8 });
        ctx.out(results, () => {
          const c = ctx.c;
          if (!results.length) return c.dim(`no results for "${q}"`);
          return results
            .map((r) =>
              [
                `${c.bold(r.path)} ${c.dim(`[${r.kind}${r.trust ? `, ${r.trust}` : ""}${r.stale ? ", stale" : ""}${r.status && r.status !== "stable" ? `, ${r.status}` : ""}]`)}`,
                `  ${r.title}${r.description ? c.dim(` - ${truncate(r.description, 120)}`) : ""}`,
                r.snippet ? c.dim(`  ${truncate(r.snippet, 200)}`) : "",
              ]
                .filter(Boolean)
                .join("\n"),
            )
            .join("\n\n");
        });
      }),
    );

  program
    .command("read")
    .description("print a concept (body + metadata)")
    .argument("<path>", 'concept path, e.g. "metrics/arr" or "skills/revenue-report"')
    .option("--body", "print only the markdown body")
    .action(
      run(async (ctx: Ctx, path: string, opts: { body?: boolean }) => {
        // exact JSON through the RPC (the MCP tool renders markdown for models); not logged as agent usage
        const sp = await ctx.space();
        const db = await ctx.db();
        const c = (await must(db.rpc("read_concept", { p_space: sp.id, p_path: path.replace(/^\/+/, "").replace(/\.md$/, "") }))) as Concept | null;
        if (!c) throw new CliError(`no concept at "${path}"`, { hint: "try `kf search`" });
        ctx.out(c, () => {
          if (opts.body) return c.body;
          const s = ctx.c;
          const meta = [
            `${s.dim("path")} ${c.path}  ${s.dim("kind")} ${c.kind}  ${s.dim("type")} ${c.type}`,
            `${s.dim("trust")} ${statusColor(String(c.trust ?? "unverified"), s)}  ${s.dim("revision")} ${c.revision ?? "?"}  ${s.dim("status")} ${c.status ?? "stable"}${c.stale ? `  ${s.yellow("stale")}` : ""}`,
          ];
          const out = [s.bold(`# ${c.title}`), ...meta];
          if (c.description) out.push("", s.dim(`> ${c.description}`));
          out.push("", c.body.trimEnd());
          if (c.links?.length) out.push("", s.dim("links:"), ...c.links.map((l) => `  ${l.path}${l.exists === false ? s.red(" (missing)") : ""}`));
          if (c.backlinks?.length) out.push(s.dim("backlinks:"), ...c.backlinks.map((l) => `  ${l.path}`));
          if (c.files?.length) out.push(s.dim("files:"), ...c.files.map((f) => `  ${f.path}`));
          return out.join("\n");
        });
      }),
    );

  program
    .command("flag")
    .description("report missing / incorrect / outdated / conflicting / unclear knowledge")
    .argument("<kind>", FLAG_KINDS.join(" | "))
    .argument("<observation...>", "what you observed")
    .option("--path <concept>", "concept the flag is about")
    .option("--fix <text>", "suggested fix")
    .option("--query <text>", "what you were trying to do")
    .addHelpText("after", '\nExample:\n  kf flag incorrect "orders.revenue_usd was renamed to revenue_usd_net" --path data/orders --fix "use revenue_usd_net"')
    .action(
      run(async (ctx: Ctx, kind: string, observation: string[], opts: { path?: string; fix?: string; query?: string }) => {
        if (!FLAG_KINDS.includes(kind as FlagKind)) throw new CliError(`kind must be one of ${FLAG_KINDS.join(", ")}`, { exitCode: 2 });
        const kf = await ctx.sdk();
        const r = await kf.flag({ kind: kind as FlagKind, observation: observation.join(" "), conceptPath: opts.path, suggestedFix: opts.fix, query: opts.query });
        ctx.out(r, () => `${ctx.c.green("flagged")} ${r.id ?? ""}`.trim());
      }),
    );
}

