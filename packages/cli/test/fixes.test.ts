import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { projectSubdir } from "../src/commands/bundle.ts";
import { harness, json, SPACE_ID, spaceRoute } from "./helpers.ts";

const RUN_ID = "11111111-0000-4000-8000-000000000001";
const GROUP_ID = "22222222-0000-4000-8000-000000000002";
const USER = "33333333-0000-4000-8000-000000000003";

describe("kf curate --watch --json", () => {
  it("prints exactly one JSON document when the run fails, and exits 1", async () => {
    const h = harness();
    h.routes.push(
      spaceRoute,
      (c) => (c.url.endsWith("/functions/v1/curator/run") ? json({ run: { id: RUN_ID, status: "queued", trigger: "manual", stats: {}, error: null } }, 202) : undefined),
      (c) => (c.url.includes("/rest/v1/curator_runs?") ? json({ id: RUN_ID, status: "failed", trigger: "manual", stats: { clusters: 2 }, error: "task research failed" }) : undefined),
    );
    const r = await h.run("curate", "--watch", "--json");
    assert.equal(r.code, 1);
    const doc = JSON.parse(r.stdout); // throws if two documents were printed
    assert.equal(doc.status, "failed");
    assert.equal(doc.error, "task research failed");
    assert.deepEqual(h.calls.find((c) => c.url.endsWith("/functions/v1/curator/run"))!.body, { space: "acme/finance" });
  });
});

describe("kf curate rate limits (429)", () => {
  const cooldown = (c: { url: string }) =>
    c.url.endsWith("/functions/v1/curator/run")
      ? json({ error: "a manual curator run of this space started 30s ago; try again in 90s" }, 429, { "retry-after": "90" })
      : undefined;

  it("prints a friendly message and exits 1", async () => {
    const h = harness();
    h.routes.push(spaceRoute, cooldown);
    const r = await h.run("curate");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /curator was run recently; try again in 90 s/);
    assert.equal(h.calls.filter((c) => c.url.endsWith("/functions/v1/curator/run")).length, 1, "a run request is not retried");
    assert.ok(!h.calls.some((c) => c.url.endsWith("/rpc/request_curator_run")), "no RPC fallback around the cooldown");
  });

  it("--json prints one JSON document with status and retry_after_s", async () => {
    const h = harness();
    h.routes.push(spaceRoute, cooldown);
    const r = await h.run("curate", "--watch", "--json");
    assert.equal(r.code, 1);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.status, 429);
    assert.equal(doc.retry_after_s, 90);
    assert.match(doc.error, /try again in 90 s/);
  });

  it("uses the message when Retry-After is missing", async () => {
    const h = harness();
    h.routes.push(spaceRoute, (c) => (c.url.endsWith("/functions/v1/curator/run") ? json({ error: "a manual curator run of this space started 100s ago; try again in 20s" }, 429) : undefined));
    const r = await h.run("curate");
    assert.match(r.stderr, /try again in 20 s/);
  });

  it("falls back to rpc request_curator_run when the curator function is not deployed", async () => {
    const h = harness();
    h.routes.push(
      spaceRoute,
      (c) => (c.url.endsWith("/functions/v1/curator/run") ? json({ code: "NOT_FOUND", message: "Requested function was not found" }, 404) : undefined),
      (c) => (c.url.endsWith("/rpc/request_curator_run") ? json({ id: RUN_ID, status: "queued", trigger: "manual", stats: {}, error: null }) : undefined),
    );
    const r = await h.run("curate", "--json");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).id, RUN_ID);
  });
});

describe("kf runs cancel", () => {
  it("cancels through cancel_curator_run", async () => {
    const h = harness();
    h.routes.push(spaceRoute, (c) => (c.url.endsWith("/rpc/cancel_curator_run") ? json({ id: RUN_ID, status: "cancelled", trigger: "manual", stats: {}, error: "cancelled by user:x" }) : undefined));
    const r = await h.run("runs", "cancel", RUN_ID);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /cancelled/);
    assert.deepEqual(h.calls.find((c) => c.url.endsWith("/rpc/cancel_curator_run"))!.body, { p_run: RUN_ID });
  });

  it("`kf runs` still lists runs by default", async () => {
    const h = harness();
    h.routes.push(spaceRoute, (c) => (c.url.includes("/rest/v1/curator_runs?") ? json([{ id: RUN_ID, status: "running", trigger: "cron", stats: {}, error: null, created_at: new Date().toISOString(), started_at: null, finished_at: null }]) : undefined));
    const r = await h.run("runs", "-n", "5", "--json");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout)[0].id, RUN_ID);
    assert.match(h.calls.find((c) => c.url.includes("curator_runs"))!.url, /limit=5/);
  });
});

