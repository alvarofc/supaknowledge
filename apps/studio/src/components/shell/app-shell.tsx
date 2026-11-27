import {
  Activity,
  BookOpen,
  Bot,
  CalendarRange,
  Check,
  ChevronsUpDown,
  HeartPulse,
  Inbox,
  LogOut,
  Menu,
  MessageSquare,
  Network,
  Plug,
  Plus,
  Search,
  Settings,
  X,
} from "lucide-react";
import { Link } from "@/components/ui/link";
import { useLocation, useRouter } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import type { SpaceRole, WorkspaceRole } from "@/lib/roles";
import { atLeast, isWorkspaceAdmin, ROLE_HELP } from "@/lib/roles";
import { LogoMark } from "./logo";
import { ThemeToggle } from "./theme-toggle";

type NavWorkspace = { id: string; slug: string; name: string };
type NavSpace = { id: string; slug: string; name: string; workspace_id: string };

export interface ShellProps {
  base: string;
  user: { email: string | null; isAnonymous?: boolean };
  workspace: NavWorkspace;
  space: { id: string; slug: string; name: string };
  role: SpaceRole | null;
  workspaceRole: WorkspaceRole | null;
  workspaces: NavWorkspace[];
  spaces: NavSpace[];
  inboxCount?: number;
  children: ReactNode;
}

type SubItem = { href: string; label: string; active: boolean; count?: number };
type SubGroup = { label: string; items: SubItem[] };
type Section = {
  id: string;
  href: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  count?: number;
  /** product sidebar groups; sections without them get no sidebar (like the Supabase project home) */
  groups?: SubGroup[];
};

/**
 * Layout modelled on the Supabase dashboard: a top bar with the workspace / space breadcrumb, a thin icon rail with
 * the space's sections, and a product sidebar with the current section's sub-pages. Below `lg` the rail and
 * sidebar collapse into a drawer.
 */
