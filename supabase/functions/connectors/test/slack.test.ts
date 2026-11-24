import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { runSync } from "../lib/engine.ts";
import { dayOf, groupByDay, slack, type SlackMessage } from "../lib/slack.ts";
import { ConfigError } from "../lib/types.ts";
import { collect, fakeFetch, fixture, lastCursor, makeCtx, MemoryStore, upserts } from "./helpers.ts";

const CH = "CFIN0001";

interface Fx {
  history: { ok: true; messages: SlackMessage[] };
  replies: { ok: true; messages: SlackMessage[] };
  info: unknown;
  auth: unknown;
  users: Record<string, unknown>;
}

async function api(overrides: { history?: (url: URL) => unknown } = {}) {
  const fx = await fixture<Fx>("slack.json");
  const f = fakeFetch([
    ["GET https://slack.com/api/auth.test", () => fx.auth],
    ["GET https://slack.com/api/conversations.info", () => fx.info],
    ["GET https://slack.com/api/conversations.history", ({ url }) => {
      if (overrides.history) return overrides.history(url);
      const oldest = Number(url.searchParams.get("oldest"));
      const latest = Number(url.searchParams.get("latest") ?? Infinity);
      return { ...fx.history, messages: fx.history.messages.filter((m) => Number(m.ts) >= oldest && Number(m.ts) <= latest) };
    }],
    ["GET https://slack.com/api/conversations.replies", () => fx.replies],
    ["GET https://slack.com/api/users.info", ({ url }) => ({ ok: true, user: fx.users[url.searchParams.get("user")!] ?? { name: "ghost" } })],
  ]);
  return { f, fx };
}

Deno.test("slack: groups top-level messages into UTC days and drops thread replies", async () => {
  const { fx } = await api();
  const days = groupByDay([...fx.history.messages, fx.replies.messages[1]!]);
  assertEquals([...days.keys()], ["2026-11-23", "2026-11-24"]);
  assertEquals(days.get("2026-11-23")!.map((m) => m.user), ["U2", "U1"]); // oldest first, reply excluded
  assertEquals(dayOf("1795516200.000200"), "2026-11-24");
});

Deno.test("slack: full sync -> one doc per channel-day with threads, names and private-channel ACL", async () => {
  const { f } = await api();
  const changes = await collect(slack, makeCtx(slack, { channels: [CH] }, { fetch: f, full: true }));
  const docs = upserts(changes);
  assertEquals(docs.map((d) => d.externalId), [`${CH}:2026-11-23`, `${CH}:2026-11-24`]);
  const d1 = docs[0]!;
  assertEquals(d1.title, "#finance-private — 2026-11-23");
  assertEquals(d1.url, `https://acme.slack.com/archives/${CH}/p1795425300000400`);
  assertEquals(
    d1.content,
    [
      "# #finance-private — 2026-11-23",
      "**Bob Diaz** (09:15 UTC):\nMorning! Revenue dashboard is green.",
      "**alice** (16:45 UTC):\n**Reminder**: accruals are due Friday. See [the accrual guide](https://wiki.acme.example/accruals)",
      "> **Bob Diaz** (17:00 UTC, in thread):\n> Does that include the EU entity?",
      "> **alice** (17:10 UTC, in thread):\n> Yes, EU too.",
    ].join("\n\n"),
  );
  assertEquals(d1.acl, { restricted: true, refs: [{ slack_channel: CH }] });
  assertEquals(d1.metadata?.reply_count, 2);
  // channel_join noise is gone, mentions resolved
  assertEquals(docs[1]!.content, "# #finance-private — 2026-11-24\n\n**Bob Diaz** (10:30 UTC):\nQ4 close moves to Dec 5. cc @alice");
  assertEquals(lastCursor(changes)?.cursor, { channels: { [CH]: { oldest: "1795516200.000200" } } });
  // users.info is cached
  assertEquals(f.calls.filter((c) => c.url.includes("users.info")).length, 2);
});

Deno.test("slack: private channel maps to the group with external_ref.slack_channel", async () => {
  const { f } = await api();
  const store = new MemoryStore();
  const FIN = "00000000-0000-0000-0000-0000000000f1";
  await runSync({
    source: { id: "s", space_id: "sp", connector: "slack", config: { channels: [CH] }, audience: [], cursor: {}, status: "active" },
    connector: slack as never, store, token: "xoxb-test", full: true, fetch: f, log: () => {}, sleep: async () => {},
    now: () => new Date("2026-11-24T12:00:00Z"),
    groups: [{ id: FIN, external_ref: { slack_channel: CH } }, { id: "other", external_ref: { slack_channel: "COTHER" } }],
  });
  assertEquals([...store.docs.values()].map((d) => d.audience), [[FIN], [FIN]]);
});

Deno.test("slack: incremental sync asks for oldest = cursor - lookback and rebuilds only affected days", async () => {
  const { f } = await api();
  // everything up to the 2026-11-23 16:45 message was synced; a thread reply arrived later (latest_reply 17:10)
  const cursorTs = "1795452300.000300";
  const changes = await collect(slack, makeCtx(slack, { channels: [CH], thread_lookback_days: 1 }, { fetch: f, cursor: { channels: { [CH]: { oldest: cursorTs } } } }));
  const first = f.calls.find((c) => c.url.includes("conversations.history"))!;
  assertEquals(new URL(first.url).searchParams.get("oldest"), (Number(cursorTs) - 86400).toFixed(6));
  // 11-23 is rebuilt because of the newer thread reply, 11-24 because of the new message
  assertEquals(upserts(changes).map((d) => d.externalId), [`${CH}:2026-11-23`, `${CH}:2026-11-24`]);

  // without threads only the new day is touched
  const { f: f2 } = await api();
  const c2 = await collect(slack, makeCtx(slack, { channels: [CH], include_threads: false }, { fetch: f2, cursor: { channels: { [CH]: { oldest: cursorTs } } } }));
  assertEquals(upserts(c2).map((d) => d.externalId), [`${CH}:2026-11-24`]);
  assertEquals(f2.calls.some((c) => c.url.includes("conversations.replies")), false);
});

Deno.test("slack: min_reactions keeps only messages with enough reactions", async () => {
  const { f } = await api();
  const docs = upserts(await collect(slack, makeCtx(slack, { channels: [CH], min_reactions: 2 }, { fetch: f, full: true })));
  assertEquals(docs.map((d) => d.externalId), [`${CH}:2026-11-24`]);
});

Deno.test("slack: channels dropped from config are deleted; not_in_channel is a config error", async () => {
  const { f } = await api();
  const changes = await collect(slack, makeCtx(slack, { channels: [CH] }, { fetch: f, full: true, previous: { "COLD0001:2026-01-01": {} } }));
  assert(changes.some((c) => c.type === "delete" && c.externalId === "COLD0001:2026-01-01"));

  const { f: f2 } = await api({ history: () => ({ ok: false, error: "not_in_channel" }) });
  await assertRejects(() => collect(slack, makeCtx(slack, { channels: [CH] }, { fetch: f2 })), ConfigError, "invite it");
  assertThrows(() => slack.parseConfig({ channels: ["general"] }), ConfigError, "not a channel id");
});
