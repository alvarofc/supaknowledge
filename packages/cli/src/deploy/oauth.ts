// `kf deploy --login`: a Supabase Management API token through Supabase's OAuth for integrations
// (https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration), authorization code + PKCE (S256).
//
// Supabase's token endpoint takes the OAuth app's client id and secret as HTTP Basic auth, so the CLI never holds a
// secret it would have to ship. Two setups:
//   * broker (KF_SUPABASE_OAUTH_CLIENT_ID + KF_SUPABASE_OAUTH_BROKER_URL): the OAuth app's redirect URI is the
//     broker's /callback (supabase/functions/oauth-broker), which sends the browser on to this CLI's loopback
//     listener (port carried in `state`); code exchange and refresh go through the broker's /token, which adds the
//     secret. The broker stores nothing.
//   * your own OAuth app (KF_SUPABASE_OAUTH_CLIENT_ID + KF_SUPABASE_OAUTH_CLIENT_SECRET): redirect URI
//     http://127.0.0.1:<KF_SUPABASE_OAUTH_PORT, default 8791>/callback, token calls straight to Supabase.
// Tokens are saved in the kf config file (0600) next to the Supaknowledge sessions, under `supabase_oauth`.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { ConfigFile, Env, StoredSupabaseOAuth } from "../config.ts";
import { CliError, type FetchFn } from "../context.ts";

export const SUPABASE_OAUTH_AUTHORIZE_URL = "https://api.supabase.com/v1/oauth/authorize";
export const SUPABASE_OAUTH_TOKEN_URL = "https://api.supabase.com/v1/oauth/token";
export const DEFAULT_CALLBACK_PORT = 8791;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export type OAuthSetup =
  | { kind: "broker"; clientId: string; brokerUrl: string }
  | { kind: "direct"; clientId: string; clientSecret: string; port: number };

export const OAUTH_ENV_HINT =
  "set KF_SUPABASE_OAUTH_CLIENT_ID and either KF_SUPABASE_OAUTH_BROKER_URL (the oauth-broker function of whoever registered the OAuth app) or KF_SUPABASE_OAUTH_CLIENT_SECRET (your own OAuth app); see docs/deploy.md#deploy-with-kf-deploy---login. Or use a personal access token: SUPABASE_ACCESS_TOKEN";

/** Which OAuth setup the environment describes. Throws a usage error (exit 2) when it describes none. */
export function oauthSetup(env: Env): OAuthSetup {
  const clientId = env.KF_SUPABASE_OAUTH_CLIENT_ID?.trim();
  const secret = env.KF_SUPABASE_OAUTH_CLIENT_SECRET?.trim();
  const broker = env.KF_SUPABASE_OAUTH_BROKER_URL?.trim();
  if (!clientId) throw new CliError("--login needs KF_SUPABASE_OAUTH_CLIENT_ID", { exitCode: 2, hint: OAUTH_ENV_HINT });
  if (secret) {
    const raw = env.KF_SUPABASE_OAUTH_PORT?.trim();
    const port = raw ? Number(raw) : DEFAULT_CALLBACK_PORT;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new CliError("KF_SUPABASE_OAUTH_PORT must be a port between 1024 and 65535", { exitCode: 2 });
    return { kind: "direct", clientId, clientSecret: secret, port };
  }
  if (broker) {
    let u: URL;
    try {
      u = new URL(broker);
    } catch {
      throw new CliError(`KF_SUPABASE_OAUTH_BROKER_URL is not a URL: ${broker}`, { exitCode: 2 });
    }
    const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new CliError("KF_SUPABASE_OAUTH_BROKER_URL must be https", { exitCode: 2 });
    return { kind: "broker", clientId, brokerUrl: u.toString().replace(/\/+$/, "") };
  }
  throw new CliError("--login needs KF_SUPABASE_OAUTH_BROKER_URL or KF_SUPABASE_OAUTH_CLIENT_SECRET", { exitCode: 2, hint: OAUTH_ENV_HINT });
}

const b64url = (b: Buffer) => b.toString("base64url");

