import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ConfigFile } from "../src/config.ts";
import type { FetchFn } from "../src/context.ts";
import {
  authorizeUrl,
  browserLogin,
  encodeState,
  oauthSetup,
  pkcePair,
  SUPABASE_OAUTH_TOKEN_URL,
  supabaseAccessToken,
  type OAuthSetup,
} from "../src/deploy/oauth.ts";
import { harness, json, type Call } from "./helpers.ts";

const BROKER = "https://broker.example.com/functions/v1/oauth-broker";
const broker: OAuthSetup = { kind: "broker", clientId: "client-1", brokerUrl: BROKER };
const REF = "abcdefghijklmnopqrst";
const OAUTH_TOKEN = `sbp_oauth_${"a".repeat(40)}`;

/** Scripted fetch for the token endpoints; records calls with form bodies decoded. */
function fakeFetch(respond: (c: Call) => Response | undefined) {
  const calls: Call[] = [];
  const fetch: FetchFn = async (input, init = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init.body === "string" ? Object.fromEntries(new URLSearchParams(init.body)) : init.body;
    const call = { method: (init.method ?? "GET").toUpperCase(), url: String(input), headers, body };
    calls.push(call);
    return respond(call) ?? json({ error: "unmocked" }, 599);
  };
  return { fetch, calls };
}

/** What the browser does: Supabase sends it to the redirect URI; for the broker, the broker sends it to 127.0.0.1. */
function browser(opts: { code?: string; error?: string; tamper?: boolean; seen?: URL[] } = {}) {
  return async (url: string) => {
    const u = new URL(url);
    opts.seen?.push(u);
    const state = u.searchParams.get("state")!;
    const port = JSON.parse(Buffer.from(state, "base64url").toString()).p as number;
    const q = new URLSearchParams(opts.error ? { error: opts.error, state } : { code: opts.code ?? "code-1", state });
    if (opts.tamper) {
      // a stray request with another state is answered 400 and does not end the login
      const r = await globalThis.fetch(`http://127.0.0.1:${port}/callback?code=evil&state=other`);
      assert.equal(r.status, 400);
    }
    const r = await globalThis.fetch(`http://127.0.0.1:${port}/callback?${q}`);
    await r.text();
  };
}

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

