import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Table = "flags" | "proposals" | "curator_runs" | "concepts";

let instance = 0;
/** a first subscription within this long after mount does not reload: the page was just loaded */
const FRESH_MS = 3000;

/**
 * Subscribes to Realtime postgres_changes for a space and refreshes the server-rendered page when rows
 * change. postgres_changes respects RLS, so users only hear about rows they can read.
 */
export function LiveRefresh({ spaceId, tables, label = true }: { spaceId: string; tables: Table[]; label?: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState<"connecting" | "live" | "offline">("connecting");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = tables.join(",");

  useEffect(() => {
    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;
    const mountedAt = Date.now();
    let subscribedBefore = false;
    const refresh = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => router.invalidate(), 350);
    };
    (async () => {
      // make sure realtime uses the user's JWT (RLS) before subscribing
      const { data } = await supabase.auth.getSession();
      if (data.session) await supabase.realtime.setAuth(data.session.access_token);
      if (cancelled) return;
      // a unique topic per mount: supabase.channel() returns an existing channel with the same topic, so a remount
      // (or two components on one page) would otherwise reuse a channel the previous cleanup is removing
      channel = supabase.channel(`space:${spaceId}:${key}:${++instance}`);
      for (const table of key.split(",")) {
        channel.on("postgres_changes", { event: "*", schema: "public", table, filter: `space_id=eq.${spaceId}` }, refresh);
      }
      channel.subscribe((s) => {
        if (s === "SUBSCRIBED") {
          // changes made while we were not subscribed were never delivered: reload on every (re)subscribe, except
          // a first one right after mount, when the page data is as fresh as the subscription (no double load)
          if (subscribedBefore || Date.now() - mountedAt > FRESH_MS) refresh();
          subscribedBefore = true;
        }
        setStatus(s === "SUBSCRIBED" ? "live" : s === "CLOSED" || s === "CHANNEL_ERROR" || s === "TIMED_OUT" ? "offline" : "connecting");
      });
    })();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [spaceId, key, router]);

  if (!label) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-subtle" title="Updates appear here as they happen (Supabase Realtime)">
      <span className={`size-1.5 rounded-full ${status === "live" ? "animate-pulse bg-ok" : status === "offline" ? "bg-danger" : "bg-warn"}`} />
      {status === "live" ? "Live" : status === "offline" ? "Offline" : "Connecting"}
    </span>
  );
}
