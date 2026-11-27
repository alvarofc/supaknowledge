import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffSchemas,
  driftFlags,
  mentionsIdentifier,
  parseSchemaSnapshot,
  renderSchemaDocuments,
  schemaSnapshotSql,
  type SchemaSnapshot,
} from "../src/index.ts";

const col = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ name, type, nullable: true, default: null, comment: null, ...extra });

function snapshot(over: { orders?: unknown[]; policies?: unknown[]; rls?: boolean; extraTables?: unknown[]; functions?: unknown[] } = {}): SchemaSnapshot {
  return parseSchemaSnapshot({
    // deliberately unsorted: parse puts everything in canonical order
    functions: over.functions ?? [
      { schema: "public", name: "order_total", arguments: "p_order uuid", returns: "numeric", language: "sql", security_definer: false, comment: null },
    ],
    tables: [
      ...(over.extraTables ?? []),
      {
        schema: "public", name: "orders", kind: "table", comment: "One row per checkout.", rls_enabled: over.rls ?? true,
        columns: over.orders ?? [col("id", "uuid", { nullable: false, default: "gen_random_uuid()" }), col("customer_id", "uuid"), col("amount", "numeric(12,2)", { comment: "Order total in EUR | incl. VAT" }), col("status", "text")],
        primary_key: ["id"],
        foreign_keys: [{ name: "orders_customer_id_fkey", definition: "FOREIGN KEY (customer_id) REFERENCES customers(id)" }],
        policies: over.policies ?? [
          { name: "own orders", command: "select", permissive: true, roles: ["authenticated"], using: "(customer_id = auth.uid())", check: null },
        ],
        definition: null,
      },
      { schema: "public", name: "customers", kind: "table", comment: null, rls_enabled: false, columns: [col("id", "uuid"), col("email", "text")], primary_key: ["id"], foreign_keys: [], policies: [], definition: null },
    ],
  });
}

test("schema: the catalog query only accepts plain identifiers", () => {
  assert.match(schemaSnapshotSql(["public", "billing"]), /n\.nspname in \('public', 'billing'\)/);
  assert.throws(() => schemaSnapshotSql(["public'; drop table x; --"]));
  assert.throws(() => schemaSnapshotSql([]));
});

test("schema: documents are sorted, stable and cover columns, comments, keys and policies", () => {
  const a = renderSchemaDocuments(snapshot());
  assert.deepEqual(a.map((d) => d.externalId), ["schema:public", "table:public.customers", "table:public.orders"]);
  const orders = a.find((d) => d.externalId === "table:public.orders")!;
  assert.equal(orders.title, "public.orders (table)");
  assert.match(orders.content, /One row per checkout\./);
  assert.match(orders.content, /\| `amount` \| numeric\(12,2\) \| yes \|  \| Order total in EUR \\\| incl\. VAT \|/);
  assert.match(orders.content, /Primary key: `id`/);
  assert.match(orders.content, /`orders_customer_id_fkey`: `FOREIGN KEY \(customer_id\) REFERENCES customers\(id\)`/);
  assert.match(orders.content, /- `own orders` \(select, permissive, roles authenticated\)\n {2}- using `\(customer_id = auth\.uid\(\)\)`/);
  const customers = a.find((d) => d.externalId === "table:public.customers")!;
  assert.match(customers.content, /RLS is disabled/);
  const overview = a[0]!;
  assert.match(overview.content, /`public\.order_total\(p_order uuid\)` \| numeric \| sql \| invoker/);
  // same schema, different input order -> identical documents
  const raw = JSON.parse(JSON.stringify(snapshot()));
  raw.tables.reverse();
  assert.deepEqual(renderSchemaDocuments(parseSchemaSnapshot(raw)), a);
});

test("schema: identical snapshots have no changes", () => {
  assert.deepEqual(diffSchemas(snapshot(), snapshot()), []);
});

test("schema: one column dropped and one added with the same type is a likely rename", () => {
  const next = snapshot({ orders: [col("id", "uuid"), col("customer_id", "uuid"), col("amount_cents", "numeric(12,2)"), col("status", "text")] });
  assert.deepEqual(diffSchemas(snapshot(), next), [
    { kind: "column_removed", table: "public.orders", column: "amount", type: "numeric(12,2)", renamed_to: "amount_cents" },
  ]);
});

test("schema: ambiguous or differently typed replacements are drops plus additions", () => {
  const twoNew = snapshot({ orders: [col("id", "uuid"), col("customer_id", "uuid"), col("net", "numeric(12,2)"), col("gross", "numeric(12,2)"), col("status", "text")] });
  const changes = diffSchemas(snapshot(), twoNew);
  assert.deepEqual(changes.find((c) => c.kind === "column_removed"), { kind: "column_removed", table: "public.orders", column: "amount", type: "numeric(12,2)", renamed_to: null });
  assert.equal(changes.filter((c) => c.kind === "column_added").length, 2);

  const otherType = snapshot({ orders: [col("id", "uuid"), col("customer_id", "uuid"), col("amount_cents", "bigint"), col("status", "text")] });
  assert.deepEqual(diffSchemas(snapshot(), otherType).map((c) => c.kind), ["column_removed", "column_added"]);
});

