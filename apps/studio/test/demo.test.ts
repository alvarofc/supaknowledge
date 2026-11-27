import assert from "node:assert/strict";
import { test } from "node:test";
import { demoEnabled, demoErrorMessage, demoLanding, parseDemoJoin } from "../src/lib/demo.ts";

test("KF_DEMO turns the demo on only with an explicit true value", () => {
  for (const v of ["1", "true", "True", " on "]) assert.equal(demoEnabled(v), true, v);
  for (const v of [undefined, "", "0", "false", "yes"]) assert.equal(demoEnabled(v), false, String(v));
});

test("join_demo() results are parsed defensively", () => {
  assert.deepEqual(parseDemoJoin({ workspace: "acme", space: "revenue", space_id: "x" }), { workspace: "acme", space: "revenue" });
  assert.equal(parseDemoJoin(null), null);
  assert.equal(parseDemoJoin({ workspace: "acme" }), null);
  assert.equal(parseDemoJoin("acme/revenue"), null);
});

test("visitors land in the demo space, or back on an OAuth consent request", () => {
  const j = { workspace: "acme", space: "revenue" };
  assert.equal(demoLanding(j, "/"), "/w/acme/revenue");
  assert.equal(demoLanding(j, "/w/other/space"), "/w/acme/revenue");
  assert.equal(demoLanding(j, "/oauth/consent?authorization_id=abc"), "/oauth/consent?authorization_id=abc");
});

test("Auth errors become actionable sentences", () => {
  assert.match(demoErrorMessage("Anonymous sign-ins are disabled"), /turned off in Supabase Auth/);
  assert.match(demoErrorMessage("no demo space is configured"), /no demo space/);
  assert.match(demoErrorMessage("Request rate limit reached"), /Try again in an hour/);
  assert.equal(demoErrorMessage("boom"), "boom");
});
