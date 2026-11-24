import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Everything below requires a signed-in user. Signed-out visitors go to /login with the URL they wanted (which
 * matters for /oauth/consent?authorization_id=...). This guard is UX: server functions re-check the session and
 * RLS decides what each query returns.
 */
export const Route = createFileRoute("/_authed")({
  beforeLoad: ({ context, location }) => {
    if (!context.user) throw redirect({ to: "/login", search: { next: location.href } });
    return { user: context.user };
  },
});
