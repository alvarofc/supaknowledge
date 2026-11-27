import { createFileRoute, redirect } from "@tanstack/react-router";
import { AuthForm } from "@/components/auth/auth-form";
import { DemoSignIn } from "@/components/auth/demo-sign-in";
import { title } from "@/lib/meta";
import { safeNext } from "@/lib/safe-next";
import { loadDemoMode } from "@/server/demo.functions";

export const Route = createFileRoute("/_guest/login")({
  validateSearch: (search: Record<string, unknown>): { next?: string; error?: string } => ({
    next: typeof search.next === "string" ? search.next : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  beforeLoad: ({ context, search }) => {
    if (context.user) throw redirect({ href: safeNext(search.next) });
  },
  loader: () => loadDemoMode(),
  head: () => ({ meta: [title("Sign in")] }),
  component: LoginPage,
});

function LoginPage() {
  const search = Route.useSearch();
  const demo = Route.useLoaderData();
  const next = safeNext(search.next);
  const isConsent = next.startsWith("/oauth/consent");
  return (
    <div className="w-full">
      <div className="mb-8">
        <h1 className="text-[28px] leading-tight font-normal tracking-tight">Welcome back</h1>
        <p className="mt-1 text-sm text-muted">
          {isConsent
            ? "An application wants to connect to your knowledge. Sign in first, then you'll review what it can access."
            : "Sign in to your Supaknowledge account"}
        </p>
      </div>
      <AuthForm key={search.error ?? ""} mode="signin" next={next} initialError={search.error} />
      {demo.enabled ? <DemoSignIn next={next} /> : null}
    </div>
  );
}
