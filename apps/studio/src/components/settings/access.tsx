import { KeyRound, Lock, Trash } from "lucide-react";
import { useState } from "react";
import { RoleBadge } from "@/components/kf/badges";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, EmptyState } from "@/components/ui/card";
import { Field, Select } from "@/components/ui/form";
import { createClient } from "@/lib/supabase/client";
import { ROLE_HELP } from "@/lib/roles";
import type { SpaceRole } from "@/lib/roles";
import { useMutation } from "@/lib/use-mutation";

const ROLES: SpaceRole[] = ["reader", "editor", "reviewer", "admin"];

export function AccessGrants({
  spaceId,
  grants,
  groups,
  canManage,
}: {
  spaceId: string;
  grants: { group_id: string; role: SpaceRole }[];
  groups: { id: string; name: string }[];
  canManage: boolean;
}) {
  const { run, pending } = useMutation();
  const [group, setGroup] = useState("");
  const [role, setRole] = useState<SpaceRole>("reader");
  const supabase = createClient();
  const available = groups.filter((g) => !grants.some((x) => x.group_id === g.id));
  const name = (id: string) => groups.find((g) => g.id === id)?.name ?? "Unknown group";

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="px-4 py-3">
          <div className="mb-1 flex items-center gap-2 text-sm font-medium">
            <KeyRound className="size-4 text-accent" /> Role = what you can do
          </div>
          <ul className="flex flex-col gap-1 text-sm text-muted">
            {ROLES.map((r) => (
              <li key={r}>
                <span className="font-medium text-fg capitalize">{r}</span> — {ROLE_HELP[r].toLowerCase()}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-subtle">The highest of: direct membership, group grants, workspace visibility (reader), workspace admin (admin).</p>
        </Card>
        <Card className="px-4 py-3">
          <div className="mb-1 flex items-center gap-2 text-sm font-medium">
            <Lock className="size-4 text-warn" /> Audience = what you can see
          </div>
          <p className="text-sm text-muted">
            Concepts, sources, documents, traces and flags can be restricted to groups. If something is restricted, you need to be in one of its groups to
            see it, whatever your role. A proposal that would publish restricted material more widely is an <em>escalation</em>: only a space admin can
            approve it, and it is never auto-applied.
          </p>
        </Card>
      </div>

      <Card>
        <CardHeader title="Group grants" description="Give every member of a group a role on this space." />
        {grants.length === 0 ? (
          <EmptyState title="No group grants">
            {groups.length ? "Grant a group a role to onboard a whole team at once." : "Create groups under the Groups tab first."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {grants.map((g) => (
              <li key={g.group_id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="flex-1 text-sm font-medium">{name(g.group_id)}</span>
                {canManage ? (
                  <>
                    <label className="sr-only" htmlFor={`grant-${g.group_id}`}>
                      Role for {name(g.group_id)}
                    </label>
                    <Select
                      id={`grant-${g.group_id}`}
                      className="w-32"
                      value={g.role}
                      disabled={pending}
                      onChange={(e) =>
                        run(
                          async () =>
                            supabase.from("space_group_grants").update({ role: e.target.value as SpaceRole }).eq("space_id", spaceId).eq("group_id", g.group_id),
                          { success: "Grant updated" },
                        )
                      }
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </Select>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove grant for ${name(g.group_id)}`}
                      disabled={pending}
                      onClick={() => run(async () => supabase.from("space_group_grants").delete().eq("space_id", spaceId).eq("group_id", g.group_id), { success: "Grant removed" })}
                    >
                      <Trash className="size-3.5" />
                    </Button>
                  </>
                ) : (
                  <RoleBadge role={g.role} />
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && available.length ? (
          <form
            className="flex flex-wrap items-end gap-3 border-t border-line bg-surface-2/40 px-4 py-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!group) return;
              const res = await run(async () => supabase.from("space_group_grants").insert({ space_id: spaceId, group_id: group, role }), { success: "Group granted access" });
              if (res.ok) setGroup("");
            }}
          >
            <Field label="Group" htmlFor="grant-group" className="min-w-48 flex-1">
              <Select id="grant-group" value={group} onChange={(e) => setGroup(e.target.value)}>
                <option value="">Choose a group…</option>
                {available.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Role" htmlFor="grant-role">
              <Select id="grant-role" className="w-32" value={role} onChange={(e) => setRole(e.target.value as SpaceRole)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" variant="primary" disabled={!group} pending={pending}>
              Grant
            </Button>
          </form>
        ) : null}
      </Card>
    </div>
  );
}
