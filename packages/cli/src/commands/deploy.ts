// `kf deploy`: deploy this repository's Supabase project (migrations, Vault secrets, function secrets, Edge Functions,
// Auth settings) to a hosted Supabase project and check the result. Automates docs/deploy.md steps 1-4 and 6.
//
// Lessons from the first hosted deploy, encoded here:
// - function secrets go through the Management API, never `supabase secrets set` (the CLI merges supabase/.env and
//   silently replaced hosted values, so cron calls failed with "invalid internal secret");
// - functions are deployed from a clean copy of supabase/functions + config.jsonc without any .env file and with
//   `edge_runtime.secrets` removed from the config, and the child process gets no KF_* variables;
// - the internal secret in Vault (what cron sends) and KF_INTERNAL_SECRET (what functions expect) come from one
//   value, and step 7 proves they match by calling `embed` the way cron does.
import type { Command } from "commander";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import type { Env } from "../config.ts";
import { CliError, type Ctx, type RunFn } from "../context.ts";
import type { Runner } from "../program.ts";
import { ApiError, ManagementApi, type AuthConfig } from "../deploy/api.ts";
import {
  configWithoutSecrets,
  formatMB,
  FUNCTION_SECRET_RE,
  lineRedactor,
  mergeAllowList,
  parseDotenv,
  parseFunctionSizes,
  parseOrigin,
  redactor,
  selectEnvSecrets,
  sqlLiteral,
  tail,
  type SecretSelection,
} from "../deploy/lib.ts";

const TOTAL = 7;
const REF_RE = /^[a-z]{20}$/;
/** Supabase's per-function limit is 20 MB; warn when the curator gets close. */
const SIZE_WARN_BYTES = 19.5e6;
const DEFAULT_TASK_BUDGET_MS = "140000";
const TOKEN_HINT = "create a personal access token at https://supabase.com/dashboard/account/tokens and export SUPABASE_ACCESS_TOKEN (or pipe it with --access-token-stdin)";

/** Auth settings Supaknowledge needs (docs/deploy.md#4-auth). mailer_autoconfirm is never turned on. */
export const AUTH_SETTINGS: AuthConfig = {
  oauth_server_enabled: true,
  oauth_server_allow_dynamic_registration: true,
  oauth_server_authorization_path: "/oauth/consent",
  hook_before_user_created_enabled: true,
  hook_before_user_created_uri: "pg-functions://postgres/private/hook_before_user_created",
  security_update_password_require_reauthentication: true,
};

interface DeployOpts {
  projectRef: string;
  dir?: string;
  accessTokenStdin?: boolean;
  publicUrl?: string;
  studioUrl?: string[];
  envFile?: string;
  taskBudgetMs?: string;
  skipDb?: boolean;
  skipFunctions?: boolean;
  skipAuth?: boolean;
  skipCheck?: boolean;
  dryRun?: boolean;
  useApi?: boolean;
  verbose?: boolean;
}

type StepStatus = "ok" | "skipped" | "planned" | "failed";
interface StepRecord {
  step: number;
  name: string;
  status: StepStatus;
  detail: string;
}

const collect = (v: string, prev: string[] = []) => [...prev, ...v.split(",").map((s) => s.trim()).filter(Boolean)];

