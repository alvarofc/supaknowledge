// Slack connector (Web API).
//   config: { channels: string[] (ids), include_threads?: boolean (default true), min_reactions?: number (default 0),
//             since_days?: number (initial backfill, default 90), thread_lookback_days?: number (default 7),
//             acl_strict?: boolean }
//   token:  bot token (xoxb-…) with channels:history, groups:history, channels:read, groups:read, users:read
//   cursor: { channels: { [channel_id]: { oldest: "<ts of last synced message>" } } }
// One document per channel per UTC day ("C123:2026-11-24") containing the day's messages and, optionally,
// their thread replies. A day is rebuilt whenever it gets new messages (or, within the lookback window,
// new thread replies). Private channels are restricted upstream and map to groups whose external_ref has
// {"slack_channel": "<channel id>"}.
import { getJson } from "./http.ts";
import { slackToMarkdown } from "./markdown.ts";
import { asObject, AuthError, type Connector, ConfigError, type DocumentChange, optBool, optNumber, stringList, type SyncContext, UpstreamError } from "./types.ts";

export interface SlackConfig {
  channels: string[];
  include_threads: boolean;
  min_reactions: number;
  since_days: number;
  thread_lookback_days: number;
}

export interface SlackMessage {
  type?: string;
  subtype?: string;
  ts: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  reactions?: { name: string; count: number }[];
  files?: { name?: string; title?: string }[];
}

interface SlackChannel {
  id: string;
  name?: string;
  is_private?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_archived?: boolean;
}

const API = "https://slack.com/api";
const SKIP_SUBTYPES = new Set([
  "channel_join", "channel_leave", "channel_topic", "channel_purpose", "channel_name", "channel_archive",
  "channel_unarchive", "group_join", "group_leave", "group_topic", "group_purpose", "group_name", "pinned_item",
  "unpinned_item", "bot_add", "bot_remove", "reminder_add",
]);

export function dayOf(ts: string): string {
  return new Date(Number(ts) * 1000).toISOString().slice(0, 10);
}

function dayBounds(day: string): [number, number] {
  const start = Date.parse(`${day}T00:00:00Z`) / 1000;
  return [start, start + 86400];
}

function reactionCount(m: SlackMessage): number {
  return (m.reactions ?? []).reduce((n, r) => n + (r.count ?? 0), 0);
}

function keep(m: SlackMessage): boolean {
  if (m.subtype && SKIP_SUBTYPES.has(m.subtype)) return false;
  return !!(m.text?.trim() || m.files?.length);
}

/** Group top-level messages into UTC days, oldest first. Thread replies are attached separately. */
export function groupByDay(messages: SlackMessage[]): Map<string, SlackMessage[]> {
  const days = new Map<string, SlackMessage[]>();
  for (const m of [...messages].sort((a, b) => Number(a.ts) - Number(b.ts))) {
    // replies broadcast to the channel show up in history too; they belong to their thread
    if (m.thread_ts && m.thread_ts !== m.ts && m.subtype !== "thread_broadcast") continue;
    const d = dayOf(m.ts);
    if (!days.has(d)) days.set(d, []);
    days.get(d)!.push(m);
  }
  return days;
}

export function renderDay(
  channel: { id: string; name: string },
  day: string,
  messages: SlackMessage[],
  replies: Map<string, SlackMessage[]>,
  userName: (id: string) => string | undefined,
): string {
  const time = (ts: string) => new Date(Number(ts) * 1000).toISOString().slice(11, 16);
  const who = (m: SlackMessage) => (m.user ? userName(m.user) ?? m.user : m.username ?? (m.bot_id ? "bot" : "unknown"));
  const body = (m: SlackMessage) => {
    const t = slackToMarkdown(m.text ?? "", { user: userName });
    const files = (m.files ?? []).map((f) => `[file: ${f.title ?? f.name ?? "attachment"}]`).join(" ");
    return [t, files].filter(Boolean).join("\n");
  };
  const parts = [`# #${channel.name} — ${day}`];
  for (const m of messages) {
    parts.push(`**${who(m)}** (${time(m.ts)} UTC):\n${body(m)}`);
    const thread = (replies.get(m.ts) ?? []).filter((r) => r.ts !== m.ts && keep(r));
    for (const r of thread) {
      const d = dayOf(r.ts) === day ? time(r.ts) : `${dayOf(r.ts)} ${time(r.ts)}`;
      parts.push(`> **${who(r)}** (${d} UTC, in thread):\n${body(r).split("\n").map((l) => `> ${l}`).join("\n")}`);
    }
  }
  return parts.join("\n\n");
}