/** PKCE (RFC 7636): a 43-character verifier and its S256 challenge. */
export function pkcePair(random: (n: number) => Buffer = randomBytes): { verifier: string; challenge: string } {
  const verifier = b64url(random(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

/** `state`: base64url JSON {"p": loopback port, "n": nonce}. The broker reads the port; kf checks the nonce. */
export function encodeState(port: number, nonce: string): string {
  return Buffer.from(JSON.stringify({ p: port, n: nonce })).toString("base64url");
}

export function redirectUri(setup: OAuthSetup): string {
  return setup.kind === "broker" ? `${setup.brokerUrl}/callback` : `http://127.0.0.1:${setup.port}/callback`;
}

export function authorizeUrl(setup: OAuthSetup, p: { state: string; challenge: string; organizationSlug?: string }): string {
  const u = new URL(SUPABASE_OAUTH_AUTHORIZE_URL);
  u.searchParams.set("client_id", setup.clientId);
  u.searchParams.set("redirect_uri", redirectUri(setup));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", p.state);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (p.organizationSlug) u.searchParams.set("organization_slug", p.organizationSlug);
  return u.toString();
}

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string | null;
  /** seconds */
  expires_in?: number;
}

/** POST to Supabase's token endpoint (own app) or the broker's /token. Errors never contain tokens. */
export async function tokenRequest(fetch: FetchFn, setup: OAuthSetup, params: Record<string, string>): Promise<OAuthTokens> {
  const url = setup.kind === "broker" ? `${setup.brokerUrl}/token` : SUPABASE_OAUTH_TOKEN_URL;
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (setup.kind === "direct") headers.Authorization = `Basic ${Buffer.from(`${setup.clientId}:${setup.clientSecret}`).toString("base64")}`;
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new CliError(`Supabase OAuth token request failed: ${(e as Error).message}`);
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const msg = [data.error_description, data.error, data.message].find((v) => typeof v === "string" && v) as string | undefined;
    throw new CliError(`Supabase OAuth token request failed (HTTP ${res.status})${msg ? `: ${msg.slice(0, 300)}` : ""}`, { status: res.status });
  }
  if (typeof data.access_token !== "string" || !data.access_token) throw new CliError("Supabase OAuth token response has no access_token");
  return {
    access_token: data.access_token,
    refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : null,
    expires_in: typeof data.expires_in === "number" ? data.expires_in : undefined,
  };
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:4rem auto;max-width:32rem"><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`;

export interface CallbackListener {
  port: number;
  /** resolves with the authorization code once a request with the expected state arrives */
  code: Promise<string>;
  close: () => void;
}

/**
 * A one-shot listener on 127.0.0.1 for the OAuth redirect. Requests with another state are answered 400 and
 * ignored (so a stray request cannot end the login); an `error` with the right state rejects.
 */
export function listenForCallback(opts: { port: number; state: string; timeoutMs?: number }): Promise<CallbackListener> {
  return new Promise((resolveListener, rejectListener) => {
    let settle: { resolve: (c: string) => void; reject: (e: Error) => void } | undefined;
    const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
    code.catch(() => {}); // the caller may close before awaiting
    let timer: ReturnType<typeof setTimeout> | undefined;
    const server: Server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      const send = (status: number, title: string, body: string) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(PAGE(title, body));
      };
      if (u.pathname !== "/callback" || u.searchParams.get("state") !== opts.state) {
        send(400, "Unknown sign-in request", "This request does not belong to the running kf command.");
        return;
      }
      const err = u.searchParams.get("error");
      const c = u.searchParams.get("code");
      if (err || !c) {
        send(400, "Sign-in cancelled", "Supabase did not authorize kf. Return to the terminal.");
        settle!.reject(new CliError(`Supabase authorization failed: ${err ?? "no code"}${u.searchParams.get("error_description") ? ` (${u.searchParams.get("error_description")!.slice(0, 200)})` : ""}`));
        return;
      }
      send(200, "Signed in to Supabase", "kf can now deploy. Close this tab and return to the terminal.");
      settle!.resolve(c);
    });
    const close = () => {
      if (timer) clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
    };
    server.once("error", (e: NodeJS.ErrnoException) =>
      rejectListener(
        new CliError(`cannot listen on 127.0.0.1:${opts.port} for the OAuth callback: ${e.code ?? e.message}`, {
          hint: e.code === "EADDRINUSE" ? "another process uses the port; set KF_SUPABASE_OAUTH_PORT (and register that redirect URI)" : undefined,
        }),
      ),
    );
    server.listen(opts.port, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      timer = setTimeout(() => settle!.reject(new CliError("timed out waiting for the Supabase sign-in (5 minutes)")), opts.timeoutMs ?? LOGIN_TIMEOUT_MS);
      timer.unref?.();
      resolveListener({ port, code, close });
    });
  });
}

