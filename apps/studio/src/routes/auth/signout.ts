import { createFileRoute } from "@tanstack/react-router";
import { redirectTo } from "@/lib/safe-next";
import { getSupabase } from "@/server/supabase.server";

/** POST (a plain <form>): signs out, clears the session cookies and returns to /login. */
export const Route = createFileRoute("/auth/signout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        await getSupabase().auth.signOut();
        return redirectTo(request, "/login", 303);
      },
    },
  },
});
