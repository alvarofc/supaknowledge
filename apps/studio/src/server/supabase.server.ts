import { createServerClient } from "@supabase/ssr";
import { getCookies, getRequest, setCookie, setResponseHeader } from "@tanstack/react-start/server";
import type { Database } from "@/lib/database.types";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, assertEnv } from "@/lib/env";
import type { Supa } from "@/lib/supabase/client";

// One client (and one getClaims) per incoming request. Server functions called during SSR run inside the same
// request, so a token refresh happens once and every later query in that request uses the new session.
const clients = new WeakMap<Request, Supa>();
const users = new WeakMap<Request, Promise<SessionUser | null>>();

export type SessionUser = { id: string; email: string | null; isAnonymous: boolean };

/**
 * Supabase client bound to the request cookies (@supabase/ssr). Refreshed tokens are written back to the
 * response with Start's cookie helpers, together with the no-store headers @supabase/ssr asks for.
 */
export function getSupabase(): Supa {
  assertEnv();
  const request = getRequest();
  let client = clients.get(request);
  if (!client) {
    client = createServerClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      cookies: {
        getAll() {
          return Object.entries(getCookies()).map(([name, value]) => ({ name, value }));
        },
        setAll(cookiesToSet, headers) {
          for (const { name, value, options } of cookiesToSet) setCookie(name, value, options);
          for (const [key, value] of Object.entries(headers)) setResponseHeader(key, value);
        },
      },
    });
    clients.set(request, client);
  }
  return client;
}

/**
 * The signed-in user, verified with auth.getClaims() (which also refreshes an expired session), memoised per
 * request. Returns null when signed out.
 */
export function getUser(): Promise<SessionUser | null> {
  const request = getRequest();
  let user = users.get(request);
  if (!user) {
    user = getSupabase()
      .auth.getClaims()
      .then(({ data }) => {
        const claims = data?.claims;
        if (!claims?.sub) return null;
        return {
          id: claims.sub,
          email: (claims.email) ?? null,
          isAnonymous: Boolean(claims.is_anonymous),
        };
      });
    users.set(request, user);
  }
  return user;
}
