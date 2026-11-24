import { KeyRound, Pause, Pencil, Play, RefreshCw, Trash } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { AudiencePicker } from "@/components/kf/audience-picker";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import type { Json } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/client";
import { useMutation } from "@/lib/use-mutation";
import { ConfigFields } from "./config-fields";
import { SYNC_INTERVALS, configToDraft, connectorDef, draftToConfig } from "./connectors";
import type { ConnectorKind, SourceStatus } from "./connectors";

export type EditableSource = {
  id: string;
  name: string;
  connector: ConnectorKind;
  config: Json;
  audience: string[];
  sync_interval: string;
  status: SourceStatus;
};

type Groups = { id: string; name: string; description: string | null }[];

export function SourceActions({ source, base, groups, myGroupIds }: { source: EditableSource; base: string; groups: Groups; myGroupIds: string[] }) {
  const { run, pending } = useMutation();
  const [dialog, setDialog] = useState<null | "edit" | "token" | "delete">(null);
  const def = connectorDef(source.connector);
  const supabase = createClient();

  return (
    <div className="flex flex-wrap items-center gap-2">
      {source.connector !== "upload" ? (
        <Button
          variant="primary"
          pending={pending}
          onClick={() =>
            run(async () => supabase.rpc("request_source_sync", { p_source: source.id }), {
              success: "Sync queued. The connector picks it up within a minute.",
            })
          }
        >
          <RefreshCw className="size-4" /> Sync now
        </Button>
      ) : null}
      {source.connector !== "upload" ? (
        <Button
          pending={pending}
          onClick={() =>
            run(async () => supabase.from("sources").update({ status: source.status === "paused" ? "active" : "paused" }).eq("id", source.id), {
              success: source.status === "paused" ? "Source resumed" : "Source paused: scheduled syncs stop until you resume it",
            })
          }
        >
          {source.status === "paused" ? <Play className="size-4" /> : <Pause className="size-4" />}
          {source.status === "paused" ? "Resume" : "Pause"}
        </Button>
      ) : null}
      {def.token ? (
        <Button onClick={() => setDialog("token")}>
          <KeyRound className="size-4" /> Set token
        </Button>
      ) : null}
      <Button onClick={() => setDialog("edit")}>
        <Pencil className="size-4" /> Edit
      </Button>
      <Button variant="outline-danger" onClick={() => setDialog("delete")}>
        <Trash className="size-4" /> Delete
      </Button>
      {dialog === "edit" ? <EditSourceDialog source={source} groups={groups} myGroupIds={myGroupIds} onClose={() => setDialog(null)} /> : null}
      {dialog === "token" ? <SetTokenDialog source={source} onClose={() => setDialog(null)} /> : null}
      {dialog === "delete" ? <DeleteSourceDialog source={source} base={base} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

function EditSourceDialog({ source, groups, myGroupIds, onClose }: { source: EditableSource; groups: Groups; myGroupIds: string[]; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [name, setName] = useState(source.name);
  const [draft, setDraft] = useState(() => configToDraft(source.connector, source.config));
  const [interval, setInterval] = useState(source.sync_interval);
  const [audience, setAudience] = useState(source.audience);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const intervals = SYNC_INTERVALS.some((i) => i.value === source.sync_interval)
    ? SYNC_INTERVALS
    : [...SYNC_INTERVALS, { value: source.sync_interval, label: `Every ${source.sync_interval}` }];

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const { config, errors: errs } = draftToConfig(source.connector, draft, source.config);
    if (!name.trim()) errs.name = "Name is required";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const supabase = createClient();
    const res = await run(
      async () => supabase.from("sources").update({ name: name.trim(), config, sync_interval: interval, audience }).eq("id", source.id).select("id"),
      { success: "Source updated" },
    );
    if (res.ok) onClose();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Edit ${source.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="edit-source-form" pending={pending}>
            Save changes
          </Button>
        </>
      }
    >
      <form id="edit-source-form" onSubmit={save} className="flex flex-col gap-5" noValidate>
        <Field label="Name" htmlFor="edit-src-name" error={errors.name}>
          <Input id="edit-src-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <ConfigFields kind={source.connector} draft={draft} onChange={setDraft} errors={errors} idPrefix="edit-src-cfg" />
        {source.connector !== "upload" ? (
          <Field label="Sync" htmlFor="edit-src-interval">
            <Select id="edit-src-interval" value={interval} onChange={(e) => setInterval(e.target.value)}>
              {intervals.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <div>
          <div className="mb-1.5 text-sm font-medium">Audience</div>
          <AudiencePicker groups={groups} myGroupIds={myGroupIds} value={audience} onChange={setAudience} />
          <p className="mt-2 text-xs text-subtle">Changing the audience applies to documents synced from now on; existing documents keep the audience they were synced with.</p>
        </div>
      </form>
    </Dialog>
  );
}

function SetTokenDialog({ source, onClose }: { source: EditableSource; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [token, setToken] = useState("");
  const def = connectorDef(source.connector);
  if (!def.token) return null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Set ${def.token.label.toLowerCase()}`}
      description="The value is written to Supabase Vault. Nobody can read it back through the API, including you; only connectors running with the service role can use it."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            pending={pending}
            disabled={!token.trim()}
            onClick={async () => {
              const supabase = createClient();
              const res = await run(async () => supabase.rpc("set_source_secret", { p_source: source.id, p_secret: token.trim() }), {
                success: "Token saved to Vault",
              });
              if (res.ok) onClose();
            }}
          >
            Save token
          </Button>
        </>
      }
    >
      <Field label={def.token.label} htmlFor="set-token" hint={`${def.token.hint} Saving replaces any previous token.`}>
        {def.token.multiline ? (
          <Textarea id="set-token" rows={5} className="font-mono text-xs" value={token} onChange={(e) => setToken(e.target.value)} placeholder={def.token.placeholder} autoComplete="off" spellCheck={false} />
        ) : (
          <Input id="set-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={def.token.placeholder} autoComplete="off" spellCheck={false} />
        )}
      </Field>
    </Dialog>
  );
}

function DeleteSourceDialog({ source, base, onClose }: { source: EditableSource; base: string; onClose: () => void }) {
  const router = useRouter();
  const { run, pending } = useMutation();
  const [confirm, setConfirm] = useState("");
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`Delete ${source.name}?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            pending={pending}
            disabled={confirm !== source.name}
            onClick={async () => {
              const supabase = createClient();
              const res = await run(async () => supabase.from("sources").delete().eq("id", source.id).select("id"), {
                success: "Source deleted",
                refresh: false,
              });
              if (res.ok) {
                void router.navigate({ href: `${base}/sources` });
              }
            }}
          >
            Delete source
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Callout tone="danger">
          All synced documents and their chunks are deleted. Knowledge already written from them stays, but its citations will point to documents that no
          longer exist.
        </Callout>
        <Field label={`Type “${source.name}” to confirm`} htmlFor="del-src-confirm">
          <Input id="del-src-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
        </Field>
      </div>
    </Dialog>
  );
}
