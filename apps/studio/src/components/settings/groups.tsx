import { Pencil, Plus, Trash, Users, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout, Card, CardHeader, EmptyState } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import type { Json } from "@/lib/database.types";
import { slugify } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import { useMutation } from "@/lib/use-mutation";
import type { Person } from "./people";

export type GroupRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  external_ref: Json;
  members: Person[];
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function Groups({ workspaceId, groups, people, canManage, me }: { workspaceId: string; groups: GroupRow[]; people: Person[]; canManage: boolean; me: string }) {
  const [editing, setEditing] = useState<GroupRow | "new" | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <Callout tone="info" icon={<Users />} title="Groups are audiences">
        A group (say “finance”) can restrict who sees a concept, source, document or trace. Restricted material is visible only to members of one of its
        groups — no role bypasses that, not even admin. Groups can also be granted a role on a space under Access.
      </Callout>
      <Card>
        <CardHeader
          title="Groups"
          description="Workspace-wide. Map them to upstream ACLs (a Slack channel, a GitHub team) with an external reference so connectors can set audiences."
          actions={
            canManage ? (
              <Button variant="primary" size="sm" onClick={() => setEditing("new")}>
                <Plus className="size-3.5" /> New group
              </Button>
            ) : null
          }
        />
        {groups.length === 0 ? (
          <EmptyState icon={<Users />} title="No groups yet" actions={canManage ? <Button onClick={() => setEditing("new")}>Create a group</Button> : null}>
            Create groups for teams whose knowledge is sensitive — finance, legal, security — then use them as audiences on sources and concepts.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {groups.map((g) => (
              <GroupItem key={g.id} group={g} people={people} canManage={canManage} me={me} onEdit={() => setEditing(g)} />
            ))}
          </ul>
        )}
      </Card>
      {editing ? <GroupDialog workspaceId={workspaceId} group={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function GroupItem({ group, people, canManage, me, onEdit }: { group: GroupRow; people: Person[]; canManage: boolean; me: string; onEdit: () => void }) {
  const { run, pending } = useMutation();
  const [add, setAdd] = useState("");
  const supabase = createClient();
  const candidates = people.filter((p) => !group.members.some((m) => m.user_id === p.user_id));
  const ref = group.external_ref && typeof group.external_ref === "object" && !Array.isArray(group.external_ref) && Object.keys(group.external_ref).length ? group.external_ref : null;

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-fg">{group.name}</span>
            <code className="font-mono text-[11px] text-subtle">{group.slug}</code>
            <Badge>{group.members.length} {group.members.length === 1 ? "member" : "members"}</Badge>
            {group.members.some((m) => m.user_id === me) ? <Badge tone="accent">You&apos;re in it</Badge> : null}
          </div>
          {group.description ? <p className="mt-0.5 text-sm text-muted">{group.description}</p> : null}
          {ref ? <code className="mt-1 block truncate font-mono text-[11px] text-subtle">external_ref {JSON.stringify(ref)}</code> : null}
        </div>
        {canManage ? (
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit ${group.name}`}>
              <Pencil className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Delete ${group.name}`}
              disabled={pending}
              onClick={() => {
                if (!window.confirm(`Delete the group “${group.name}”? Anything restricted only to it becomes invisible to everyone until its audience is changed.`)) return;
                void run(async () => supabase.from("groups").delete().eq("id", group.id), { success: "Group deleted" });
              }}
            >
              <Trash className="size-3.5" />
            </Button>
          </div>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {group.members.map((m) => (
          <span key={m.user_id} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 py-0.5 pr-1 pl-2 text-xs">
            {m.name}
            {canManage ? (
              <button
                type="button"
                aria-label={`Remove ${m.name} from ${group.name}`}
                disabled={pending}
                className="rounded-full p-0.5 text-subtle hover:bg-surface-3 hover:text-fg"
                onClick={() => run(async () => supabase.from("group_members").delete().eq("group_id", group.id).eq("user_id", m.user_id), { success: `${m.name} removed` })}
              >
                <X className="size-3" />
              </button>
            ) : (
              <span className="pr-1" />
            )}
          </span>
        ))}
        {canManage && candidates.length ? (
          <form
            className="inline-flex items-center gap-1"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!add) return;
              const res = await run(async () => supabase.from("group_members").insert({ group_id: group.id, user_id: add }), { success: "Member added" });
              if (res.ok) setAdd("");
            }}
          >
            <label htmlFor={`gm-${group.id}`} className="sr-only">
              Add a member to {group.name}
            </label>
            <Select id={`gm-${group.id}`} value={add} onChange={(e) => setAdd(e.target.value)} className="h-7 w-40 text-xs">
              <option value="">Add member…</option>
              {candidates.map((p) => (
                <option key={p.user_id} value={p.user_id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <Button type="submit" size="sm" disabled={!add} pending={pending}>
              Add
            </Button>
          </form>
        ) : null}
        {!group.members.length && !canManage ? <span className="text-xs text-subtle">No members</span> : null}
      </div>
    </li>
  );
}

function GroupDialog({ workspaceId, group, onClose }: { workspaceId: string; group: GroupRow | null; onClose: () => void }) {
  const { run, pending } = useMutation();
  const [name, setName] = useState(group?.name ?? "");
  const [slug, setSlug] = useState(group?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(Boolean(group));
  const [description, setDescription] = useState(group?.description ?? "");
  const [ref, setRef] = useState(group?.external_ref && JSON.stringify(group.external_ref) !== "{}" ? JSON.stringify(group.external_ref, null, 2) : "");
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = "Name is required";
    if (!SLUG_RE.test(slug)) errs.slug = "Lowercase letters, digits and dashes; starts with a letter or digit";
    let external_ref: NonNullable<Json> = {};
    if (ref.trim()) {
      try {
        const parsed: unknown = JSON.parse(ref);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) errs.ref = "Must be a JSON object";
        else external_ref = parsed as NonNullable<Json>;
      } catch {
        errs.ref = "Not valid JSON";
      }
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const supabase = createClient();
    const values = { name: name.trim(), slug, description: description.trim() || null, external_ref };
    const res = await run(
      async () => (group ? supabase.from("groups").update(values).eq("id", group.id) : supabase.from("groups").insert({ ...values, workspace_id: workspaceId })),
      { success: group ? "Group updated" : "Group created" },
    );
    if (res.ok) onClose();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={group ? `Edit ${group.name}` : "New group"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="group-form" pending={pending}>
            {group ? "Save" : "Create group"}
          </Button>
        </>
      }
    >
      <form id="group-form" onSubmit={save} className="flex flex-col gap-4" noValidate>
        <Field label="Name" htmlFor="g-name" error={errors.name}>
          <Input
            id="g-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugTouched) setSlug(slugify(e.target.value, 63));
            }}
            placeholder="Finance"
          />
        </Field>
        <Field label="Slug" htmlFor="g-slug" error={errors.slug} hint="Used in exported bundles (x-supaknowledge-audience).">
          <Input
            id="g-slug"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
            className="font-mono text-xs"
            placeholder="finance"
          />
        </Field>
        <Field label="Description" htmlFor="g-desc" optional>
          <Input id="g-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Revenue, billing and forecasts" />
        </Field>
        <Field label="External reference" htmlFor="g-ref" optional error={errors.ref} hint='Upstream ACL this group mirrors, e.g. {"slack_channel": "C0123"} or {"github_team": "acme/finance"}.'>
          <Textarea id="g-ref" rows={3} value={ref} onChange={(e) => setRef(e.target.value)} className="font-mono text-xs" placeholder='{"slack_channel": "C0123456789"}' />
        </Field>
      </form>
    </Dialog>
  );
}
