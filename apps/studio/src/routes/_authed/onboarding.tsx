import { createFileRoute } from "@tanstack/react-router";
import { OnboardingWizard } from "@/components/onboarding/wizard";
import { Logo } from "@/components/shell/logo";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { Link } from "@/components/ui/link";
import { title } from "@/lib/meta";
import { loadOnboarding } from "@/server/onboarding.functions";

type Search = { workspace?: string; space?: string; step?: string; new?: string };
const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);

export const Route = createFileRoute("/_authed/onboarding")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    workspace: str(search.workspace),
    space: str(search.space),
    step: str(search.step),
    new: str(search.new),
  }),
  loaderDeps: ({ search }) => ({ workspace: search.workspace, space: search.space, step: search.step, new: search.new }),
  loader: ({ deps }) => loadOnboarding({ data: { workspace: deps.workspace, space: deps.space, step: deps.step } }),
  head: () => ({ meta: [title("Get started")] }),
  component: OnboardingPage,
});

function OnboardingPage() {
  const { initial, userId, hasAny } = Route.useLoaderData();
  const deps = Route.useLoaderDeps();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-12 items-center justify-between border-b border-line bg-chrome px-4">
        <Link href="/">
          <Logo />
        </Link>
        <div className="flex items-center gap-3">
          {hasAny ? (
            <Link href="/" className="text-sm text-muted hover:text-fg">
              Back to Studio
            </Link>
          ) : null}
          <ThemeToggle />
        </div>
      </header>
      <main className="flex flex-1 justify-center px-4 pt-[6vh] pb-16">
        {/* a new ?workspace= / ?new= starts the wizard over, like a fresh page in the Next app */}
        <OnboardingWizard key={JSON.stringify(deps)} initial={initial} userId={userId} firstTime={!hasAny} />
      </main>
    </div>
  );
}
