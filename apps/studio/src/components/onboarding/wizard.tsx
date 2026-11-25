import { ArrowRight, Bot, BookOpen, Check, Flag, GitPullRequestArrow, Lock, Users } from "lucide-react";
import { Link } from "@/components/ui/link";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ConnectSnippets } from "@/components/agents/connect-snippets";
import { Button, LinkButton } from "@/components/ui/button";
import { Callout, Card } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { CopyButton } from "@/components/ui/copy-button";
import { Field, Input, Textarea } from "@/components/ui/form";
import { errorMessage, slugify } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";

type Ws = { id: string; slug: string; name: string };
type Step = "workspace" | "space" | "connect";

const SLUG_RE_WS = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SLUG_RE_SPACE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function OnboardingWizard({
  initial,
  email,
  firstTime,
}: {
  initial: { step: Step; workspace?: Ws; space?: { slug: string; name: string } };
  email: string | null;
  firstTime: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(initial.step);
  const [workspace, setWorkspace] = useState<Ws | undefined>(initial.workspace);
  const [space, setSpace] = useState(initial.space);

  const steps: { id: Step; label: string }[] = [
    { id: "workspace", label: "Workspace" },
    { id: "space", label: "Space" },
    { id: "connect", label: "Connect an agent" },
  ];
  const idx = steps.findIndex((s) => s.id === step);

  return (
    <div className="w-full max-w-xl">
      <ol className="mb-8 flex items-center gap-2" aria-label="Setup progress">
        {steps.map((s, i) => (
          <li key={s.id} className="flex flex-1 items-center gap-2" aria-current={i === idx ? "step" : undefined}>
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-xs",
                i < idx ? "bg-brand text-on-brand" : i === idx ? "border border-accent bg-accent-soft text-accent" : "border border-line-strong text-subtle",
              )}
            >
              {i < idx ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className={cn("hidden text-sm sm:inline", i === idx ? "font-medium text-fg" : "text-subtle")}>{s.label}</span>
            {i < steps.length - 1 ? <span className="h-px flex-1 bg-line" aria-hidden="true" /> : null}
          </li>
        ))}
      </ol>

      {step === "workspace" ? (
        <WorkspaceStep
          firstTime={firstTime}
          email={email}
          onDone={(ws) => {
            setWorkspace(ws);
            setStep("space");
          }}
        />
      ) : null}
      {step === "space" && workspace ? (
        <SpaceStep
          workspace={workspace}
          onDone={(sp) => {
            setSpace(sp);
            setStep("connect");
            void router.invalidate();
          }}
        />
      ) : null}
      {step === "connect" && workspace && space ? <ConnectStep workspace={workspace} space={space} /> : null}
    </div>
  );
}