export function registerDeploy(program: Command, run: Runner): void {
  program
    .command("deploy")
    .description("deploy this repository to a hosted Supabase project: migrations, Vault, function secrets, Edge Functions, Auth, checks")
    .requiredOption("--project-ref <ref>", "the hosted project's ref (Settings → General, 20 lowercase letters)")
    .option("--dir <path>", "the supaknowledge repository clone (default: the current directory)")
    .option("--access-token-stdin", "read the Supabase personal access token from stdin (default: SUPABASE_ACCESS_TOKEN)")
    .option("--public-url <url>", "KF_PUBLIC_URL: the API origin MCP clients see (default: https://<ref>.supabase.co)")
    .option("--studio-url <url>", "Studio origin: becomes the Site URL and is added to the redirect URLs (repeatable or comma-separated; the first is the Site URL)", collect)
    .option("--env-file <file>", "upload the curator model / connector settings (KF_LLM_*, AI_GATEWAY_API_KEY, ...) from this dotenv file")
    .option("--task-budget-ms <ms>", "KF_CURATOR_TASK_BUDGET_MS (default: keep the project's value, else 140000; up to 380000 on paid plans)")
    .option("--skip-db", "skip `supabase db push` (step 2)")
    .option("--skip-functions", "skip deploying the Edge Functions (step 5)")
    .option("--skip-auth", "skip the Auth settings (step 6)")
    .option("--skip-check", "skip the post-deploy checks (step 7)")
    .option("--use-api", "bundle functions on Supabase's servers instead of with Docker (passed to `supabase functions deploy`)")
    .option("--dry-run", "print what would run (secret names only) without changing anything")
    .option("--verbose", "stream the Supabase CLI's output")
    .addHelpText(
      "after",
      `
Steps:
  [preflight]            the repo's Supabase CLI is installed and _shared/core is in sync (nothing changed yet)
  [1/7] Project          check the project and the access token (Management API)
  [2/7] Database         supabase db push --remote=<ref> --yes --skip-vault
  [3/7] Vault            kf_internal_secret (reused if present, else generated) and project_url
  [4/7] Function secrets KF_INTERNAL_SECRET, KF_PUBLIC_URL, KF_CURATOR_TASK_BUDGET_MS and --env-file settings
                         (Management API; never \`supabase secrets set\`, which also uploads supabase/.env)
  [5/7] Edge Functions   supabase functions deploy from a clean copy (no .env files)
  [6/7] Auth             OAuth 2.1 server, Before User Created hook, Site URL / redirect URLs (--studio-url)
  [7/7] Check            MCP metadata, the internal secret (calls embed like cron does), OAuth metadata

Run it from a clone of the supaknowledge repository (after npm install). Studio hosting stays manual
(docs/deploy.md#5-studio-on-vercel).

Examples:
  export SUPABASE_ACCESS_TOKEN=sbp_...
  kf deploy --project-ref abcdefghijklmnopqrst --dry-run
  kf deploy --project-ref abcdefghijklmnopqrst --env-file ./hosted.env --studio-url https://studio.example.com`,
    )
    .action(run(deploy));
}

const defaultRun: RunFn = (cmd, args, opts) =>
  new Promise((done) => {
    let output = "";
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    const on = (b: Buffer) => {
      const s = b.toString("utf8");
      output += s;
      opts.onOutput?.(s);
    };
    child.stdout.on("data", on);
    child.stderr.on("data", on);
    child.on("error", (e) => done({ code: 127, output: output + `${e.message}\n` }));
    child.on("close", (code) => done({ code: code ?? 1, output }));
  });

const defaultRandomHex = (bytes: number) => randomBytes(bytes).toString("hex");

/** Environment for the Supabase CLI: no function settings it could pick up, plus the access token. */
function childEnv(env: Env, token: string): Env {
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("KF_") || FUNCTION_SECRET_RE.test(k) || k === "SUPABASE_PUBLIC_URL") continue;
    out[k] = v;
  }
  out.SUPABASE_ACCESS_TOKEN = token;
  return out;
}

