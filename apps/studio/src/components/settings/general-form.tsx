import { Globe, Lock } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout, Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/form";
import type { Database } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/client";
import { useMutation } from "@/lib/use-mutation";

type Visibility = Database["public"]["Enums"]["space_visibility"];

export function GeneralForm({
  space,
  canEdit,
}: {
  space: { id: string; slug: string; name: string; description: string | null; visibility: Visibility };
  canEdit: boolean;
}) {
  const { run, pending } = useMutation();
  const [name, setName] = useState(space.name);
  const [description, setDescription] = useState(space.description ?? "");
  const [visibility, setVisibility] = useState<Visibility>(space.visibility);
  const dirty = name !== space.name || description !== (space.description ?? "") || visibility !== space.visibility;

  return (
    <Card>
      <CardHeader title="Space" description="One space is one knowledge factory: its own knowledge, sources, flags and curator." />
      <form
        className="flex flex-col gap-5 px-4 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          const supabase = createClient();
          void run(
            async () => {
              const res = await supabase
                .from("spaces")
                .update({ name: name.trim(), description: description.trim() || null, visibility })
                .eq("id", space.id)
                .select("id");
              if (!res.error && !res.data?.length) return { error: { message: "Only space admins can change this space." } };
              return res;
            },
            { success: "Space updated" },
          );
        }}
      >
        <fieldset disabled={!canEdit || pending} className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="space-name">
              <Input id="space-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <Field label="Slug" htmlFor="space-slug" hint="Used in URLs and the MCP endpoint; it can't be changed.">
              <Input id="space-slug" value={space.slug} readOnly disabled className="font-mono text-xs" />
            </Field>
          </div>
          <Field label="Description" htmlFor="space-desc" optional hint="What this space knows about, for people picking a space and for agents.">
            <Textarea id="space-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Visibility</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ["workspace", <Globe key="g" className="size-4" />, "Workspace", "Every workspace member is at least a reader. Grant higher roles in Members."],
                  ["private", <Lock key="l" className="size-4" />, "Private", "Only people and groups added in Members or Access can see it. Workspace admins always can."],
                ] as const
              ).map(([v, icon, label, help]) => (
                <label
                  key={v}
                  className={cn(
                    "flex cursor-pointer gap-3 rounded-md border p-3 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                    visibility === v ? "border-accent bg-accent-soft/50" : "border-line hover:bg-surface-2",
                  )}
                >
                  <input type="radio" name="visibility" value={v} checked={visibility === v} onChange={() => setVisibility(v)} className="sr-only" />
                  <span className="mt-0.5 text-muted">{icon}</span>
                  <span>
                    <span className="block font-medium">{label}</span>
                    <span className="block text-xs text-subtle">{help}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </fieldset>
        {canEdit ? (
          <div className="flex justify-end">
            <Button type="submit" variant="primary" pending={pending} disabled={!dirty || !name.trim()}>
              Save
            </Button>
          </div>
        ) : (
          <p className="text-xs text-subtle">Only space admins can change these.</p>
        )}
      </form>
    </Card>
  );
}

export function DeleteSpace({ space, wsSlug }: { space: { id: string; slug: string; name: string }; wsSlug: string }) {
  const router = useRouter();
  const { run, pending } = useMutation();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  return (
    <Card className="border-danger/40">
      <CardHeader title="Danger zone" />
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
        <p className="max-w-xl text-sm text-muted">
          Deleting a space removes its knowledge, revisions, sources, documents, flags, proposals and traces. Export a bundle first if you want to keep
          them.
        </p>
        <Button variant="outline-danger" onClick={() => setOpen(true)}>
          Delete space
        </Button>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="sm"
        title={`Delete ${space.name}?`}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              pending={pending}
              disabled={confirm !== space.slug}
              onClick={async () => {
                const supabase = createClient();
                const res = await run(
                  async () => {
                    const r = await supabase.from("spaces").delete().eq("id", space.id).select("id");
                    if (!r.error && !r.data?.length) return { error: { message: "Only workspace admins can delete spaces." } };
                    return r;
                  },
                  { success: "Space deleted", refresh: false },
                );
                if (res.ok) {
                  document.cookie = "kf_last=; path=/; max-age=0";
                  void router.navigate({ href: `/w/${wsSlug}` });
                }
              }}
            >
              Delete forever
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Callout tone="danger">This cannot be undone.</Callout>
          <Field label={`Type the space slug “${space.slug}” to confirm`} htmlFor="del-space">
            <Input id="del-space" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" className="font-mono text-xs" />
          </Field>
        </div>
      </Dialog>
    </Card>
  );
}