export const slack: Connector<SlackConfig> = {
  kind: "slack",
  parseConfig(raw) {
    const o = asObject(raw);
    const channels = stringList(o, "channels", { required: true });
    for (const c of channels) if (!/^[CGD][A-Z0-9]{6,}$/.test(c)) throw new ConfigError(`config.channels: "${c}" is not a channel id (e.g. C0123ABCD)`);
    return {
      channels,
      include_threads: optBool(o, "include_threads", true),
      min_reactions: optNumber(o, "min_reactions", 0, 0, 1000),
      since_days: optNumber(o, "since_days", 90, 1, 3650),
      thread_lookback_days: optNumber(o, "thread_lookback_days", 7, 0, 90),
    };
  },

  async *sync(ctx: SyncContext<SlackConfig>): AsyncGenerator<DocumentChange> {
    if (!ctx.token) throw new ConfigError("slack source has no token; call set_source_secret with the bot token");
    const headers = { Authorization: `Bearer ${ctx.token}` };
    const { config } = ctx;

    // deno-lint-ignore no-explicit-any
    const call = async <T extends Record<string, any>>(method: string, params: Record<string, string | number | boolean | undefined>): Promise<T> => {
      const url = new URL(`${API}/${method}`);
      for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
      const r = await getJson<T & { ok: boolean; error?: string }>(ctx, url, { headers });
      if (!r.ok) {
        const err = r.error ?? "unknown_error";
        if (["invalid_auth", "not_authed", "token_revoked", "account_inactive", "token_expired"].includes(err)) {
          throw new AuthError(`slack ${method}: ${err}`);
        }
        if (err === "not_in_channel") throw new ConfigError(`slack: the bot is not a member of ${params.channel}; invite it to the channel`);
        if (err === "channel_not_found") throw new ConfigError(`slack: channel ${params.channel} not found (or bot lacks access)`);
        if (err === "missing_scope") throw new ConfigError(`slack ${method}: missing scope ${(r as { needed?: string }).needed ?? ""}`);
        throw new UpstreamError(200, `slack ${method}: ${err}`);
      }
      return r;
    };

    const auth = await call<{ url?: string; team_id?: string }>("auth.test", {});
    const teamUrl = (auth.url ?? "https://slack.com/").replace(/\/?$/, "/");

    const users = new Map<string, string>();
    const resolveUsers = async (ids: Iterable<string>) => {
      for (const id of ids) {
        if (users.has(id)) continue;
        try {
          const r = await call<{ user: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } }>("users.info", { user: id });
          const u = r.user;
          users.set(id, u.profile?.display_name || u.real_name || u.profile?.real_name || u.name || id);
        } catch (e) {
          if (e instanceof AuthError) throw e;
          users.set(id, id);
        }
      }
    };
    const mentioned = (msgs: SlackMessage[]) => {
      const ids = new Set<string>();
      for (const m of msgs) {
        if (m.user) ids.add(m.user);
        for (const x of (m.text ?? "").matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/g)) ids.add(x[1]!);
      }
      return ids;
    };

    const history = async (channel: string, oldest: number, latest?: number): Promise<SlackMessage[]> => {
      const out: SlackMessage[] = [];
      let cursor: string | undefined;
      do {
        const r = await call<{ messages: SlackMessage[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>(
          "conversations.history",
          { channel, oldest: oldest.toFixed(6), latest: latest?.toFixed(6), inclusive: true, limit: 200, cursor },
        );
        out.push(...r.messages);
        cursor = r.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return out;
    };

    const repliesOf = async (channel: string, ts: string): Promise<SlackMessage[]> => {
      const out: SlackMessage[] = [];
      let cursor: string | undefined;
      do {
        const r = await call<{ messages: SlackMessage[]; response_metadata?: { next_cursor?: string } }>(
          "conversations.replies",
          { channel, ts, limit: 200, cursor },
        );
        out.push(...r.messages);
        cursor = r.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return out;
    };

    const chanCursor: Record<string, { oldest: string }> = {
      ...((ctx.cursor.channels as Record<string, { oldest: string }>) ?? {}),
    };
    const nowSec = ctx.now().getTime() / 1000;
    let fetched = 0;
    let capped = false;

    // channels removed from the config: their day documents leave the synced scope
    const configured = new Set(config.channels);
    for (const id of ctx.known()) {
      const ch = id.split(":")[0]!;
      if (!configured.has(ch) && !ctx.previous(id)?.deleted) yield { type: "delete", externalId: id, reason: "channel removed from config" };
    }

    for (const channelId of config.channels) {
      if (capped) break;
      const info = (await call<{ channel: SlackChannel }>("conversations.info", { channel: channelId })).channel;
      const name = info.name ?? channelId;
      const restricted = !!(info.is_private || info.is_im || info.is_mpim);
      const prevOldest = ctx.full ? undefined : chanCursor[channelId]?.oldest;
      const since = prevOldest ? Number(prevOldest) : nowSec - config.since_days * 86400;
      const fetchOldest = prevOldest && config.include_threads ? since - config.thread_lookback_days * 86400 : since;

      const msgs = (await history(channelId, fetchOldest)).filter(keep);
      const affected = new Set<string>();
      let maxTs = since;
      for (const m of msgs) {
        const ts = Number(m.ts);
        maxTs = Math.max(maxTs, ts);
        if (!prevOldest || ts > since) affected.add(dayOf(m.ts));
        else if (config.include_threads && m.latest_reply && Number(m.latest_reply) > since) affected.add(dayOf(m.ts));
      }
      const byDay = groupByDay(msgs);

      for (const day of [...affected].sort()) {
        const extId = `${channelId}:${day}`;
        if (fetched >= ctx.limit) {
          capped = true;
          break;
        }
        const [dStart, dEnd] = dayBounds(day);
        // the fetched window may only cover part of the day: refetch the whole day then
        let dayMsgs = byDay.get(day) ?? [];
        if (dStart < fetchOldest) dayMsgs = [...groupByDay((await history(channelId, dStart, dEnd - 0.000001)).filter(keep)).get(day) ?? []];
        if (config.min_reactions > 0) dayMsgs = dayMsgs.filter((m) => reactionCount(m) >= config.min_reactions);

        const replies = new Map<string, SlackMessage[]>();
        if (config.include_threads) {
          for (const m of dayMsgs) if ((m.reply_count ?? 0) > 0) replies.set(m.ts, await repliesOf(channelId, m.ts));
        }
        const dayMax = Math.max(...(byDay.get(day) ?? []).map((m) => Number(m.ts)), dStart);
        if (!dayMsgs.length) {
          if (ctx.previous(extId) && !ctx.previous(extId)!.deleted) yield { type: "delete", externalId: extId, reason: "no qualifying messages" };
        } else {
          fetched++;
          await resolveUsers(mentioned([...dayMsgs, ...[...replies.values()].flat()]));
          const content = renderDay({ id: channelId, name }, day, dayMsgs, replies, (id) => users.get(id));
          const first = dayMsgs[0]!;
          const lastTs = Math.max(...dayMsgs.map((m) => Number(m.ts)), ...[...replies.values()].flat().map((m) => Number(m.ts)));
          yield {
            type: "upsert",
            doc: {
              externalId: extId,
              title: `#${name} — ${day}`,
              url: `${teamUrl}archives/${channelId}/p${first.ts.replace(".", "")}`,
              content,
              mimeType: "text/markdown",
              raw: { body: JSON.stringify({ channel: info, day, messages: dayMsgs, replies: Object.fromEntries(replies) }, null, 2), ext: "json", contentType: "application/json" },
              author: null,
              updatedAt: new Date(lastTs * 1000).toISOString(),
              metadata: {
                channel_id: channelId,
                channel_name: name,
                day,
                message_count: dayMsgs.length,
                reply_count: [...replies.values()].reduce((n, r) => n + Math.max(0, r.length - 1), 0),
                private: restricted,
              },
              acl: { restricted, refs: [{ slack_channel: channelId }] },
            },
          };
        }
        // checkpoint: everything up to the end of this day is synced
        const prevMark = Number(chanCursor[channelId]?.oldest ?? 0);
        const mark = Math.max(prevMark, ctx.full ? dayMax : Math.max(since, dayMax));
        chanCursor[channelId] = { oldest: mark.toFixed(6) };
        yield { type: "cursor", cursor: { channels: { ...chanCursor } } };
      }
      if (!capped) {
        chanCursor[channelId] = { oldest: Math.max(maxTs, Number(chanCursor[channelId]?.oldest ?? 0)).toFixed(6) };
        yield { type: "cursor", cursor: { channels: { ...chanCursor } } };
      }
    }
    yield { type: "cursor", cursor: { channels: chanCursor }, more: capped };
  },
};
