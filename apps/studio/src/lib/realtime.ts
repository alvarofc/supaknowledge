import type { RealtimeChannel, RealtimePresenceState } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

/**
 * Private Realtime channels shared by topic. Realtime Authorization (RLS on realtime.messages, migration
 * 20261127000300) checks the exact topic, so a topic cannot get a unique suffix per mount the way LiveRefresh's
 * postgres_changes channels do. supabase.channel() returns the existing channel for a topic, including one that a
 * component which just unmounted is still leaving, so channels are reference-counted here and closed shortly after
 * the last user leaves (a navigation from the proposal page to the inbox reuses the channel instead).
 *
 *   proposal:<id>   presence (who is viewing / reviewing a proposal)
 *   curator:<space> broadcast "progress" events from the curator
 */

export type ChannelStatus = "connecting" | "live" | "offline";

export interface BroadcastMessage {
  event: string;
  payload: unknown;
  meta?: { replayed?: boolean; id: string };
}

interface Listeners {
  onPresence?: (state: RealtimePresenceState) => void;
  onBroadcast?: (msg: BroadcastMessage) => void;
  onStatus?: (status: ChannelStatus) => void;
}

interface Shared {
  refs: number;
  closeTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  channel: RealtimeChannel | null;
  status: ChannelStatus;
  presence: RealtimePresenceState;
  listeners: Set<Listeners>;
  /** what this tab tracks on the channel (re-sent after a reconnect) */
  tracked: Record<string, unknown> | null;
}

export interface ChannelOptions {
  /** receive presence; `key` groups one person's tabs (we use the user id) */
  presence?: { key: string };
  /** receive broadcast "progress" events, replaying stored ones sent since this time (ms) */
  broadcast?: { replaySince?: number };
}

const channels = new Map<string, Shared>();
/** keep a channel this long after its last user leaves, so a remount or the next page reuses it */
const LINGER_MS = 1_500;

function open(topic: string, opts: ChannelOptions, s: Shared) {
  void (async () => {
    const supabase = createClient();
    // private channels authorize with the user's JWT
    const { data } = await supabase.auth.getSession();
    if (data.session) await supabase.realtime.setAuth(data.session.access_token);
    if (s.closed) return;
    const replay = opts.broadcast?.replaySince ? { replay: { since: Math.floor(opts.broadcast.replaySince), limit: 25 } } : {};
    const channel = supabase.channel(topic, {
      config: {
        private: true,
        ...(opts.presence ? { presence: { key: opts.presence.key, enabled: true } } : {}),
        ...(opts.broadcast ? { broadcast: replay } : {}),
      },
    });
    s.channel = channel;
    if (opts.presence) {
      channel.on("presence", { event: "sync" }, () => {
        s.presence = channel.presenceState();
        for (const l of s.listeners) l.onPresence?.(s.presence);
      });
    }
    if (opts.broadcast) {
      channel.on("broadcast", { event: "progress" }, (msg) => {
        const m: BroadcastMessage = { event: msg.event, payload: (msg as { payload?: unknown }).payload, meta: msg.meta };
        for (const l of s.listeners) l.onBroadcast?.(m);
      });
    }
    channel.subscribe((state) => {
      s.status = state === "SUBSCRIBED" ? "live" : state === "CLOSED" || state === "CHANNEL_ERROR" || state === "TIMED_OUT" ? "offline" : "connecting";
      for (const l of s.listeners) l.onStatus?.(s.status);
      if (state === "SUBSCRIBED" && s.tracked) void channel.track(s.tracked);
    });
  })();
}

function close(topic: string, s: Shared) {
  s.closed = true;
  channels.delete(topic);
  if (s.channel) void createClient().removeChannel(s.channel);
}

export interface ChannelHandle {
  /** start or update what this tab tracks in presence */
  track: (payload: Record<string, unknown>) => void;
  /** stop appearing in presence */
  untrack: () => void;
  leave: () => void;
}

/** Join (or share) a private channel. Call `leave()` on unmount. Browser only. */
export function joinChannel(topic: string, opts: ChannelOptions, listeners: Listeners): ChannelHandle {
  let s = channels.get(topic);
  if (!s) {
    s = { refs: 0, closeTimer: null, closed: false, channel: null, status: "connecting", presence: {}, listeners: new Set(), tracked: null };
    channels.set(topic, s);
    open(topic, opts, s);
  }
  const shared = s;
  if (shared.closeTimer) {
    clearTimeout(shared.closeTimer);
    shared.closeTimer = null;
  }
  shared.refs++;
  shared.listeners.add(listeners);
  // late joiners get the current state right away
  queueMicrotask(() => {
    if (!shared.listeners.has(listeners)) return;
    listeners.onStatus?.(shared.status);
    if (Object.keys(shared.presence).length) listeners.onPresence?.(shared.presence);
  });

  let tracking = false;
  let left = false;
  const track = (payload: Record<string, unknown>) => {
    if (left) return;
    tracking = true;
    shared.tracked = payload;
    if (shared.channel && shared.status === "live") void shared.channel.track(payload);
  };
  const untrack = () => {
    if (!tracking) return;
    tracking = false;
    shared.tracked = null;
    if (shared.channel && shared.status === "live") void shared.channel.untrack();
  };
  const leave = () => {
    if (left) return;
    left = true;
    untrack();
    shared.listeners.delete(listeners);
    shared.refs--;
    if (shared.refs <= 0 && !shared.closed) shared.closeTimer = setTimeout(() => close(topic, shared), LINGER_MS);
  };
  return { track, untrack, leave };
}
