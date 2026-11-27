import { assert, assertEquals, assertMatch, assertRejects, assertStringIncludes } from "@std/assert";
import { sha256 } from "../../_shared/core/chunk.ts";
import { runSync } from "../lib/engine.ts";
import { normaliseProjectRef, schema } from "../lib/schema.ts";
import { detectSchemaDrift, schemaChanges } from "../lib/schema-drift.ts";
import { AuthError, ConfigError, type Cursor } from "../lib/types.ts";
import { collect, fakeFetch, lastCursor, makeCtx, MemoryStore, upserts } from "./helpers.ts";

const REF = "abcdefghijklmnopqrst";
const URL_QUERY = `https://api.supabase.com/v1/projects/${REF}/database/query`;

const col = (name: string, type: string) => ({ name, type, nullable: true, default: null, comment: null });
function snap(amount = "amount", extra: unknown[] = []) {
  return {
    tables: [
      {
        schema: "public", name: "orders", kind: "table", comment: "One row per checkout.", rls_enabled: true,
        columns: [col("id", "uuid"), col(amount, "numeric"), col("status", "text")], primary_key: ["id"], foreign_keys: [],
        policies: [{ name: "own", command: "select", permissive: true, roles: ["authenticated"], using: "(auth.uid() = id)", check: null }],
        definition: null,
      },
      ...extra,
    ],
    functions: [],
  };
}
const customers = { schema: "public", name: "customers", kind: "table", comment: null, rls_enabled: false, columns: [col("id", "uuid")], primary_key: [], foreign_keys: [], policies: [], definition: null };

function api(snapshot: unknown, status = 200) {
  return fakeFetch([[`POST ${URL_QUERY}`, () => status === 200 ? [{ snapshot }] : new Response('{"message":"nope"}', { status })]]);
}

Deno.test("schema: config takes a ref or a project URL and plain schema names", () => {
  assertEquals(schema.parseConfig({ project_ref: REF }), { project_ref: REF, schemas: ["public"] });
  assertEquals(schema.parseConfig({ project_ref: REF, schemas: [] }).schemas, ["public"], "the Studio form stores an empty list");
  assertEquals(schema.parseConfig({ project_ref: `https://${REF}.supabase.co`, schemas: ["public", "billing", "public"] }).schemas, ["billing", "public"]);
  assertEquals(normaliseProjectRef(`https://supabase.com/dashboard/project/${REF}/editor`), REF);
  assertEquals(normaliseProjectRef("https://evil.example/abcdefghijklmnopqrst"), null);
  for (const bad of [{}, { project_ref: "short" }, { project_ref: REF, schemas: ["public; drop"] }]) {
    let threw = false;
    try {
      schema.parseConfig(bad);
    } catch (e) {
      threw = e instanceof ConfigError;
    }
    assert(threw, JSON.stringify(bad));
  }
});

Deno.test("schema: one read-only query to the Management API, documents per schema and table, snapshot cursor", async () => {
  const f = api(snap("amount", [customers]));
  const changes = await collect(schema, makeCtx(schema, { project_ref: REF, schemas: ["public"] }, { fetch: f, token: "sbp_test" }));
  assertEquals(f.calls.length, 1);
  const call = f.calls[0]!;
  assertEquals(call.headers.get("authorization"), "Bearer sbp_test");
  const body = JSON.parse(call.body!);
  assertEquals(body.read_only, true);
  assertStringIncludes(body.query, "n.nspname in ('public')");
  const docs = upserts(changes);
  assertEquals(docs.map((d) => d.externalId), ["schema:public", "table:public.customers", "table:public.orders"]);
  assertStringIncludes(docs[2]!.content, "| `amount` | numeric | yes |");
  const snapshotChange = changes.find((c) => c.type === "snapshot");
  assertEquals(snapshotChange?.type === "snapshot" && snapshotChange.externalIds.length, 3);
  const cur = lastCursor(changes)!;
  assertEquals(cur.more, undefined);
  assertEquals((cur.cursor.snapshot as { tables: unknown[] }).tables.length, 2);
  assertEquals(cur.cursor.project_ref, REF);
});

