import type { Command } from "commander";
import { CliError, decodeJwt, must, sessionFrom, type Ctx } from "../context.ts";
import type { Runner } from "../program.ts";
import { table } from "../render.ts";

interface LoginOpts {
  url?: string;
  publishableKey?: string;
  email?: string;
  password?: string;
  passwordStdin?: boolean;
  token?: string;
  tokenStdin?: boolean;
}

export function registerAuth(program: Command, run: Runner): void {
  program
    .command("login")
    .description("sign in and save the session in the profile (~/.config/supaknowledge/config.json)")
    .option("--url <url>", "Supaknowledge (Supabase) project URL")
    .option("--publishable-key <key>", "project publishable key (sb_publishable_...)")
    .option("--email <email>", "sign in with email + password")
    .option("--password <password>", "password (prefer the prompt or --password-stdin)")
    .option("--password-stdin", "read the password from stdin")
    .option("--token <token>", "use an access token (JWT) or an agent key (skn_...)")
    .option("--token-stdin", "read the token / agent key from stdin")
    .addHelpText("after", "\nExamples:\n  kf login --url https://abc.supabase.co --publishable-key sb_publishable_... --email me@acme.com\n  echo $SUPAKNOWLEDGE_AGENT_KEY | kf login --token-stdin")
    .action(run(login));

  program
    .command("logout")
    .description("revoke the saved session and remove it from the profile")
    .option("--supabase", "instead: forget the Supabase sign-in saved by kf deploy --login")
    .action(
      run(async (ctx, opts: { supabase?: boolean }) => {
        if (opts.supabase) {
          const had = !!ctx.config().supabase_oauth;
          ctx.config().supabase_oauth = null;
          ctx.saveConfig();
          ctx.out({ ok: true, supabase: had }, () => (had ? "Forgot the saved Supabase sign-in." : "No saved Supabase sign-in."));
          return;
        }
        const prof = ctx.profile();
        const s = prof.session;
        if (s?.access_token && prof.url && prof.publishable_key) {
          await ctx.io
            .fetch(`${prof.url}/auth/v1/logout?scope=local`, {
              method: "POST",
              headers: { Authorization: `Bearer ${s.access_token}`, apikey: prof.publishable_key },
            })
            .catch(() => undefined);
        }
        prof.session = null;
        ctx.saveConfig();
        ctx.out({ ok: true, profile: ctx.profileName }, () => `Logged out (profile ${ctx.profileName}).`);
      }),
    );

  program
    .command("whoami")
    .description("show the signed-in principal, workspaces and the current space")
    .action(
      run(async (ctx) => {
        const token = await ctx.accessToken();
        const claims = decodeJwt(token) ?? {};
        const db = await ctx.db();
        const uid = String(claims.sub ?? "");
        const workspaces = await must(db.from("workspace_members").select("role, workspaces(id, slug, name)").eq("user_id", uid));
        let space: { ref: string; id: string; role: string | null } | null = null;
        try {
          const sp = await ctx.space();
          const role = await must(db.rpc("my_space_role", { p_space: sp.id }));
          space = { ref: sp.ref, id: sp.id, role: (role as string | null) ?? null };
        } catch {
          space = null;
        }
        const appMeta = (claims.app_metadata ?? {}) as Record<string, unknown>;
        const data = {
          url: ctx.url(),
          profile: ctx.profileName,
          user_id: uid,
          email: claims.email ?? null,
          kind: appMeta.kind === "agent" ? "agent" : "human",
          expires_at: claims.exp ? new Date(Number(claims.exp) * 1000).toISOString() : null,
          workspaces: (workspaces as unknown as { role: string; workspaces: { id: string; slug: string; name: string } }[]).map((w) => ({ ...w.workspaces, role: w.role })),
          space,
        };
        ctx.out(data, () => {
          const c = ctx.c;
          const lines = [
            `${c.bold(String(data.email ?? data.user_id))} ${c.dim(`(${data.kind}, ${data.user_id})`)}`,
            `${c.dim("url:")}     ${data.url}  ${c.dim(`profile ${data.profile}`)}`,
            `${c.dim("space:")}   ${space ? `${space.ref} ${c.dim(`role ${space.role ?? "none"}`)}` : c.dim("(none selected)")}`,
          ];
          if (data.workspaces.length) lines.push("", table(["WORKSPACE", "NAME", "ROLE"], data.workspaces.map((w) => [w.slug, w.name, w.role]), c));
          return lines.join("\n");
        });
      }),
    );
}

async function login(ctx: Ctx, opts: LoginOpts): Promise<void> {
  const prof = ctx.profile();
  const url = (opts.url ?? ctx.g.url ?? ctx.io.env.SUPAKNOWLEDGE_URL ?? prof.url)?.replace(/\/+$/, "");
  const pk = opts.publishableKey ?? ctx.io.env.SUPAKNOWLEDGE_PUBLISHABLE_KEY ?? prof.publishable_key;
  if (!url) throw new CliError("--url is required for the first login", { exitCode: 2 });
  if (!pk) throw new CliError("--publishable-key is required for the first login", { exitCode: 2, hint: "find it in Studio > Project Settings > API keys, or `supabase status` locally" });
  prof.url = url;
  prof.publishable_key = pk;
  const auth = ctx.anonClient().auth;

  let token = opts.token;
  if (opts.tokenStdin) token = (await ctx.io.readStdin()).trim();
  if (token) {
    if (token.startsWith("skn_")) {
      prof.session = await ctx.exchangeAgentKey(token);
    } else {
      const { data, error } = await auth.getUser(token);
      if (error || !data.user) throw new CliError(`token rejected: ${error?.message ?? "unknown user"}`);
      prof.session = sessionFrom({ access_token: token, refresh_token: null, user: data.user });
      ctx.warn("access tokens cannot be refreshed; log in again when it expires");
    }
  } else {
    let email = opts.email;
    if (!email) email = (await ctx.io.prompt("Email: ")).trim();
    let password = opts.password;
    if (opts.passwordStdin) password = (await ctx.io.readStdin()).replace(/\r?\n$/, "");
    if (!password) password = await ctx.io.prompt("Password: ", true);
    if (!email || !password) throw new CliError("email and password are required", { exitCode: 2 });
    const { data, error } = await auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new CliError(`sign-in failed: ${error?.message ?? "no session"}`);
    prof.session = sessionFrom(data.session);
  }
  ctx.config().current_profile = ctx.profileName;
  ctx.saveConfig();
  const who = prof.session!.user?.email ?? prof.session!.user?.id ?? "unknown";
  ctx.out({ ok: true, profile: ctx.profileName, url, user: prof.session!.user ?? null }, () => `Logged in to ${url} as ${ctx.c.bold(String(who))} ${ctx.c.dim(`(profile ${ctx.profileName})`)}`);
}