describe("RLS no-op detection", () => {
  it("groups remove fails when RLS filtered the delete (0 rows)", async () => {
    const h = harness();
    h.routes.push(
      spaceRoute,
      (c) => (c.method === "GET" && c.url.includes("/rest/v1/groups?") ? json([{ id: GROUP_ID, slug: "finance", name: "Finance" }]) : undefined),
      (c) => (c.method === "DELETE" && c.url.includes("/rest/v1/group_members?") ? json([]) : undefined),
    );
    const r = await h.run("groups", "remove", "finance", USER);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /nothing removed/);
    const del = h.calls.find((c) => c.method === "DELETE")!;
    assert.match(del.url, /select=user_id/);
  });

  it("groups revoke succeeds when a row came back", async () => {
    const h = harness();
    h.routes.push(
      spaceRoute,
      (c) => (c.method === "GET" && c.url.includes("/rest/v1/groups?") ? json([{ id: GROUP_ID, slug: "finance", name: "Finance" }]) : undefined),
      (c) => (c.method === "DELETE" && c.url.includes("/rest/v1/space_group_grants?") ? json([{ group_id: GROUP_ID }]) : undefined),
    );
    const r = await h.run("groups", "revoke", "finance");
    assert.equal(r.code, 0, r.stderr);
  });
});

describe("kf sources secret", () => {
  it("prompts when stdin is a terminal, even if stdout is not", async () => {
    const h = harness();
    const sid = "ffffffff-0000-4000-8000-000000000003";
    h.stdinIsTTY = true;
    h.prompts.push("xoxb-typed");
    h.routes.push((c) => (c.url.endsWith("/rpc/set_source_secret") ? new Response(null, { status: 204 }) : undefined));
    const r = await h.run("sources", "secret", sid);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(h.calls.find((c) => c.url.endsWith("/rpc/set_source_secret"))!.body, { p_source: sid, p_secret: "xoxb-typed" });
  });
});

describe("kf pull directories", () => {
  it("are resolved against the project root and must be strict subdirectories", () => {
    assert.equal(projectSubdir("/p", ".claude/skills", "--skills-dir"), ".claude/skills");
    assert.equal(projectSubdir("/p", "/p/out/skills/", "--skills-dir"), "out/skills");
    assert.throws(() => projectSubdir("/p", ".", "--bundle-dir"), /not its root/);
    assert.throws(() => projectSubdir("/p", "", "--bundle-dir"), /not its root/);
    assert.throws(() => projectSubdir("/p", "../elsewhere", "--bundle-dir"), /inside the project/);
  });

  it("writes to the project root from a subdirectory", async () => {
    const h = harness();
    const sub = join(h.dir, "src", "deep");
    mkdirSync(sub, { recursive: true });
    h.routes.push(spaceRoute, (c) =>
      c.url.includes("/functions/v1/bundle/export") ? json({ files: [{ path: "skills/report/SKILL.md", content: "---\nname: report\n---\nx\n" }] }) : undefined,
    );
    const r = await h.runIn(sub, "pull", "--no-bundle");
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(h.dir, ".claude", "skills", "report", "SKILL.md")));
    assert.ok(!existsSync(join(sub, ".claude")));
  });

  it("refuses the project root as a target", async () => {
    const h = harness();
    const r = await h.run("pull", "--bundle-dir", ".");
    assert.equal(r.code, 2);
    assert.equal(h.calls.length, 0);
  });
});