/** The full browser flow: listener, authorize URL (handed to `open`), code, token exchange. */
export async function browserLogin(
  fetch: FetchFn,
  setup: OAuthSetup,
  opts: { open: (url: string) => Promise<void> | void; organizationSlug?: string; timeoutMs?: number; random?: (n: number) => Buffer },
): Promise<OAuthTokens> {
  const random = opts.random ?? randomBytes;
  const { verifier, challenge } = pkcePair(random);
  const nonce = b64url(random(16));
  // broker: any free port (the broker reads it from state); own app: the registered port
  const wanted = setup.kind === "direct" ? setup.port : 0;
  // the state names the port, so a random port is known only after listening: listen first with a placeholder
  // state, then compare against the real one (the handler reads opts.state lazily)
  const listenOpts = { port: wanted, state: "", timeoutMs: opts.timeoutMs };
  const listener = await listenForCallback(listenOpts);
  try {
    const state = encodeState(listener.port, nonce);
    listenOpts.state = state;
    await opts.open(authorizeUrl(setup, { state, challenge, organizationSlug: opts.organizationSlug }));
    const code = await listener.code;
    return await tokenRequest(fetch, setup, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri(setup) });
  } finally {
    listener.close();
  }
}

/** Saved tokens of the same OAuth app (and broker), if any. */
export function storedFor(cfg: ConfigFile, setup: OAuthSetup): StoredSupabaseOAuth | null {
  const s = cfg.supabase_oauth;
  if (!s || s.client_id !== setup.clientId) return null;
  if ((s.broker_url ?? null) !== (setup.kind === "broker" ? setup.brokerUrl : null)) return null;
  return s;
}

export function toStored(setup: OAuthSetup, t: OAuthTokens, nowMs: number, previousRefresh?: string | null): StoredSupabaseOAuth {
  return {
    client_id: setup.clientId,
    broker_url: setup.kind === "broker" ? setup.brokerUrl : null,
    access_token: t.access_token,
    // a refresh response without a new refresh token keeps the old one
    refresh_token: t.refresh_token ?? previousRefresh ?? null,
    expires_at: Math.floor(nowMs / 1000) + (t.expires_in ?? 3600),
  };
}

/**
 * A Management API access token: the saved one while it is valid for another minute, else a refresh, else the
 * browser flow. Saves what it gets.
 */
export async function supabaseAccessToken(p: {
  fetch: FetchFn;
  setup: OAuthSetup;
  config: ConfigFile;
  save: () => void;
  nowMs: number;
  open: (url: string) => Promise<void> | void;
  note: (s: string) => void;
  organizationSlug?: string;
  forceLogin?: boolean;
  timeoutMs?: number;
}): Promise<string> {
  const stored = p.forceLogin ? null : storedFor(p.config, p.setup);
  const now = Math.floor(p.nowMs / 1000);
  if (stored && stored.expires_at - 60 > now) return stored.access_token;
  if (stored?.refresh_token) {
    try {
      const t = await tokenRequest(p.fetch, p.setup, { grant_type: "refresh_token", refresh_token: stored.refresh_token });
      p.config.supabase_oauth = toStored(p.setup, t, p.nowMs, stored.refresh_token);
      p.save();
      return t.access_token;
    } catch (e) {
      p.note(`saved Supabase sign-in could not be refreshed (${(e as Error).message}); signing in again`);
    }
  }
  const t = await browserLogin(p.fetch, p.setup, { open: p.open, organizationSlug: p.organizationSlug, timeoutMs: p.timeoutMs });
  p.config.supabase_oauth = toStored(p.setup, t, p.nowMs);
  p.save();
  return t.access_token;
}
