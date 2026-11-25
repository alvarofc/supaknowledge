import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AUTH_SETTINGS } from "../src/commands/deploy.ts";
import type { RunFn } from "../src/context.ts";
import { configWithoutSecrets, jsoncToJson, lineRedactor, mergeAllowList, parseDotenv, parseFunctionSizes, redactor, selectEnvSecrets, sqlLiteral } from "../src/deploy/lib.ts";
import { harness, json, type Call, type Harness } from "./helpers.ts";

const REF = "abcdefghijklmnopqrst";
const TOKEN = "sbp_test_token_0123456789abcdef";
const API = `https://api.supabase.com/v1/projects/${REF}`;
const PROJECT_URL = `https://${REF}.supabase.co`;
const GENERATED = "f".repeat(64);
const EXISTING = "e".repeat(64);
const LLM_KEY = "llm-key-very-secret-value";

const CONFIG_JSONC = `{
  // comment with a URL https://example.com
  "project_id": "supaknowledge",
  "edge_runtime": {
    "enabled": true,
    /* block */
    "secrets": {
      "KF_INTERNAL_SECRET": "env(KF_INTERNAL_SECRET)",
    },
  },
  "functions": { "mcp": { "verify_jwt": false }, "embed": { "verify_jwt": false } },
}
`;

/** A fake repository clone: supabase/{config.jsonc,migrations,functions}, a stray .env and node_modules. */
function makeRepo(h: Harness): string {
  const dir = join(h.dir, "repo");
  mkdirSync(join(dir, "supabase", "migrations"), { recursive: true });
  writeFileSync(join(dir, "supabase", "config.jsonc"), CONFIG_JSONC);
  writeFileSync(join(dir, "supabase", ".env"), "KF_INTERNAL_SECRET=local-secret\n");
  for (const f of ["mcp", "embed", "curator", "_shared"]) {
    mkdirSync(join(dir, "supabase", "functions", f), { recursive: true });
    writeFileSync(join(dir, "supabase", "functions", f, "index.ts"), "// fn\n");
  }
  writeFileSync(join(dir, "supabase", "functions", "mcp", ".env.local"), "X=1\n");
  mkdirSync(join(dir, "supabase", "functions", "embed", "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "check-shared.mjs"), "");
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(dir, "node_modules", ".bin", "supabase"), "");
  return dir;
}

interface RunCall {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  /** for functions deploy: files in the workdir at call time */
  files?: string[];
  config?: string;
}

interface Backend {
  vault: { id: string; name: string; decrypted_secret: string }[];
  vaultReadable: boolean;
  secrets: string[];
  /** SHA-256 digests GET /secrets returns, by name (default "digest") */
  digests?: Record<string, string>;
  auth: Record<string, unknown>;
  runs: RunCall[];
  runResult: (c: RunCall) => { code: number; output: string } | undefined;
  /** the function secret the deployed functions expect (set by POST /secrets) */
  fnSecret?: string;
  /** origin the mcp function advertises in its protected-resource metadata (default: the project URL) */
  mcpOrigin?: string;
}

function listFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(root, p));
    else out.push(p);
  }
  return out;
}

