import { Ban, Bot, KeyRound, MoreHorizontal, Plus, RotateCcw, RotateCw, Trash } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { callFunction, FunctionError } from "@/lib/functions";
import { errorMessage } from "@/lib/format";
import { ROLE_HELP } from "@/lib/roles";
import type { SpaceRole } from "@/lib/roles";
import { ConnectSnippets } from "./connect-snippets";

type Ctx = { workspaceId: string; wsSlug: string; spaceId: string; spaceSlug: string; spaceName: string };

function unavailableMessage(err: unknown): string | null {
  if (err instanceof FunctionError && (err.status === 501 || err.status === 404 || err.status === 0)) {
    return `${err.message} Agent keys are issued by the \`agents\` Edge Function, which needs the Auth admin API. Deploy it (or run \`npm run functions:serve\`) and try again.`;
  }
  return null;
}

/** Shows a freshly issued key exactly once, with configs that embed it. */
function KeyReveal({ agentName, agentKey, ctx }: { agentName: string; agentKey: string; ctx: Ctx }) {
  return (
    <div className="flex flex-col gap-4">
      <Callout tone="warn" icon={<KeyRound />} title="Copy this key now — it won't be shown again">
        Only a hash is stored. If you lose it, rotate the key to issue a new one.
      </Callout>
      <div>
        <div className="mb-1.5 text-sm font-medium">API key for {agentName}</div>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-xs whitespace-nowrap">{agentKey}</code>
          <CopyButton value={agentKey} label="Copy key" />
        </div>
      </div>
      <div>
        <div className="mb-2 text-sm font-medium">Connect it to {ctx.spaceName}</div>
        <ConnectSnippets wsSlug={ctx.wsSlug} spaceSlug={ctx.spaceSlug} agentKey={agentKey} />
      </div>
    </div>
  );
}

export function CreateAgentButton({ ctx }: { ctx: Ctx }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [role, setRole] = useState<SpaceRole>("reader");
  const [pending, setPending] = useState(false);
  const [issued, setIssued] = useState<{ name: string; key: string } | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  function close() {
    setOpen(false);
    setIssued(null);
    setName("");
    setDescription("");
    setRole("reader");
    setUnavailable(null);
    setNameError(null);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setNameError("Give the agent a name");
      return;
    }
    setNameError(null);
    setPending(true);
    setUnavailable(null);
    try {
      const res = await callFunction<{ agent: { id: string; name: string }; key: string }>("agents", {
        body: { workspace_id: ctx.workspaceId, name: name.trim(), description: description.trim() || undefined, spaces: [{ space_id: ctx.spaceId, role }] },
      });
      setIssued({ name: res.agent?.name ?? name.trim(), key: res.key });
      void router.invalidate();
    } catch (err) {
      const msg = unavailableMessage(err);
      if (msg) setUnavailable(msg);
      else toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Plus className="size-4" /> Create agent
      </Button>
      <Dialog
        open={open}
        onClose={close}
        size="lg"
        title={issued ? `${issued.name} is ready` : "Create an agent"}
        description={issued ? undefined : "A headless identity for an automated agent (CI job, Slack bot, scheduled worker) with its own API key."}
        footer={
          issued ? (
            <Button variant="primary" onClick={close}>
              I&apos;ve saved the key
            </Button>
          ) : (
            <>
              <Button onClick={close}>Cancel</Button>
              <Button variant="primary" type="submit" form="create-agent-form" pending={pending}>
                Create agent
              </Button>
            </>
          )
        }
      >
        {issued ? (
          <KeyReveal agentName={issued.name} agentKey={issued.key} ctx={ctx} />
        ) : (
          <form id="create-agent-form" onSubmit={create} className="flex flex-col gap-4" noValidate>
            {unavailable ? (
              <Callout tone="warn" title="Agent keys can't be issued yet">
                {unavailable}
              </Callout>
            ) : null}
            <Field label="Name" htmlFor="agent-name" error={nameError} hint="Unique in the workspace. Shows up as the author of flags and traces.">
              <Input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="revenue-report-bot" autoComplete="off" />
            </Field>
            <Field label="Description" htmlFor="agent-desc" optional>
              <Textarea id="agent-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Builds the weekly revenue report from BigQuery." />
            </Field>
            <Field
              label={`Role in ${ctx.spaceName}`}
              htmlFor="agent-role"
              hint="Agents are usually readers: they search, read and flag, but never see raw source documents or other people's traces."
            >
              <Select id="agent-role" value={role} onChange={(e) => setRole(e.target.value as SpaceRole)}>
                {(["reader", "editor", "reviewer"] as const).map((r) => (
                  <option key={r} value={r}>
                    {r[0].toUpperCase() + r.slice(1)} — {ROLE_HELP[r]}
                  </option>
                ))}
              </Select>
            </Field>
          </form>
        )}
      </Dialog>
    </>
  );
}