describe("Supabase OAuth setup", () => {
  it("needs a client id and either a broker URL or a client secret", () => {
    assert.throws(() => oauthSetup({}), /KF_SUPABASE_OAUTH_CLIENT_ID/);
    assert.throws(() => oauthSetup({ KF_SUPABASE_OAUTH_CLIENT_ID: "id" }), /BROKER_URL or KF_SUPABASE_OAUTH_CLIENT_SECRET/);
    assert.deepEqual(oauthSetup({ KF_SUPABASE_OAUTH_CLIENT_ID: "id", KF_SUPABASE_OAUTH_BROKER_URL: `${BROKER}/` }), { kind: "broker", clientId: "id", brokerUrl: BROKER });
    assert.deepEqual(oauthSetup({ KF_SUPABASE_OAUTH_CLIENT_ID: "id", KF_SUPABASE_OAUTH_CLIENT_SECRET: "s" }), { kind: "direct", clientId: "id", clientSecret: "s", port: 8791 });
    assert.throws(() => oauthSetup({ KF_SUPABASE_OAUTH_CLIENT_ID: "id", KF_SUPABASE_OAUTH_BROKER_URL: "http://broker.example.com" }), /https/);
    assert.throws(() => oauthSetup({ KF_SUPABASE_OAUTH_CLIENT_ID: "id", KF_SUPABASE_OAUTH_CLIENT_SECRET: "s", KF_SUPABASE_OAUTH_PORT: "80" }), /1024/);
  });

  it("PKCE uses S256 (RFC 7636 appendix B)", () => {
    const rfcBytes = Buffer.from([116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121]);
    const { verifier, challenge } = pkcePair(() => rfcBytes);
    assert.equal(verifier, "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    assert.equal(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("the authorize URL carries the client, redirect URI, state and the S256 challenge", () => {
    const u = new URL(authorizeUrl(broker, { state: encodeState(5000, "n"), challenge: "ch", organizationSlug: "acme" }));
    assert.equal(u.origin + u.pathname, "https://api.supabase.com/v1/oauth/authorize");
    assert.equal(u.searchParams.get("client_id"), "client-1");
    assert.equal(u.searchParams.get("redirect_uri"), `${BROKER}/callback`);
    assert.equal(u.searchParams.get("response_type"), "code");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.equal(u.searchParams.get("organization_slug"), "acme");
    assert.equal(u.searchParams.has("scope"), false, "scopes are set on the OAuth app");
  });
});

describe("browser login", () => {
  it("broker: loopback callback, then the code and verifier go to the broker (no secret in the CLI)", async () => {
    const { fetch, calls } = fakeFetch((c) => (c.url === `${BROKER}/token` ? json({ access_token: OAUTH_TOKEN, refresh_token: "rt-1", expires_in: 3600, token_type: "Bearer" }) : undefined));
    const seen: URL[] = [];
    const t = await browserLogin(fetch, broker, { open: browser({ code: "code-1", tamper: true, seen }), timeoutMs: 5000 });
    assert.equal(t.access_token, OAUTH_TOKEN);
    assert.equal(calls.length, 1);
    const body = calls[0]!.body as Record<string, string>;
    assert.equal(body.grant_type, "authorization_code");
    assert.equal(body.code, "code-1");
    assert.equal(body.redirect_uri, `${BROKER}/callback`);
    assert.equal(createHash("sha256").update(body.code_verifier!).digest("base64url"), seen[0]!.searchParams.get("code_challenge"), "the verifier matches the challenge");
    assert.equal(calls[0]!.headers.authorization, undefined, "no client credentials leave the CLI");
  });

  it("own OAuth app: fixed loopback redirect URI and HTTP Basic client auth to Supabase", async () => {
    const port = await freePort();
    const direct: OAuthSetup = { kind: "direct", clientId: "id-2", clientSecret: "secret-2", port };
    const { fetch, calls } = fakeFetch((c) => (c.url === SUPABASE_OAUTH_TOKEN_URL ? json({ access_token: OAUTH_TOKEN, expires_in: 60 }) : undefined));
    const seen: URL[] = [];
    await browserLogin(fetch, direct, { open: browser({ seen }), timeoutMs: 5000 });
    assert.equal(seen[0]!.searchParams.get("redirect_uri"), `http://127.0.0.1:${port}/callback`);
    assert.equal(calls[0]!.headers.authorization, `Basic ${Buffer.from("id-2:secret-2").toString("base64")}`);
    assert.equal((calls[0]!.body as Record<string, string>).redirect_uri, `http://127.0.0.1:${port}/callback`);
  });

  it("a denied authorization fails with Supabase's error", async () => {
    const { fetch, calls } = fakeFetch(() => undefined);
    await assert.rejects(browserLogin(fetch, broker, { open: browser({ error: "access_denied" }), timeoutMs: 5000 }), /access_denied/);
    assert.equal(calls.length, 0);
  });

  it("a token error is reported without the code or verifier", async () => {
    const { fetch } = fakeFetch(() => json({ error: "invalid_grant", error_description: "code expired" }, 400));
    await assert.rejects(browserLogin(fetch, broker, { open: browser({ code: "secret-code" }), timeoutMs: 5000 }), (e: Error) => {
      assert.match(e.message, /HTTP 400.*code expired/);
      assert.doesNotMatch(e.message, /secret-code/);
      return true;
    });
  });
});

describe("saved Supabase sign-in", () => {
  const base = (cfg: ConfigFile, fetch: FetchFn, nowMs: number, open: (url: string) => Promise<void> = async () => assert.fail("no browser expected")) => {
    let saved = 0;
    const notes: string[] = [];
    return {
      run: () => supabaseAccessToken({ fetch, setup: broker, config: cfg, save: () => void saved++, nowMs, open, note: (m) => void notes.push(m), timeoutMs: 5000 }),
      saved: () => saved,
      notes,
    };
  };

  it("uses a valid saved token without any request", async () => {
    const now = 1_000_000_000_000;
    const cfg: ConfigFile = { profiles: {}, supabase_oauth: { client_id: "client-1", broker_url: BROKER, access_token: "saved", refresh_token: "rt", expires_at: now / 1000 + 600 } };
    const { fetch, calls } = fakeFetch(() => undefined);
    assert.equal(await base(cfg, fetch, now).run(), "saved");
    assert.equal(calls.length, 0);
  });

  it("refreshes an expired token and keeps the refresh token when none is returned", async () => {
    const now = 1_000_000_000_000;
    const cfg: ConfigFile = { profiles: {}, supabase_oauth: { client_id: "client-1", broker_url: BROKER, access_token: "old", refresh_token: "rt-1", expires_at: now / 1000 - 10 } };
    const { fetch, calls } = fakeFetch(() => json({ access_token: "new", expires_in: 3600 }));
    const b = base(cfg, fetch, now);
    assert.equal(await b.run(), "new");
    assert.deepEqual(calls[0]!.body, { grant_type: "refresh_token", refresh_token: "rt-1" });
    assert.equal(cfg.supabase_oauth?.refresh_token, "rt-1");
    assert.equal(cfg.supabase_oauth?.expires_at, now / 1000 + 3600);
    assert.equal(b.saved(), 1);
  });

  it("signs in again when the refresh is refused, and ignores tokens of another OAuth app", async () => {
    const now = 1_000_000_000_000;
    const cfg: ConfigFile = { profiles: {}, supabase_oauth: { client_id: "client-1", broker_url: BROKER, access_token: "old", refresh_token: "revoked", expires_at: 0 } };
    const { fetch, calls } = fakeFetch((c) =>
      (c.body as Record<string, string>).grant_type === "refresh_token" ? json({ error: "invalid_grant" }, 400) : json({ access_token: "fresh", refresh_token: "rt-2", expires_in: 3600 }),
    );
    const b = base(cfg, fetch, now, browser());
    assert.equal(await b.run(), "fresh");
    assert.equal(calls.length, 2);
    assert.match(b.notes.join("\n"), /signing in again/);
    assert.equal(cfg.supabase_oauth?.refresh_token, "rt-2");

    const other: ConfigFile = { profiles: {}, supabase_oauth: { client_id: "someone-else", broker_url: BROKER, access_token: "theirs", expires_at: now / 1000 + 600 } };
    const f2 = fakeFetch(() => json({ access_token: "mine", expires_in: 3600 }));
    assert.equal(await base(other, f2.fetch, now, browser()).run(), "mine");
  });
});

describe("kf deploy --login", () => {
  const env = { KF_SUPABASE_OAUTH_CLIENT_ID: "client-1", KF_SUPABASE_OAUTH_BROKER_URL: BROKER };
  /** a minimal repository clone: what kf deploy checks for before anything else */
  const repo = (h: ReturnType<typeof harness>) => {
    for (const d of ["supabase/migrations", "supabase/functions/mcp"]) mkdirSync(join(h.dir, d), { recursive: true });
    writeFileSync(join(h.dir, "supabase", "config.jsonc"), "{}");
  };
  const savedToken = (h: ReturnType<typeof harness>) => {
    repo(h);
    const p = join(h.configDir, "config.json");
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    cfg.supabase_oauth = { client_id: "client-1", broker_url: BROKER, access_token: OAUTH_TOKEN, refresh_token: "rt", expires_at: Math.floor(Date.now() / 1000) + 3600 };
    writeFileSync(p, JSON.stringify(cfg));
  };

  it("without the OAuth settings it is a usage error that names them", async () => {
    const h = harness();
    const r = await h.run("deploy", "--login", "--dir", h.dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /KF_SUPABASE_OAUTH_CLIENT_ID/);
  });

  it("refuses conflicting options before any request", async () => {
    const h = harness();
    h.env = env;
    for (const args of [["--org", "acme"], ["--login", "--access-token-stdin"], ["--login", "--create-project", "x", "--dry-run"], ["--login", "--region", "us-east-1"]]) {
      const r = await h.run("deploy", "--project-ref", REF, ...args);
      assert.equal(r.code, 2, args.join(" "));
    }
    assert.equal((await h.run("deploy")).code, 2, "no --project-ref and no --login");
    assert.equal(h.calls.length, 0);
  });

  it("without a terminal and several organizations it asks for --org", async () => {
    const h = harness();
    h.env = env;
    savedToken(h);
    h.routes.push((c) => (c.url === "https://api.supabase.com/v1/organizations" ? json([{ slug: "acme", name: "Acme" }, { slug: "beta", name: "Beta" }]) : undefined));
    const r = await h.run("deploy", "--login", "--dir", h.dir);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /pass --org <slug>[\s\S]*acme, beta/);
    assert.equal(h.calls[0]!.headers.authorization, `Bearer ${OAUTH_TOKEN}`, "the saved OAuth token is used");
  });

  it("--create-project creates the project, waits until it is healthy, prints the password once, then deploys to it", async () => {
    const h = harness();
    h.env = env;
    h.io = { randomHex: (n: number) => "d".repeat(n * 2) };
    savedToken(h);
    let polls = 0;
    h.routes.push((c) => {
      if (c.url === "https://api.supabase.com/v1/organizations") return json([{ slug: "acme", name: "Acme" }]);
      if (c.url === "https://api.supabase.com/v1/projects" && c.method === "POST") return json({ ref: REF, name: "kb", status: "COMING_UP" }, 201);
      if (c.url === `https://api.supabase.com/v1/projects/${REF}` && c.method === "GET") {
        polls++;
        // the first poll is the wait loop; the next one is step 1 of the deploy, stopped here on purpose
        return polls === 1 ? json({ ref: REF, status: "ACTIVE_HEALTHY" }) : json({ message: "stop" }, 404);
      }
      return undefined;
    });
    const r = await h.run("deploy", "--login", "--create-project", "kb", "--region", "eu-central-1", "--dir", h.dir, "--skip-db", "--skip-functions");
    const create = h.calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/projects"))!;
    assert.deepEqual(create.body, { name: "kb", organization_slug: "acme", db_pass: "d".repeat(32), region: "eu-central-1" });
    assert.match(r.stderr, /Database password[\s\S]*d{32}/);
    assert.match(r.stderr, /\[1\/7\] Project/, "the deploy continues with the new project");
    assert.equal(r.code, 1);
  });

  it("kf logout --supabase forgets the saved sign-in only", async () => {
    const h = harness();
    savedToken(h);
    const r = await h.run("logout", "--supabase");
    assert.equal(r.code, 0);
    const cfg = JSON.parse(readFileSync(join(h.configDir, "config.json"), "utf8"));
    assert.equal(cfg.supabase_oauth, null);
    assert.ok(cfg.profiles.default.session, "the Supaknowledge session stays");
  });
});
