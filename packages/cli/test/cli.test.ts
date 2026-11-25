import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { skillTargets } from "../src/commands/bundle.ts";
import { opDocuments } from "../src/commands/review.ts";
import { encodeFile, isIgnored, parseIgnore, readTree, writeManaged } from "../src/files.ts";
import { makeColors } from "../src/render.ts";
import { harness, json, SPACE_ID, spaceRoute, URL } from "./helpers.ts";

describe("arg handling", () => {
  it("--help lists commands and exits 0", async () => {
    const h = harness();
    const r = await h.run("--help");
    assert.equal(r.code, 0);
    for (const c of ["login", "import", "pull", "proposal", "approve", "mcp-config", "agents", "sources", "groups"]) assert.match(r.stdout, new RegExp(`\\b${c}\\b`));
  });

  it("subcommand help works", async () => {
    const h = harness();
    const r = await h.run("pull", "--help");
    assert.equal(r.code, 0);
    assert.match(r.stdout, /--skills-dir <dir>/);
    assert.match(r.stdout, /\.claude\/skills/);
  });

  it("unknown commands and missing arguments exit 2", async () => {
    const h = harness();
    assert.equal((await h.run("frobnicate")).code, 2);
    assert.equal((await h.run("reject", "abc")).code, 2); // --note is required
    assert.equal((await h.run("search")).code, 2);
  });

  it("validates enums before touching the network", async () => {
    const h = harness();
    const r = await h.run("flag", "wrongkind", "something");
    assert.equal(r.code, 2);
    assert.match(r.stderr, /kind must be one of/);
    assert.equal((await h.run("proposals", "--status", "bogus")).code, 2);
    assert.equal((await h.run("search", "x", "--kind", "nope")).code, 2);
    assert.equal(h.calls.length, 0);
  });

  it("reports missing login with a hint, and as JSON with --json", async () => {
    const h = harness({ loggedIn: false });
    const r = await h.run("health", "--url", URL);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no publishable key|not logged in/);
    const j = await h.run("health", "--json");
    assert.ok(JSON.parse(j.stdout).error);
  });
});

