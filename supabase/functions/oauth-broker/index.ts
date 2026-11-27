// oauth-broker: lets `kf deploy --login` use Supabase's OAuth for integrations without shipping the OAuth app's
// client secret in the CLI. Deploy it to the project of whoever registered the OAuth app (not to every
// Supaknowledge project: `kf deploy` skips it).
//
//   GET  /oauth-broker/callback  Supabase redirects here (the OAuth app's registered redirect URI). The broker
//                                sends the browser on to http://127.0.0.1:<port>/callback, the port taken from
//                                `state`; only code, state, error and error_description are forwarded.
//   POST /oauth-broker/token     form or JSON body: grant_type=authorization_code (code, code_verifier,
//                                redirect_uri) or grant_type=refresh_token (refresh_token). Adds the client secret
//                                (HTTP Basic) and forwards to https://api.supabase.com/v1/oauth/token. Stores nothing.
//
// Secrets: KF_SUPABASE_OAUTH_CLIENT_ID, KF_SUPABASE_OAUTH_CLIENT_SECRET, KF_SUPABASE_OAUTH_REDIRECT_URI
// (https://<ref>.supabase.co/functions/v1/oauth-broker/callback). Deploy with --no-verify-jwt.
import { brokerConfig, loopbackRedirect, MAX_BODY_BYTES, SUPABASE_OAUTH_TOKEN_URL, tokenRequest } from "./lib.ts";

const noStore = { "Cache-Control": "no-store" };
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...noStore } });

async function readParams(req: Request): Promise<URLSearchParams | null> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return null;
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const o = JSON.parse(text) as Record<string, unknown>;
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(o ?? {})) if (typeof v === "string") p.set(k, v);
      return p;
    } catch {
      return null;
    }
  }
  return new URLSearchParams(text);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/oauth-broker/, "") || "/";
  const cfg = brokerConfig((n) => Deno.env.get(n));
  if (!cfg) return json({ error: "the OAuth broker is not configured" }, 503);

  if (req.method === "GET" && path === "/callback") {
    const target = loopbackRedirect(url.searchParams);
    if (!target) return new Response("Invalid sign-in request: start again from the kf command line.", { status: 400, headers: noStore });
    return new Response(null, { status: 302, headers: { Location: target, ...noStore } });
  }

  if (req.method === "POST" && path === "/token") {
    const params = await readParams(req);
    if (!params) return json({ error: "invalid request body" }, 400);
    const r = tokenRequest(params, cfg);
    if (!r.ok) return json({ error: r.error }, r.status);
    let upstream: Response;
    try {
      upstream = await fetch(SUPABASE_OAUTH_TOKEN_URL, { method: "POST", headers: r.headers, body: r.body, signal: AbortSignal.timeout(20_000) });
    } catch {
      return json({ error: "Supabase's token endpoint did not answer" }, 502);
    }
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json", ...noStore },
    });
  }

  return json({ error: "not found" }, 404);
});
