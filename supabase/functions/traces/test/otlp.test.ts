import assert from "node:assert/strict";
import { audienceParam, clipPayload, compareSpans, type Mapped, mapSpan, messagesFrom, nanoKey, nanoToIso, type OtlpSpan } from "../otlp.ts";

const s = (v: string) => ({ stringValue: v });

Deno.test("plain-string prompts are user messages, completions assistant", () => {
  assert.deepEqual(messagesFrom("Actually, use revenue_usd_net instead.", "user"), [{ role: "user", content: "Actually, use revenue_usd_net instead." }]);
  assert.deepEqual(messagesFrom("done", "assistant"), [{ role: "assistant", content: "done" }]);
  assert.deepEqual(messagesFrom('[{"role":"system","content":"x"},{"content":"y"}]', "user"), [{ role: "system", content: "x" }, { role: "user", content: "y" }]);
});

Deno.test("mapSpan stores gen_ai.prompt strings and gen_ai.content.prompt events as user", () => {
  const span: OtlpSpan = {
    spanId: "ab", startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000001000000000",
    attributes: [{ key: "gen_ai.prompt", value: s("Actually, that is wrong, use revenue_usd_net.") }, { key: "gen_ai.completion", value: s("ok") }],
    events: [{ name: "gen_ai.content.prompt", timeUnixNano: "1700000000500000000", attributes: [{ key: "gen_ai.prompt", value: s("second prompt") }] }],
  };
  const out: Mapped = { events: [], meta: {} };
  mapSpan(span, out);
  const roles = Object.fromEntries(out.events.map((e) => [e.content, e.role]));
  assert.equal(roles["Actually, that is wrong, use revenue_usd_net."], "user");
  assert.equal(roles["second prompt"], "user");
  assert.equal(roles["ok"], "assistant");
});

Deno.test("malformed OTLP timestamps never throw", () => {
  assert.equal(nanoKey(""), 0n);
  assert.equal(nanoKey("1e18"), 0n);
  assert.equal(nanoKey(1.5e18), 1500000000000000000n);
  assert.equal(nanoToIso("garbage"), null);
  const spans: OtlpSpan[] = [{ startTimeUnixNano: "2" }, { startTimeUnixNano: "" }, { startTimeUnixNano: "1e3" }, { startTimeUnixNano: "1" }];
  assert.doesNotThrow(() => spans.sort(compareSpans));
  assert.equal(spans.at(-1)!.startTimeUnixNano, "2");
});

Deno.test("tool payloads are bounded", () => {
  assert.deepEqual(clipPayload({ a: 1 }), { a: 1 });
  assert.equal(clipPayload(undefined), null);
  const big = clipPayload({ x: "y".repeat(200_000) }) as { truncated: boolean; original_bytes: number; preview: string };
  assert.equal(big.truncated, true);
  assert.ok(JSON.stringify(big).length < 101_000);
});

Deno.test("audience from query or header", () => {
  assert.equal(audienceParam(new URL("http://x/otlp"), new Headers()), undefined);
  assert.deepEqual(audienceParam(new URL("http://x/otlp?audience=finance,sales&audience=finance"), new Headers()), ["finance", "sales"]);
  assert.deepEqual(audienceParam(new URL("http://x/otlp"), new Headers({ "x-supaknowledge-audience": " finance , " })), ["finance"]);
});