describe("commands with a mocked backend", () => {
  it("search goes through MCP with the session token and prints JSON", async () => {
    const h = harness();
    h.routes.push(spaceRoute, (c) => {
      if (!c.url.startsWith(`${URL}/functions/v1/mcp`)) return undefined;
      if (c.body.method === "initialize") return json({ jsonrpc: "2.0", id: c.body.id, result: { protocolVersion: "2025-06-18" } });
      if (c.body.method === "notifications/initialized") return new Response(null, { status: 202 });
      assert.equal(c.body.params.name, "search_knowledge");
      assert.deepEqual(c.body.params.arguments, { query: "annual revenue", kinds: ["domain", "data_access"], limit: 3 });
      return json({ jsonrpc: "2.0", id: c.body.id, result: { content: [{ type: "text", text: JSON.stringify({ results: [{ path: "metrics/arr", title: "ARR", kind: "domain" }] }) }] } });
    });
    const r = await h.run("search", "annual", "revenue", "-k", "domain,data-access", "-n", "3", "--json");
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).map((x: any) => x.path), ["metrics/arr"]);
    const mcp = h.calls.find((c) => c.url.includes("/mcp"))!;
    assert.match(mcp.url, /space=acme\/finance/);
    assert.match(mcp.headers.authorization!, /^Bearer ey/);
    assert.equal(mcp.headers.apikey, "pk_test");
  });

  it("refreshes an expired session and saves it", async () => {
    const h = harness({ expiresIn: -10 });
    h.routes.push(
      (c) =>
        c.url.includes("/auth/v1/token?grant_type=refresh_token")
          ? json({ access_token: "new.eyJzdWIiOiJ4In0.sig", refresh_token: "rt-2", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user: { id: "x", email: "me@acme.test", app_metadata: {} } })
          : undefined,
      spaceRoute,
      (c) => (c.url.endsWith("/rpc/knowledge_health") ? json({ concepts: 2, by_kind: {}, by_trust: {}, stale: 0, open_flags: 0, missing_flags: 0, pending_proposals: 0, applied_proposals: 0, auto_applied: 0, never_used: 0, most_flagged: [], last_run: null }) : undefined),
    );
    const r = await h.run("health", "--json");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).concepts, 2);
    const cfg = JSON.parse(readFileSync(join(h.configDir, "config.json"), "utf8"));
    assert.equal(cfg.profiles.default.session.refresh_token, "rt-2");
    const health = h.calls.find((c) => c.url.endsWith("/rpc/knowledge_health"))!;
    assert.equal(health.headers.authorization, "Bearer new.eyJzdWIiOiJ4In0.sig");
    assert.deepEqual(health.body, { p_space: SPACE_ID, p_days: 30 });
  });

  it("approve resolves an id prefix and fails clearly on conflicts", async () => {
    const h = harness();
    const pid = "dddddddd-0000-4000-8000-000000000001";
    h.routes.push(
      spaceRoute,
      (c) => (c.url.includes("/rest/v1/proposals?select=id") ? json([{ id: pid }, { id: "eeeeeeee-0000-4000-8000-000000000002" }]) : undefined),
      (c) => (c.url.endsWith("/rpc/apply_proposal") ? json({ id: pid, status: "conflicted", review_note: "concept changed since draft" }) : undefined),
    );
    const r = await h.run("approve", "dddd", "--note", "ok");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /conflicted: concept changed since draft/);
    assert.deepEqual(h.calls.find((c) => c.url.endsWith("/rpc/apply_proposal"))!.body, { p_proposal: pid, p_note: "ok" });
  });

  it("lint works offline with the local linter", async () => {
    const h = harness({ loggedIn: false, project: false });
    const kdir = join(h.dir, "k");
    mkdirSync(join(kdir, "skills", "Bad_Name"), { recursive: true });
    writeFileSync(join(kdir, "skills", "Bad_Name", "SKILL.md"), "---\nname: Bad_Name\n---\nbody\n");
    const r = await h.run("lint", kdir, "--json");
    assert.equal(r.code, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.via, "local");
    assert.equal(out.ok, false);
  });

  it("mcp-config needs no network when the space is a slug", async () => {
    const h = harness();
    const r = await h.run("mcp-config", "--client", "cursor", "--agent-key", "--json");
    assert.equal(r.code, 0, r.stderr);
    const cfg = JSON.parse(r.stdout);
    assert.equal(cfg.config.mcpServers.supaknowledge.url, `${URL}/functions/v1/mcp?space=acme/finance`);
    assert.equal(cfg.config.mcpServers.supaknowledge.headers.Authorization, "Bearer ${env:SUPAKNOWLEDGE_API_KEY}");
    assert.equal(h.calls.length, 0);
  });

  it("sources secret reads the token from stdin", async () => {
    const h = harness();
    const sid = "ffffffff-0000-4000-8000-000000000003";
    h.stdin = "xoxb-secret\n";
    h.routes.push((c) => (c.url.endsWith("/rpc/set_source_secret") ? new Response(null, { status: 204 }) : undefined));
    const r = await h.run("sources", "secret", sid);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(h.calls.at(-1)!.body, { p_source: sid, p_secret: "xoxb-secret" });
  });
});