function WorkspaceStep({ onDone, firstTime, email }: { onDone: (ws: Ws) => void; firstTime: boolean; email: string | null }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const effectiveSlug = slugTouched ? slug : slugify(name);
  const slugInvalid = effectiveSlug.length > 0 && !SLUG_RE_WS.test(effectiveSlug);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const { data, error } = await createClient().rpc("create_workspace", { p_slug: effectiveSlug, p_name: name.trim() });
    setPending(false);
    if (error || !data) {
      setError(error?.code === "23505" ? `The address "${effectiveSlug}" is taken. Pick another.` : errorMessage(error));
      return;
    }
    onDone({ id: data.id, slug: data.slug, name: data.name });
  }

  return (
    <>
      <h1 className="text-2xl font-normal tracking-tight">{firstTime ? "Welcome to Supaknowledge" : "Create a workspace"}</h1>
      <p className="mt-2 text-sm text-muted">
        A <strong className="font-medium text-fg">workspace</strong> is your organization: its people, access groups and agents. Inside it you
        create <strong className="font-medium text-fg">spaces</strong>, one knowledge factory per team or agent.
      </p>
      <Card className="mt-6 p-5">
        <form onSubmit={submit} className="flex flex-col gap-4">
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Field label="Workspace name" htmlFor="ws-name">
            <Input id="ws-name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." />
          </Field>
          <Field
            label="URL"
            htmlFor="ws-slug"
            error={slugInvalid ? "2–63 characters: lowercase letters, numbers and dashes, starting with a letter or number." : null}
            hint="Used in links and in the MCP address agents connect to."
          >
            <div className="flex items-center overflow-hidden rounded-md border border-line-strong bg-surface-2 pl-3 font-mono text-xs text-subtle focus-within:border-accent focus-within:ring-2 focus-within:ring-ring">
              <span className="shrink-0 pr-2">/w/</span>
              <Input
                id="ws-slug"
                required
                className="rounded-none border-0 border-l border-line-strong font-sans shadow-none focus:ring-0"
                value={effectiveSlug}
                aria-invalid={slugInvalid || undefined}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value.toLowerCase());
                }}
                placeholder="acme"
              />
            </div>
          </Field>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" pending={pending} disabled={!name.trim() || !effectiveSlug || slugInvalid}>
              Create workspace <ArrowRight className="size-4" />
            </Button>
          </div>
        </form>
      </Card>
      {firstTime ? (
        <Card className="mt-4 flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="text-sm">
            <div className="flex items-center gap-1.5 font-medium">
              <Users className="size-4 text-subtle" /> Joining your team instead?
            </div>
            <p className="mt-0.5 text-xs text-subtle">
              Ask a workspace admin to invite your e-mail address (Settings → Members). Once they have, reload: the invitation shows up at the top of
              this page, ready to accept.
            </p>
            {email ? <code className="mt-1 block font-mono text-xs break-all text-muted">{email}</code> : null}
          </div>
          {email ? <CopyButton value={email} label="Copy e-mail" /> : null}
        </Card>
      ) : null}
    </>
  );
}

function SpaceStep({ workspace, onDone }: { workspace: Ws; onDone: (sp: { slug: string; name: string }) => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"workspace" | "private">("workspace");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const effectiveSlug = slugTouched ? slug : slugify(name);
  const slugInvalid = effectiveSlug.length > 0 && !SLUG_RE_SPACE.test(effectiveSlug);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const { data, error } = await createClient().rpc("create_space", {
      p_workspace: workspace.id,
      p_slug: effectiveSlug,
      p_name: name.trim(),
      p_description: description.trim() || undefined,
      p_visibility: visibility,
    });
    setPending(false);
    if (error || !data) {
      setError(error?.code === "23505" ? `A space called "${effectiveSlug}" already exists in ${workspace.name}.` : errorMessage(error));
      return;
    }
    onDone({ slug: data.slug, name: data.name });
  }

  return (
    <>
      <h1 className="text-2xl font-normal tracking-tight">Create your first space</h1>
      <p className="mt-2 text-sm text-muted">
        A space is one knowledge factory: the skills, domain knowledge and data-access notes an agent (or a team of agents) works
        with. Agents read and flag it; the curator keeps it current; you review the changes.
      </p>
      <Card className="mt-6 p-5">
        <form onSubmit={submit} className="flex flex-col gap-4">
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Field label="Space name" htmlFor="sp-name">
            <Input id="sp-name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Revenue reporting" />
          </Field>
          <Field
            label="URL"
            htmlFor="sp-slug"
            error={slugInvalid ? "Lowercase letters, numbers and dashes, starting with a letter or number." : null}
          >
            <div className="flex items-center overflow-hidden rounded-md border border-line-strong bg-surface-2 pl-3 font-mono text-xs text-subtle focus-within:border-accent focus-within:ring-2 focus-within:ring-ring">
              <span className="shrink-0 pr-2">/w/{workspace.slug}/</span>
              <Input
                id="sp-slug"
                required
                className="rounded-none border-0 border-l border-line-strong font-sans shadow-none focus:ring-0"
                value={effectiveSlug}
                aria-invalid={slugInvalid || undefined}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value.toLowerCase());
                }}
                placeholder="revenue"
              />
            </div>
          </Field>
          <Field label="What is it for?" htmlFor="sp-desc" optional>
            <Textarea
              id="sp-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Metrics definitions and warehouse access for the weekly revenue report agent."
            />
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-medium">Who can read it?</legend>
            {(
              [
                { v: "workspace", icon: <Users className="size-4" />, title: "Everyone in the workspace", help: "Every workspace member is a reader. Good default." },
                { v: "private", icon: <Lock className="size-4" />, title: "Only people and groups you add", help: "For sensitive knowledge (finance, HR, security)." },
              ] as const
            ).map((o) => (
              <label
                key={o.v}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 text-sm",
                  visibility === o.v ? "border-accent bg-accent-soft/40" : "border-line hover:bg-surface-2",
                )}
              >
                <input type="radio" name="visibility" className="mt-1 accent-[var(--brand-strong)]" checked={visibility === o.v} onChange={() => setVisibility(o.v)} />
                <span className="mt-0.5 text-subtle">{o.icon}</span>
                <span>
                  <span className="font-medium">{o.title}</span>
                  <span className="block text-xs text-subtle">{o.help}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" pending={pending} disabled={!name.trim() || !effectiveSlug || slugInvalid}>
              Create space <ArrowRight className="size-4" />
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}

