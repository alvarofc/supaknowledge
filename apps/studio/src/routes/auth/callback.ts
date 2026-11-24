import { createFileRoute } from "@tanstack/react-router";
import { redirectTo, safeNext } from "@/lib/safe-next";
import { getSupabase } from "@/server/supabase.server";

/** PKCE callback for email links (magic link, signup confirmation): exchange ?code= for a session cookie. */
export const Route = createFileRoute("/auth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { searchParams } = new URL(request.url);
        const code = searchParams.get("code");
        const next = safeNext(searchParams.get("next"));
        const authError = searchParams.get("error_description") ?? searchParams.get("error");
        if (code) {
          const { error } = await getSupabase().auth.exchangeCodeForSession(code);
          if (!error) return redirectTo(request, next);
          return redirectTo(request, `/login?next=${encodeURIComponent(next)}&error=${encodeURIComponent(error.message)}`);
        }
        return redirectTo(
          request,
          `/login?next=${encodeURIComponent(next)}&error=${encodeURIComponent(authError ?? "That sign-in link is invalid or has expired.")}`,
        );
      },
    },
  },
});