test("schema: type changes, access changes, table renames and function signature changes", () => {
  const next = snapshot({
    orders: [col("id", "uuid"), col("customer_id", "uuid"), col("amount", "bigint"), col("status", "text")],
    policies: [{ name: "own orders", command: "select", permissive: true, roles: ["authenticated"], using: "(customer_id = auth.uid() and status <> 'void')", check: null }],
    functions: [{ schema: "public", name: "order_total", arguments: "p_order uuid, p_currency text", returns: "numeric", language: "sql" }],
  });
  assert.deepEqual(diffSchemas(snapshot(), next), [
    { kind: "column_type_changed", table: "public.orders", column: "amount", from: "numeric(12,2)", to: "bigint" },
    { kind: "access_changed", table: "public.orders", rls: null, policies_added: [], policies_removed: [], policies_changed: ["own orders"] },
    { kind: "function_removed", function: "public.order_total(p_order uuid)", schema: "public", name: "order_total", replaced_by: "public.order_total(p_order uuid, p_currency text)" },
  ]);

  const prev = snapshot();
  const renamed = parseSchemaSnapshot({ ...prev, tables: prev.tables.map((t) => (t.name === "customers" ? { ...t, name: "clients" } : t)) });
  assert.deepEqual(diffSchemas(prev, renamed), [{ kind: "table_removed", table: "public.customers", renamed_to: "public.clients" }]);

  const rlsOff = snapshot({ rls: false });
  assert.deepEqual(diffSchemas(prev, rlsOff), [{ kind: "access_changed", table: "public.orders", rls: "disabled", policies_added: [], policies_removed: [], policies_changed: [] }]);
});

test("schema: mentionsIdentifier matches whole identifiers only", () => {
  assert.ok(mentionsIdentifier("select sum(amount) from public.orders", "amount"));
  assert.ok(mentionsIdentifier('from "public"."orders"', "public.orders"));
  assert.ok(mentionsIdentifier("`acme-prod.finance.revenue_daily`", "finance.revenue_daily"));
  assert.ok(!mentionsIdentifier("amount_cents is in cents", "amount"));
  assert.ok(!mentionsIdentifier("preorders", "orders"));
  assert.ok(mentionsIdentifier("The ORDERS table", "orders"));
});

test("schema: drift flags target data-access concepts that mention the changed identifier", () => {
  const next = snapshot({ orders: [col("id", "uuid"), col("customer_id", "uuid"), col("amount_cents", "numeric(12,2)"), col("status", "text")] });
  const changes = diffSchemas(snapshot(), next);
  const concepts = [
    { id: "c1", path: "data/orders", kind: "data_access", body: "Revenue: `select sum(amount) from public.orders`." },
    { id: "c2", path: "data/customers", kind: "data_access", body: "The amount of customers is in customers." },
    { id: "c3", path: "metrics/revenue", kind: "domain", body: "sum(amount) from orders" },
    { id: "c4", path: "data/orders-cents", kind: "data_access", body: "orders.amount_cents holds cents." },
  ];
  const flags = driftFlags(changes, concepts);
  assert.equal(flags.length, 1);
  const f = flags[0]!;
  assert.equal(f.concept_id, "c1");
  assert.equal(f.kind, "outdated");
  assert.equal(f.key, "column:public.orders.amount");
  assert.equal(f.document, "table:public.orders");
  assert.match(f.observation, /probably renamed to amount_cents/);
  assert.match(f.suggested_fix!, /public\.orders\.amount_cents/);

  // additions alone never flag; dropped tables cite the schema overview
  assert.deepEqual(driftFlags(diffSchemas(next, next), concepts), []);
  const prev = snapshot();
  const dropped = parseSchemaSnapshot({ ...prev, tables: prev.tables.filter((t) => t.name !== "customers") });
  const tf = driftFlags(diffSchemas(prev, dropped), concepts);
  assert.deepEqual(tf.map((x) => [x.concept_path, x.key, x.document]), [["data/customers", "table:public.customers", "schema:public"]]);
});

test("schema: one flag per concept and identifier, capped", () => {
  const next = snapshot({ orders: [col("id", "uuid"), col("customer_id", "uuid"), col("status", "bigint")] });
  const concepts = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, path: `data/o${i}`, body: "orders: amount, status" }));
  const all = driftFlags(diffSchemas(snapshot(), next), concepts);
  assert.equal(all.length, 10); // amount dropped + status retyped, for 5 concepts
  assert.equal(new Set(all.map((f) => `${f.concept_id}|${f.key}`)).size, 10);
  assert.equal(driftFlags(diffSchemas(snapshot(), next), concepts, 3).length, 3);
});

test("schema: parse rejects malformed snapshots", () => {
  assert.throws(() => parseSchemaSnapshot([]), /must be an object/);
  assert.throws(() => parseSchemaSnapshot({ tables: [{ name: "x" }] }), /schema must be a non-empty string/);
  assert.deepEqual(parseSchemaSnapshot('{"tables":[],"functions":[]}'), { tables: [], functions: [] });
});

test("schema: triage only follows the schema document of system-opened drift flags", async () => {
  const { schemaDriftDocument } = await import("../src/curator/engine.ts");
  const base = {
    id: "f1", space_id: "s", created_by: null, trace_id: null, kind: "outdated" as const, concept_id: "c1", concept_path: "data/orders",
    query: null, observation: "x", suggested_fix: null, audience: [], status: "open" as const, synthetic: false, created_at: "",
    evidence: { schema_drift: { key: "column:public.orders.amount", document_id: "doc-1" } },
  };
  assert.equal(schemaDriftDocument(base), "doc-1");
  assert.equal(schemaDriftDocument({ ...base, created_by: "user-1" }), null, "a flag someone raised cannot pull in documents");
  assert.equal(schemaDriftDocument({ ...base, trace_id: "t1" }), null);
  assert.equal(schemaDriftDocument({ ...base, synthetic: true }), null);
  assert.equal(schemaDriftDocument({ ...base, evidence: { schema_drift: { document_id: 7 } } }), null);
  assert.equal(schemaDriftDocument({ ...base, evidence: {} }), null);
});
