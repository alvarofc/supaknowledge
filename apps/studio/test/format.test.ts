import assert from "node:assert/strict";
import { test } from "node:test";
import { actorLabel, actorUserId, cancelledBy } from "../src/lib/format.ts";

const A = "11111111-1111-1111-1111-111111111111";
const H = "22222222-2222-2222-2222-222222222222";

test("actorUserId understands human:, user: and agent: actors", () => {
  assert.equal(actorUserId(`human:${H}`), H);
  assert.equal(actorUserId(`user:${H}`), H);
  assert.equal(actorUserId(`agent:${A}`), A);
  assert.equal(actorUserId("curator/claude"), null);
  assert.equal(actorUserId("process:policy"), null);
  assert.equal(actorUserId("agent:"), null);
  assert.equal(actorUserId(null), null);
});

test("actorLabel shows agent names from profiles instead of raw ids", () => {
  const profiles = { [A]: { display_name: "billing-bot", kind: "agent" as const }, [H]: { display_name: "Ana", kind: "human" as const } };
  assert.equal(actorLabel(`agent:${A}`, profiles), "billing-bot");
  assert.equal(actorLabel(`agent:${A}`), "Agent 11111111");
  assert.equal(actorLabel(`human:${H}`, profiles), "Ana");
  assert.equal(actorLabel(`user:${H}`, profiles), "Ana");
  assert.equal(actorLabel("curator/claude-x"), "Curator · claude-x");
  assert.equal(actorLabel("process:policy"), "Auto-apply policy");
});

test("cancelledBy reads cancel_curator_run's error text", () => {
  assert.equal(cancelledBy(`cancelled by user:${H}`), `user:${H}`);
  assert.equal(cancelledBy("cancelled by system"), "system");
  assert.equal(cancelledBy("model timeout"), null);
  assert.equal(cancelledBy(null), null);
});
