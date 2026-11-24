import { createFileRoute, redirect } from "@tanstack/react-router";
import { AuthForm } from "@/components/auth/auth-form";
import { title } from "@/lib/meta";
import { safeNext } from "@/lib/safe-next";

export const Route = createFileRoute("/_guest/signup")({
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({
    next: typeof search.next === "string" ? search.next : undefined,
  }),
  beforeLoad: ({ context, search }) => {
    if (context.user) throw redirect({ href: safeNext(search.next) });
  },
  head: () => ({ meta: [title("Create account")] }),
  component: SignupPage,
});

function SignupPage() {
  const next = safeNext(Route.useSearch().next);
  return (
    <div className="w-full">
      <div className="mb-8">
        <h1 className="text-[28px] leading-tight font-normal tracking-tight">Get started</h1>
        <p className="mt-1 text-sm text-muted">Create an account, then create a workspace or ask an admin to add you to theirs.</p>
      </div>
      <AuthForm mode="signup" next={next} />
    </div>
  );
}
