#!/usr/bin/env node
// Live smoke test of the built CLI (dist/kf.js) against a running Supaknowledge stack (`supabase start`).
//
//   npm run build && npm run smoke -w @supaknowledge/cli
//
// Env: SUPAKNOWLEDGE_URL (default http://127.0.0.1:54321), SUPAKNOWLEDGE_PUBLISHABLE_KEY, SUPAKNOWLEDGE_SECRET_KEY (to create and
// delete throwaway users through the Auth admin API). Everything it creates (two users, one workspace) is
// deleted at the end.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const URL = process.env.SUPAKNOWLEDGE_URL ?? "http://127.0.0.1:54321";
// Fallbacks are the Supabase CLI's public local-development defaults (printed by `supabase status`), not real secrets.
const PK = process.env.SUPAKNOWLEDGE_PUBLISHABLE_KEY ?? "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
const SK = process.env.SUPAKNOWLEDGE_SECRET_KEY ?? "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const KF = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "kf.js");
if (!existsSync(KF)) throw new Error("build first: npm run build -w @supaknowledge/cli");

const tag = Date.now().toString(36);
const root = mkdtempSync(join(tmpdir(), "kf-smoke-"));
const proj = join(root, "proj");
mkdirSync(proj);
const env = { ...process.env, SUPAKNOWLEDGE_CONFIG_DIR: join(root, "config"), NO_COLOR: "1" };
for (const k of ["SUPAKNOWLEDGE_URL", "SUPAKNOWLEDGE_TOKEN", "SUPAKNOWLEDGE_SPACE", "SUPAKNOWLEDGE_PROFILE", "SUPAKNOWLEDGE_PUBLISHABLE_KEY", "SUPAKNOWLEDGE_TRANSPORT"]) delete env[k];