function setup(over: Partial<Backend> = {}): { h: Harness; dir: string; b: Backend } {
  const h = harness({ loggedIn: false, project: false });
  const dir = makeRepo(h);
  const b: Backend = {
    vault: [],
    vaultReadable: true,
    secrets: [],
    auth: { site_url: "http://localhost:3000", uri_allow_list: "http://localhost:3000/**", mailer_autoconfirm: false },
    runs: [],
    runResult: () => undefined,
    ...over,
  };
  h.env.SUPABASE_ACCESS_TOKEN = TOKEN;
  h.env.KF_LLM_API_KEY = "from-shell"; // must not reach the Supabase CLI
  h.env.PATH = "/usr/bin";
  const run: RunFn = async (cmd, args, opts) => {
    const call: RunCall = { cmd, args, cwd: opts.cwd, env: { ...opts.env } };
    const wd = args.indexOf("--workdir");
    if (wd >= 0) {
      call.files = listFiles(args[wd + 1]!);
      call.config = readFileSync(join(args[wd + 1]!, "supabase", "config.jsonc"), "utf8");
    }
    b.runs.push(call);
    const custom = b.runResult(call);
    if (custom) return custom;
    if (args.includes("functions"))
      return { code: 0, output: "Bundling Function: mcp\nDeploying Function: mcp (script size: 1.2MB)\nDeploying Function: curator (script size: 19.6MB)\nDeploying Function: embed (script size: 812kB)\n" };
    if (args.includes("db")) return { code: 0, output: "Applying migration 20261124000001_init.sql...\nApplying migration 20261125000002_more.sql...\nFinished supabase db push.\n" };
    return { code: 0, output: "" };
  };
  h.io = { run, randomHex: () => GENERATED };
  h.routes.push(async (c) => {
    if (c.url === API && c.method === "GET") return json({ id: REF, ref: REF, name: "kf-prod", region: "eu-west-1", status: "ACTIVE_HEALTHY" });
    if (c.url === `${API}/database/query` && c.method === "POST") {
      const q = String(c.body.query);
      if (q.includes("from vault.decrypted_secrets")) {
        if (!b.vaultReadable) return json({ message: "Failed to run sql query: ERROR:  42501: permission denied for view decrypted_secrets" }, 400);
        return json(b.vault, 201);
      }
      if (q.includes("from vault.secrets")) return json(b.vault.map(({ id, name }) => ({ id, name })), 201);
      if (q.includes("vault.create_secret")) return json([{ create_secret: "new-id" }], 201);
      if (q.includes("vault.update_secret")) return json([{ update_secret: "" }], 201);
      return json({ message: `unexpected query ${q}` }, 400);
    }
    if (c.url === `${API}/secrets` && c.method === "GET") return json(b.secrets.map((name) => ({ name, value: b.digests?.[name] ?? "digest" })));
    if (c.url === `${API}/secrets` && c.method === "POST") {
      b.fnSecret = (c.body as { name: string; value: string }[]).find((s) => s.name === "KF_INTERNAL_SECRET")?.value;
      return json(null, 201);
    }
    if (c.url === `${API}/config/auth` && c.method === "GET") return json(b.auth);
    if (c.url === `${API}/config/auth` && c.method === "PATCH") return json({ ...b.auth, ...c.body });
    if (c.url === `${API}/api-keys?reveal=false`) return json([{ name: "anon", type: "legacy", api_key: "eyJ..." }, { name: "default", type: "publishable", api_key: "sb_publishable_abc" }]);
    if (c.url === `${PROJECT_URL}/functions/v1/mcp/.well-known/oauth-protected-resource`) return json({ resource: `${b.mcpOrigin ?? PROJECT_URL}/functions/v1/mcp` });
    if (c.url === `${PROJECT_URL}/functions/v1/embed`) {
      return c.headers["x-kf-internal"] && c.headers["x-kf-internal"] === b.fnSecret ? json({ completed: [], failed: [], archived: [], requeued: 0 }) : json({ error: "invalid internal secret" }, 401);
    }
    if (c.url === `${PROJECT_URL}/.well-known/oauth-authorization-server/auth/v1`) return json({ issuer: `${PROJECT_URL}/auth/v1` });
    return undefined;
  });
  return { h, dir, b };
}

const mgmt = (calls: Call[]) => calls.filter((c) => c.url.startsWith("https://api.supabase.com/")).map((c) => `${c.method} ${c.url.slice(API.length) || "/"}`);
const queries = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/database/query")).map((c) => String(c.body.query));

