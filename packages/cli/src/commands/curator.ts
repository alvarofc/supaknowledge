import type { Command } from "commander";
import { isNotDeployed, SupaknowledgeError } from "@supaknowledge/sdk";
import { CliError, must, resolveId, type Ctx, type SpaceRef } from "../context.ts";
import type { Runner } from "../program.ts";
import { ago, shortId, statusColor, table, truncate } from "../render.ts";

interface RunRow {
  id: string;
  status: string;
  trigger: string;
  stats: Record<string, unknown>;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const DONE = new Set(["succeeded", "failed", "cancelled"]);

function statsText(stats: Record<string, unknown> | null | undefined): string {
  const entries = Object.entries(stats ?? {}).filter(([, v]) => v !== null && typeof v !== "object");
  return entries.map(([k, v]) => `${k}=${v}`).join(" ");
}

/** Seconds to wait from a 429: Retry-After, else "try again in Ns" in the message. */
export function retryAfterSeconds(e: SupaknowledgeError): number | null {
  if (typeof e.retryAfterMs === "number") return Math.max(1, Math.ceil(e.retryAfterMs / 1000));
  const m = /try again in (\d+)\s*s/i.exec(e.message);
  return m ? Number(m[1]) : null;
}

/**
 * Ask for a manual run through POST /functions/v1/curator/run (per-space cooldown KF_CURATOR_RUN_COOLDOWN_S and a
 * per-caller limit, both answered with 429 + Retry-After). Falls back to rpc request_curator_run when the curator
 * function is not deployed.
 */
async function requestRun(ctx: Ctx, sp: SpaceRef): Promise<RunRow> {
  try {
    const res = await ctx.fn<{ run: RunRow }>("curator/run", { body: { space: sp.ref } });
    if (!res?.run?.id) throw new CliError("the curator function returned no run", { hint: "kf runs" });
    return res.run;
  } catch (e) {
    if (e instanceof SupaknowledgeError && e.status === 429) {
      const wait = retryAfterSeconds(e);
      throw new CliError(`curator was run recently; try again in ${wait ?? 60} s`, {
        status: 429,
        hint: "kf runs shows the latest runs",
        data: { retry_after_s: wait ?? 60 },
      });
    }
    if (!isNotDeployed(e)) throw e;
    const db = await ctx.db();
    return (await must(db.rpc("request_curator_run", { p_space: sp.id }))) as RunRow;
  }
}

export function registerCurator(program: Command, run: Runner): void {
  program
    .command("curate")
    .description("request a curator run for the space (reviewer+); one active run per space, and a short cooldown between manual runs")
    .option("-w, --watch", "poll the run until it finishes and print its stats")
    .option("--interval <seconds>", "poll interval", "3")
    .option("--timeout <seconds>", "stop watching after this long", "900")
    .action(
      run(async (ctx: Ctx, opts: { watch?: boolean; interval: string; timeout: string }) => {
        const sp = await ctx.space();
        const db = await ctx.db();
        let r = await requestRun(ctx, sp);
        if (!opts.watch) {
          ctx.out(r, () => `curator run ${r.id} ${statusColor(r.status, ctx.c)} ${ctx.c.dim(`(kf curate --watch, kf runs)`)}`);
          return;
        }
        const deadline = ctx.io.now() + (Number(opts.timeout) || 900) * 1000;
        let last = "";
        for (;;) {
          const line = `${r.status} ${statsText(r.stats)}`;
          if (line !== last) {
            ctx.note(`${ctx.c.dim(new Date(ctx.io.now()).toISOString().slice(11, 19))} ${statusColor(r.status, ctx.c)} ${statsText(r.stats)}`);
            last = line;
          }
          if (DONE.has(r.status)) break;
          if (ctx.io.now() > deadline) throw new CliError(`run ${r.id} still ${r.status} after ${opts.timeout}s`, { hint: "kf runs" });
          await ctx.io.sleep((Number(opts.interval) || 3) * 1000);
          r = (await must(db.from("curator_runs").select("*").eq("id", r.id).single())) as RunRow;
        }
        ctx.out(r, () => {
          const lines = [`run ${r.id} ${statusColor(r.status, ctx.c)}${r.error ? ctx.c.red(`: ${r.error}`) : ""}`];
          for (const [k, v] of Object.entries(r.stats ?? {})) lines.push(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
          if (r.status === "succeeded") lines.push(ctx.c.dim("review the results with: kf proposals"));
          return lines.join("\n");
        });
        // the run (with its error) was already printed: in --json mode print nothing more, just exit non-zero
        if (r.status === "failed" || r.status === "cancelled") {
          throw new CliError(`curator run ${r.status}${r.error ? `: ${r.error}` : ""}`, { reported: true });
        }
      }),
    );

  const runs = program.command("runs").description("curator runs: list recent runs, cancel a stuck one");

  runs
    .command("list", { isDefault: true })
    .description("recent curator runs")
    .option("-n, --limit <n>", "max rows", "20")
    .action(
      run(async (ctx: Ctx, opts: { limit: string }) => {
        const sp = await ctx.space();
        const db = await ctx.db();
        const rows = (await must(
          db.from("curator_runs").select("id, status, trigger, stats, error, created_at, started_at, finished_at").eq("space_id", sp.id).order("created_at", { ascending: false }).limit(Number(opts.limit) || 20),
        )) as RunRow[];
        ctx.out(rows, () =>
          table(
            ["ID", "STATUS", "TRIGGER", "STARTED", "STATS"],
            rows.map((r) => [shortId(r.id), statusColor(r.status, ctx.c), r.trigger, ago(r.started_at ?? r.created_at, ctx.io.now()), truncate(r.error ?? statsText(r.stats), 70)]),
            ctx.c,
          ),
        );
      }),
    );

  runs
    .command("cancel")
    .description("cancel a queued or running curator run (reviewer+); its remaining tasks stop")
    .argument("<id>", "run id (or a unique prefix)")
    .action(
      run(async (ctx: Ctx, idArg: string) => {
        const id = await resolveId(ctx, "curator_runs", idArg, "curator run");
        const db = await ctx.db();
        const r = (await must(db.rpc("cancel_curator_run", { p_run: id }))) as RunRow;
        ctx.out(r, () =>
          r.status === "cancelled"
            ? `${ctx.c.yellow("cancelled")} run ${r.id}`
            : `run ${r.id} was already ${statusColor(r.status, ctx.c)}; nothing to cancel`,
        );
      }),
    );

  program
    .command("health")
    .description("knowledge health: trust mix, staleness, open flags, most-flagged concepts, last run")
    .option("--days <n>", "window for usage and flag rates", "30")
    .action(
      run(async (ctx: Ctx, opts: { days: string }) => {
        const sp = await ctx.space();
        const db = await ctx.db();
        const h = (await must(db.rpc("knowledge_health", { p_space: sp.id, p_days: Number(opts.days) || 30 }))) as {
          concepts: number;
          by_kind: Record<string, number>;
          by_trust: Record<string, number>;
          stale: number;
          open_flags: number;
          missing_flags: number;
          pending_proposals: number;
          applied_proposals: number;
          auto_applied: number;
          never_used: number;
          most_flagged: { path: string; title: string; flags: number; uses: number; flag_rate: number }[];
          last_run: { id: string; status: string; trigger: string; finished_at: string | null } | null;
        };
        ctx.out(h, () => {
          const c = ctx.c;
          const kv = (o: Record<string, number>) => Object.entries(o ?? {}).map(([k, v]) => `${k} ${v}`).join(", ") || "-";
          const lines = [
            c.bold(`${sp.ref}`) + c.dim(` (last ${opts.days} days)`),
            `concepts           ${h.concepts}  ${c.dim(kv(h.by_kind))}`,
            `trust              ${kv(h.by_trust)}`,
            `stale              ${h.stale ? c.yellow(String(h.stale)) : 0}`,
            `never used         ${h.never_used}`,
            `open flags         ${h.open_flags ? c.yellow(String(h.open_flags)) : 0}  ${c.dim(`(${h.missing_flags} missing)`)}`,
            `pending proposals  ${h.pending_proposals ? c.yellow(String(h.pending_proposals)) : 0}`,
            `applied proposals  ${h.applied_proposals}  ${c.dim(`(${h.auto_applied} auto-applied)`)}`,
            `last curator run   ${h.last_run ? `${statusColor(h.last_run.status, c)} ${h.last_run.trigger} ${ago(h.last_run.finished_at, ctx.io.now())}` : c.dim("never")}`,
          ];
          if (h.most_flagged?.length) {
            lines.push("", c.bold("Most flagged"), table(["PATH", "FLAGS", "USES", "RATE"], h.most_flagged.map((m) => [m.path, m.flags, m.uses, m.flag_rate]), c));
          }
          return lines.join("\n");
        });
      }),
    );
}
