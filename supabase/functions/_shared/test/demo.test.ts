import assert from "node:assert/strict";
import { checkAnonymous, demoMode } from "../auth.ts";
import { HttpError } from "../http.ts";

Deno.test("demoMode: only explicit true values turn demo mode on", () => {
  for (const v of ["1", "true", "TRUE", " on "]) assert.equal(demoMode(v), true, v);
  for (const v of [undefined, "", "0", "false", "off", "yes", "env(KF_DEMO)"]) assert.equal(demoMode(v), false, String(v));
});

Deno.test("checkAnonymous: anonymous sessions need demo mode", () => {
  assert.equal(checkAnonymous({}, false), false);
  assert.equal(checkAnonymous({ is_anonymous: false }, false), false);
  assert.equal(checkAnonymous({ is_anonymous: true }, true), true);
  assert.throws(() => checkAnonymous({ is_anonymous: true }, false), (e) => e instanceof HttpError && e.status === 403);
  // only the boolean claim counts
  assert.equal(checkAnonymous({ is_anonymous: "true" }, false), false);
});
