import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, KeyRound, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { ConsentActions } from "@/components/oauth/consent-actions";
import { Logo } from "@/components/shell/logo";
import { LinkButton } from "@/components/ui/button";
import { Callout, Card, EmptyState } from "@/components/ui/card";
import { title } from "@/lib/meta";
import { loadConsent } from "@/server/consent.functions";
import { safeHref } from "@/lib/safe-href";

export const Route = createFileRoute("/_authed/oauth/consent")({
  validateSearch: (search: Record<string, unknown>): { authorization_id?: string } => ({
    authorization_id:
      typeof search.authorization_id === "string" || typeof search.authorization_id === "number" ? String(search.authorization_id) : undefined,
  }),
  loaderDeps: ({ search }) => ({ authorizationId: search.authorization_id }),
  loader: ({ deps }) => loadConsent({ data: { authorizationId: deps.authorizationId } }),
  // never preload: loading the page answers nothing, but an already-consented request redirects straight away
  preload: false,
  head: () => ({ meta: [title("Authorize application")] }),
  component: ConsentPage,
});

const SCOPE_HELP: Record<string, string> = {
  openid: "Confirm who you are",
  email: "See your email address",
  profile: "See your basic profile (name)",
  phone: "See your phone number",
};

function describeRedirect(uri: string) {
  try {
    const u = new URL(uri);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    return { host: u.host, scheme: u.protocol.replace(":", ""), insecure: u.protocol === "http:" && !loopback, loopback };
  } catch {
    return { host: uri, scheme: "", insecure: false, loopback: false };
  }
}

/**
 * Consent screen for Supabase Auth's OAuth 2.1 server (auth.oauth_server.authorization_url_path).
 * MCP clients (Claude, Cursor, ...) send the user here; after approval they get tokens for THIS user, so
 * the agent sees exactly what the user can see (RLS) and nothing more.
 */
function ConsentPage() {
  const data = Route.useLoaderData();
  const user = data.me;

  if (data.kind === "missing") {
    return (
      <Shell>
        <EmptyState framed icon={<KeyRound />} title="No authorization request" actions={<LinkButton href="/">Go to Studio</LinkButton>}>
          This page is opened by an application (like Claude Code or Cursor) that asks to connect to Supaknowledge as you. Start the
          connection from that application.
        </EmptyState>
      </Shell>
    );
  }

  if (data.kind === "error") {
    return (
      <Shell>
        <EmptyState
          framed
          icon={<AlertTriangle />}
          title="This authorization request can't be used"
          actions={<LinkButton href="/">Go to Studio</LinkButton>}
        >
          {data.message} It may have expired or already been answered. Go back to the application
          and connect again.
        </EmptyState>
      </Shell>
    );
  }

  const { details, spaceCount, workspaceNames } = data;
  const redirectInfo = describeRedirect(details.redirectUri);
  const scopes = details.scope.split(/\s+/).filter(Boolean);
  const clientName = details.client.name || "An application";
  const mismatch = details.requestEmail && user.email && details.requestEmail !== user.email;

  return (
    <Shell>
      <div className="mb-5 flex flex-col items-center text-center">
        <div className="mb-3 flex items-center gap-3">
          <ClientAvatar name={clientName} logo={details.client.logoUri} />
          <span className="text-subtle" aria-hidden="true">
            ⟶
          </span>
          <span className="flex size-10 items-center justify-center rounded-md border border-line bg-surface">
            <Logo withText={false} className="[&_svg]:size-6" />
          </span>
        </div>
        <h1 className="text-xl font-normal tracking-tight">
          <span className="font-medium">{clientName}</span> wants to access Supaknowledge as you
        </h1>
        {safeHref(details.client.uri) ? (
          <a href={safeHref(details.client.uri)!} target="_blank" rel="noopener noreferrer" className="mt-1 text-xs text-subtle hover:underline">
            {details.client.uri}
          </a>
        ) : details.client.uri ? (
          <span className="mt-1 text-xs break-all text-subtle">{details.client.uri}</span>
        ) : null}
      </div>

      <Card className="divide-y divide-line">
        <div className="px-4 py-3">
          <div className="mono-label text-subtle">Signed in as</div>
          <div className="mt-0.5 flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-medium">{details.requestEmail || user.email}</span>
            <form action="/auth/signout" method="post">
              <input
                type="hidden"
                name="next"
                value={`/oauth/consent?authorization_id=${encodeURIComponent(details.authorizationId)}`}
              />
              <button type="submit" className="text-xs text-accent hover:underline">
                Not you? Switch account
              </button>
            </form>
          </div>
        </div>

        <div className="px-4 py-3">
          <div className="flex items-start gap-2.5">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" />
            <div className="text-sm">
              <p className="font-medium">It will act with your permissions</p>
              <p className="mt-0.5 text-muted">
                It can search and read the knowledge you can read, and flag problems, in{" "}
                {spaceCount === 1 ? "the 1 space" : `the ${spaceCount} spaces`} you have access to
                {workspaceNames.length ? ` (${workspaceNames.join(", ")})` : ""}. Restricted knowledge stays
                restricted: it sees only what you see, and every action is recorded under your account.
              </p>
            </div>
          </div>
        </div>

        {scopes.length ? (
          <div className="px-4 py-3">
            <div className="mono-label mb-1.5 text-subtle">Requested permissions</div>
            <ul className="flex flex-col gap-1 text-sm">
              {scopes.map((s) => (
                <li key={s} className="flex items-center justify-between gap-3">
                  <span>{SCOPE_HELP[s] ?? s}</span>
                  <code className="rounded border border-line bg-surface-2 px-1.5 py-px font-mono text-[11px] text-subtle">{s}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="px-4 py-3">
          <div className="mono-label text-subtle">After you decide, you&apos;ll be sent to</div>
          <div className="mt-0.5 font-mono text-xs break-all">{details.redirectUri}</div>
          {redirectInfo.loopback ? (
            <p className="mt-1 text-xs text-subtle">A local address: the application runs on this computer.</p>
          ) : null}
        </div>
      </Card>

      {redirectInfo.insecure ? (
        <Callout tone="warn" icon={<AlertTriangle />} className="mt-4" title="Unencrypted redirect">
          This application receives its access over plain HTTP ({redirectInfo.host}). Only continue if you trust the network.
        </Callout>
      ) : null}
      {mismatch ? (
        <Callout tone="warn" icon={<AlertTriangle />} className="mt-4" title="Different account">
          This request belongs to {details.requestEmail}, but you are signed in as {user.email}.
        </Callout>
      ) : null}

      <ConsentActions authorizationId={details.authorizationId} clientName={clientName} />

      <p className="mt-4 text-center text-xs text-subtle">
        Only approve applications you started connecting yourself. You can disconnect it later from Agents → Connected
        applications in Studio.
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-12 items-center border-b border-line bg-chrome px-4">
        <Logo />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-[6vh] pb-16">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}

function ClientAvatar({ name, logo }: { name: string; logo: string | null }) {
  if (logo && /^https:\/\//.test(logo)) {
    // arbitrary client logo host over https
    return <img src={logo} alt="" className="size-10 rounded-md border border-line bg-surface object-contain" />;
  }
  return (
    <span className="flex size-10 items-center justify-center rounded-md border border-line bg-surface-2 text-base font-medium text-muted uppercase">
      {name.slice(0, 1)}
    </span>
  );
}
