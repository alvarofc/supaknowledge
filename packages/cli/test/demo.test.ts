import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { harness, json, SPACE_ID, spaceRoute, URL } from "./helpers.ts";

const RESET = { space_id: SPACE_ID, flags: 3, proposals: 1, traces: 0, usage: 7, visitors: 2, users_deleted: 2 };

describe("kf demo", () => {
  it("enable sends the limits for the current space", async () => {
    const h = harness();
    h.routes.push(spaceRoute, (c) =>
      c.url === `${URL}/rest/v1/rpc/kf_demo_enable` ? json({ space_id: SPACE_ID, enabled: true, flags_per_visitor_per_hour: 3, flags_per_day: 50 }) : undefined,
    );
    const r = await h.run("demo", "enable", "--flags-per-hour", "3", "--flags-per-day", "50");
    assert.equal(r.code, 0, r.stderr);
    const call = h.calls.find((c) => c.url.endsWith("/rpc/kf_demo_enable"))!;
    assert.deepEqual(call.body, { p_space: SPACE_ID, p_flags_per_visitor_per_hour: 3, p_flags_per_day: 50 });
    assert.match(r.stdout, /3 flags per visitor per hour, 50 per day/);
  });

  it("rejects limits out of range before any request", async () => {
    const h = harness();
    const r = await h.run("demo", "enable", "--flags-per-hour", "-1");
    assert.notEqual(r.code, 0);
    assert.equal(h.calls.length, 0);
  });

  it("reset reports what was cleared; --bundle re-imports and applies the bundle", async () => {
    const h = harness();
    h.routes.push(spaceRoute, (c) => {
      if (c.url === `${URL}/rest/v1/rpc/kf_demo_reset`) return json(RESET);
      if (c.url === `${URL}/functions/v1/bundle/import`) return json({ proposal_id: "p-1", status: "applied", created: [], updated: ["revenue/arr"], unchanged: [] });
      return undefined;
    });
    const plain = await h.run("demo", "reset");
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout, /cleared 3 flags, 1 proposals, 0 traces and 7 usage rows of 2 visitors/);

    const dir = join(h.dir, "bundle");
    mkdirSync(dir);
    writeFileSync(join(dir, "arr.md"), "---\ntitle: ARR\n---\n# ARR\n");
    const r = await h.run("demo", "reset", "--bundle", dir);
    assert.equal(r.code, 0, r.stderr);
    const imp = h.calls.find((c) => c.url.endsWith("/functions/v1/bundle/import"))!;
    assert.equal(imp.body.apply, true);
    assert.equal(imp.body.space, SPACE_ID);
    assert.match(r.stdout, /applied/);
  });

  it("a refused call (not a workspace owner) fails with the database message", async () => {
    const h = harness();
    h.routes.push(spaceRoute, (c) =>
      c.url.endsWith("/rpc/kf_demo_status") ? json({ code: "42501", message: "workspace owner required" }, 403) : undefined,
    );
    const r = await h.run("demo", "status");
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /workspace owner required/);
  });
});
