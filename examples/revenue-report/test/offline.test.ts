// Keeps the offline demo honest: the bundle imports cleanly and the curator story ends where the docs say.
import { test } from "node:test";
import assert from "node:assert/strict";
import { importBundle, lintConcept } from "@supaknowledge/core";
import { runOfflineDemo } from "../src/offline.ts";
import { readBundle, runWarehouseQuery } from "../src/lib.ts";

test("the knowledge bundle is valid OKF + Agent Skills", () => {
  const parsed = importBundle(readBundle(), { toId: (s) => (s === "finance" ? "g-finance" : undefined), toSlug: (id) => id });
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.bundle.okf_version, "0.3");
  const byPath = Object.fromEntries(parsed.concepts.map((c) => [c.draft.path, c]));
  assert.deepEqual(Object.keys(byPath).sort(), [
    "data/bigquery/revenue",
    "data/salesforce/opportunities",
    "finance/board-pack",
    "metrics/arr",
    "metrics/nrr",
    "policies/report-formatting",
    "skills/revenue-report",
  ]);
  for (const c of parsed.concepts) assert.deepEqual(lintConcept(c.draft, c.files), [], c.draft.path);
  assert.equal(byPath["data/bigquery/revenue"]!.draft.kind, "data_access");
  assert.equal(byPath["data/salesforce/opportunities"]!.draft.kind, "data_access");
  assert.deepEqual(byPath["finance/board-pack"]!.draft.audience, ["g-finance"]);
  assert.deepEqual(byPath["skills/revenue-report"]!.files.map((f) => f.path), ["templates/report-template.md"]);
  assert.equal(byPath["data/bigquery/revenue"]!.draft.frontmatter["x-acme-owner"], "finance-data", "unknown keys are preserved");
});

test("the simulated warehouse only knows the renamed column", () => {
  assert.throws(() => runWarehouseQuery("select sum(revenue_usd) as revenue_usd from t"), /Did you mean revenue_usd_net/);
  assert.equal(runWarehouseQuery("select sum(revenue_usd_net) as revenue_usd from t order by revenue_usd").rows.length, 4);
});

test("offline curator run: data fix auto-applies, skill fix waits for review, ARR change is an escalation", async () => {
  const { runStatus, proposals, store } = await runOfflineDemo({ quiet: true });
  assert.equal(runStatus, "succeeded");
  assert.equal(proposals.length, 3);

  const data = proposals.find((p) => p.ops[0]!.path === "data/bigquery/revenue")!;
  assert.equal(data.risk, "low");
  assert.equal(data.auto_applied, true);
  assert.deepEqual((data.ops[0]!.after.frontmatter!.sources as { id: string }[]).map((s) => s.id).slice(-2), ["renamed-column", "renamed-column-trace"]);

  const skill = proposals.find((p) => p.ops[0]!.path === "skills/revenue-report")!;
  assert.equal(skill.status, "applied", "approved by the finance lead in the demo");
  assert.equal(skill.auto_applied, false);
  assert.match(store.concepts.find((c) => c.path === "skills/revenue-report")!.body, /ACME CONFIDENTIAL/);

  const arr = proposals.find((p) => p.ops[0]!.path === "metrics/arr")!;
  assert.equal(arr.escalation, true);
  assert.equal(arr.risk, "high");
  assert.equal(arr.status, "pending");

  assert.ok(store.flags.every((f) => f.status !== "open"), "every flag is resolved or in a proposal");
});

test("offline schema drift: the rename becomes a flag, then a proposal citing the schema document", async () => {
  const { drift } = await runOfflineDemo({ quiet: true });
  assert.equal(drift.runStatus, "succeeded");
  const flags = drift.store.flags;
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.concept_path, "data/bigquery/revenue");
  assert.equal(flags[0]!.created_by, null);
  assert.match(flags[0]!.observation, /probably renamed to revenue_usd_net/);
  assert.equal(flags[0]!.status, "in_proposal");

  assert.equal(drift.proposals.length, 1);
  const p = drift.proposals[0]!;
  assert.deepEqual(p.citations.map((x) => x.ref_kind).sort(), ["flag", "source_document"]);
  assert.equal(p.status, "pending", "a heuristic rename waits for a person");
  assert.match(p.ops[0]!.after.body!, /sum\(revenue_usd_net\)/);
  assert.doesNotMatch(p.ops[0]!.after.body!, /sum\(revenue_usd\)/);
});
