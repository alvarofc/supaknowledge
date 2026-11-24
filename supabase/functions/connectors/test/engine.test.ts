import { assert, assertEquals, assertRejects } from "@std/assert";
import { isNarrowerOrEqual, matchAcl, matchGroups, resolveAudience } from "../lib/acl.ts";
import { runSync, type SourceRow, storagePath } from "../lib/engine.ts";
import type { DocumentChange } from "../lib/types.ts";
import { MemoryStore, scripted } from "./helpers.ts";

const G_FIN = "00000000-0000-0000-0000-00000000f1f1";
const G_ENG = "00000000-0000-0000-0000-00000000e1e1";
const G_OPS = "00000000-0000-0000-0000-00000000a1a1";
const groups = [
  { id: G_FIN, external_ref: { slack_channel: "CFIN", github_team: ["acme/finance", "acme/fin-leads"] } },
  { id: G_ENG, external_ref: { github_team: "acme/eng" } },
  { id: G_OPS, external_ref: { slack_channel: "COPS" } },
];

Deno.test("acl: external_ref matching (strings, arrays, case-insensitive)", () => {
  assertEquals(matchGroups([{ slack_channel: "CFIN" }], groups), [G_FIN]);
  assertEquals(matchGroups([{ github_team: "ACME/fin-leads" }, { github_team: "acme/eng" }], groups), [G_ENG, G_FIN].sort());
  assertEquals(matchGroups([{ slack_channel: "CNOPE" }], groups), []);
});

Deno.test("acl: narrowing rules", () => {
  // unrestricted source -> mapped groups
  assertEquals(resolveAudience([], { restricted: true, refs: [{ slack_channel: "CFIN" }] }, groups), { kind: "ok", audience: [G_FIN], mode: "mapped", groups: [G_FIN] });
  // no acl -> source audience
  assertEquals(resolveAudience([G_ENG], undefined, groups), { kind: "ok", audience: [G_ENG], mode: "inherit", groups: [] });
  // restricted source: intersection
  const r = resolveAudience([G_FIN, G_ENG], { restricted: true, refs: [{ slack_channel: "CFIN" }] }, groups);
  assertEquals(r.kind === "ok" && r.audience, [G_FIN]);
  // disjoint: keep the (narrower-or-equal) source audience, never the mapped group
  const d = resolveAudience([G_ENG], { restricted: true, refs: [{ slack_channel: "CFIN" }] }, groups);
  assertEquals(d.kind === "ok" && d.audience, [G_ENG]);
  // unmapped private object: inherit, or skip in strict mode
  assertEquals(resolveAudience([], { restricted: true, refs: [{ slack_channel: "CX" }] }, groups).kind, "ok");
  assertEquals(resolveAudience([], { restricted: true, refs: [{ slack_channel: "CX" }] }, groups, { strict: true }).kind, "skip");
});

Deno.test("acl: property - a document is never wider than its source", () => {
  const ids = [G_FIN, G_ENG, G_OPS];
  const refsPool: Record<string, string>[] = [{ slack_channel: "CFIN" }, { slack_channel: "COPS" }, { github_team: "acme/eng" }, { github_team: "acme/fin-leads" }, { slack_channel: "CX" }];
  let seed = 7;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let i = 0; i < 2000; i++) {
    const source = ids.filter(() => rnd() < 0.4);
    const refs = refsPool.filter(() => rnd() < 0.4);
    const acl = rnd() < 0.2 ? undefined : { restricted: rnd() < 0.5, refs };
    const d = resolveAudience(source, acl, groups, { strict: rnd() < 0.5 });
    if (d.kind === "ok") assert(isNarrowerOrEqual(source, d.audience), `source=${source} doc=${d.audience}`);
  }
});

function source(over: Partial<SourceRow> = {}): SourceRow {
  return { id: "src-1", space_id: "space-1", connector: "web", config: {}, audience: [], cursor: {}, status: "active", ...over };
}

