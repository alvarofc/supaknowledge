// `kf demo`: the public read-only demo of a space (migration 20261127000600, docs/deploy.md#host-a-public-demo).
// Visitors are anonymous Supabase Auth users that join the space as readers; these commands are for its owner.
import type { Command } from "commander";
import { CliError, must, type Ctx } from "../context.ts";
import type { Runner } from "../program.ts";
import { importCmd } from "./bundle.ts";

type DemoStatus = {
  space_id: string;
  enabled: boolean;
  flags_per_visitor_per_hour?: number;
  flags_per_day?: number;
  enabled_at?: string;
  last_reset_at?: string | null;
  visitors?: number;
};
type DemoReset = { flags: number; proposals: number; traces: number; usage: number; visitors: number; users_deleted: number };

const intOpt = (name: string, min: number, max: number) => (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new CliError(`${name} must be an integer between ${min} and ${max}`, { exitCode: 2 });
  return n;
};

function resetLine(r: DemoReset): string {
  return `cleared ${r.flags} flags, ${r.proposals} proposals, ${r.traces} traces and ${r.usage} usage rows of ${r.visitors} visitors (${r.users_deleted} anonymous users deleted)`;
}

export function registerDemo(program: Command, run: Runner): void {
  const demo = program
    .command("demo")
    .description("public read-only demo of the current space: anonymous visitors read, search and flag (workspace owners)");

  demo
    .command("enable")
    .description("open the space to demo visitors (turns auto-apply off; the workspace must have no other space visible to all members)")
    .option("--flags-per-hour <n>", "flags one visitor may raise per hour", intOpt("--flags-per-hour", 0, 1000), 5)
    .option("--flags-per-day <n>", "flags all visitors together may raise per day", intOpt("--flags-per-day", 0, 100000), 200)
    .action(
      run(async (ctx: Ctx, opts: { flagsPerHour: number; flagsPerDay: number }) => {
        const sp = await ctx.space();
        const db = await ctx.db();
        const st = (await must(
          db.rpc("kf_demo_enable", { p_space: sp.id, p_flags_per_visitor_per_hour: opts.flagsPerHour, p_flags_per_day: opts.flagsPerDay }),
        )) as DemoStatus;
        ctx.out(st, () =>
          [
            `Demo enabled for ${sp.ref}: ${st.flags_per_visitor_per_hour} flags per visitor per hour, ${st.flags_per_day} per day.`,
            ctx.c.dim("Next: KF_DEMO=true on the functions and on Studio, anonymous sign-ins on in Supabase Auth (docs/deploy.md#host-a-public-demo)."),
          ].join("\n"),
        );
      }),
    );

  demo
    .command("status")
    .description("show whether the space is a demo, its flag limits, visitors and last reset")
    .action(
      run(async (ctx: Ctx) => {
        const sp = await ctx.space();
        const db = await ctx.db();
        const st = (await must(db.rpc("kf_demo_status", { p_space: sp.id }))) as DemoStatus;
        ctx.out(st, () =>
          st.enabled
            ? [
                `${sp.ref} is a demo space`,
                `  flags per visitor per hour  ${st.flags_per_visitor_per_hour}`,
                `  flags per day               ${st.flags_per_day}`,
                `  visitors                    ${st.visitors}`,
                `  last reset                  ${st.last_reset_at ?? "never"}`,
              ].join("\n")
            : `${sp.ref} is not a demo space`,
        );
      }),
    );

  demo
    .command("reset")
    .description("delete what demo visitors left (flags, unapplied proposals, traces, usage, their anonymous users); with --bundle, re-import it")
    .option("--bundle <dir>", "re-import this OKF bundle / skills directory and apply it (restores edited concepts)")
    .addHelpText(
      "after",
      "\nThe database runs the same reset every night (cron kf-demo-reset). Use --bundle after changing the demo bundle.\n\nExample:\n  kf demo reset --bundle examples/revenue-report/knowledge",
    )
    .action(
      run(async (ctx: Ctx, opts: { bundle?: string }) => {
        const sp = await ctx.space();
        const db = await ctx.db();
        const r = (await must(db.rpc("kf_demo_reset", { p_space: sp.id }))) as DemoReset;
        if (!opts.bundle) {
          ctx.out(r, () => `${sp.ref}: ${resetLine(r)}`);
          return;
        }
        ctx.note(`${sp.ref}: ${resetLine(r)}`);
        await importCmd(ctx, opts.bundle, { apply: true, title: "Demo reset: re-import the demo bundle" });
      }),
    );

  demo
    .command("disable")
    .description("close the demo: reset it, then remove the space from the demo list")
    .action(
      run(async (ctx: Ctx) => {
        const sp = await ctx.space();
        const db = await ctx.db();
        const r = (await must(db.rpc("kf_demo_disable", { p_space: sp.id }))) as DemoReset & { enabled: boolean };
        ctx.out(r, () => `Demo disabled for ${sp.ref}${typeof r.flags === "number" ? `; ${resetLine(r)}` : ""}.`);
      }),
    );
}