describe("files", () => {
  it("gitignore-ish matching", () => {
    const rules = parseIgnore("# c\n*.log\ntmp/\n/build\ndocs/**/draft-*.md\n!keep.log\n");
    assert.ok(isIgnored(rules, "a/b/x.log", false));
    assert.ok(!isIgnored(rules, "keep.log", false));
    assert.ok(isIgnored(rules, "x/tmp", true));
    assert.ok(!isIgnored(rules, "x/tmp", false));
    assert.ok(isIgnored(rules, "build", true));
    assert.ok(!isIgnored(rules, "src/build", true));
    assert.ok(isIgnored(rules, "docs/a/b/draft-1.md", false));
  });

  it("encodes binary files as base64", () => {
    assert.equal(encodeFile(Buffer.from("héllo")).encoding, "utf8");
    const bin = encodeFile(Buffer.from([0x89, 0x50, 0x00, 0xff]));
    assert.equal(bin.encoding, "base64");
    assert.deepEqual([...Buffer.from(bin.content, "base64")], [0x89, 0x50, 0x00, 0xff]);
  });

  it("readTree honors .gitignore and skips dot dirs", () => {
    const h = harness({ loggedIn: false, project: false });
    const d = join(h.dir, "b");
    mkdirSync(join(d, ".git"), { recursive: true });
    mkdirSync(join(d, "tmp"), { recursive: true });
    writeFileSync(join(d, ".gitignore"), "tmp/\n");
    writeFileSync(join(d, "a.md"), "# a");
    writeFileSync(join(d, "tmp", "x.md"), "x");
    writeFileSync(join(d, ".git", "HEAD"), "ref");
    assert.deepEqual(readTree(d).files.map((f) => f.path), ["a.md"]);
  });

  it("readTree never uploads dotfiles (.env) and reports them", () => {
    const h = harness({ loggedIn: false, project: false });
    const d = join(h.dir, "b");
    mkdirSync(join(d, ".github"), { recursive: true });
    mkdirSync(join(d, "skills", "x"), { recursive: true });
    writeFileSync(join(d, ".env"), "SECRET=1");
    writeFileSync(join(d, ".env.local"), "SECRET=2");
    writeFileSync(join(d, ".github", "ci.yml"), "on: push");
    writeFileSync(join(d, "skills", "x", ".secret"), "s");
    writeFileSync(join(d, "skills", "x", "SKILL.md"), "# x");
    writeFileSync(join(d, ".kfignore"), ".env.local\n");
    const r = readTree(d);
    assert.deepEqual(r.files.map((f) => f.path), ["skills/x/SKILL.md"]);
    assert.deepEqual(
      r.skipped.map((s) => s.path).sort(),
      [".env", ".github/", "skills/x/.secret"],
      "ignored dotfiles are not reported, the rest are",
    );
    assert.ok(r.skipped.every((s) => s.reason === "dotfile"));
  });

  it("writeManaged only overwrites what it wrote and prunes what disappeared", () => {
    const h = harness({ loggedIn: false, project: false });
    const root = join(h.dir, "w");
    const manifest = join(root, ".m.json");
    mkdirSync(root);
    writeFileSync(join(root, "mine.md"), "user file");
    const t = (path: string, s: string) => ({ path, data: Buffer.from(s) });

    let r = writeManaged(root, manifest, [t("a.md", "1"), t("mine.md", "export"), t("sub/b.md", "2")]);
    assert.deepEqual(r.written.sort(), ["a.md", "sub/b.md"]);
    assert.deepEqual(r.skipped, [{ path: "mine.md", reason: "not managed by kf" }]);
    assert.equal(readFileSync(join(root, "mine.md"), "utf8"), "user file");

    writeFileSync(join(root, "a.md"), "edited");
    r = writeManaged(root, manifest, [t("a.md", "1b")]);
    assert.deepEqual(r.skipped, [{ path: "a.md", reason: "edited locally" }]);
    assert.deepEqual(r.deleted, ["sub/b.md"]);
    assert.ok(!existsSync(join(root, "sub")), "empty dirs are pruned");

    r = writeManaged(root, manifest, [t("a.md", "1b")], { force: true });
    assert.deepEqual(r.written, ["a.md"]);
    assert.deepEqual(writeManaged(root, manifest, [t("../evil", "x")]).skipped[0]!.reason, "unsafe path");
  });

  it("maps exported skills to <skills-dir>/<name>/", () => {
    const targets = skillTargets(
      [
        { path: "skills/revenue-report/SKILL.md", content: "s" },
        { path: "skills/revenue-report/scripts/q.sql", content: "q" },
        { path: "metrics/arr.md", content: "m" },
      ],
      ".claude/skills",
    );
    assert.deepEqual(targets.map((t) => t.path), [".claude/skills/revenue-report/SKILL.md", ".claude/skills/revenue-report/scripts/q.sql"]);
  });
});

describe("proposal diffs", () => {
  it("renders update ops as OKF file diffs", () => {
    const current = {
      id: "c1",
      path: "data/orders",
      kind: "data_access" as const,
      type: "BigQuery Table",
      title: "orders",
      description: "Orders table.",
      body: "Revenue column: `revenue_usd`.\n",
      frontmatter: {},
      tags: [],
      status: "stable" as const,
      superseded_by: null,
      stale_after: null,
      audience: [],
      revision: 3,
    };
    const docs = opDocuments(
      { id: "o", ord: 0, op: "update", concept_id: "c1", path: "data/orders", new_path: null, base_revision: 3, after: { body: "Revenue column: `revenue_usd_net`.\n" }, target_audience: [], rationale: null },
      current,
    );
    assert.equal(docs.before.name, "data/orders.md");
    assert.match(docs.before.text, /revenue_usd`/);
    assert.match(docs.after.text, /revenue_usd_net/);
    assert.match(docs.after.text, /^---\ntype: BigQuery Table/);
    const created = opDocuments({ id: "o", ord: 0, op: "create", concept_id: null, path: "metrics/nrr", new_path: null, base_revision: null, after: { type: "Metric", title: "NRR", body: "x" }, target_audience: [], rationale: null }, null);
    assert.equal(created.before.text, "");
    assert.equal(makeColors(false).red("x"), "x");
  });
});