function ConnectStep({ workspace, space }: { workspace: Ws; space: { slug: string; name: string } }) {
  const base = `/w/${workspace.slug}/${space.slug}`;
  return (
    <>
      <h1 className="text-2xl font-normal tracking-tight">Connect your first agent</h1>
      <p className="mt-2 text-sm text-muted">
        <span className="font-medium text-fg">{space.name}</span> is ready. Agents reach it over MCP: they search and read knowledge, and
        flag what&apos;s missing or wrong. The quickest start is to connect your own coding assistant as yourself.
      </p>

      <Card className="mt-6 p-5">
        <h2 className="text-sm font-medium">Connect as yourself</h2>
        <p className="mt-1 mb-4 text-xs text-subtle">
          The client signs you in through Supaknowledge&apos;s OAuth consent screen and then acts with exactly your permissions.
        </p>
        <ConnectSnippets wsSlug={workspace.slug} spaceSlug={space.slug} />
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4 text-sm">
          <span className="text-muted">Running a headless agent in CI or production?</span>
          <LinkButton href={`${base}/agents`} size="sm">
            <Bot className="size-3.5" /> Create an agent key
          </LinkButton>
        </div>
      </Card>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        {[
          { icon: <Flag className="size-4" />, title: "Agents flag", body: "Working agents report knowledge that is missing, wrong or unclear." },
          { icon: <GitPullRequestArrow className="size-4" />, title: "Curator proposes", body: "The curator turns flags, traces and sources into reviewable changes." },
          { icon: <BookOpen className="size-4" />, title: "You review", body: "Approve in the Inbox; the knowledge updates with a full history." },
        ].map((x) => (
          <div key={x.title} className="rounded-md border border-line bg-surface p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className="text-accent">{x.icon}</span>
              {x.title}
            </div>
            <p className="mt-1 text-xs text-subtle">{x.body}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <LinkButton href={`${base}/suggest`}>Write a first concept</LinkButton>
        <LinkButton href={base} variant="primary">
          Open the inbox <ArrowRight className="size-4" />
        </LinkButton>
      </div>
      <p className="mt-3 text-right text-xs text-subtle">
        Have an OKF bundle or Agent Skills already? Import them with the CLI: <code className="font-mono">kf import &lt;dir&gt;</code>. They arrive
        as a proposal in the{" "}
        <Link href={base} className="underline">
          inbox
        </Link>
        .
      </p>
    </>
  );
}