describe("deploy helpers", () => {
  it("parses dotenv: quotes, escapes, single-quoted JSON, comments, export", () => {
    const env = parseDotenv(
      [
        "# comment",
        "export KF_LLM_MODEL=acme/model   # trailing comment",
        "KF_LLM_BASE_URL = https://llm.example.com/v1#frag",
        `KF_LLM_EXTRA_BODY='{"chat_template_kwargs":{"enable_thinking":false}}'`,
        `KF_LLM_HEADERS="{\\"x-team\\":\\"kb\\"}"`,
        `MULTI="line1\\nline2"`,
        "SPANNING='a",
        "b'",
        "EMPTY=",
        "QUOTED_HASH=\"a # not a comment\"",
        "not a line",
        "KF_LLM_MODEL=acme/override",
      ].join("\r\n"),
    );
    assert.equal(env.get("KF_LLM_MODEL"), "acme/override");
    assert.equal(env.get("KF_LLM_BASE_URL"), "https://llm.example.com/v1#frag");
    assert.deepEqual(JSON.parse(env.get("KF_LLM_EXTRA_BODY")!), { chat_template_kwargs: { enable_thinking: false } });
    assert.deepEqual(JSON.parse(env.get("KF_LLM_HEADERS")!), { "x-team": "kb" });
    assert.equal(env.get("MULTI"), "line1\nline2");
    assert.equal(env.get("SPANNING"), "a\nb");
    assert.equal(env.get("EMPTY"), "");
    assert.equal(env.get("QUOTED_HASH"), "a # not a comment");
    assert.equal(env.has("not"), false);
  });

  it("selects function secrets and ignores the ones kf deploy owns", () => {
    const sel = selectEnvSecrets(
      new Map([
        ["KF_LLM_MODEL", "acme/m"],
        ["KF_LLM_API_KEY", "k"],
        ["AI_GATEWAY_API_KEY", "g"],
        ["KF_CONNECTOR_MAX_BYTES", "100"],
        ["KF_CONNECTORS_EGRESS_PROXY", "http://p:3128"],
        ["KF_CURATOR_TASK_BUDGET_MS", "380000"],
        ["CONNECTOR_DOC_LIMIT", "50"],
        ["GITHUB_TOKEN", "gh"],
        ["KF_LLM_FAST_MODEL", ""],
        ["KF_INTERNAL_SECRET", "local"],
        ["KF_PUBLIC_URL", "http://localhost"],
        ["SUPABASE_PUBLIC_URL", "http://x"],
        ["OPENROUTER_API_KEY_OLD", "x"],
        ["S3_HOST", "x"],
      ]),
    );
    assert.deepEqual(sel.upload.map((s) => s.name), ["KF_LLM_MODEL", "KF_LLM_API_KEY", "AI_GATEWAY_API_KEY", "KF_CONNECTOR_MAX_BYTES", "KF_CONNECTORS_EGRESS_PROXY", "KF_CURATOR_TASK_BUDGET_MS", "CONNECTOR_DOC_LIMIT", "GITHUB_TOKEN"]);
    assert.deepEqual(sel.ignored.map((s) => s.name), ["KF_INTERNAL_SECRET", "KF_PUBLIC_URL", "SUPABASE_PUBLIC_URL", "OPENROUTER_API_KEY_OLD", "S3_HOST"]);
    assert.deepEqual(sel.empty, ["KF_LLM_FAST_MODEL"]);
    assert.ok(!JSON.stringify(sel.ignored).includes("local"), "ignored entries carry no values");
  });

  it("merges the redirect allow-list without duplicates", () => {
    assert.deepEqual(mergeAllowList("http://localhost:3000/**, https://studio.example.com/**", ["https://studio.example.com", "https://preview.example.com/"]), {
      value: "http://localhost:3000/**,https://studio.example.com/**,https://preview.example.com/**",
      added: ["https://preview.example.com/**"],
    });
    assert.deepEqual(mergeAllowList("", ["https://s.example.com"]), { value: "https://s.example.com/**", added: ["https://s.example.com/**"] });
    assert.deepEqual(mergeAllowList(null, []), { value: "", added: [] });
  });

  it("redacts the longest secret first, and whole lines of streamed output", () => {
    const redact = redactor(() => ["abcdef", "abcdefghijkl", undefined, "123"]);
    assert.equal(redact("x abcdefghijkl y abcdef z 123"), "x *** y *** z 123");
    let out = "";
    const stream = lineRedactor(redact, (s) => void (out += s));
    stream.push("a abc");
    stream.push("def\nb abcdefgh");
    assert.equal(out, "a ***\n");
    stream.push("ijkl");
    stream.flush();
    assert.equal(out, "a ***\nb ***");
  });

  it("strips JSONC and edge_runtime.secrets, quotes SQL, parses function sizes", () => {
    assert.equal(JSON.parse(jsoncToJson(CONFIG_JSONC)).project_id, "supaknowledge");
    const cfg = JSON.parse(configWithoutSecrets(CONFIG_JSONC)!);
    assert.equal(cfg.edge_runtime.enabled, true);
    assert.equal(cfg.edge_runtime.secrets, undefined);
    assert.equal(cfg.functions.mcp.verify_jwt, false);
    assert.equal(configWithoutSecrets("{ nope"), null);
    assert.equal(sqlLiteral("it's"), "'it''s'");
    assert.deepEqual([...parseFunctionSizes("Deploying Function: curator (script size: 19.6MB)\nDeploying Function: embed (script size: 812kB)\n")], [
      ["curator", 19_600_000],
      ["embed", 812_000],
    ]);
  });
});

