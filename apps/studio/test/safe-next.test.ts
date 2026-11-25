import assert from "node:assert/strict";
import { test } from "node:test";
import { isSameOriginRequest, redirectTo, requestOrigin, safeNext } from "../src/lib/safe-next.ts";
import { safeHref } from "../src/lib/safe-href.ts";

test("safeNext keeps same-origin paths with search and hash", () => {
  assert.equal(safeNext("/w/acme/main?tab=flags#x"), "/w/acme/main?tab=flags#x");
  assert.equal(safeNext("/oauth/consent?authorization_id=abc"), "/oauth/consent?authorization_id=abc");
  assert.equal(safeNext("/"), "/");
});

test("safeNext rejects open redirects", () => {
  for (const bad of [
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r\n/evil.example",
    "\t//evil.example",
    "/%09/evil.example/../",
    "https://evil.example",
    "javascript:alert(1)",
    "evil.example",
    "",
    null,
    undefined,
  ]) {
    const out = safeNext(bad);
    assert.ok(out === "/" || (out.startsWith("/") && !out.startsWith("//")), `${JSON.stringify(bad)} -> ${out}`);
    assert.equal(new URL(out, "https://studio.test").origin, "https://studio.test", JSON.stringify(bad));
  }
  assert.equal(safeNext("/\t/evil.example"), "/");
  assert.equal(safeNext("//evil.example", "/home"), "/home");
});

test("safeNext normalizes dot segments without leaving the origin", () => {
  assert.equal(safeNext("/a/../b"), "/b");
  assert.equal(safeNext("/..//evil.example"), "/");
});

const req = (headers: Record<string, string>, url = "http://127.0.0.1:3000/auth/callback") => new Request(url, { headers });

test("requestOrigin prefers SITE_URL", () => {
  assert.equal(requestOrigin(req({ host: "evil.example" }), { SITE_URL: "https://studio.example.com/app" }), "https://studio.example.com");
});

test("requestOrigin ignores X-Forwarded-* unless TRUST_PROXY", () => {
  const r = req({ host: "localhost:3000", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" });
  assert.equal(requestOrigin(r, {}), "http://localhost:3000");
  assert.equal(requestOrigin(r, { TRUST_PROXY: "1" }), "https://evil.example");
});

test("requestOrigin takes the first value of comma lists and validates it", () => {
  const r = req({ host: "localhost:3000", "x-forwarded-host": "studio.example.com, proxy.internal", "x-forwarded-proto": "https,http" });
  assert.equal(requestOrigin(r, { TRUST_PROXY: "true" }), "https://studio.example.com");
  const bad = req({ host: "localhost:3000", "x-forwarded-host": "evil.example/path", "x-forwarded-proto": "javascript" });
  assert.equal(requestOrigin(bad, { TRUST_PROXY: "1" }), "http://localhost:3000");
});

test("requestOrigin falls back to the request URL on a bad Host", () => {
  assert.equal(requestOrigin(req({ host: "a b" }), {}), "http://127.0.0.1:3000");
});

test("redirectTo never redirects off-origin", () => {
  const res = redirectTo(req({ host: "127.0.0.1:3000" }), "//evil.example", 302, {});
  assert.equal(res.headers.get("location"), "http://127.0.0.1:3000/");
});

const post = (headers: Record<string, string>) => new Request("http://127.0.0.1:3000/auth/signout", { method: "POST", headers });

test("isSameOriginRequest blocks cross-site POSTs (logout CSRF)", () => {
  assert.equal(isSameOriginRequest(post({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin" }), {}), true);
  assert.equal(isSameOriginRequest(post({ host: "127.0.0.1:3000" }), {}), true);
  assert.equal(isSameOriginRequest(post({ host: "127.0.0.1:3000", "sec-fetch-site": "cross-site" }), {}), false);
  assert.equal(isSameOriginRequest(post({ host: "127.0.0.1:3000", origin: "https://evil.example" }), {}), false);
  assert.equal(isSameOriginRequest(post({ host: "127.0.0.1:3000", origin: "null" }), {}), false);
});

test("safeHref only allows http(s)", () => {
  assert.equal(safeHref("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(safeHref(" http://example.com "), "http://example.com/");
  for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "vbscript:x", "ftp://x", "/relative", "//evil", "", null, 42, "https://"]) {
    assert.equal(safeHref(bad), null, String(bad));
  }
});

test("requestOrigin behind a TLS proxy that keeps Host and sends only X-Forwarded-Proto", () => {
  const env = { TRUST_PROXY: "1" };
  const r = req({ host: "studio.example.com", "x-forwarded-proto": "https" });
  assert.equal(requestOrigin(r, env), "https://studio.example.com");
  const signout = req({ host: "studio.example.com", "x-forwarded-proto": "https", origin: "https://studio.example.com", "sec-fetch-site": "same-origin" });
  assert.equal(isSameOriginRequest(signout, env), true, "normal sign-out is not refused behind the proxy");
});

test("requestOrigin normalizes default ports and rejects invalid hosts without throwing", () => {
  const env = { TRUST_PROXY: "1" };
  assert.equal(requestOrigin(req({ host: "x", "x-forwarded-host": "studio.example.com:443", "x-forwarded-proto": "https" }), env), "https://studio.example.com");
  assert.doesNotThrow(() => redirectTo(req({ host: "ok.example", "x-forwarded-host": "evil.example:99999" }), "/", 302, env));
  assert.doesNotThrow(() => redirectTo(req({ host: "ok.example", "x-forwarded-host": "[:::1]" }), "/", 302, env));
  assert.equal(new URL(redirectTo(req({ host: "ok.example", "x-forwarded-host": "evil.example:99999" }), "/", 302, env).headers.get("location")!).host, "ok.example");
});
