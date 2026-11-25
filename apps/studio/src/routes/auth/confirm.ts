import { createFileRoute } from "@tanstack/react-router";
import { redirectTo, safeNext } from "@/lib/safe-next";
import { getSupabase } from "@/server/supabase.server";

/**
 * Token-hash confirmation (for email templates that link to
 * {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/). Works across devices.
 */
export const Route = createFileRoute("/auth/confirm")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { searchParams } = new URL(request.url);
        const tokenHash = searchParams.get("token_hash");
        const type = searchParams.get("type");
        const next = safeNext(searchParams.get("next"));
        if (tokenHash && type) {
          const { error } = await getSupabase().auth.verifyOtp({ type, token_hash: tokenHash });
          if (!error) return redirectTo(request, next);
          return redirectTo(request, `/login?error=${encodeURIComponent(error.message)}`);
        }
        return redirectTo(request, `/login?error=${encodeURIComponent("That link is invalid or has expired.")}`);
      },
    },
  },
});