describe("kf deploy", () => {
  it("--help shows the steps", async () => {
    const h = harness({ loggedIn: false, project: false });
    const r = await h.run("deploy", "--help");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /--project-ref <ref>/);
    assert.match(r.stdout, /\[7\/7\] Check/);
  });

  it("refuses to run outside a repository clone, and without a token", async () => {
    const { h, dir } = setup();
    let r = await h.runIn(h.dir, "deploy", "--project-ref", REF);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /run kf deploy from a clone of the supaknowledge repository \(or pass --dir\)/);
    delete h.env.SUPABASE_ACCESS_TOKEN;
    r = await h.run("deploy", "--project-ref", REF, "--dir", dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /SUPABASE_ACCESS_TOKEN is not set/);
    assert.match(r.stderr, /dashboard\/account\/tokens/);
    r = await h.run("deploy", "--project-ref", "Not-A-Ref", "--dir", dir);
    assert.equal(r.code, 2);
    r = await h.run("deploy", "--project-ref", REF, "--dir", dir, "--studio-url", "https://studio.example.com/path");
    assert.equal(r.code, 2);
    assert.equal(h.calls.length, 0);
  });

  it("--dry-run reads but changes nothing, and prints secret names only", async () => {
    const { h, dir, b } = setup({ secrets: ["KF_LLM_MODEL", "KF_CURATOR_TASK_BUDGET_MS"] });
    const envFile = join(h.dir, "hosted.env");
    writeFileSync(envFile, `KF_LLM_API_KEY=${LLM_KEY}\nKF_INTERNAL_SECRET=local-secret\n`);
    const r = await h.run("deploy", "--project-ref", REF, "--dir", dir, "--dry-run", "--env-file", envFile, "--studio-url", "https://studio.example.com");
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      h.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url}`),
      [],
      "no mutating calls",
    );
    assert.deepEqual(
      b.runs.map((x) => x.args.filter((a) => !a.startsWith("/")).join(" ")),
      ["", `db push --remote=${REF} --dry-run --skip-vault --agent no`], // check-shared.mjs (an absolute path), then the preview
      "only check-shared and db push --dry-run",
    );
    const out = r.stdout + r.stderr;
    assert.match(out, /dry run/i);
    assert.match(out, /KF_INTERNAL_SECRET, KF_PUBLIC_URL, KF_LLM_API_KEY/);
    assert.match(out, /keeping the project's value/);
    assert.match(out, /ignored KF_INTERNAL_SECRET/);
    assert.match(out, /site_url, uri_allow_list/);
    assert.ok(!out.includes(LLM_KEY) && !out.includes("local-secret") && !out.includes(TOKEN));
    assert.equal(JSON.parse((await h.run("deploy", "--project-ref", REF, "--dir", dir, "--dry-run", "--json")).stdout).dry_run, true);
  });

  it("keeps a custom KF_PUBLIC_URL on re-runs without --public-url, and resets the default one", async () => {
    const sha = (v: string) => createHash("sha256").update(v).digest("hex");
    const posted = async (digest: string) => {
      const { h, dir } = setup({ secrets: ["KF_PUBLIC_URL"], digests: { KF_PUBLIC_URL: digest }, mcpOrigin: digest === sha(PROJECT_URL) ? PROJECT_URL : "https://kb.example.com" });
      const r = await h.run("deploy", "--project-ref", REF, "--dir", dir);
      assert.equal(r.code, 0, r.stderr);
      const body = h.calls.find((c) => c.method === "POST" && c.url.endsWith("/secrets"))!.body as { name: string }[];
      return { names: body.map((x) => x.name), out: r.stdout + r.stderr };
    };
    const custom = await posted(sha("https://kb.example.com"));
    assert.ok(!custom.names.includes("KF_PUBLIC_URL"));
    assert.match(custom.out, /keeping the project's custom value \(https:\/\/kb\.example\.com\)/);
    assert.match(custom.out, /MCP URL\s+https:\/\/kb\.example\.com\/functions\/v1\/mcp/);
    assert.ok((await posted(sha(PROJECT_URL))).names.includes("KF_PUBLIC_URL"));
  });

  it("reports a kept custom KF_PUBLIC_URL without running the check, and never substitutes the default", async () => {
    const sha = (v: string) => createHash("sha256").update(v).digest("hex");
    const digests = { KF_PUBLIC_URL: sha("https://kb.example.com") };
    // identified from the deployed function's metadata (digest matches): reported even with --skip-check
    let { h, dir } = setup({ secrets: ["KF_PUBLIC_URL"], digests, mcpOrigin: "https://kb.example.com" });
    let r = await h.run("deploy", "--project-ref", REF, "--dir", dir, "--skip-db", "--skip-functions", "--skip-check", "--json");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).mcp_url, "https://kb.example.com/functions/v1/mcp");
    // the function still advertises the default origin (stale): unknown, not the default
    ({ h, dir } = setup({ secrets: ["KF_PUBLIC_URL"], digests }));
    r = await h.run("deploy", "--project-ref", REF, "--dir", dir, "--skip-db", "--skip-functions", "--skip-check", "--json");
    assert.equal(r.code, 0, r.stderr);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.mcp_url, null);
    assert.equal(doc.public_url, null);
    r = await h.run("deploy", "--project-ref", REF, "--dir", dir, "--skip-db", "--skip-functions", "--skip-check");
    assert.match(r.stdout, /<KF_PUBLIC_URL>\/functions\/v1\/mcp\?space=/);
    // ... and the check does not accept the stale origin
    r = await h.run("deploy", "--project-ref", REF, "--dir", dir, "--skip-db", "--skip-functions");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /expected the project's custom KF_PUBLIC_URL/);
  });

  it("happy path: creates the Vault secret and pushes the same value to the functions, in order", async () => {
    const { h, dir, b } = setup();
    const envFile = join(h.dir, "hosted.env");
    writeFileSync(envFile, `# hosted\nKF_LLM_MODEL=acme/model\nKF_LLM_API_KEY="${LLM_KEY}"\nKF_LLM_EXTRA_BODY='{"a":1}'\nKF_PUBLIC_URL=http://localhost\nSUPABASE_URL=http://kong:8000\n`);
    const r = await h.run("deploy", "--project-ref", REF, "--dir", dir, "--env-file", envFile, "--studio-url", "https://studio.example.com");
    assert.equal(r.code, 0, r.stderr);

    assert.deepEqual(mgmt(h.calls), [
      "GET /",
      "POST /database/query",
      "POST /database/query",
      "POST /database/query",
      "GET /secrets",
      "POST /secrets",
      "GET /config/auth",
      "PATCH /config/auth",
      "GET /api-keys?reveal=false",
    ]);
    const q = queries(h.calls);
    assert.match(q[1]!, new RegExp(`vault.create_secret\\('${GENERATED}', 'kf_internal_secret'`));
    assert.match(q[2]!, new RegExp(`vault.create_secret\\('${PROJECT_URL}', 'project_url'`));

    const secrets = h.calls.find((c) => c.method === "POST" && c.url.endsWith("/secrets"))!.body as { name: string; value: string }[];
    assert.deepEqual(Object.fromEntries(secrets.map((s) => [s.name, s.value])), {
      KF_INTERNAL_SECRET: GENERATED,
      KF_PUBLIC_URL: PROJECT_URL,
      KF_LLM_MODEL: "acme/model",
      KF_LLM_API_KEY: LLM_KEY,
      KF_LLM_EXTRA_BODY: '{"a":1}',
      KF_CURATOR_TASK_BUDGET_MS: "140000",
    });

    // check-shared before anything changes, then db push, then functions deploy from a clean copy
    const [check, push, deployFns] = b.runs;
    assert.deepEqual(push!.args, ["db", "push", `--remote=${REF}`, "--yes", "--skip-vault", "--agent", "no"]);
    assert.equal(push!.cwd, dir);
    assert.equal(push!.env.SUPABASE_ACCESS_TOKEN, TOKEN);
    assert.equal(push!.env.KF_LLM_API_KEY, undefined, "no function settings leak into the CLI's environment");
    assert.match(check!.args[0]!, /check-shared\.mjs$/);
    assert.deepEqual(deployFns!.args.filter((a) => !a.startsWith("/")), ["functions", "deploy", `--remote=${REF}`, "--workdir", "--yes", "--agent", "no"]);
    assert.ok(deployFns!.files!.includes("supabase/functions/mcp/index.ts"));
    assert.ok(deployFns!.files!.every((f) => !/\.env|node_modules/.test(f)), deployFns!.files!.join(","));
    assert.equal(JSON.parse(deployFns!.config!).edge_runtime.secrets, undefined);
    assert.ok(!existsSync(deployFns!.args[deployFns!.args.indexOf("--workdir") + 1]!), "temp dir removed");

    const patch = h.calls.find((c) => c.method === "PATCH")!.body;
    assert.equal(patch.mailer_autoconfirm, undefined);
    assert.deepEqual(patch, {
      oauth_server_enabled: true,
      oauth_server_allow_dynamic_registration: true,
      oauth_server_authorization_path: "/oauth/consent",
      hook_before_user_created_enabled: true,
      hook_before_user_created_uri: "pg-functions://postgres/private/hook_before_user_created",
      security_update_password_require_reauthentication: true,
      site_url: "https://studio.example.com",
      uri_allow_list: "http://localhost:3000/**,https://studio.example.com/**",
    });

    const embed = h.calls.find((c) => c.url.endsWith("/functions/v1/embed"))!;
    assert.equal(embed.headers["x-kf-internal"], GENERATED);
    assert.deepEqual(embed.body, { queue: "kf_embed", jobs: [] });

    const out = r.stdout + r.stderr;
    for (let n = 1; n <= 7; n++) assert.match(out, new RegExp(`\\[${n}/7\\]`));
    assert.match(out, /applied 2 migrations/);
    assert.match(out, /curator is 19\.6 MB/);
    assert.match(out, /ignored KF_PUBLIC_URL/);
    assert.match(out, /ignored SUPABASE_URL/);
    assert.match(out, /sb_publishable_abc/);
    assert.match(out, /VITE_SUPABASE_URL=https:\/\/abcdefghijklmnopqrst\.supabase\.co/);
    assert.match(out, /claude mcp add --transport http supaknowledge/);
    for (const secret of [TOKEN, GENERATED, LLM_KEY]) assert.ok(!out.includes(secret), `output leaks ${secret.slice(0, 6)}…`);
  });

  it("reuses an existing Vault secret and keeps a matching project_url", async () => {
    const { h, dir } = setup({
      vault: [
        { id: "11111111-1111-4111-8111-111111111111", name: "kf_internal_secret", decrypted_secret: EXISTING },
        { id: "22222222-2222-4222-8222-222222222222", name: "project_url", decrypted_secret: PROJECT_URL },
      ],
      secrets: ["KF_LLM_MODEL", "KF_CURATOR_TASK_BUDGET_MS"],
      auth: { site_url: "https://studio.example.com", ...AUTH_SETTINGS },
    });
    const r = await h.run("deploy", "--project-ref", REF, "--dir", dir, "--skip-db", "--skip-functions", "--json");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(queries(h.calls).length, 1, "only the read: nothing to create or update");
    const secrets = h.calls.find((c) => c.method === "POST" && c.url.endsWith("/secrets"))!.body as { name: string; value: string }[];
    assert.deepEqual(secrets.map((s) => s.name), ["KF_INTERNAL_SECRET", "KF_PUBLIC_URL"], "budget kept, no model warning");
    assert.equal(secrets[0]!.value, EXISTING);
    assert.equal(h.calls.filter((c) => c.method === "PATCH").length, 0, "auth already configured");
    const doc = JSON.parse(r.stdout);
    assert.deepEqual(doc.steps.map((s: { status: string }) => s.status), ["ok", "skipped", "ok", "ok", "skipped", "ok", "ok"]);
    assert.equal(doc.publishable_key, "sb_publishable_abc");
    assert.match(r.stderr, /Site URL is https:\/\/studio\.example\.com/);
    assert.ok(!r.stderr.includes(EXISTING) && !r.stdout.includes(EXISTING));
  });

  it("rotates the secret when Vault values cannot be read, and warns about autoconfirm and a missing model", async () => {
    const { h, dir } = setup({
      vaultReadable: false,
      vault: [
        { id: "11111111-1111-4111-8111-111111111111", name: "kf_internal_secret", decrypted_secret: EXISTING },
        { id: "22222222-2222-4222-8222-222222222222", name: "project_url", decrypted_secret: "http://old" },
      ],
      auth: { site_url: "", mailer_autoconfirm: true },
    });
    const r = await h.run("deploy", "--project-ref", REF, "--dir", dir, "--skip-db", "--skip-functions", "--skip-check");
    assert.equal(r.code, 0, r.stderr);
    const q = queries(h.calls);
    assert.match(q[1]!, /from vault\.secrets/);
    assert.match(q[2]!, new RegExp(`vault.update_secret\\('11111111-1111-4111-8111-111111111111'::uuid, '${GENERATED}'\\)`));
    assert.match(q[3]!, new RegExp(`vault.update_secret\\('22222222-2222-4222-8222-222222222222'::uuid, '${PROJECT_URL}'\\)`));
    assert.match(r.stderr, /rotated/);
    assert.match(r.stderr, /e-mail confirmations are OFF/);
    assert.match(r.stderr, /curator needs a model/);
    assert.equal(h.calls.find((c) => c.method === "PATCH")!.body.mailer_autoconfirm, undefined, "never touches autoconfirm");
  });

  it("stops at the first failing step with a non-zero exit and the CLI output tail", async () => {
    const { h, dir, b } = setup({ runResult: (c) => (c.args.includes("db") ? { code: 1, output: `connecting with ${TOKEN}\nERROR: migration 0042 failed: relation x does not exist\n` } : undefined) });
    const r = await h.run("deploy", "--project-ref", REF, "--dir", dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\[2\/7\] Database/);
    assert.match(r.stderr, /migration 0042 failed/);
    assert.match(r.stderr, /deploy stopped at \[2\/7\]/);
    assert.doesNotMatch(r.stderr, /\[3\/7\]/);
    assert.deepEqual(mgmt(h.calls), ["GET /"], "nothing after the failed step");
    assert.equal(b.runs.length, 2, "check-shared and db push only");
    assert.ok(!r.stderr.includes(TOKEN) && !r.stdout.includes(TOKEN), "token redacted from CLI output");
    assert.match(r.stderr, /connecting with \*\*\*/);
  });

  it("refuses a stale _shared/core before changing anything", async () => {
    const { h, dir, b } = setup({ runResult: (c) => (c.args[0]?.endsWith("check-shared.mjs") ? { code: 1, output: "differs: okf.ts\n" } : undefined) });
    const r = await h.run("deploy", "--project-ref", REF, "--dir", dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /out of date/);
    assert.match(r.stderr, /run npm run sync:shared/);
    assert.equal(b.runs.length, 1);
    assert.equal(h.calls.length, 0);
    assert.match(r.stderr, /deploy stopped at \[preflight\]/);
    const j = await h.run("deploy", "--project-ref", REF, "--dir", dir, "--json");
    assert.deepEqual(JSON.parse(j.stdout).steps.map((x: { step: number; status: string }) => [x.step, x.status]), [[0, "failed"]]);
  });

  it("checks for the Supabase CLI before changing anything, also with --skip-db", async () => {
    const { h, dir, b } = setup();
    rmSync(join(dir, "node_modules"), { recursive: true });
    const r = await h.run("deploy", "--project-ref", REF, "--dir", dir, "--skip-db");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Supabase CLI was not found/);
    assert.match(r.stderr, /run npm install/);
    assert.equal(h.calls.length, 0);
    assert.equal(b.runs.length, 0);
    // not needed when both steps that use it are skipped
    const ok = await h.run("deploy", "--project-ref", REF, "--dir", dir, "--skip-db", "--skip-functions", "--skip-check");
    assert.equal(ok.code, 0, ok.stderr);
  });

  it("refuses an unexpected GET /secrets response instead of assuming no secrets", async () => {
    const { h, dir } = setup();
    h.routes.unshift((c) => (c.url === `${API}/secrets` && c.method === "GET" ? json({ secrets: [] }) : undefined));
    const r = await h.run("deploy", "--project-ref", REF, "--dir", dir, "--skip-db", "--skip-functions");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unexpected response/);
    assert.ok(!h.calls.some((c) => c.method === "POST" && c.url.endsWith("/secrets")));
  });

  it("--verbose redacts a token split across output chunks", async () => {
    const { h, dir, b } = setup();
    const half = TOKEN.length / 2;
    h.io.run = async (cmd, args, opts) => {
      b.runs.push({ cmd, args, cwd: opts.cwd, env: {} });
      if (args.includes("db")) {
        opts.onOutput?.(`token ${TOKEN.slice(0, half)}`);
        opts.onOutput?.(`${TOKEN.slice(half)} in use\nno newline at the end ${TOKEN}`);
      }
      return { code: args.includes("db") ? 1 : 0, output: "" };
    };
    const r = await h.run("deploy", "--project-ref", REF, "--dir", dir, "--verbose");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /token \*\*\* in use\nno newline at the end \*\*\*/);
    assert.ok(!r.stderr.includes(TOKEN.slice(0, half)) && !r.stderr.includes(TOKEN.slice(half)));
  });

  it("reports a rejected token with exit 3 and never prints it", async () => {
    const { h, dir } = setup();
    h.routes.unshift((c) => (c.url === API ? json({ message: `Unauthorized: ${TOKEN}` }, 401) : undefined));
    const r = await h.run("deploy", "--project-ref", REF, "--dir", dir);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /rejected the access token/);
    assert.ok(!r.stderr.includes(TOKEN) && !r.stdout.includes(TOKEN));
    assert.equal(h.calls[0]!.headers.authorization, `Bearer ${TOKEN}`);
  });

  it("reads the token from stdin and fails the check when the function secret does not match", async () => {
    const { h, dir } = setup();
    delete h.env.SUPABASE_ACCESS_TOKEN;
    h.stdin = `${TOKEN}\n`;
    // the functions keep an old secret (e.g. overwritten from a .env): embed rejects the Vault value
    h.routes.unshift((c) => (c.url.endsWith("/functions/v1/embed") ? json({ error: "invalid internal secret" }, 401) : undefined));
    const r = await h.run("deploy", "--project-ref", REF, "--dir", dir, "--access-token-stdin", "--skip-db", "--skip-functions", "--skip-auth");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /internal secret check failed/);
    assert.match(r.stderr, /KF_INTERNAL_SECRET on the functions must equal/);
    assert.equal(h.calls.filter((c) => c.url.endsWith("/functions/v1/embed")).length, 6, "retried while secrets propagate");
  });
});
