import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getNavigation, requireUser } from "@/server/space.server";
import { getSupabase } from "@/server/supabase.server";

export type ConsentDetails = {
  authorizationId: string;
  redirectUri: string;
  scope: string;
  client: { name: string; uri: string | null; logoUri: string | null };
  requestEmail: string | null;
};

/**
 * Loads an OAuth 2.1 authorization request (Supabase Auth's OAuth server) with the user's session. When Auth
 * answers with a redirect (the user already consented to this client and these scopes), go there at once.
 */
export const loadConsent = createServerFn({ method: "GET" })
  .validator((d: { authorizationId?: string }) => d)
  .handler(async ({ data }) => {
    const authorizationId = data.authorizationId;
    // the _authed guard normally does this; keep it here too so the endpoint is safe on its own
    const user = await requireUser(`/oauth/consent${authorizationId ? `?authorization_id=${encodeURIComponent(authorizationId)}` : ""}`);
    const me = { email: user.email };
    if (!authorizationId) return { kind: "missing" as const, me };

    const { data: res, error } = await getSupabase().auth.oauth.getAuthorizationDetails(authorizationId);
    if (error || !res) return { kind: "error" as const, me, message: error?.message ?? "The request was not found." };

    // Already consented (or nothing left to decide): Auth hands back the final redirect.
    if (!("authorization_id" in res)) throw redirect({ href: res.redirect_url });

    const nav = await getNavigation();
    const details: ConsentDetails = {
      authorizationId: res.authorization_id,
      redirectUri: res.redirect_uri,
      scope: res.scope,
      client: { name: res.client.name, uri: res.client.uri || null, logoUri: res.client.logo_uri || null },
      requestEmail: res.user.email || null,
    };
    return {
      kind: "details" as const,
      me,
      details,
      spaceCount: nav.spaces.length,
      workspaceNames: nav.workspaces.map((w) => w.name),
    };
  });