export function AgentRowActions({ agent, ctx }: { agent: { id: string; name: string; revoked?: boolean | null }; ctx: Ctx }) {
  const router = useRouter();
  const toast = useToast();
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<null | "rotate" | "revoke" | "restore" | "delete">(null);
  const [pending, setPending] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  function close() {
    setDialog(null);
    setNewKey(null);
    setUnavailable(null);
  }

  async function act(kind: "rotate" | "revoke" | "restore" | "delete") {
    setPending(true);
    setUnavailable(null);
    try {
      if (kind === "rotate") {
        const res = await callFunction<{ key: string }>(`agents/${agent.id}/rotate`, { method: "POST", body: {} });
        setNewKey(res.key);
      } else if (kind === "revoke") {
        await callFunction(`agents/${agent.id}/revoke`, { method: "POST", body: {} });
        toast.success(`${agent.name} revoked`);
        close();
      } else if (kind === "restore") {
        await callFunction(`agents/${agent.id}/restore`, { method: "POST", body: {} });
        toast.success(`${agent.name} restored`);
        close();
      } else {
        await callFunction(`agents/${agent.id}`, { method: "DELETE" });
        toast.success(`${agent.name} deleted`);
        close();
      }
      void router.invalidate();
    } catch (err) {
      const msg = unavailableMessage(err);
      if (msg) setUnavailable(msg);
      else toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const copy = {
    rotate: {
      title: `Rotate ${agent.name}'s key?`,
      body: "A new key is issued, the old one stops working within seconds and every session created with it is signed out. Update every place that uses it.",
      cta: "Rotate key",
      tone: "primary" as const,
    },
    revoke: {
      title: `Revoke ${agent.name}?`,
      body: "Its key stops working within seconds, every session it holds is signed out and its Auth user is banned. Supaknowledge functions (MCP, traces) refuse it right away; an access token it already holds only works against the raw database API until it expires (JWT expiry, one hour by default). The agent's flags and traces are kept.",
      cta: "Revoke agent",
      tone: "danger" as const,
    },
    restore: {
      title: `Restore ${agent.name}?`,
      body: "Lifts the ban: its current key works again. Rotate the key as well if it may have leaked.",
      cta: "Restore agent",
      tone: "primary" as const,
    },
    delete: {
      title: `Delete ${agent.name}?`,
      body: "Deletes the agent and its Auth user. Flags and traces it sent stay, but lose their author. This can't be undone.",
      cta: "Delete agent",
      tone: "danger" as const,
    },
  };
  const d = dialog ? copy[dialog] : null;

  return (
    <div ref={ref} className="relative">
      <Button variant="ghost" size="sm" aria-label={`Actions for ${agent.name}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
        <MoreHorizontal className="size-4" />
      </Button>
      {menu ? (
        <div role="menu" className="absolute right-0 z-20 mt-1 w-44 rounded-md border border-line-strong bg-surface p-1 shadow-lg">
          {(
            [
              ["rotate", <RotateCw key="i" className="size-3.5" />, "Rotate key"],
              // unknown state (null): offer both, the function makes either one idempotent
              ...(agent.revoked !== false ? ([["restore", <RotateCcw key="i" className="size-3.5" />, "Restore"]] as const) : []),
              ...(agent.revoked !== true ? ([["revoke", <Ban key="i" className="size-3.5" />, "Revoke"]] as const) : []),
              ["delete", <Trash key="i" className="size-3.5" />, "Delete"],
            ] as const
          ).map(([k, icon, label]) => (
            <button
              key={k}
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(false);
                setDialog(k);
              }}
              className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2", k === "rotate" || k === "restore" ? "text-fg" : "text-danger")}
            >
              {icon} {label}
            </button>
          ))}
        </div>
      ) : null}
      {d ? (
        <Dialog
          open
          onClose={close}
          size={newKey ? "lg" : "sm"}
          title={newKey ? `New key for ${agent.name}` : d.title}
          footer={
            newKey ? (
              <Button variant="primary" onClick={close}>
                I&apos;ve saved the key
              </Button>
            ) : (
              <>
                <Button onClick={close}>Cancel</Button>
                <Button variant={d.tone === "danger" ? "danger" : "primary"} pending={pending} onClick={() => dialog && act(dialog)}>
                  {d.cta}
                </Button>
              </>
            )
          }
        >
          {newKey ? (
            <KeyReveal agentName={agent.name} agentKey={newKey} ctx={ctx} />
          ) : (
            <div className="flex flex-col gap-3">
              {unavailable ? (
                <Callout tone="warn" title="Not available yet">
                  {unavailable}
                </Callout>
              ) : null}
              <p className="text-sm text-muted">{d.body}</p>
            </div>
          )}
        </Dialog>
      ) : null}
    </div>
  );
}

export function AgentAvatar() {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-info-soft text-info">
      <Bot className="size-4" />
    </span>
  );
}
