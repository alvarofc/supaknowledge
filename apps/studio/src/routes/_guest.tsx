import { Outlet, createFileRoute } from "@tanstack/react-router";
import { CheckCheck, Flag, GitPullRequestArrow } from "lucide-react";
import { Logo } from "@/components/shell/logo";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { Link } from "@/components/ui/link";

/** Layout for the sign-in and sign-up pages: form panel on the left, product story on the right (wide screens). */
export const Route = createFileRoute("/_guest")({
  component: GuestLayout,
});

const LOOP = [
  { icon: <Flag />, title: "Agents flag", body: "Working agents report knowledge that is missing, wrong, outdated or unclear." },
  { icon: <GitPullRequestArrow />, title: "The curator proposes", body: "Flags, traces and sources become reviewable changes, each with citations." },
  { icon: <CheckCheck />, title: "People review", body: "Approve like a pull request. Every change becomes a revision with full history." },
];

function GuestLayout() {
  return (
    <div className="flex min-h-dvh">
      <div className="flex w-full shrink-0 flex-col border-line bg-chrome lg:w-[480px] lg:border-r xl:w-[520px]">
        <header className="flex h-16 items-center justify-between px-6 sm:px-10">
          <Link href="/" aria-label="Supaknowledge Studio">
            <Logo />
          </Link>
          <ThemeToggle className="lg:hidden" />
        </header>
        <main className="flex flex-1 flex-col justify-center px-6 pt-6 pb-16 sm:px-10">
          <div className="mx-auto w-full max-w-[380px]">
            <Outlet />
          </div>
        </main>
        <footer className="px-6 pb-6 text-center text-xs text-subtle sm:px-10">
          Supaknowledge is open source (Apache-2.0) and runs on your own Supabase project.
        </footer>
      </div>

      <aside className="relative hidden flex-1 flex-col bg-surface lg:flex" aria-label="How Supaknowledge works">
        <div className="flex h-16 items-center justify-end px-10">
          <ThemeToggle />
        </div>
        <div className="flex flex-1 items-center justify-center px-12 pb-16">
          <div className="max-w-lg">
            <div className="mono-label text-subtle">The knowledge factory</div>
            <p className="mt-4 text-[28px] leading-snug tracking-tight text-fg">
              Your agents learn on the job. <span className="text-subtle">Your team decides what becomes company knowledge.</span>
            </p>
            <ol className="mt-10 flex flex-col">
              {LOOP.map((s, i) => (
                <li key={s.title} className="relative flex gap-4 pb-6 last:pb-0">
                  {i < LOOP.length - 1 ? <span className="absolute top-8 bottom-0 left-[15px] w-px bg-line" aria-hidden="true" /> : null}
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-accent [&_svg]:size-4">
                    {s.icon}
                  </span>
                  <span className="pt-1">
                    <span className="block text-sm text-fg">{s.title}</span>
                    <span className="mt-0.5 block text-sm text-muted">{s.body}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </aside>
    </div>
  );
}
