import { Trash, UserPlus } from "lucide-react";
import { useState } from "react";
import { AgentBadge, RoleBadge } from "@/components/kf/badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, EmptyState } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/form";
import { createClient } from "@/lib/supabase/client";
import { ROLE_HELP } from "@/lib/roles";
import type { SpaceRole, WorkspaceRole } from "@/lib/roles";
import { useMutation } from "@/lib/use-mutation";

export type Person = { user_id: string; name: string; kind: "human" | "agent" };

const SPACE_ROLES: SpaceRole[] = ["reader", "editor", "reviewer", "admin"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function PersonName({ p, me }: { p: Person; me: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-medium text-muted uppercase">{p.name.slice(0, 1)}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-fg">
          {p.name}
          {p.user_id === me ? <span className="ml-1 font-normal text-subtle">(you)</span> : null}
        </span>
        <span className="block truncate font-mono text-[11px] text-subtle">{p.user_id}</span>
      </span>
      {p.kind === "agent" ? <AgentBadge /> : null}
    </span>
  );
}

/** Rows touched by an update/delete; zero means RLS filtered it out. */
function ensureRows<T extends { data: unknown[] | null; error: unknown }>(r: T, msg: string) {
  if (!r.error && !r.data?.length) return { error: { message: msg } };
  return r;
}

export function SpaceMembers({
  spaceId,
  members,
  candidates,
  canManage,
  me,
  visibility,
}: {
  spaceId: string;
  members: (Person & { role: SpaceRole })[];
  candidates: Person[];
  canManage: boolean;
  me: string;
  visibility: "workspace" | "private";
}) {
  const { run, pending } = useMutation();
  const [addId, setAddId] = useState("");
  const [addRole, setAddRole] = useState<SpaceRole>("editor");
  const supabase = createClient();
  const available = candidates.filter((c) => !members.some((m) => m.user_id === c.user_id));
  const idValid = UUID_RE.test(addId.trim());

  return (
    <Card>
      <CardHeader
        title="Space members"
        description={
          visibility === "workspace"
            ? "Every workspace member is already a reader. Add people here to give them a higher role."
            : "This space is private: only these people, groups granted under Access, and workspace admins can see it."
        }
      />
      {members.length === 0 ? (
        <EmptyState title="No direct members">Roles can also come from groups (see Access). Workspace owners and admins are admins of every space.</EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {members.map((m) => (
            <li key={m.user_id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <PersonName p={m} me={me} />
              </div>
              {canManage ? (
                <>
                  <label className="sr-only" htmlFor={`sm-role-${m.user_id}`}>
                    Role for {m.name}
                  </label>
                  <Select
                    id={`sm-role-${m.user_id}`}
                    className="w-32"
                    value={m.role}
                    disabled={pending}
                    onChange={(e) =>
                      run(
                        async () =>
                          ensureRows(
                            await supabase.from("space_members").update({ role: e.target.value as SpaceRole }).eq("space_id", spaceId).eq("user_id", m.user_id).select("user_id"),
                            "Only space admins can change roles",
                          ),
                        { success: `${m.name} is now ${e.target.value}` },
                      )
                    }
                  >
                    {SPACE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${m.name}`}
                    disabled={pending}
                    onClick={() =>
                      run(
                        async () =>
                          ensureRows(
                            await supabase.from("space_members").delete().eq("space_id", spaceId).eq("user_id", m.user_id).select("user_id"),
                            "Only space admins can remove members",
                          ),
                        { success: `${m.name} removed from the space` },
                      )
                    }
                  >
                    <Trash className="size-3.5" />
                  </Button>
                </>
              ) : (
                <RoleBadge role={m.role} />
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <form
          className="flex flex-wrap items-end gap-3 border-t border-line bg-surface-2/40 px-4 py-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const id = addId.trim();
            if (!idValid) return;
            const res = await run(async () => supabase.from("space_members").insert({ space_id: spaceId, user_id: id, role: addRole }), {
              success: "Member added",
            });
            if (res.ok) setAddId("");
          }}
        >
          <Field label="Add a member" htmlFor="sm-add" className="min-w-56 flex-1" hint={available.length ? "Pick a coworker or paste a user ID." : "Paste the user ID of a workspace member."}>
            <div className="flex flex-col gap-2 sm:flex-row">
              {available.length ? (
                <Select id="sm-add-pick" aria-label="Workspace member" value={available.some((a) => a.user_id === addId) ? addId : ""} onChange={(e) => setAddId(e.target.value)} className="sm:w-44 sm:shrink-0">
                  <option value="">Choose…</option>
                  {available.map((c) => (
                    <option key={c.user_id} value={c.user_id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              ) : null}
              <Input id="sm-add" value={addId} onChange={(e) => setAddId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" className="font-mono text-xs" />
            </div>
          </Field>
          <Field label="Role" htmlFor="sm-add-role">
            <Select id="sm-add-role" value={addRole} onChange={(e) => setAddRole(e.target.value as SpaceRole)} className="w-32" title={ROLE_HELP[addRole]}>
              {SPACE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="primary" pending={pending} disabled={!idValid}>
            <UserPlus className="size-4" /> Add
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

const WS_ROLE_HELP: Record<WorkspaceRole, string> = {
  owner: "Full control, including other owners",
  admin: "Admin of every space; manages members, groups and agents",
  member: "Sees spaces with workspace visibility, plus spaces they're added to",
};

export function WorkspaceMembers({
  workspaceId,
  workspaceName,
  members,
  canManage,
  isOwner,
  me,
}: {
  workspaceId: string;
  workspaceName: string;
  members: (Person & { role: WorkspaceRole })[];
  canManage: boolean;
  isOwner: boolean;
  me: string;
}) {
  const { run, pending } = useMutation();
  const [addId, setAddId] = useState("");
  const [addRole, setAddRole] = useState<WorkspaceRole>("member");
  const supabase = createClient();
  const owners = members.filter((m) => m.role === "owner").length;
  const roles: WorkspaceRole[] = isOwner ? ["member", "admin", "owner"] : ["member", "admin"];
  const idValid = UUID_RE.test(addId.trim());

  return (
    <Card>
      <CardHeader
        title={`Workspace members · ${workspaceName}`}
        description="People (and agents) in the workspace. New people sign up at Studio, then a workspace admin adds them here by user ID."
      />
      <ul className="divide-y divide-line">
        {members.map((m) => {
          const lastOwner = m.role === "owner" && owners <= 1;
          const locked = !canManage || (m.role === "owner" && !isOwner) || lastOwner;
          return (
            <li key={m.user_id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <PersonName p={m} me={me} />
              </div>
              {locked ? (
                <Badge tone={m.role === "owner" ? "violet" : m.role === "admin" ? "accent" : "neutral"} title={lastOwner ? "The last owner can't be changed or removed" : WS_ROLE_HELP[m.role]}>
                  {m.role}
                </Badge>
              ) : (
                <>
                  <label className="sr-only" htmlFor={`wm-role-${m.user_id}`}>
                    Workspace role for {m.name}
                  </label>
                  <Select
                    id={`wm-role-${m.user_id}`}
                    className="w-32"
                    value={m.role}
                    disabled={pending}
                    onChange={(e) =>
                      run(
                        async () =>
                          ensureRows(
                            await supabase.from("workspace_members").update({ role: e.target.value as WorkspaceRole }).eq("workspace_id", workspaceId).eq("user_id", m.user_id).select("user_id"),
                            "Only workspace admins can change roles",
                          ),
                        { success: `${m.name} is now ${e.target.value}` },
                      )
                    }
                  >
                    {roles.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${m.name} from the workspace`}
                    disabled={pending}
                    onClick={() => {
                      if (!window.confirm(`Remove ${m.name} from ${workspaceName}? They lose access to every space in it.`)) return;
                      void run(
                        async () =>
                          ensureRows(
                            await supabase.from("workspace_members").delete().eq("workspace_id", workspaceId).eq("user_id", m.user_id).select("user_id"),
                            "Only workspace admins can remove members",
                          ),
                        { success: `${m.name} removed from the workspace` },
                      );
                    }}
                  >
                    <Trash className="size-3.5" />
                  </Button>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {canManage ? (
        <form
          className="flex flex-wrap items-end gap-3 border-t border-line bg-surface-2/40 px-4 py-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!idValid) return;
            const res = await run(async () => supabase.from("workspace_members").insert({ workspace_id: workspaceId, user_id: addId.trim(), role: addRole }), {
              success: "Added to the workspace",
            });
            if (res.ok) setAddId("");
          }}
        >
          <Field
            label="Add by user ID"
            htmlFor="wm-add"
            className="min-w-56 flex-1"
            hint="Ask them to sign up at Studio and send you the user ID shown in Settings → Members."
            error={addId.trim() && !idValid ? "That doesn't look like a user ID" : null}
          >
            <Input id="wm-add" value={addId} onChange={(e) => setAddId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" className="font-mono text-xs" />
          </Field>
          <Field label="Role" htmlFor="wm-add-role">
            <Select id="wm-add-role" value={addRole} onChange={(e) => setAddRole(e.target.value as WorkspaceRole)} className="w-32" title={WS_ROLE_HELP[addRole]}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="primary" pending={pending} disabled={!idValid}>
            <UserPlus className="size-4" /> Add
          </Button>
        </form>
      ) : null}
    </Card>
  );
}
