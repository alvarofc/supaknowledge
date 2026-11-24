import { createFileRoute } from "@tanstack/react-router";
import { isSameOriginRequest, redirectTo, safeNext } from "@/lib/safe-next";
import { getSupabase } from "@/server/supabase.server";

/**
 * POST (a plain <form>): signs out, clears the session cookies and returns to /login. An optional `next` form field
 * (validated, same-origin only) is carried to the login page, e.g. so "Switch account" on the OAuth consent page
 * comes back to the same authorization request. Cross-site POSTs are refused (logout CSRF).
 */
export const Route = createFileRoute("/auth/signout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isSameOriginRequest(request)) return new Response("Cross-site sign-out refused", { status: 403 });
        let next: string | null = null;
        try {
          const form = await request.formData();
          const v = form.get("next");
          next = typeof v === "string" && v ? safeNext(v, "") || null : null;
        } catch {
          // no form body
        }
        await getSupabase().auth.signOut();
        return redirectTo(request, next ? `/login?next=${encodeURIComponent(next)}` : "/login", 303);
      },
    },
  },
});
