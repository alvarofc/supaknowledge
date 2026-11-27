import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import type { ProfileMap } from "@/lib/format";
import { initials, viewersFrom } from "@/lib/presence";
import type { ReviewState, Viewer } from "@/lib/presence";
import { joinChannel } from "@/lib/realtime";
import type { ChannelHandle } from "@/lib/realtime";
import { createClient } from "@/lib/supabase/client";

/** at most this many proposal channels from one inbox page */
const MAX_WATCHED = 25;

/**
 * Who else has this proposal open, and whether they are reviewing it. Tracks the current user with `track`
 * ("viewing", or "reviewing" while the approve / reject form is open). Presence on the private channel
 * proposal:<id> is only open to people who can see the proposal (Realtime Authorization), never to agents.
 */
export function useProposalPresence(proposalId: string, selfId: string, track: ReviewState): Viewer[] {
  const [seen, setSeen] = useState<{ id: string; viewers: Viewer[] }>({ id: proposalId, viewers: [] });
  const handle = useRef<ChannelHandle | null>(null);

  useEffect(() => {
    const h = joinChannel(`proposal:${proposalId}`, { presence: { key: selfId } }, {
      onPresence: (state) => setSeen({ id: proposalId, viewers: viewersFrom(state, selfId) }),
    });
    handle.current = h;
    return () => {
      h.leave();
      handle.current = null;
    };
  }, [proposalId, selfId]);

  // runs after the join above (effects run in order), including when the proposal changes
  useEffect(() => {
    handle.current?.track({ user_id: selfId, state: track });
  }, [proposalId, selfId, track]);

  return seen.id === proposalId ? seen.viewers : [];
}

/** Who has each of these proposals open (the inbox watches without appearing itself). */
export function useProposalsPresence(proposalIds: string[], selfId: string): Record<string, Viewer[]> {
  const [byId, setById] = useState<Record<string, Viewer[]>>({});
  const key = proposalIds.slice(0, MAX_WATCHED).join(",");

  useEffect(() => {
    if (!key) return;
    const handles = key.split(",").map((id) =>
      joinChannel(`proposal:${id}`, { presence: { key: selfId } }, {
        onPresence: (state) => setById((prev) => ({ ...prev, [id]: viewersFrom(state, selfId) })),
      }),
    );
    return () => {
      for (const h of handles) h.leave();
    };
  }, [key, selfId]);

  return byId;
}

type Person = { name: string; kind: "human" | "agent" };
const people = new Map<string, Person | null>();

/**
 * Display names for user ids, read from `profiles` as the current user (RLS: coworkers only). Ids without a
 * readable human profile resolve to nothing and are not shown.
 */
export function usePeople(ids: string[], known: ProfileMap = {}): Map<string, Person> {
  const [, bump] = useState(0);
  const key = [...new Set(ids)].sort().join(",");

  useEffect(() => {
    for (const [id, p] of Object.entries(known)) {
      if (!people.has(id) && p.display_name) people.set(id, { name: p.display_name, kind: p.kind });
    }
    const missing = key ? key.split(",").filter((id) => !people.has(id)) : [];
    if (!missing.length) return;
    let cancelled = false;
    void (async () => {
      const { data } = await createClient().from("profiles").select("id, display_name, kind").in("id", missing);
      for (const id of missing) people.set(id, null);
      for (const p of data ?? []) people.set(p.id, { name: p.display_name ?? "A teammate", kind: p.kind });
      if (!cancelled) bump((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [key, known]);

  // `people` is a module cache; the lookup above re-renders when it fills in
  const out = new Map<string, Person>();
  for (const id of key ? key.split(",") : []) {
    const p = people.get(id) ?? (known[id]?.display_name ? { name: known[id].display_name, kind: known[id].kind } : null);
    if (p && p.kind === "human") out.set(id, p);
  }
  return out;
}

/** Viewers with a resolved name, reviewing first. */
export function namedViewers(viewers: Viewer[], names: Map<string, Person>): (Viewer & { name: string })[] {
  return viewers.flatMap((v) => {
    const p = names.get(v.userId);
    return p ? [{ ...v, name: p.name }] : [];
  });
}

/** Small stacked initials of the people who have a proposal open; the name (and "reviewing") on hover. */
export function ViewerAvatars({ viewers, max = 3, className }: { viewers: (Viewer & { name: string })[]; max?: number; className?: string }) {
  if (!viewers.length) return null;
  const shown = viewers.slice(0, max);
  const more = viewers.length - shown.length;
  const label = viewers.map((v) => `${v.name}${v.state === "reviewing" ? " (reviewing)" : ""}`).join(", ");
  return (
    <span className={cn("inline-flex shrink-0 items-center", className)} role="img" aria-label={`Also open by ${label}`}>
      {shown.map((v, i) => (
        <span
          key={v.userId}
          title={v.state === "reviewing" ? `${v.name}, reviewing` : v.name}
          className={cn(
            "inline-flex size-6 items-center justify-center rounded-full text-[10px] font-medium ring-2 ring-surface select-none",
            i > 0 && "-ml-1.5",
            v.state === "reviewing" ? "bg-warn-soft text-warn" : "bg-surface-3 text-fg",
          )}
        >
          {initials(v.name)}
        </span>
      ))}
      {more > 0 ? (
        <span title={viewers.slice(max).map((v) => v.name).join(", ")} className="-ml-1.5 inline-flex size-6 items-center justify-center rounded-full bg-surface-2 text-[10px] font-medium text-muted ring-2 ring-surface">
          +{more}
        </span>
      ) : null}
    </span>
  );
}