describe("kf import REST fallback", () => {
  function setup(applyStatus: string) {
    const h = harness();
    const kdir = join(h.dir, "k");
    mkdirSync(join(kdir, "metrics"), { recursive: true });
    writeFileSync(join(kdir, "metrics", "arr.md"), "---\ntype: Metric\ntitle: ARR\ndescription: Annual recurring revenue.\n---\n# ARR\n\nSum of subscriptions.\n");
    h.routes.push(
      spaceRoute,
      (c) => (c.url.includes("/functions/v1/bundle/import") ? json({ error: "not found" }, 404) : undefined),
      (c) => (c.url.includes("/rest/v1/groups?") ? json([]) : undefined),
      (c) => (c.url.includes("/rest/v1/concepts?") ? json([]) : undefined),
      (c) => (c.url.endsWith("/rpc/create_proposal") ? json({ id: "44444444-0000-4000-8000-000000000004", status: "pending" }) : undefined),
      (c) => (c.url.endsWith("/rpc/apply_proposal") ? json({ id: "44444444-0000-4000-8000-000000000004", status: applyStatus, review_note: "changed" }) : undefined),
      (c) => (c.method === "POST" && /\/rest\/v1\/proposal(_ops|s)\b/.test(c.url) ? json({ message: "direct inserts are revoked" }, 403) : undefined),
    );
    return { h, kdir };
  }

  it("creates the proposal atomically through create_proposal (no direct inserts)", async () => {
    const { h, kdir } = setup("applied");
    const r = await h.run("import", kdir, "--json");
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.via, "rest");
    assert.equal(out.status, "pending");
    const call = h.calls.find((c) => c.url.endsWith("/rpc/create_proposal"))!;
    assert.equal(call.body.p_space, SPACE_ID);
    assert.equal(call.body.p_ops.length, 1);
    assert.equal(call.body.p_ops[0].op, "create");
    assert.equal(call.body.p_ops[0].path, "metrics/arr");
    assert.ok(!("ord" in call.body.p_ops[0]));
    assert.ok(!h.calls.some((c) => c.method === "POST" && /\/rest\/v1\/proposal/.test(c.url)));
  });

  it("exits non-zero when --apply conflicts", async () => {
    const { h, kdir } = setup("conflicted");
    const r = await h.run("import", kdir, "--apply", "--json");
    assert.equal(r.code, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.status, "conflicted");
  });
});

describe("kf proposal on an applied proposal", () => {
  it("diffs against the revision it replaced and does not warn about conflicts", async () => {
    const h = harness();
    const pid = "55555555-0000-4000-8000-000000000005";
    const cid = "66666666-0000-4000-8000-000000000006";
    const concept = (revision: number, body: string) => ({
      path: "data/orders",
      kind: "data_access",
      type: "BigQuery Table",
      title: "orders",
      description: "Orders table.",
      body,
      frontmatter: {},
      tags: [],
      status: "stable",
      superseded_by: null,
      stale_after: null,
      audience: [],
      revision,
    });
    const proposal = {
      id: pid,
      space_id: SPACE_ID,
      title: "Rename revenue column",
      rationale: "",
      status: "applied",
      risk: "low",
      escalation: false,
      author: "curator/x",
      created_at: new Date().toISOString(),
      review_note: null,
      proposal_ops: [
        { id: "o1", ord: 0, op: "update", concept_id: cid, path: "data/orders", new_path: null, base_revision: 3, after: { body: "Revenue column: `revenue_usd_net`.\n" }, target_audience: [], rationale: null },
      ],
      proposal_citations: [
        { label: "1", ref_kind: "source_document", ref_id: "77777777-0000-4000-8000-000000000007", url: null, quote: null, op_id: "o1", consulted: false },
        { label: "c1", ref_kind: "trace", ref_id: "88888888-0000-4000-8000-000000000008", url: null, quote: null, op_id: null, consulted: true },
      ],
      proposal_reviews: [],
    };
    h.routes.push(
      spaceRoute,
      (c) => (c.url.includes("/rest/v1/proposals?") ? json(c.headers.accept?.includes("object") ? proposal : [proposal]) : undefined),
      // the concept moved on after this proposal (revision 4 was written by it; 5 by someone else)
      (c) => (c.url.includes("/rest/v1/concepts?") ? json([{ id: cid, ...concept(5, "Revenue column: `net_revenue`.\n") }]) : undefined),
      (c) =>
        c.url.includes("/rest/v1/concept_revisions?") && c.url.includes("proposal_id=eq.")
          ? json([{ concept_id: cid, revision: 4 }])
          : c.url.includes("/rest/v1/concept_revisions?")
            ? json([{ concept_id: cid, ...concept(3, "Revenue column: `revenue_usd`.\n") }])
            : undefined,
    );
    const r = await h.run("proposal", pid, "--no-color");
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /applying will conflict/);
    assert.doesNotMatch(r.stdout, /no content change/);
    assert.match(r.stdout, /-Revenue column: `revenue_usd`\./);
    assert.match(r.stdout, /\+Revenue column: `revenue_usd_net`\./);
    assert.match(r.stdout, /Also consulted/);
  });
});