async function deploy(ctx: Ctx, opts: DeployOpts): Promise<void> {
  const io = ctx.io;
  const c = ctx.c;
  const usage = (msg: string, hint?: string) => new CliError(msg, { exitCode: 2, hint });

  // ---- validate everything before touching the network ----------------------------------------------------
  const ref = opts.projectRef.trim();
  if (!REF_RE.test(ref)) throw usage(`invalid project ref "${ref}" (20 lowercase letters)`, "find it in the dashboard under Settings → General, or in the project URL");
  const dir = resolve(io.cwd, opts.dir ?? ".");
  for (const p of ["supabase/config.jsonc", "supabase/migrations", "supabase/functions"]) {
    if (!existsSync(join(dir, p))) throw usage("run kf deploy from a clone of the supaknowledge repository (or pass --dir)", `${join(dir, p)} not found`);
  }
  const projectUrl = `https://${ref}.supabase.co`;
  let publicUrl = projectUrl;
  if (opts.publicUrl) {
    const o = parseOrigin(opts.publicUrl);
    if (!o) throw usage(`--public-url must be an http(s) origin without a path, got "${opts.publicUrl}"`);
    publicUrl = o;
  }
  const studio: string[] = [];
  for (const s of opts.studioUrl ?? []) {
    const o = parseOrigin(s);
    if (!o) throw usage(`--studio-url must be an http(s) origin without a path, got "${s}"`);
    if (!studio.includes(o)) studio.push(o);
  }
  let taskBudget: string | undefined;
  if (opts.taskBudgetMs !== undefined) {
    const n = Number(opts.taskBudgetMs);
    if (!Number.isInteger(n) || n < 30000 || n > 380000) throw usage("--task-budget-ms must be an integer between 30000 and 380000");
    taskBudget = String(n);
  }
  let fileSel: SecretSelection | null = null;
  let envFile: string | undefined;
  if (opts.envFile) {
    envFile = resolve(io.cwd, opts.envFile);
    let text: string;
    try {
      text = readFileSync(envFile, "utf8");
    } catch (e) {
      throw usage(`cannot read --env-file ${opts.envFile}: ${(e as Error).message}`);
    }
    fileSel = selectEnvSecrets(parseDotenv(text));
  }
  const token = (opts.accessTokenStdin ? await io.readStdin() : (io.env.SUPABASE_ACCESS_TOKEN ?? "")).trim();
  if (!token) throw usage(opts.accessTokenStdin ? "no access token on stdin" : "SUPABASE_ACCESS_TOKEN is not set", TOKEN_HINT);

  const runCmd = io.run ?? defaultRun;
  const randomHex = io.randomHex ?? defaultRandomHex;
  const api = new ManagementApi(io.fetch, token, ref);
  const env = childEnv(io.env, token);
  let internalSecret: string | undefined;
  const redact = redactor(() => [token, internalSecret, ...(fileSel?.upload.map((s) => s.value) ?? [])]);
  const dry = !!opts.dryRun;
  const checkFetch = (url: string, init: RequestInit = {}) => io.fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });

  // ---- step reporting --------------------------------------------------------------------------------------
  const steps: StepRecord[] = [];
  const say = (s: string) => ctx.note(redact(s));
  const info = (s: string) => say(`      ${c.dim(s)}`);
  const warn = (s: string) => say(`      ${c.yellow("warning:")} ${s}`);
  type Outcome = { status?: StepStatus; detail: string };
  /** n = 0: the preflight checks, which run before anything changes */
  const step = async (n: number, name: string, skip: string | false, fn: () => Promise<Outcome>): Promise<void> => {
    const label = n === 0 ? "[preflight]" : `[${n}/${TOTAL}]`;
    say(`${c.bold(label)} ${name}`);
    if (skip) {
      steps.push({ step: n, name, status: "skipped", detail: skip });
      say(`      ${c.dim(`skipped (${skip})`)}`);
      return;
    }
    let out: Outcome;
    try {
      out = await fn();
    } catch (e) {
      const err = e as Error & { hint?: string; exitCode?: number };
      const detail = redact(err.message);
      steps.push({ step: n, name, status: "failed", detail });
      say(`      ${c.red("✗")} ${detail}`);
      throw new CliError(`deploy stopped at ${label} ${name}`, {
        exitCode: err instanceof CliError ? err.exitCode : 1,
        hint: err.hint ? redact(err.hint) : undefined,
        data: { steps },
      });
    }
    const status = out.status ?? "ok";
    steps.push({ step: n, name, status, detail: redact(out.detail) });
    say(`      ${status === "planned" ? c.cyan("would") : c.green("✓")} ${out.detail}`);
  };

  /** The repo's Supabase CLI (devDependency). */
  const supabaseBin = (): string => {
    const bin = join(dir, "node_modules", ".bin", "supabase");
    if (!existsSync(bin)) throw new CliError(`the Supabase CLI was not found at ${relative(io.cwd, bin) || bin}`, { hint: `run npm install in ${dir}` });
    return bin;
  };
  const supabase = async (args: string[], cwd: string) => {
    const stream = opts.verbose ? lineRedactor(redact, io.stderr) : undefined;
    const r = await runCmd(supabaseBin(), args, { cwd, env, onOutput: stream?.push });
    stream?.flush();
    return { code: r.code, output: redact(r.output) };
  };
  const failed = (what: string, output: string, hint?: string) =>
    new CliError(`${what}${output.trim() ? `\n${tail(output).replace(/^/gm, "        ")}` : ""}`, { hint });

  if (dry) say(c.yellow("dry run: nothing will be changed"));

  // ---- preflight: everything that can fail without the network, before anything changes -------------------
  // (the Supabase CLI is needed by steps 2 and 5; functions bundle supabase/functions/_shared/core, a copy of
  // packages/core, so a stale copy is refused here rather than after migrations and secrets changed)
  const needsCli = !dry && (!opts.skipDb || !opts.skipFunctions);
  const checkShared = join(dir, "scripts", "check-shared.mjs");
  const runCheckShared = !opts.skipFunctions && existsSync(checkShared);
  if (needsCli || runCheckShared) {
    await step(0, "Preflight", false, async () => {
      const parts: string[] = [];
      if (needsCli) {
        supabaseBin();
        parts.push("Supabase CLI found");
      }
      if (runCheckShared) {
        const r = await runCmd(process.execPath, [checkShared], { cwd: dir, env });
        if (r.code !== 0) throw failed("supabase/functions/_shared/core is out of date with packages/core", redact(r.output), "run npm run sync:shared, then kf deploy again");
        parts.push("_shared/core up to date");
      }
      return { detail: parts.join(", ") };
    });
  }

  // ---- 1. project --------------------------------------------------------------------------------------------
  let project: { name?: string; region?: string; status?: string } = {};
  await step(1, "Project", false, async () => {
    try {
      project = await api.project();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) throw new CliError("the Management API rejected the access token (HTTP 401)", { exitCode: 3, hint: TOKEN_HINT });
      if (e instanceof ApiError && (e.status === 404 || e.status === 403))
        throw new CliError(`project ${ref} not found, or this token's account cannot access it (HTTP ${e.status})`, { hint: "check --project-ref and which account created the token" });
      throw e;
    }
    if (project.status && /PAUSED|PAUSING|INACTIVE|REMOVED|GOING_DOWN/.test(project.status)) {
      throw new CliError(`project ${ref} is ${project.status}`, { hint: "restore or unpause it in the Supabase dashboard first" });
    }
    if (project.status && project.status !== "ACTIVE_HEALTHY") warn(`project status is ${project.status} (expected ACTIVE_HEALTHY)`);
    return { detail: `${project.name ?? ref} (${[project.region, project.status].filter(Boolean).join(", ") || ref})` };
  });

  // ---- 2. database -------------------------------------------------------------------------------------------
  await step(2, "Database migrations", opts.skipDb ? "--skip-db" : false, async () => {
    if (dry) {
      try {
        const r = await supabase(["db", "push", `--remote=${ref}`, "--dry-run", "--skip-vault", "--agent", "no"], dir);
        if (r.code !== 0) warn(`could not preview pending migrations (supabase db push --dry-run exited ${r.code}):\n${tail(r.output, 8)}`);
        else for (const line of tail(r.output, 12).split("\n").filter((l) => l.trim())) info(line);
      } catch (e) {
        warn(`could not preview pending migrations: ${(e as Error).message}`);
      }
      return { status: "planned", detail: `run supabase db push --remote=${ref} --yes --skip-vault` };
    }
    const r = await supabase(["db", "push", `--remote=${ref}`, "--yes", "--skip-vault", "--agent", "no"], dir);
    if (r.code !== 0) throw failed(`supabase db push exited ${r.code}`, r.output, "fix the error above and run kf deploy again (completed steps are idempotent)");
    const applied = (r.output.match(/Applying migration/gi) ?? []).length;
    return { detail: applied ? `applied ${applied} migration${applied === 1 ? "" : "s"}` : /up to date/i.test(r.output) ? "up to date" : "done" };
  });

  // ---- 3. vault ----------------------------------------------------------------------------------------------
  await step(3, "Vault secrets", false, async () => {
    if (dry) return { status: "planned", detail: `reuse Vault kf_internal_secret if it exists (else generate one); set project_url = ${projectUrl}` };
    type Row = { id: string; name: string; decrypted_secret?: string | null };
    const names = "('kf_internal_secret', 'project_url')";
    let rows: Row[];
    let canRead = true;
    try {
      rows = await api.query<Row>(`select id::text as id, name, decrypted_secret from vault.decrypted_secrets where name in ${names}`);
    } catch (e) {
      if (!(e instanceof ApiError) || !/permission denied|42501/i.test(e.message)) throw e;
      canRead = false;
      rows = await api.query<Row>(`select id::text as id, name from vault.secrets where name in ${names}`);
    }
    const parts: string[] = [];
    const cur = rows.find((r) => r.name === "kf_internal_secret");
    if (cur && canRead && cur.decrypted_secret) {
      internalSecret = cur.decrypted_secret;
      parts.push("kf_internal_secret reused");
    } else if (cur) {
      internalSecret = randomHex(32);
      await api.query(`select vault.update_secret(${sqlLiteral(cur.id)}::uuid, ${sqlLiteral(internalSecret)})`);
      parts.push("kf_internal_secret rotated (its value could not be read)");
    } else {
      internalSecret = randomHex(32);
      await api.query(`select vault.create_secret(${sqlLiteral(internalSecret)}, 'kf_internal_secret', 'Supaknowledge: x-kf-internal header for cron -> Edge Functions')`);
      parts.push("kf_internal_secret created");
    }
    const pu = rows.find((r) => r.name === "project_url");
    if (!pu) {
      await api.query(`select vault.create_secret(${sqlLiteral(projectUrl)}, 'project_url', 'Supaknowledge: base URL cron uses for Edge Functions')`);
      parts.push("project_url created");
    } else if (canRead && pu.decrypted_secret === projectUrl) {
      parts.push("project_url unchanged");
    } else {
      await api.query(`select vault.update_secret(${sqlLiteral(pu.id)}::uuid, ${sqlLiteral(projectUrl)})`);
      parts.push("project_url updated");
    }
    return { detail: parts.join(", ") };
  });

  // ---- 4. function secrets -----------------------------------------------------------------------------------
  let modelConfigured = false;
  /** SHA-256 digest of a custom KF_PUBLIC_URL kept on the project (its value is not readable) */
  let keptPublicDigest: string | undefined;
  /** false while a kept custom KF_PUBLIC_URL has not been identified (the summary then does not guess) */
  let publicUrlKnown = true;
  const sha = (v: string) => createHash("sha256").update(v).digest("hex");
  const matchesKept = (origin: string) => [origin, `${origin}/`].some((v) => sha(v) === keptPublicDigest);
  const mcpMetadataUrl = `${projectUrl}/functions/v1/mcp/.well-known/oauth-protected-resource`;
  /** The origin the deployed mcp function advertises (from its protected-resource metadata). */
  const advertisedOrigin = async (): Promise<{ origin?: string; error: string }> => {
    try {
      const res = await checkFetch(mcpMetadataUrl);
      const body = (await res.json().catch(() => null)) as { resource?: unknown } | null;
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const m = typeof body?.resource === "string" ? /^(https?:\/\/[^/]+)\/functions\/v1\/mcp$/.exec(body.resource) : null;
      return m ? { origin: m[1]!, error: "" } : { error: `resource is ${JSON.stringify(body?.resource)}` };
    } catch (e) {
      return { error: (e as Error).message };
    }
  };
  await step(4, "Function secrets", false, async () => {
    const entries = await api.secrets();
    const existing = new Set(entries.map((s) => s.name));
    const set = new Map<string, string>();
    set.set("KF_INTERNAL_SECRET", internalSecret ?? "");
    // keep a custom KF_PUBLIC_URL (custom domain, proxy) on re-runs without --public-url: the API returns the value's
    // SHA-256, so a digest that is not the default origin's means someone set it on purpose
    const storedPublic = entries.find((s) => s.name === "KF_PUBLIC_URL")?.value;
    if (!opts.publicUrl && storedPublic && storedPublic !== sha(projectUrl)) {
      keptPublicDigest = storedPublic;
      publicUrlKnown = false;
      // identify it from what the deployed mcp function advertises, accepted only if its digest matches
      const adv = await advertisedOrigin();
      if (adv.origin && matchesKept(adv.origin)) {
        publicUrl = adv.origin;
        publicUrlKnown = true;
      }
      info(`KF_PUBLIC_URL: keeping the project's custom value${publicUrlKnown ? ` (${publicUrl})` : ""} (pass --public-url to change it)`);
    } else set.set("KF_PUBLIC_URL", publicUrl);
    for (const s of fileSel?.upload ?? []) set.set(s.name, s.value);
    if (taskBudget) set.set("KF_CURATOR_TASK_BUDGET_MS", taskBudget);
    else if (!set.has("KF_CURATOR_TASK_BUDGET_MS")) {
      if (existing.has("KF_CURATOR_TASK_BUDGET_MS")) info("KF_CURATOR_TASK_BUDGET_MS: keeping the project's value");
      else {
        set.set("KF_CURATOR_TASK_BUDGET_MS", DEFAULT_TASK_BUDGET_MS);
        info(`KF_CURATOR_TASK_BUDGET_MS=${DEFAULT_TASK_BUDGET_MS} (fits the Free plan's 150 s limit; pass --task-budget-ms 380000 on paid plans)`);
      }
    }
    if (fileSel) {
      const rel = relative(io.cwd, envFile!) || envFile!;
      for (const i of fileSel.ignored) info(`ignored ${i.name} from ${rel}: ${i.reason}`);
      if (fileSel.empty.length) info(`empty in ${rel} (not uploaded): ${fileSel.empty.join(", ")}`);
    }
    modelConfigured = set.has("KF_LLM_MODEL") || existing.has("KF_LLM_MODEL");
    if (!modelConfigured) warn("no KF_LLM_MODEL on the project or in --env-file: the curator needs a model (docs/curator.md#model-configuration)");
    const names = [...set.keys()];
    if (dry) return { status: "planned", detail: `set ${names.join(", ")}` };
    await api.setSecrets([...set].map(([name, value]) => ({ name, value })));
    return { detail: `set ${names.join(", ")}` };
  });

  // ---- 5. edge functions -------------------------------------------------------------------------------------
  await step(5, "Edge Functions", opts.skipFunctions ? "--skip-functions" : false, async () => {
    const fnDir = join(dir, "supabase", "functions");
    const fns = readdirSync(fnDir).filter((f) => !f.startsWith("_") && !f.startsWith(".") && statSync(join(fnDir, f)).isDirectory());
    const useApi = opts.useApi ? ["--use-api"] : [];
    if (dry) return { status: "planned", detail: `run supabase functions deploy --remote=${ref} --yes${useApi.length ? " --use-api" : ""} from a clean copy (${fns.join(", ")})` };
    supabaseBin();
    const tmp = mkdtempSync(join(tmpdir(), "kf-deploy-"));
    try {
      mkdirSync(join(tmp, "supabase"));
      cpSync(fnDir, join(tmp, "supabase", "functions"), {
        recursive: true,
        filter: (src) => {
          const b = basename(src);
          return b !== "node_modules" && !b.startsWith(".env");
        },
      });
      const raw = readFileSync(join(dir, "supabase", "config.jsonc"), "utf8");
      const cleaned = configWithoutSecrets(raw);
      if (!cleaned) warn("could not parse supabase/config.jsonc; deploying with it unchanged (no .env files are copied)");
      writeFileSync(join(tmp, "supabase", "config.jsonc"), cleaned ?? raw);
      const r = await supabase(["functions", "deploy", `--remote=${ref}`, "--workdir", tmp, "--yes", "--agent", "no", ...useApi], tmp);
      if (r.code !== 0) throw failed(`supabase functions deploy exited ${r.code}`, r.output);
      const sizes = parseFunctionSizes(r.output);
      for (const [name, bytes] of sizes) info(`${name.padEnd(12)} ${formatMB(bytes)}`);
      const curator = sizes.get("curator");
      if (curator !== undefined && curator >= SIZE_WARN_BYTES) warn(`curator is ${formatMB(curator)}, close to Supabase's 20 MB function limit`);
      return { detail: `deployed ${fns.length} functions (${fns.join(", ")})` };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---- 6. auth -----------------------------------------------------------------------------------------------
  let siteUrl: string | undefined;
  await step(6, "Auth", opts.skipAuth ? "--skip-auth" : false, async () => {
    const current = await api.authConfig();
    siteUrl = typeof current.site_url === "string" ? current.site_url : undefined;
    const patch: AuthConfig = {};
    for (const [k, v] of Object.entries(AUTH_SETTINGS)) if (current[k] !== v) patch[k] = v;
    if (studio.length) {
      if (current.site_url !== studio[0]) patch.site_url = studio[0];
      const merged = mergeAllowList(typeof current.uri_allow_list === "string" ? current.uri_allow_list : "", studio);
      if (merged.added.length) patch.uri_allow_list = merged.value;
      siteUrl = studio[0];
    } else {
      info(`Site URL is ${siteUrl || "(unset)"}: the OAuth consent page and e-mail links use it. Pass --studio-url <url> once Studio is deployed.`);
    }
    if (current.mailer_autoconfirm === true) {
      warn(
        c.bold("e-mail confirmations are OFF (mailer_autoconfirm).") +
          " Invitations are accepted by the account whose confirmed e-mail matches, so anyone could sign up with an invited address. Turn on Authentication → Sign In / Providers → Email → Confirm email.",
      );
    }
    const keys = Object.keys(patch);
    if (!keys.length) return { detail: "already configured" };
    if (dry) return { status: "planned", detail: `set ${keys.join(", ")}` };
    await api.patchAuthConfig(patch);
    return { detail: `set ${keys.join(", ")}` };
  });

  // ---- 7. check ----------------------------------------------------------------------------------------------
  await step(7, "Check", opts.skipCheck ? "--skip-check" : false, async () => {
    const mcpUrl = `${publicUrl}/functions/v1/mcp`;
    if (dry) return { status: "planned", detail: "check the MCP metadata, the internal secret (embed, like cron) and the OAuth server metadata" };
    const done: string[] = [];

    // a) MCP protected-resource metadata names KF_PUBLIC_URL
    let lastErr = "";
    let ok = false;
    for (let attempt = 0; attempt < 5 && !ok; attempt++) {
      if (attempt) await io.sleep(3000);
      const adv = await advertisedOrigin();
      // a kept custom KF_PUBLIC_URL: the advertised origin must be the one whose digest is stored
      if (adv.origin && (keptPublicDigest ? matchesKept(adv.origin) : adv.origin === publicUrl)) {
        ok = true;
        publicUrl = adv.origin;
        publicUrlKnown = true;
      } else if (adv.origin) {
        lastErr = `resource is ${adv.origin}/functions/v1/mcp, expected ${keptPublicDigest ? "the project's custom KF_PUBLIC_URL" : mcpUrl}`;
      } else lastErr = adv.error;
    }
    if (!ok) throw new CliError(`MCP metadata check failed: ${lastErr}`, { hint: "is the mcp function deployed, and is KF_PUBLIC_URL right?" });
    done.push("MCP metadata");

    // b) the function secret matches what cron sends (Vault kf_internal_secret): an empty embed batch
    ok = false;
    for (let attempt = 0; attempt < 6 && !ok; attempt++) {
      if (attempt) await io.sleep(5000); // new secrets reach the functions within seconds
      try {
        const res = await checkFetch(`${projectUrl}/functions/v1/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-kf-internal": internalSecret ?? "" },
          body: JSON.stringify({ queue: "kf_embed", jobs: [] }),
        });
        const text = await res.text().catch(() => "");
        if (res.ok) ok = true;
        else lastErr = `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`;
        if (!ok && res.status !== 401 && res.status < 500) break;
      } catch (e) {
        lastErr = (e as Error).message;
      }
    }
    if (!ok) throw new CliError(`internal secret check failed (POST /functions/v1/embed): ${lastErr}`, { hint: "KF_INTERNAL_SECRET on the functions must equal the Vault kf_internal_secret; run kf deploy again" });
    done.push("internal secret");

    // c) OAuth authorization server metadata (Auth config takes up to a minute to propagate)
    ok = false;
    const maxAttempts = opts.skipAuth ? 1 : 13;
    for (let attempt = 0; attempt < maxAttempts && !ok; attempt++) {
      if (attempt) await io.sleep(5000);
      try {
        const res = await checkFetch(`${projectUrl}/.well-known/oauth-authorization-server/auth/v1`);
        await res.body?.cancel().catch(() => {});
        ok = res.status === 200;
      } catch {
        /* retry */
      }
    }
    if (ok) done.push("OAuth server");
    else info("OAuth server metadata is still propagating (it can take a minute); check later with: curl -s " + `${projectUrl}/.well-known/oauth-authorization-server/auth/v1`);
    return { detail: done.join(", ") + (ok ? "" : "; OAuth server still propagating") };
  });

  // ---- summary -----------------------------------------------------------------------------------------------
  let publishableKey: string | undefined;
  try {
    publishableKey = (await api.apiKeys()).find((k) => k.type === "publishable" && k.api_key)?.api_key ?? undefined;
  } catch {
    /* printed as a placeholder below */
  }
  // a custom KF_PUBLIC_URL that could not be identified is reported as unknown, not as the default origin
  const mcpUrl = publicUrlKnown ? `${publicUrl}/functions/v1/mcp` : null;
  const mcpShown = mcpUrl ?? "<KF_PUBLIC_URL>/functions/v1/mcp";
  const key = publishableKey ?? "sb_publishable_...";
  const result = {
    project_ref: ref,
    project: { name: project.name ?? null, region: project.region ?? null, status: project.status ?? null },
    project_url: projectUrl,
    public_url: publicUrlKnown ? publicUrl : null,
    mcp_url: mcpUrl,
    publishable_key: publishableKey ?? null,
    site_url: siteUrl ?? null,
    dry_run: dry,
    model_configured: modelConfigured,
    steps,
  };
  ctx.out(result, () => {
    const lines = [
      "",
      dry ? c.yellow("Dry run complete: nothing was changed.") : c.green(`Deployed to ${project.name ?? ref}.`),
      "",
      `  ${c.dim("Project URL    ")} ${projectUrl}`,
      `  ${c.dim("MCP URL        ")} ${mcpUrl ?? c.dim("<the project's custom KF_PUBLIC_URL>/functions/v1/mcp (not verified: run without --skip-check / --dry-run)")}`,
      `  ${c.dim("Publishable key")} ${publishableKey ?? c.dim("(see Settings → API Keys)")}`,
      "",
      c.bold("Next steps"),
      `  1. Studio (docs/deploy.md#5-studio-on-vercel): set VITE_SUPABASE_URL=${projectUrl}`,
      `     and VITE_SUPABASE_PUBLISHABLE_KEY=${key}, deploy apps/studio${studio.length ? "" : ", then run kf deploy again with --studio-url <studio-url> --skip-db --skip-functions"}`,
      `  2. Sign up in Studio, then: kf login --url ${projectUrl} --publishable-key ${key} --email you@example.com`,
      "  3. kf init --workspace <workspace> --space <space>",
      `  4. claude mcp add --transport http supaknowledge '${mcpShown}?space=<workspace>/<space>'   (or: kf mcp-config)`,
    ];
    return lines.join("\n");
  });
}