Deno.test("schema: unchanged documents are skipped and the per-run cap continues later", async () => {
  const first = upserts(await collect(schema, makeCtx(schema, { project_ref: REF }, { fetch: api(snap("amount", [customers])) })));
  const previous: Record<string, { contentHash: string }> = {};
  for (const d of first) previous[d.externalId] = { contentHash: await sha256(d.content) };
  const again = await collect(schema, makeCtx(schema, { project_ref: REF }, { fetch: api(snap("amount_cents", [customers])), previous }));
  assertEquals(upserts(again).map((d) => d.externalId), ["table:public.orders"]);

  const capped = await collect(schema, makeCtx(schema, { project_ref: REF }, { fetch: api(snap("amount", [customers])), limit: 1 }));
  assertEquals(upserts(capped).length, 1);
  assertEquals(lastCursor(capped)!.more, true);
  assert(!capped.some((c) => c.type === "snapshot"), "no deletions from a partial run");
});

Deno.test("schema: credentials and project errors", async () => {
  const cfg = { project_ref: REF };
  await assertRejects(() => collect(schema, makeCtx(schema, cfg, { fetch: api(null), token: null })), ConfigError, "no access token");
  await assertRejects(() => collect(schema, makeCtx(schema, cfg, { fetch: api(null, 401) })), AuthError);
  await assertRejects(() => collect(schema, makeCtx(schema, cfg, { fetch: api(null, 403) })), AuthError);
  await assertRejects(() => collect(schema, makeCtx(schema, cfg, { fetch: api(null, 404) })), ConfigError, "not found");
});

Deno.test("schema: engine marks documents of dropped tables deleted", async () => {
  const store = new MemoryStore();
  const source = { id: "src", space_id: "space", connector: "schema" as const, config: { project_ref: REF }, audience: [], cursor: {}, status: "active" as const };
  const run = (snapshot: unknown, cursor: Cursor = {}) =>
    runSync({ source: { ...source, cursor }, connector: schema as never, store, groups: [], token: "sbp", full: true, fetch: api(snapshot), log: () => {}, env: () => undefined });
  const r1 = await run(snap("amount", [customers]));
  assertEquals(r1.upserted, 3);
  const r2 = await run(snap("amount"), r1.cursor);
  assertEquals(r2.deleted, 1);
  assertEquals(store.live(), ["schema:public", "table:public.orders"]);
});

Deno.test("schema drift: a rename flags the data-access concepts that use the old column", async () => {
  const cursor = (s: unknown, schemas = ["public"], ref = REF) => ({ project_ref: ref, schemas, snapshot: s });
  const recorded: unknown[] = [];
  const deps = {
    concepts: () => Promise.resolve([
      { id: "c1", path: "data/orders", kind: "data_access", body: "Revenue is `sum(amount)` from `public.orders`." },
      { id: "c2", path: "data/other", kind: "data_access", body: "Nothing about it." },
    ]),
    record: (flags: unknown[]) => {
      recorded.push(...flags);
      return Promise.resolve(flags.length);
    },
  };
  const logs: string[] = [];
  const res = await detectSchemaDrift(cursor(snap("amount")), cursor(snap("amount_cents")), deps, (m) => logs.push(m));
  assertEquals(res.opened, 1);
  assertEquals(res.flags[0]!.concept_path, "data/orders");
  assertMatch(res.flags[0]!.observation, /probably renamed to amount_cents/);
  assertEquals(res.flags[0]!.document, "table:public.orders");
  assertMatch(logs.join("\n"), /column public\.orders\.amount probably renamed to amount_cents/);

  // first sync, another project, a schema removed from the config: no drift
  assertEquals(schemaChanges({}, cursor(snap("amount_cents"))), []);
  assertEquals(schemaChanges(cursor(snap("amount"), ["public"], "zzzzzzzzzzzzzzzzzzzz"), cursor(snap("amount_cents"))), []);
  const billing = { ...customers, schema: "billing", name: "invoices" };
  assertEquals(schemaChanges(cursor(snap("amount", [billing]), ["billing", "public"]), cursor(snap("amount"), ["public"])), []);

  // additions only: nothing recorded
  recorded.length = 0;
  const added = await detectSchemaDrift(cursor(snap("amount")), cursor(snap("amount", [customers])), deps, () => {});
  assertEquals([added.opened, recorded.length, added.changes.length], [0, 0, 1]);
});
