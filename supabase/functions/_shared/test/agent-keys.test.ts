import assert from "node:assert/strict";
import { AGENT_KEY_RE, FailureLimiter, formatAgentKey, keyPrefix, LruCache, meetsPasswordPolicy, newAgentSecret, SingleFlight } from "../agent-keys.ts";

Deno.test("agent secrets always satisfy lower_upper_letters_digits_symbols and stay parseable", () => {
  const id = "0b6f3c1e-1d2a-4c3b-9a8f-123456789abc";
  for (let i = 0; i < 2000; i++) {
    const s = newAgentSecret();
    assert.ok(meetsPasswordPolicy(s), s);
    assert.match(s, /^[A-Za-z0-9_-]{43}$/);
    const m = AGENT_KEY_RE.exec(formatAgentKey(id, s));
    assert.ok(m);
    assert.equal(m[1], id);
    assert.equal(m[2], s);
  }
});

Deno.test("key prefix holds the agent id and 4 secret characters", () => {
  assert.equal(keyPrefix("a".repeat(36), "Ab1-xyz"), `skn_${"a".repeat(36)}_Ab1-`);
});

Deno.test("LruCache bounds size, evicts least recently used, expires entries", () => {
  let now = 0;
  const c = new LruCache<number>(2, () => now);
  c.set("a", 1, 1000);
  c.set("b", 2, 1000);
  assert.equal(c.get("a"), 1); // a is now most recent
  c.set("c", 3, 1000); // evicts b
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), 1);
  assert.equal(c.size, 2);
  now = 1001;
  assert.equal(c.get("a"), undefined);
});

Deno.test("SingleFlight coalesces concurrent calls per key", async () => {
  const sf = new SingleFlight<number>();
  let calls = 0;
  const work = () => new Promise<number>((r) => setTimeout(() => r(++calls), 10));
  const [a, b, c] = await Promise.all([sf.run("k", work), sf.run("k", work), sf.run("other", work)]);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(calls, 2);
  assert.equal(sf.size, 0);
  // a rejected flight is not cached
  await assert.rejects(sf.run("x", () => Promise.reject(new Error("boom"))));
  assert.equal(await sf.run("x", () => Promise.resolve(7)), 7);
});

Deno.test("agent keys need a strict lowercase UUID id (no 22P02 round-trip for junk ids)", () => {
  const secret = "Ab1-" + "x".repeat(39);
  for (
    const id of [
      "-".repeat(36), "0".repeat(36), "0b6f3c1e1d2a4c3b9a8f123456789abc----", "0b6f3c1e-1d2a-4c3b-9a8f-123456789abg",
      "0B6F3C1E-1D2A-4C3B-9A8F-123456789ABC", "0b6f3c1e-1d2a-4c3b-9a8f123456789abc-",
    ]
  ) assert.equal(AGENT_KEY_RE.exec(`skn_${id}_${secret}`), null, id);
  assert.ok(AGENT_KEY_RE.exec(`skn_0b6f3c1e-1d2a-4c3b-9a8f-123456789abc_${secret}`));
  // bounded secret length
  assert.equal(AGENT_KEY_RE.exec(`skn_0b6f3c1e-1d2a-4c3b-9a8f-123456789abc_${"a".repeat(129)}`), null);
});

Deno.test("FailureLimiter blocks after max failures per key and window, then recovers", () => {
  let now = 0;
  const l = new FailureLimiter(3, 60_000, 100, () => now);
  assert.equal(l.retryAfterMs("a"), 0);
  l.fail("a");
  l.fail("a");
  assert.equal(l.retryAfterMs("a"), 0);
  l.fail("a");
  assert.equal(l.retryAfterMs("a"), 60_000);
  assert.equal(l.retryAfterMs("b"), 0); // per key
  now = 30_000;
  l.fail("a"); // more failures do not extend the window
  assert.equal(l.retryAfterMs("a"), 30_000);
  now = 60_000;
  assert.equal(l.retryAfterMs("a"), 0);
  l.fail("a");
  assert.equal(l.retryAfterMs("a"), 0); // new window
  l.reset("a");
  assert.equal(l.retryAfterMs("a"), 0);
});
