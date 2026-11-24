import { Plus } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { AudiencePicker } from "@/components/kf/audience-picker";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import { ConfigFields } from "./config-fields";
import { CONNECTORS, ConnectorIcon, SYNC_INTERVALS, connectorDef, draftToConfig } from "./connectors";
import type { ConfigDraft, ConnectorKind } from "./connectors";

export function AddSourceButton({
  spaceId,
  base,
  groups,
  myGroupIds,
  variant = "primary",
}: {
  spaceId: string;
  base: string;
  groups: { id: string; name: string; description: string | null }[];
  myGroupIds: string[];
  /** the page header carries the primary action; repeats (empty state) use the default button */
  variant?: "primary" | "secondary";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size={variant === "primary" ? "md" : "sm"} onClick={() => setOpen(true)}>
        <Plus className="size-4" /> Add source
      </Button>
      {open ? <AddSourceDialog spaceId={spaceId} base={base} groups={groups} myGroupIds={myGroupIds} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function AddSourceDialog({
  spaceId,
  base,
  groups,
  myGroupIds,
  onClose,
}: {
  spaceId: string;
  base: string;
  groups: { id: string; name: string; description: string | null }[];
  myGroupIds: string[];
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [kind, setKind] = useState<ConnectorKind>("notion");
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<ConfigDraft>({});
  const [interval, setInterval] = useState("01:00:00");
  const [audience, setAudience] = useState<string[]>([]);
  const [token, setToken] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const def = connectorDef(kind);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const { config, errors: cfgErrors } = draftToConfig(kind, draft);
    const errs: Record<string, string> = { ...cfgErrors };
    if (!name.trim()) errs.name = "Give the source a name";
    if (def.token && !def.token.optional && !token.trim()) errs.token = `${def.token.label} is required to sync`;
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setPending(true);
    const supabase = createClient();
    try {
      const { data, error } = await supabase
        .from("sources")
        .insert({ space_id: spaceId, connector: kind, name: name.trim(), config, audience, sync_interval: kind === "upload" ? "1 day" : interval })
        .select("id")
        .single();
      if (error || !data) {
        toast.error(errorMessage(error));
        return;
      }
      if (def.token && token.trim()) {
        const { error: secretError } = await supabase.rpc("set_source_secret", { p_source: data.id, p_secret: token.trim() });
        if (secretError) toast.error(`Source created, but saving the token failed: ${errorMessage(secretError)}`);
      }
      toast.success(`${def.label} source added`);
      onClose();
      void router.navigate({ href: `${base}/sources/${data.id}` });
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Add a source"
      description="Sources are raw evidence. Connectors copy documents into the space; the curator reads them and proposes knowledge. Agents never see raw documents."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="add-source-form" pending={pending}>
            Add source
          </Button>
        </>
      }
    >
      <form id="add-source-form" onSubmit={submit} className="flex flex-col gap-5" noValidate>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Connector</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {CONNECTORS.map((c) => (
              <label
                key={c.kind}
                className={cn(
                  "flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-left transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                  kind === c.kind ? "border-accent bg-accent-soft/50" : "border-line hover:bg-surface-2",
                )}
              >
                <input
                  type="radio"
                  name="connector"
                  value={c.kind}
                  checked={kind === c.kind}
                  onChange={() => {
                    setKind(c.kind);
                    setDraft({});
                    setErrors({});
                    setToken("");
                  }}
                  className="sr-only"
                />
                <span className="flex items-center gap-2 text-sm font-medium">
                  <ConnectorIcon kind={c.kind} /> {c.label}
                </span>
                <span className="text-xs text-subtle">{c.description}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <Field label="Name" htmlFor="src-name" error={errors.name} hint="Shown in citations, e.g. “Finance Notion” or “#eng-oncall”.">
          <Input id="src-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={`${def.label} – team docs`} aria-invalid={errors.name ? true : undefined} />
        </Field>

        <ConfigFields kind={kind} draft={draft} onChange={setDraft} errors={errors} idPrefix="src-cfg" />

        {kind !== "upload" ? (
          <Field label="Sync" htmlFor="src-interval" hint="Cron enqueues sources that are due; you can also sync on demand.">
            <Select id="src-interval" value={interval} onChange={(e) => setInterval(e.target.value)}>
              {SYNC_INTERVALS.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {def.token ? (
          <Field
            label={def.token.label}
            htmlFor="src-token"
            error={errors.token}
            optional={def.token.optional}
            hint={`${def.token.hint} Stored encrypted in Supabase Vault and never readable back.`}
          >
            {def.token.multiline ? (
              <Textarea id="src-token" rows={4} className="font-mono text-xs" value={token} onChange={(e) => setToken(e.target.value)} placeholder={def.token.placeholder} autoComplete="off" spellCheck={false} />
            ) : (
              <Input id="src-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={def.token.placeholder} autoComplete="off" spellCheck={false} />
            )}
          </Field>
        ) : null}

        <div>
          <div className="mb-1.5 text-sm font-medium">Audience</div>
          <p className="mb-2 text-xs text-subtle">
            Who may see documents from this source. Restrict it to mirror upstream access (a private channel, a finance-only folder). Knowledge the curator
            writes from restricted documents stays restricted unless an admin approves widening it.
          </p>
          <AudiencePicker groups={groups} myGroupIds={myGroupIds} value={audience} onChange={setAudience} />
        </div>
        {audience.length > 0 ? (
          <Callout tone="neutral">You can only manage sources whose audience includes a group you belong to.</Callout>
        ) : null}
      </form>
    </Dialog>
  );
}