function doc(id: string, content: string, extra: Record<string, unknown> = {}): DocumentChange {
  return { type: "upsert", doc: { externalId: id, title: id, content, raw: { body: content, ext: "md", contentType: "text/markdown" }, ...extra } };
}

const base = { groups, token: null, full: false, fetch: globalThis.fetch, log: () => {} };

Deno.test("engine: upserts, dedupes by content hash, stores raw under <space>/<source>/", async () => {
  const store = new MemoryStore();
  let r = await runSync({ ...base, source: source(), store, connector: scripted([doc("a/b", "hello"), doc("c", "world"), { type: "cursor", cursor: { n: 1 } }]) });
  assertEquals([r.upserted, r.unchanged], [2, 0]);
  assertEquals(r.cursor, { n: 1 });
  const path = store.docs.get("a/b")!.storage_path!;
  assert(path.startsWith("space-1/src-1/a_b-") && path.endsWith(".md"), path);
  assertEquals(path, await storagePath("space-1", "src-1", "a/b", "md"));
  assert(store.raw.has(path));
  assertEquals(store.docs.get("a/b")!.content_hash, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");

  // same content again -> no write; changed content -> write
  const writes = store.docs.get("c")!;
  r = await runSync({ ...base, source: source(), store, connector: scripted([doc("a/b", "hello"), doc("c", "world!")]) });
  assertEquals([r.upserted, r.unchanged], [1, 1]);
  assert(store.docs.get("c") !== writes);
});

Deno.test("engine: version-only change touches metadata without rewriting content", async () => {
  const store = new MemoryStore();
  await runSync({ ...base, source: source(), store, connector: scripted([doc("x", "same", { version: "v1" })]) });
  await runSync({ ...base, source: source(), store, connector: scripted([doc("x", "same", { version: "v2" })]) });
  assertEquals(store.touched.length, 1);
  assertEquals(store.docs.get("x")!.metadata.version, "v2");
});

Deno.test("engine: ACL narrowing applied per document and audience changes are written", async () => {
  const store = new MemoryStore();
  const priv = doc("CFIN:2026-11-24", "q4 numbers", { acl: { restricted: true, refs: [{ slack_channel: "CFIN" }] } });
  const pub = doc("CGEN:2026-11-24", "lunch", { acl: { restricted: false, refs: [{ slack_channel: "CGEN" }] } });
  await runSync({ ...base, source: source(), store, connector: scripted([priv, pub]) });
  assertEquals(store.docs.get("CFIN:2026-11-24")!.audience, [G_FIN]);
  assertEquals(store.docs.get("CGEN:2026-11-24")!.audience, []);
  assertEquals((store.docs.get("CFIN:2026-11-24")!.metadata.acl as { mode: string }).mode, "mapped");

  // source narrowed later: same content but audience must be rewritten
  const r = await runSync({ ...base, source: source({ audience: [G_OPS] }), store, connector: scripted([priv, pub]) });
  assertEquals(r.upserted, 2);
  assertEquals(store.docs.get("CFIN:2026-11-24")!.audience, [G_OPS]); // disjoint -> source audience, never wider
  assertEquals(store.docs.get("CGEN:2026-11-24")!.audience, [G_OPS]);
});

Deno.test("engine: acl_strict skips unmapped private docs and retracts earlier copies", async () => {
  const store = new MemoryStore();
  const p = doc("CSECRET:2026-11-24", "salaries", { acl: { restricted: true, refs: [{ slack_channel: "CSECRET" }] } });
  await runSync({ ...base, source: source(), store, connector: scripted([p]) });
  assertEquals(store.live(), ["CSECRET:2026-11-24"]);
  const r = await runSync({ ...base, source: source({ config: { acl_strict: true } }), store, connector: scripted([p]) });
  assertEquals([r.skipped, r.deleted], [1, 1]);
  assertEquals(store.live(), []);
});

Deno.test("engine: deletes, snapshots and revival re-embed", async () => {
  const store = new MemoryStore();
  await runSync({ ...base, source: source(), store, connector: scripted([doc("a", "1"), doc("b", "2"), doc("c", "3")]) });
  let r = await runSync({ ...base, source: source(), store, connector: scripted([{ type: "delete", externalId: "a" }, { type: "delete", externalId: "zzz" }]) });
  assertEquals(r.deleted, 1);
  r = await runSync({ ...base, source: source(), store, connector: scripted([{ type: "snapshot", externalIds: ["b"] }]) });
  assertEquals(r.deleted, 1);
  assertEquals(store.live(), ["b"]);
  // "a" comes back unchanged -> undeleted and re-embedded (chunks were dropped on delete)
  r = await runSync({ ...base, source: source(), store, connector: scripted([doc("a", "1")]) });
  assertEquals(r.upserted, 1);
  assertEquals(store.live(), ["a", "b"]);
  assertEquals(store.reembedded, [store.docs.get("a")!.id]);
});

Deno.test("engine: checkpoints are saved as they come; time budget stops at the last one", async () => {
  const store = new MemoryStore();
  const changes: DocumentChange[] = [doc("1", "a"), { type: "cursor", cursor: { at: 1 } }, doc("2", "b"), { type: "cursor", cursor: { at: 2 } }];
  const r = await runSync({ ...base, source: source({ cursor: { at: 0 } }), store, connector: scripted(changes) });
  assertEquals(store.cursors, [{ at: 1 }, { at: 2 }]);
  assertEquals(r.cursor, { at: 2 });
  assertEquals(r.more, false);

  const slow = await runSync({ ...base, source: source({ cursor: { at: 0 } }), store: new MemoryStore(), connector: scripted(changes), deadline: Date.now() - 1 });
  assertEquals([slow.upserted, slow.more], [0, true]);
  assertEquals(slow.cursor, { at: 0 });
});

Deno.test("engine: connector-reported `more` and per-run cap", async () => {
  const many: DocumentChange[] = Array.from({ length: 10 }, (_, i) => doc(`d${i}`, `c${i}`));
  const r = await runSync({ ...base, source: source(), store: new MemoryStore(), connector: scripted(many), limit: 3 });
  // a connector that ignores ctx.limit is stopped at 2x the cap
  assertEquals([r.upserted, r.more], [6, true]);
  const r2 = await runSync({ ...base, source: source(), store: new MemoryStore(), connector: scripted([doc("a", "x"), { type: "cursor", cursor: { p: 1 }, more: true }]) });
  assertEquals(r2.more, true);
});

Deno.test("engine: config errors surface before any write", async () => {
  const store = new MemoryStore();
  const bad = { ...scripted([]), parseConfig: () => { throw new Error("config.repo is required"); } };
  await assertRejects(() => runSync({ ...base, source: source(), store, connector: bad }), Error, "config.repo");
  assertEquals(store.docs.size, 0);
});

Deno.test("acl: tiers - the most specific matching tier wins and object refs narrow it", () => {
  const gs = [
    { id: "root", external_ref: { gdrive_folder: "ROOT" } },
    { id: "sub", external_ref: { gdrive_folder: "SUB" } },
    { id: "grp", external_ref: { google_group: "g@x" } },
  ];
  const tiers = [[{ gdrive_folder: "SUB" }], [{ gdrive_folder: "ROOT" }]];
  assertEquals(matchAcl({ restricted: true, refs: [], tiers }, gs), ["sub"]);
  assertEquals(matchAcl({ restricted: true, refs: [], tiers: [[{ gdrive_folder: "NONE" }], [{ gdrive_folder: "ROOT" }]] }, gs), ["root"]);
  assertEquals(matchAcl({ restricted: true, refs: [{ google_group: "g@x" }], tiers }, gs), ["sub"]); // disjoint -> tier
  assertEquals(matchAcl({ restricted: true, refs: [{ google_group: "g@x" }], tiers: [[{ gdrive_folder: "NONE" }]] }, gs), ["grp"]);
  // the old flat-refs union widened to both groups; tiers never do
  assertEquals(matchGroups([{ gdrive_folder: "SUB" }, { gdrive_folder: "ROOT" }], gs), ["root", "sub"]);
});
