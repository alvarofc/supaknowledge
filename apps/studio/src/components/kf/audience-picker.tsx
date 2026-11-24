import { Globe, Lock } from "lucide-react";
import { cn } from "@/components/ui/cn";

/**
 * Pick the audience (group ids) for a concept, source or upload. Empty = everyone who can read the space.
 * You can only restrict to groups you belong to (the database rejects audiences you are not in).
 */
export function AudiencePicker({
  groups,
  myGroupIds,
  value,
  onChange,
  disabled,
  id,
}: {
  groups: { id: string; name: string; description?: string | null }[];
  myGroupIds: string[];
  value: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
  id?: string;
}) {
  const mine = new Set(myGroupIds);
  const toggle = (gid: string) => onChange(value.includes(gid) ? value.filter((x) => x !== gid) : [...value, gid]);
  return (
    <fieldset id={id} className="flex flex-col gap-2" disabled={disabled}>
      <legend className="sr-only">Audience</legend>
      <label
        className={cn(
          "flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 text-sm",
          value.length === 0 ? "border-accent bg-accent-soft/50" : "border-line",
        )}
      >
        <input type="radio" className="mt-0.5 accent-[var(--brand-strong)]" checked={value.length === 0} onChange={() => onChange([])} />
        <span>
          <span className="flex items-center gap-1.5 font-medium">
            <Globe className="size-3.5 text-subtle" /> Everyone in the space
          </span>
          <span className="block text-xs text-subtle">Anyone who can read this space, agents included.</span>
        </span>
      </label>
      <div className={cn("rounded-md border px-3 py-2", value.length > 0 ? "border-warn/50 bg-warn-soft/40" : "border-line")}>
        <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
          <Lock className="size-3.5 text-subtle" /> Restricted to groups
        </div>
        {groups.length === 0 ? (
          <p className="text-xs text-subtle">This workspace has no groups yet. Admins can create them in Settings → Groups.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {groups.map((g) => {
              const canUse = mine.has(g.id);
              return (
                <li key={g.id}>
                  <label className={cn("flex items-start gap-2 text-sm", canUse ? "cursor-pointer" : "cursor-not-allowed opacity-60")}>
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-[var(--brand-strong)]"
                      checked={value.includes(g.id)}
                      disabled={!canUse && !value.includes(g.id)}
                      onChange={() => toggle(g.id)}
                    />
                    <span>
                      {g.name}
                      {!canUse ? <span className="ml-1 text-xs text-subtle">(you are not a member)</span> : null}
                      {g.description ? <span className="block text-xs text-subtle">{g.description}</span> : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-1.5 text-xs text-subtle">Members of any selected group can see it. Roles never bypass an audience.</p>
      </div>
    </fieldset>
  );
}
