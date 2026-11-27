// Pure logic of the OAuth token broker (see index.ts). No I/O, so it is unit-tested directly.

export const SUPABASE_OAUTH_TOKEN_URL = "https://api.supabase.com/v1/oauth/token";
/** Query parameters the callback forwards to the CLI; anything else is dropped. */
export const FORWARDED_PARAMS = ["code", "state", "error", "error_description"] as const;
export const MAX_BODY_BYTES = 8192;

export interface BrokerConfig {
  clientId: string;
  clientSecret: string;
  /** this function's callback URL, exactly as registered on the OAuth app */
  redirectUri: string;
}

/** KF_SUPABASE_OAUTH_CLIENT_ID / _CLIENT_SECRET / _REDIRECT_URI; null when any is missing. */
export function brokerConfig(get: (name: string) => string | undefined): BrokerConfig | null {
  const clientId = get("KF_SUPABASE_OAUTH_CLIENT_ID")?.trim();
  const clientSecret = get("KF_SUPABASE_OAUTH_CLIENT_SECRET")?.trim();
  const redirectUri = get("KF_SUPABASE_OAUTH_REDIRECT_URI")?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

/**
 * The CLI's loopback port from `state` (base64url JSON {"p": port, "n": nonce}, written by kf). Only ports
 * 1024-65535 are accepted; anything else is null.
 */
export function portFromState(state: string | null): number | null {
  if (!state || state.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(state)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(state.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
  const p = (parsed as { p?: unknown } | null)?.p;
  return typeof p === "number" && Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : null;
}

/** Where the browser goes after Supabase's redirect: the CLI's loopback listener, never another host. */
export function loopbackRedirect(query: URLSearchParams): string | null {
  const port = portFromState(query.get("state"));
  if (port === null) return null;
  const target = new URL(`http://127.0.0.1:${port}/callback`);
  for (const k of FORWARDED_PARAMS) {
    const v = query.get(k);
    if (v !== null) target.searchParams.set(k, v.slice(0, 2048));
  }
  return target.toString();
}

export type TokenRequest = { ok: true; body: URLSearchParams; headers: Record<string, string> } | { ok: false; status: number; error: string };

/**
 * The request to Supabase's token endpoint for a CLI request. Only two grants: authorization_code with PKCE
 * (code_verifier required, redirect_uri must be this broker's) and refresh_token. The client secret is added
 * here as HTTP Basic auth, as Supabase's OAuth docs describe.
 */
export function tokenRequest(params: URLSearchParams, cfg: BrokerConfig): TokenRequest {
  const grant = params.get("grant_type");
  const body = new URLSearchParams();
  if (grant === "authorization_code") {
    const code = params.get("code");
    const verifier = params.get("code_verifier");
    const redirect = params.get("redirect_uri") ?? cfg.redirectUri;
    if (!code || !verifier) return { ok: false, status: 400, error: "code and code_verifier are required" };
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return { ok: false, status: 400, error: "invalid code_verifier" };
    if (redirect !== cfg.redirectUri) return { ok: false, status: 400, error: "redirect_uri does not match this broker" };
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("code_verifier", verifier);
    body.set("redirect_uri", cfg.redirectUri);
  } else if (grant === "refresh_token") {
    const refresh = params.get("refresh_token");
    if (!refresh) return { ok: false, status: 400, error: "refresh_token is required" };
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", refresh);
  } else {
    return { ok: false, status: 400, error: "unsupported grant_type (authorization_code or refresh_token)" };
  }
  return {
    ok: true,
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`,
    },
  };
}
