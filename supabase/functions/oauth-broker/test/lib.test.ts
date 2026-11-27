import assert from "node:assert/strict";
import { brokerConfig, loopbackRedirect, portFromState, tokenRequest } from "../lib.ts";

const cfg = { clientId: "client-1", clientSecret: "secret-1", redirectUri: "https://ref.supabase.co/functions/v1/oauth-broker/callback" };
const state = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const VERIFIER = "a".repeat(43);

Deno.test("config needs the client id, secret and redirect URI", () => {
  const env: Record<string, string> = { KF_SUPABASE_OAUTH_CLIENT_ID: "id", KF_SUPABASE_OAUTH_CLIENT_SECRET: "s", KF_SUPABASE_OAUTH_REDIRECT_URI: "https://x/cb" };
  assert.deepEqual(brokerConfig((n) => env[n]), { clientId: "id", clientSecret: "s", redirectUri: "https://x/cb" });
  delete env.KF_SUPABASE_OAUTH_CLIENT_SECRET;
  assert.equal(brokerConfig((n) => env[n]), null);
});

Deno.test("state carries a loopback port; anything else is refused", () => {
  assert.equal(portFromState(state({ p: 51234, n: "x" })), 51234);
  for (const bad of [null, "", "not base64!", state({ p: 80 }), state({ p: 70000 }), state({ p: "5000" }), state({ p: 5000.5 }), state(null), "x".repeat(2000)]) {
    assert.equal(portFromState(bad), null, String(bad));
  }
});

Deno.test("the callback only ever redirects to 127.0.0.1 and forwards known parameters", () => {
  const s = state({ p: 51234, n: "nonce" });
  const target = loopbackRedirect(new URLSearchParams({ code: "c-1", state: s, extra: "dropped", redirect: "https://evil.example" }));
  const u = new URL(target!);
  assert.equal(u.origin, "http://127.0.0.1:51234");
  assert.equal(u.pathname, "/callback");
  assert.deepEqual([...u.searchParams.keys()].sort(), ["code", "state"]);
  assert.equal(loopbackRedirect(new URLSearchParams({ code: "c-1" })), null, "no state, no redirect");
  const err = new URL(loopbackRedirect(new URLSearchParams({ error: "access_denied", error_description: "no", state: s }))!);
  assert.equal(err.searchParams.get("error"), "access_denied");
});

Deno.test("authorization_code needs PKCE and this broker's redirect URI; the secret goes in Basic auth", () => {
  const ok = tokenRequest(new URLSearchParams({ grant_type: "authorization_code", code: "c", code_verifier: VERIFIER, redirect_uri: cfg.redirectUri }), cfg);
  assert(ok.ok);
  assert.equal(ok.headers.Authorization, `Basic ${btoa("client-1:secret-1")}`);
  assert.equal(ok.body.get("code_verifier"), VERIFIER);
  assert.equal(ok.body.get("redirect_uri"), cfg.redirectUri);
  assert.equal(ok.body.has("client_secret"), false, "the secret is never in the body");

  const bad: Record<string, string>[] = [
    { grant_type: "authorization_code", code: "c" },
    { grant_type: "authorization_code", code: "c", code_verifier: "short" },
    { grant_type: "authorization_code", code: "c", code_verifier: VERIFIER, redirect_uri: "http://127.0.0.1:1/cb" },
    { grant_type: "client_credentials" },
    { grant_type: "refresh_token" },
  ];
  for (const p of bad) {
    const r = tokenRequest(new URLSearchParams(p), cfg);
    assert.equal(r.ok, false, JSON.stringify(p));
  }
  const refresh = tokenRequest(new URLSearchParams({ grant_type: "refresh_token", refresh_token: "rt" }), cfg);
  assert(refresh.ok && refresh.body.get("refresh_token") === "rt");
});