export function AppShell(props: ShellProps) {
  const [open, setOpen] = useState(false);
  const pathname = useLocation({ select: (l) => l.pathname });
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    // close the mobile drawer on navigation
    setLastPath(pathname);
    setOpen(false);
  }

  useEffect(() => {
    // remember the last space for the "/" redirect
    document.cookie = `kf_last=${encodeURIComponent(props.base)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  }, [props.base]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const sections = useSections(props);
  const current = sections.find((s) => s.active);
  const visibleSections = sections.filter((s) => s.id !== "settings");
  const settings = sections.find((s) => s.id === "settings");

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[70] focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>

      <TopBar {...props} onOpenNav={() => setOpen(true)} />

      <div className="flex flex-1">
        {/* icon rail */}
        <nav
          aria-label="Sections"
          className="sticky top-12 z-20 hidden h-[calc(100dvh-3rem)] w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-chrome py-2 lg:flex"
        >
          {visibleSections.map((s) => (
            <RailItem key={s.id} section={s} />
          ))}
          {settings ? (
            <>
              <span className="my-1 h-px w-6 bg-line" aria-hidden="true" />
              <RailItem section={settings} />
            </>
          ) : null}
        </nav>

        {/* product sidebar */}
        {current?.groups ? (
          <aside className="sticky top-12 hidden h-[calc(100dvh-3rem)] w-[232px] shrink-0 flex-col border-r border-line bg-chrome lg:flex">
            <div className="flex h-12 shrink-0 items-center border-b border-line px-5">
              <h2 className="text-[15px] text-fg">{current.label}</h2>
            </div>
            <nav aria-label={current.label} className="flex-1 overflow-y-auto">
              <SubNav groups={current.groups} />
            </nav>
          </aside>
        ) : null}

        <main id="main" className="min-w-0 flex-1">
          <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-8">{props.children}</div>
        </main>
      </div>

      {/* mobile drawer */}
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-[var(--overlay)]" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-line bg-chrome shadow-xl">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
              <Link href="/" className="inline-flex items-center gap-2 text-sm text-fg">
                <LogoMark className="size-5" /> Supaknowledge <span className="text-subtle">Studio</span>
              </Link>
              <button
                type="button"
                autoFocus
                className="rounded p-1 text-subtle hover:bg-surface-2 hover:text-fg"
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
              >
                <X className="size-4" />
              </button>
            </div>
            <nav aria-label="Sections" className="flex-1 overflow-y-auto p-2">
              <ul className="flex flex-col gap-0.5">
                {sections.map((s) => (
                  <li key={s.id}>
                    <Link
                      href={s.href}
                      aria-current={s.active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm [&_svg]:size-4",
                        s.active ? "bg-surface-3/70 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
                      )}
                    >
                      <span className={s.active ? "text-fg" : "text-subtle"}>{s.icon}</span>
                      <span className="flex-1">{s.label}</span>
                      {s.count ? <CountPill n={s.count} /> : null}
                    </Link>
                    {s.active && s.groups ? (
                      <div className="mt-1 mb-2 ml-4 border-l border-line pl-2">
                        <SubNav groups={s.groups} compact />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </nav>
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function useSections({ base, role, inboxCount }: ShellProps): Section[] {
  const pathname = useLocation({ select: (l) => l.pathname });
  const search = useLocation({ select: (l) => l.search as Record<string, unknown> });
  const tab = typeof search.tab === "string" ? search.tab : undefined;
  const under = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const isEditor = atLeast(role, "editor");
  const isReviewer = atLeast(role, "reviewer");
  const isAdmin = atLeast(role, "admin");

  // Inbox: mirrors the tabs of the inbox page
  const inboxActive = pathname === base || under(`${base}/proposals`);
  const inboxTab = under(`${base}/proposals`)
    ? "proposals"
    : isEditor
      ? tab && ["proposals", "flags", "history"].includes(tab)
        ? tab
        : "proposals"
      : "flags";
  const inboxGroups: SubGroup[] = isEditor
    ? [
        {
          label: "Review",
          items: [
            { href: `${base}?tab=proposals`, label: "Proposals", active: inboxActive && inboxTab === "proposals", count: inboxCount },
            { href: `${base}?tab=flags`, label: "Open flags", active: inboxActive && inboxTab === "flags" },
          ],
        },
        { label: "Decisions", items: [{ href: `${base}?tab=history`, label: "History", active: inboxActive && inboxTab === "history" }] },
      ]
    : [{ label: "Review", items: [{ href: `${base}?tab=flags`, label: "Your open flags", active: inboxActive }] }];

  // Knowledge: filter by kind, plus "new concept"
  const kb = `${base}/knowledge`;
  const knowledgeActive = under(kb) || under(`${base}/suggest`);
  const kind = pathname === kb && typeof search.kind === "string" ? search.kind : undefined;
  const onSuggest = under(`${base}/suggest`);
  const knowledgeGroups: SubGroup[] = [
    {
      label: "Browse",
      items: [
        { href: kb, label: "All knowledge", active: under(kb) && !kind },
        { href: `${kb}?kind=skill`, label: "Skills", active: kind === "skill" },
        { href: `${kb}?kind=domain`, label: "Domain", active: kind === "domain" },
        { href: `${kb}?kind=data_access`, label: "Data access", active: kind === "data_access" },
      ],
    },
    ...(isEditor ? [{ label: "Contribute", items: [{ href: `${base}/suggest`, label: "New concept", active: onSuggest }] }] : []),
  ];

  // Activity: runs / traces / audit log, as on the page
  const act = `${base}/activity`;
  const actTab = under(`${act}/traces`) ? "traces" : tab && ["runs", "traces", "audit"].includes(tab) ? tab : "runs";
  const activityActive = under(act);
  const activityGroups: SubGroup[] = [
    { label: "Curator", items: [{ href: `${act}?tab=runs`, label: "Curator runs", active: activityActive && actTab === "runs" }] },
    ...(isReviewer ? [{ label: "Agents", items: [{ href: `${act}?tab=traces`, label: "Traces", active: activityActive && actTab === "traces" }] }] : []),
    ...(isAdmin ? [{ label: "Security", items: [{ href: `${act}?tab=audit`, label: "Audit log", active: activityActive && actTab === "audit" }] }] : []),
  ];

  // Settings sub-pages
  const st = `${base}/settings`;
  const settingsActive = under(st);
  const stTab = tab ?? "general";
  const stHref = (t: string) => (t === "general" ? st : `${st}?tab=${t}`);
  const settingsGroups: SubGroup[] = [
    {
      label: "Space",
      items: [
        { href: stHref("general"), label: "General", active: settingsActive && stTab === "general" },
        { href: stHref("curator"), label: "Curator & policy", active: settingsActive && stTab === "curator" },
        { href: stHref("access"), label: "Access", active: settingsActive && stTab === "access" },
      ],
    },
    {
      label: "People",
      items: [
        { href: stHref("members"), label: "Members", active: settingsActive && stTab === "members" },
        { href: stHref("groups"), label: "Groups", active: settingsActive && stTab === "groups" },
      ],
    },
  ];

  const all: (Section & { show: boolean })[] = [
    { id: "inbox", href: base, label: "Inbox", icon: <Inbox />, show: true, active: inboxActive, count: inboxCount, groups: inboxGroups },
    { id: "knowledge", href: kb, label: "Knowledge", icon: <BookOpen />, show: true, active: knowledgeActive, groups: knowledgeGroups },
    { id: "graph", href: `${base}/graph`, label: "Graph", icon: <Network />, show: true, active: under(`${base}/graph`) },
    { id: "ask", href: `${base}/ask`, label: "Ask", icon: <MessageSquare />, show: true, active: under(`${base}/ask`) },
    { id: "sources", href: `${base}/sources`, label: "Sources", icon: <Plug />, show: isEditor, active: under(`${base}/sources`) },
    { id: "agents", href: `${base}/agents`, label: "Agents", icon: <Bot />, show: true, active: under(`${base}/agents`) },
    { id: "activity", href: act, label: "Activity", icon: <Activity />, show: isEditor, active: activityActive, groups: activityGroups },
    { id: "health", href: `${base}/health`, label: "Health", icon: <HeartPulse />, show: true, active: under(`${base}/health`) },
    { id: "recap", href: `${base}/recap`, label: "Recap", icon: <CalendarRange />, show: true, active: under(`${base}/recap`) },
    { id: "settings", href: st, label: "Settings", icon: <Settings />, show: true, active: settingsActive, groups: settingsGroups },
  ];
  return all.filter((s) => s.show);
}

function CountPill({ n }: { n: number }) {
  return (
    <span className="rounded-full bg-brand px-1.5 font-mono text-[10.5px] leading-4 font-medium tabular-nums text-on-brand">{n}</span>
  );
}

function RailItem({ section: s }: { section: Section }) {
  return (
    <Link
      href={s.href}
      aria-label={s.count ? `${s.label} (${s.count} pending)` : s.label}
      aria-current={s.active ? "page" : undefined}
      className={cn(
        "group relative flex size-9 items-center justify-center rounded-md transition-colors [&_svg]:size-[18px]",
        s.active ? "bg-surface-3/70 text-fg" : "text-subtle hover:bg-surface-2 hover:text-fg",
      )}
    >
      {s.icon}
      {s.count ? (
        <span
          aria-hidden="true"
          className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-brand px-1 font-mono text-[9px] font-semibold text-on-brand ring-2 ring-chrome"
        >
          {s.count > 99 ? "99+" : s.count}
        </span>
      ) : null}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-full z-50 ml-2 -translate-y-1/2 rounded-md border border-line-strong bg-surface px-2 py-1 text-xs whitespace-nowrap text-fg opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        {s.label}
      </span>
    </Link>
  );
}

/**
 * A heading over a single link only repeats it ("Decisions" over "History"), so single-link groups show no heading,
 * and neighbouring ones share a block.
 */
function visibleGroups(groups: SubGroup[]): (SubGroup & { showLabel: boolean })[] {
  const out: (SubGroup & { showLabel: boolean })[] = [];
  for (const g of groups) {
    const prev = out.at(-1);
    if (g.items.length > 1) out.push({ ...g, showLabel: true });
    else if (prev && !prev.showLabel) prev.items = [...prev.items, ...g.items];
    else out.push({ ...g, items: [...g.items], showLabel: false });
  }
  return out;
}

function SubNav({ groups, compact }: { groups: SubGroup[]; compact?: boolean }) {
  return (
    <div className={cn(!compact && "divide-y divide-line")}>
      {visibleGroups(groups).map((g) => (
        <div key={g.label} className={compact ? "py-1" : "px-3 py-3"}>
          {g.showLabel ? <div className={cn("mono-label px-2 text-subtle", compact ? "mb-0.5" : "mb-1.5")}>{g.label}</div> : null}
          <ul className="flex flex-col gap-px">
            {g.items.map((i) => (
              <li key={i.href}>
                <Link
                  href={i.href}
                  aria-current={i.active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors",
                    i.active ? "bg-surface-3/70 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
                  )}
                >
                  <span className="flex-1 truncate">{i.label}</span>
                  {i.count ? <CountPill n={i.count} /> : null}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Open/close state for a click-to-open popover, closed by an outside click or Escape. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

const popoverPanel = "absolute top-full z-50 mt-1.5 rounded-md border border-line-strong bg-surface p-1 shadow-lg";
const menuItem = "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-2";

function TopBar({ onOpenNav, ...props }: ShellProps & { onOpenNav: () => void }) {
  const { workspace, role, workspaceRole, base, user } = props;
  return (
    <header className="sticky top-0 z-40 flex h-12 shrink-0 items-center border-b border-line bg-chrome">
      <button
        type="button"
        onClick={onOpenNav}
        className="flex size-12 shrink-0 items-center justify-center text-muted hover:text-fg lg:hidden"
        aria-label="Open navigation"
      >
        <Menu className="size-5" />
      </button>
      <Link href="/" className="hidden size-12 shrink-0 items-center justify-center lg:flex" aria-label="Supaknowledge Studio home">
        <LogoMark className="size-[22px]" />
      </Link>

      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
        <Slash className="hidden lg:block" />
        <span className="hidden min-w-0 items-center gap-2 sm:flex">
          <Link href={`/w/${workspace.slug}`} className="truncate text-fg hover:text-fg/80">
            {workspace.name}
          </Link>
          {workspaceRole ? <Badge className="hidden md:inline-flex">{workspaceRole}</Badge> : null}
        </span>
        <Slash className="hidden sm:block" />
        <SpaceSwitcher {...props} />
        <Badge tone={role ? "accent" : "neutral"} title={role ? `Your role here: ${ROLE_HELP[role]}` : "You have no role in this space"}>
          {role ?? "no access"}
        </Badge>
      </div>

      <div className="flex shrink-0 items-center gap-2 pr-3 pl-2">
        <SearchBox base={base} />
        <UserMenu email={user.email} demo={user.isAnonymous === true} />
      </div>
    </header>
  );
}

function Slash({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("px-0.5 text-line-strong select-none", className)}>
      /
    </span>
  );
}

/** Knowledge search from anywhere in the space; ⌘K / Ctrl+K focuses it. Works as a plain GET form without JS. */
function SearchBox({ base }: { base: string }) {
  const router = useRouter();
  const ref = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ref.current?.focus();
        ref.current?.select();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <form
      action={`${base}/knowledge`}
      method="get"
      role="search"
      className="relative hidden md:block"
      onSubmit={(e) => {
        const q = ref.current?.value.trim() ?? "";
        e.preventDefault();
        void router.navigate({ href: `${base}/knowledge${q ? `?q=${encodeURIComponent(q)}` : ""}` });
        ref.current?.blur();
      }}
    >
      <label htmlFor={id} className="sr-only">
        Search knowledge
      </label>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle" aria-hidden="true" />
      <input
        ref={ref}
        id={id}
        name="q"
        placeholder="Search knowledge…"
        autoComplete="off"
        className="h-[30px] w-52 rounded-md border border-line-strong bg-control pr-10 pl-8 text-xs text-fg placeholder:text-subtle focus:border-accent focus:ring-2 focus:ring-ring focus:outline-none focus-visible:outline-none xl:w-60"
      />
      <Kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">⌘K</Kbd>
    </form>
  );
}

function UserMenu({ email, demo }: { email: string | null; demo: boolean }) {
  const { open, setOpen, ref } = usePopover();
  const panelId = useId();
  const initial = demo ? "D" : (email ?? "?").slice(0, 1).toUpperCase();
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Account and theme"
        className="flex size-7 items-center justify-center rounded-full border border-line-strong bg-surface-3 text-xs font-medium text-fg hover:border-subtle"
      >
        {initial}
      </button>
      {open ? (
        <div id={panelId} className={cn(popoverPanel, "right-0 w-64")}>
          <div className="px-2 pt-1.5 pb-2">
            <div className="text-xs text-subtle">Signed in as</div>
            <div className="truncate text-sm text-fg" title={email ?? undefined}>
              {demo ? "Demo visitor" : email}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-line px-2 py-2">
            <span className="text-sm text-muted">Theme</span>
            <ThemeToggle />
          </div>
          <div className="border-t border-line pt-1">
            <form action="/auth/signout" method="post">
              <button type="submit" className={cn(menuItem, "text-muted hover:text-fg")}>
                <LogOut className="size-3.5 text-subtle" /> Sign out
              </button>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SpaceSwitcher({ workspace, space, workspaces, spaces, workspaceRole }: ShellProps) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Space: ${space.name}. Switch space`}
        className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-fg hover:bg-surface-2"
      >
        <span className="truncate">{space.name}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-subtle" />
      </button>
      {open ? (
        <div role="menu" className={cn(popoverPanel, "left-0 max-h-[70vh] w-64 overflow-y-auto")}>
          {workspaces.map((ws) => {
            const wsSpaces = spaces.filter((s) => s.workspace_id === ws.id);
            return (
              <div key={ws.id} className="py-1">
                <div className="mono-label truncate px-2 pt-0.5 pb-1 text-subtle">{ws.name}</div>
                {wsSpaces.length === 0 ? <div className="px-2 py-1 text-xs text-subtle">No spaces you can read</div> : null}
                {wsSpaces.map((s) => {
                  const current = s.id === space.id;
                  return (
                    <Link
                      key={s.id}
                      role="menuitem"
                      href={`/w/${ws.slug}/${s.slug}`}
                      onClick={() => setOpen(false)}
                      className={cn(menuItem, current ? "text-fg" : "text-muted hover:text-fg")}
                    >
                      <span className="flex-1 truncate">{s.name}</span>
                      {current ? <Check className="size-3.5 text-accent" aria-label="Current space" /> : null}
                    </Link>
                  );
                })}
                {ws.id === workspace.id && isWorkspaceAdmin(workspaceRole) ? (
                  <Link
                    role="menuitem"
                    href={`/onboarding?workspace=${ws.slug}`}
                    onClick={() => setOpen(false)}
                    className={cn(menuItem, "text-muted hover:text-fg")}
                  >
                    <Plus className="size-3.5" /> New space
                  </Link>
                ) : null}
              </div>
            );
          })}
          <div className="mt-1 border-t border-line pt-1">
            <Link role="menuitem" href="/onboarding?new=workspace" onClick={() => setOpen(false)} className={cn(menuItem, "text-muted hover:text-fg")}>
              <Plus className="size-3.5" /> New workspace
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
