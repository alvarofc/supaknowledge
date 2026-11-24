import assert from "node:assert/strict";
import { baseCacheHeaders, escapeLike, normalizeConceptPath, publicBase } from "../urls.ts";

Deno.test("flag / read paths are normalized like stored concept paths", () => {
  assert.equal(normalizeConceptPath("/finance/board-pack.md"), "finance/board-pack");
  assert.equal(normalizeConceptPath("//finance/board-pack"), "finance/board-pack");
  assert.equal(normalizeConceptPath("skills/finance-close/SKILL.md"), "skills/finance-close");
  assert.equal(normalizeConceptPath("/skills/finance-close/SKILL"), "skills/finance-close");
  assert.equal(normalizeConceptPath("./metrics/arr.MD"), "metrics/arr");
  assert.equal(normalizeConceptPath("  "), null);
  assert.equal(normalizeConceptPath(undefined), null);
});

Deno.test("LIKE wildcards are escaped", () => {
  assert.equal(escapeLike("revenue_report"), "revenue\\_report");
  assert.equal(escapeLike("a%b"), "a\\%b");
});

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const old: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    old[k] = Deno.env.get(k);
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(old)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  }
}

Deno.test("public base prefers configuration and never trusts a spoofed Host when configured", () => {
  const req = new Request("http://kong:8000/functions/v1/mcp/.well-known/oauth-protected-resource", { headers: { host: "evil.attacker.test" } });
  withEnv({ KF_PUBLIC_URL: "https://kb.example.com/", SUPABASE_PUBLIC_URL: undefined, SUPABASE_URL: "http://kong:8000" }, () => {
    assert.deepEqual(publicBase(req), { base: "https://kb.example.com", fromHeaders: false });
    assert.equal(baseCacheHeaders(req)["Cache-Control"], "public, max-age=300");
  });
  withEnv({ KF_PUBLIC_URL: undefined, SUPABASE_PUBLIC_URL: undefined, SUPABASE_URL: "https://abc.supabase.co" }, () => {
    assert.deepEqual(publicBase(req), { base: "https://abc.supabase.co", fromHeaders: false });
  });
});

Deno.test("header fallback is validated and never publicly cached", () => {
  withEnv({ KF_PUBLIC_URL: undefined, SUPABASE_PUBLIC_URL: undefined, SUPABASE_URL: "http://kong:8000" }, () => {
    const ok = new Request("http://kong:8000/x", { headers: { host: "127.0.0.1:54321" } });
    assert.deepEqual(publicBase(ok), { base: "http://127.0.0.1:54321", fromHeaders: true });
    const h = baseCacheHeaders(ok);
    assert.equal(h["Cache-Control"], "no-store");
    assert.match(h.Vary, /Host/);
    const bad = new Request("http://kong:8000/x", { headers: { "x-forwarded-host": "evil.test/@x", "x-forwarded-proto": "javascript" } });
    assert.equal(publicBase(bad).base, "http://kong:8000");
  });
});
