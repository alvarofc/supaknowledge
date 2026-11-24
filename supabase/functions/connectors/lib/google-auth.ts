// Google OAuth access tokens from what admins store with set_source_secret:
//   * a service-account key JSON ({"type": "service_account", "client_email", "private_key", ...}) -> signed
//     JWT (RS256 via WebCrypto) exchanged at the token endpoint (optionally impersonating `subject` through
//     domain-wide delegation)
//   * an OAuth "authorized_user" JSON ({"client_id", "client_secret", "refresh_token"}) -> refresh grant
//   * a bare access token (anything that is not JSON) -> used as-is (handy for tests / short-lived runs)
import { ensureOk, readJson, readText, request } from "./http.ts";
import { AuthError, ConfigError, type SyncContext } from "./types.ts";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
// Locked: a `token_uri` inside the stored secret is ignored. Otherwise anyone able to set the secret could
// make the connector POST signed assertions / refresh tokens to an arbitrary (internal) URL.
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ACCEPTED_TOKEN_URIS = new Set([TOKEN_URL, "https://accounts.google.com/o/oauth2/token", "https://www.googleapis.com/oauth2/v4/token"]);

function b64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function signJwtRS256(claims: Record<string, unknown>, privateKeyPem: string, kid?: string): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", ...(kid ? { kid } : {}) };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("pkcs8", pemToDer(privateKeyPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch (e) {
    throw new ConfigError(`service account private_key is not a valid PKCS#8 PEM: ${e instanceof Error ? e.message : e}`);
  }
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}

interface ServiceAccount {
  type: "service_account";
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
}
interface AuthorizedUser {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  token_uri?: string;
}

type Ctx = Pick<SyncContext, "fetch" | "sleep" | "log" | "now">;

export async function googleAccessToken(ctx: Ctx, secret: string, opts: { scope?: string; subject?: string } = {}): Promise<string> {
  const trimmed = secret.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  let cred: Partial<ServiceAccount & AuthorizedUser & { access_token: string }>;
  try {
    cred = JSON.parse(trimmed);
  } catch {
    throw new ConfigError("gdrive secret looks like JSON but does not parse");
  }
  if (cred.access_token && !cred.refresh_token && !cred.private_key) return cred.access_token;

  if (cred.token_uri && !ACCEPTED_TOKEN_URIS.has(cred.token_uri)) {
    throw new ConfigError(`gdrive secret: unsupported token_uri (only ${TOKEN_URL} is allowed)`);
  }
  const tokenUrl = TOKEN_URL;
  let body: URLSearchParams;
  if (cred.type === "service_account" || (cred.private_key && cred.client_email)) {
    const iat = Math.floor(ctx.now().getTime() / 1000);
    const claims: Record<string, unknown> = {
      iss: cred.client_email,
      scope: opts.scope ?? DRIVE_SCOPE,
      aud: tokenUrl,
      iat,
      exp: iat + 3600,
    };
    if (opts.subject) claims.sub = opts.subject;
    const assertion = await signJwtRS256(claims, cred.private_key!, cred.private_key_id);
    body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion });
  } else if (cred.refresh_token && cred.client_id) {
    body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cred.refresh_token,
      client_id: cred.client_id,
      client_secret: cred.client_secret ?? "",
    });
  } else {
    throw new ConfigError("gdrive secret must be a service-account key JSON, an authorized_user JSON with refresh_token, or an access token");
  }
  const res = await request(ctx, tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (res.status === 400 || res.status === 401) {
    // surface only the OAuth error code (RFC 6749 §5.2), never the raw body
    let code = "invalid_request";
    try {
      const e = JSON.parse(await readText(res, 16 * 1024)) as { error?: unknown };
      if (typeof e.error === "string" && /^[a-z_]{1,64}$/.test(e.error)) code = e.error;
    } catch {
      // not JSON
    }
    throw new AuthError(`google token exchange failed (${res.status} ${code})`);
  }
  const json = await readJson<{ access_token?: string }>(await ensureOk(res, "google token"), 1024 * 1024);
  if (!json.access_token) throw new AuthError("google token endpoint returned no access_token");
  return json.access_token;
}