let passed = 0;
function kf(args, opts = {}) {
  const r = spawnSync(process.execPath, [KF, ...args], { cwd: opts.cwd ?? proj, env: { ...env, ...(opts.env ?? {}) }, input: opts.input ?? "", encoding: "utf8" });
  const want = opts.code ?? 0;
  if (r.status !== want) {
    throw new Error(`kf ${args.join(" ")} exited ${r.status} (wanted ${want})\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
  return { out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}
async function step(name, fn) {
  await fn();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}
/** Retry until `fn` stops throwing (links and chunks are built asynchronously by the embed worker). */
async function eventually(fn, ms = 45000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return fn();
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
async function admin(method, path, body) {
  const res = await fetch(`${URL}/auth/v1/admin/${path}`, {
    method,
    headers: { apikey: SK, Authorization: `Bearer ${SK}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`auth admin ${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const owner = { email: `smoke-owner-${tag}@supaknowledge.test`, password: `pw-${tag}-owner` };
const reader = { email: `smoke-reader-${tag}@supaknowledge.test`, password: `pw-${tag}-reader` };
const ws = `smoke-${tag}`;
const users = [];

try {
  for (const u of [owner, reader]) {
    const r = await admin("POST", "users", { email: u.email, password: u.password, email_confirm: true });
    u.id = r.id;
    users.push(r.id);
  }

  // knowledge fixture: two OKF concepts + one skill with a binary attachment + an ignored dir
  const k = join(root, "knowledge");
  mkdirSync(join(k, "metrics"), { recursive: true });
  mkdirSync(join(k, "data"), { recursive: true });
  mkdirSync(join(k, "skills", "revenue-report", "scripts"), { recursive: true });
  mkdirSync(join(k, "scratch"), { recursive: true });
  writeFileSync(join(k, ".gitignore"), "scratch/\n");
  writeFileSync(join(k, "scratch", "ignored.md"), "---\ntype: Note\n---\nignored\n");
  writeFileSync(join(k, "index.md"), '---\nokf_version: "0.3"\ntitle: Smoke knowledge\n---\n# Smoke\n');
  writeFileSync(join(k, "metrics", "arr.md"), "---\ntype: Metric\ntitle: Annual Recurring Revenue\ndescription: ARR is the annualized value of active subscriptions.\n---\n# ARR\n\nARR = active subscription MRR x 12. See [orders](../data/orders.md).\n");
  writeFileSync(join(k, "data", "orders.md"), "---\ntype: BigQuery Table\ntitle: orders table\ndescription: The orders fact table.\n---\n# orders\n\nRevenue column: `revenue_usd`.\n");
  writeFileSync(join(k, "skills", "revenue-report", "SKILL.md"), "---\nname: revenue-report\ndescription: Build the weekly revenue report. Use when asked for weekly revenue.\n---\n# Revenue report\n\n1. Query `analytics.orders`.\n");
  writeFileSync(join(k, "skills", "revenue-report", "scripts", "q.sql"), "select 1;\n");
  writeFileSync(join(k, "skills", "revenue-report", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff]));

  await step("login (owner, email + password from stdin)", () => {
    const r = kf(["login", "--url", URL, "--publishable-key", PK, "--email", owner.email, "--password-stdin", "--json"], { input: owner.password });
    assert.equal(r.json().user.email, owner.email);
  });

  await step("init creates workspace + space and writes .supaknowledge.json", () => {
    const r = kf(["init", "--workspace", ws, "--space", "finance", "--name", "Finance", "--json"]).json();
    assert.equal(r.created_workspace, true);
    assert.equal(r.space.ref, `${ws}/finance`);
    assert.equal(JSON.parse(readFileSync(join(proj, ".supaknowledge.json"), "utf8")).space, `${ws}/finance`);
    assert.equal(kf(["init", "--space", `${ws}/finance`, "--json"]).json().created_space, false, "init is idempotent");
  });

  await step("whoami shows the role on the current space", () => {
    const r = kf(["whoami", "--json"]).json();
    assert.equal(r.space.role, "admin");
    assert.equal(r.kind, "human");
  });

  await step("lint passes on the fixture", () => {
    const r = kf(["lint", k, "--json"]).json();
    assert.equal(r.ok, true);
  });

  let proposalId;
  await step("import creates a pending proposal (ignored files skipped)", () => {
    const r = kf(["import", k, "--title", "Smoke import", "--json"]).json();
    assert.ok(r.proposal_id);
    assert.equal(r.files, 6, "index, 2 concepts, SKILL.md, script, png (scratch/ is gitignored)");
    proposalId = r.proposal_id;
  });

  await step("proposals lists it; proposal shows a diff", () => {
    const list = kf(["proposals", "--json"]).json();
    assert.ok(list.some((p) => p.id === proposalId && p.ops === 3));
    const show = kf(["proposal", proposalId.slice(0, 8)]).out;
    assert.match(show, /\+\+\+ b\/metrics\/arr\.md/);
    assert.match(show, /\+Revenue column: `revenue_usd`\./);
  });

  await step("approve applies it", () => {
    const r = kf(["approve", proposalId, "--note", "smoke", "--json"]).json();
    assert.equal(r.status, "applied");
  });

  await step("health counts the concepts", () => {
    const h = kf(["health", "--json"]).json();
    assert.equal(h.concepts, 3);
    assert.equal(h.by_trust.human_reviewed, 3);
  });

  await step("read returns the concept (links appear once the embed worker ran)", async () => {
    const c = kf(["read", "metrics/arr", "--json"]).json();
    assert.equal(c.type, "Metric");
    await eventually(() => assert.deepEqual(kf(["read", "metrics/arr", "--json"]).json().links.map((l) => l.path), ["data/orders"]));
    assert.equal(kf(["read", "nope/missing"], { code: 1 }).err.includes("no concept"), true);
  });

  await step("search via RPC (full-text) finds it", () => {
    const r = kf(["search", "annualized", "subscriptions", "--json"], { env: { SUPAKNOWLEDGE_TRANSPORT: "rest" } }).json();
    assert.equal(r[0].path, "metrics/arr");
  });

  await step("search via the default transport (MCP when deployed)", () => {
    const r = kf(["search", "orders", "table", "--kind", "data_access", "--json"]).json();
    assert.ok(r.some((x) => x.path === "data/orders"));
  });

  let flagId;
  await step("flag + flags + dismiss", () => {
    const f = kf(["flag", "incorrect", "revenue_usd", "was", "renamed", "--path", "data/orders", "--fix", "use revenue_usd_net", "--json"], { env: { SUPAKNOWLEDGE_TRANSPORT: "rest" } }).json();
    flagId = f.id;
    assert.ok(flagId);
    const open = kf(["flags", "--json"]).json();
    assert.ok(open.some((x) => x.id === flagId && x.concept_path === "data/orders"));
    kf(["dismiss", flagId.slice(0, 8), "--reason", "smoke"]);
    const all = kf(["flags", "--status", "dismissed", "--json"]).json();
    assert.ok(all.some((x) => x.id === flagId));
  });

  await step("re-import with a change -> update op -> reject", () => {
    writeFileSync(join(k, "data", "orders.md"), "---\ntype: BigQuery Table\ntitle: orders table\ndescription: The orders fact table.\n---\n# orders\n\nRevenue column: `revenue_usd_net`.\n");
    const r = kf(["import", k, "--json"]).json();
    assert.deepEqual(Array.isArray(r.updated) ? r.updated : [r.updated], Array.isArray(r.updated) ? ["data/orders"] : [1]);
    const show = kf(["proposal", r.proposal_id, "--json"]).json();
    assert.match(show.ops[0].diff, /-Revenue column: `revenue_usd`\./);
    assert.match(show.ops[0].diff, /\+Revenue column: `revenue_usd_net`\./);
    kf(["reject", r.proposal_id, "--note", "not yet"]);
    assert.ok(kf(["proposals", "--status", "rejected", "--json"]).json().some((p) => p.id === r.proposal_id));
  });

  await step("export + pull write files and track them in a manifest", () => {
    const out = join(root, "export");
    const e = kf(["export", out, "--json"]).json();
    assert.ok(e.written.includes("metrics/arr.md"));
    mkdirSync(join(proj, ".claude", "skills", "hand-written"), { recursive: true });
    writeFileSync(join(proj, ".claude", "skills", "hand-written", "SKILL.md"), "mine");
    const p = kf(["pull", "--json"]).json();
    assert.ok(p.written.includes(".claude/skills/revenue-report/SKILL.md"));
    assert.ok(p.written.includes(".supaknowledge/knowledge/metrics/arr.md"));
    assert.equal(readFileSync(join(proj, ".claude", "skills", "hand-written", "SKILL.md"), "utf8"), "mine");
    const png = join(proj, ".claude", "skills", "revenue-report", "logo.png");
    if (existsSync(png)) assert.deepEqual([...readFileSync(png)], [0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff]);
    writeFileSync(join(proj, ".claude", "skills", "revenue-report", "SKILL.md"), "local edit");
    const again = kf(["pull", "--json"]).json();
    assert.ok(again.skipped.some((s) => s.path === ".claude/skills/revenue-report/SKILL.md" && s.reason === "edited locally"));
  });

  await step("curate requests a run; runs lists it", () => {
    const r = kf(["curate", "--json"]).json();
    assert.ok(["queued", "running", "succeeded", "failed"].includes(r.status));
    assert.ok(kf(["runs", "--json"]).json().some((x) => x.id === r.id));
  });

  await step("mcp-config prints a Claude Code command", () => {
    const r = kf(["mcp-config", "--json"]).json();
    assert.equal(r.url, `${URL}/functions/v1/mcp?space=${ws}/finance`);
    assert.match(r.command, /^claude mcp add --transport http supaknowledge /);
  });

  await step("members/groups: add the reader to the workspace, create + grant a group", () => {
    kf(["members", "add", reader.id, "--workspace", "--role", "member"]);
    const m = kf(["members", "list", "--workspace", "--json"]).json();
    assert.ok(m.some((x) => x.user_id === reader.id && x.role === "member"));
    kf(["groups", "create", "finance-team", "--name", "Finance team"]);
    kf(["groups", "add", "finance-team", reader.id]);
    kf(["groups", "grant", "finance-team", "--role", "reader"]);
    const g = kf(["groups", "list", "--json"]).json();
    assert.equal(g.find((x) => x.slug === "finance-team").members, 1);
    assert.ok(kf(["members", "--json"]).json().group_grants.some((x) => x.group === "finance-team"));
  });

  await step("reader: can search and flag, cannot see proposals or run the curator", () => {
    const renv = { env: { SUPAKNOWLEDGE_PROFILE: "reader" } };
    kf(["login", "--url", URL, "--publishable-key", PK, "--email", reader.email, "--password-stdin"], { ...renv, input: reader.password });
    assert.equal(kf(["whoami", "--json"], renv).json().space.role, "reader");
    assert.ok(kf(["search", "orders", "--json"], { env: { SUPAKNOWLEDGE_PROFILE: "reader", SUPAKNOWLEDGE_TRANSPORT: "rest" } }).json().length > 0);
    assert.ok(kf(["flag", "missing", "no churn definition", "--json"], { env: { SUPAKNOWLEDGE_PROFILE: "reader", SUPAKNOWLEDGE_TRANSPORT: "rest" } }).json().id);
    assert.deepEqual(kf(["proposals", "--status", "all", "--json"], renv).json(), [], "readers cannot see proposals");
    const denied = kf(["curate"], { ...renv, code: 1 });
    assert.match(denied.err, /reviewer role required/);
  });

  await step("logout drops the session", () => {
    kf(["logout"], { env: { SUPAKNOWLEDGE_PROFILE: "reader" } });
    assert.match(kf(["whoami"], { env: { SUPAKNOWLEDGE_PROFILE: "reader" }, code: 1 }).err, /not logged in/);
  });

  console.log(`\n${passed} live checks passed`);
} finally {
  // cleanup: the workspace (as its owner, through PostgREST) and both users
  try {
    const cfg = JSON.parse(readFileSync(join(root, "config", "config.json"), "utf8"));
    const token = cfg.profiles?.default?.session?.access_token;
    if (token) {
      await fetch(`${URL}/rest/v1/workspaces?slug=eq.${ws}`, { method: "DELETE", headers: { apikey: PK, Authorization: `Bearer ${token}` } });
    }
  } catch {
    /* best effort */
  }
  for (const id of users) await admin("DELETE", `users/${id}`).catch(() => {});
  rmSync(root, { recursive: true, force: true });
}

