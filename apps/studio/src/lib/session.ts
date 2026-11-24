import { createIsomorphicFn } from "@tanstack/react-start";
import { createClient } from "@/lib/supabase/client";
import { getUser } from "@/server/supabase.server";

export type CurrentUser = { id: string; email: string | null } | null;

/**
 * Who is signed in, for route guards. On the server it verifies the cookie session (getClaims, refreshing it if
 * needed); in the browser it reads the session the browser client keeps in the same cookies, without a network
 * round trip. Guards are UX only: every query still runs as the user and RLS decides what they get.
 */
export const getCurrentUser = createIsomorphicFn()
  .server(async (): Promise<CurrentUser> => {
    const user = await getUser();
    return user ? { id: user.id, email: user.email } : null;
  })
  .client(async (): Promise<CurrentUser> => {
    const { data } = await createClient().auth.getSession();
    const user = data.session?.user;
    return user ? { id: user.id, email: user.email ?? null } : null;
  });
