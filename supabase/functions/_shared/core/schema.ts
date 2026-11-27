// Postgres schema snapshots, their source documents, and schema drift.
//
// The `schema` connector (supabase/functions/connectors/lib/schema.ts) reads one snapshot of an application
// database (tables, columns, comments, foreign keys, RLS policies, views, function signatures) and turns it into
// source documents with renderSchemaDocuments(). When a later snapshot differs, diffSchemas() lists what changed
// (with likely renames) and driftFlags() opens a flag on every data-access concept whose body still refers to a
// dropped, renamed or changed identifier. Everything here is pure, sorted and deterministic: the same schema
// always renders the same markdown, so an unchanged database produces unchanged content hashes.

export type SchemaRelationKind = "table" | "view" | "materialized_view" | "foreign_table";

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  comment: string | null;
}

export interface SchemaForeignKey {
  name: string;
  /** pg_get_constraintdef(), e.g. "FOREIGN KEY (customer_id) REFERENCES customers(id)" */
  definition: string;
}

export interface SchemaPolicy {
  name: string;
  command: "select" | "insert" | "update" | "delete" | "all";
  permissive: boolean;
  roles: string[];
  using: string | null;
  check: string | null;
}

export interface SchemaTable {
  schema: string;
  name: string;
  kind: SchemaRelationKind;
  comment: string | null;
  rls_enabled: boolean;
  /** in column order (attnum) */
  columns: SchemaColumn[];
  primary_key: string[];
  foreign_keys: SchemaForeignKey[];
  policies: SchemaPolicy[];
  /** view / materialized view definition */
  definition: string | null;
}

export interface SchemaFunction {
  schema: string;
  name: string;
  /** pg_get_function_identity_arguments() */
  arguments: string;
  returns: string;
  language: string;
  security_definer: boolean;
  comment: string | null;
}

export interface SchemaSnapshot {
  tables: SchemaTable[];
  functions: SchemaFunction[];
}

/** Unquoted Postgres identifier (what `schemas` in the connector config accepts). */
export const SCHEMA_NAME_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

// ---------------------------------------------------------------------------------------------------------
// the catalog query
// ---------------------------------------------------------------------------------------------------------

/**
 * One read-only catalog query that returns the whole snapshot as a single JSON value (column `snapshot`).
 * Objects owned by extensions are left out. `schemas` must already be validated with SCHEMA_NAME_RE.
 */
export function schemaSnapshotSql(schemas: string[]): string {
  if (!schemas.length || schemas.some((s) => !SCHEMA_NAME_RE.test(s))) throw new Error("schemas must be plain Postgres identifiers");
  const list = schemas.map((s) => `'${s}'`).join(", ");
  return `select json_build_object(
  'tables', coalesce((
    select json_agg(x.t order by x.s, x.n) from (
      select n.nspname as s, c.relname as n, json_build_object(
        'schema', n.nspname,
        'name', c.relname,
        'kind', case c.relkind when 'v' then 'view' when 'm' then 'materialized_view' when 'f' then 'foreign_table' else 'table' end,
        'comment', obj_description(c.oid, 'pg_class'),
        'rls_enabled', c.relrowsecurity,
        'columns', coalesce((
          select json_agg(json_build_object(
            'name', a.attname,
            'type', format_type(a.atttypid, a.atttypmod),
            'nullable', not a.attnotnull,
            'default', pg_get_expr(d.adbin, d.adrelid),
            'comment', col_description(c.oid, a.attnum)) order by a.attnum)
          from pg_attribute a
          left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
          where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '[]'::json),
        'primary_key', coalesce((
          select json_agg(a.attname order by k.ord)
          from pg_constraint pk
          cross join lateral unnest(pk.conkey) with ordinality as k(attnum, ord)
          join pg_attribute a on a.attrelid = pk.conrelid and a.attnum = k.attnum
          where pk.conrelid = c.oid and pk.contype = 'p'), '[]'::json),
        'foreign_keys', coalesce((
          select json_agg(json_build_object('name', fk.conname, 'definition', pg_get_constraintdef(fk.oid)) order by fk.conname)
          from pg_constraint fk where fk.conrelid = c.oid and fk.contype = 'f'), '[]'::json),
        'policies', coalesce((
          select json_agg(json_build_object(
            'name', p.polname,
            'command', case p.polcmd when 'r' then 'select' when 'a' then 'insert' when 'w' then 'update' when 'd' then 'delete' else 'all' end,
            'permissive', p.polpermissive,
            'roles', (select coalesce(json_agg(r.rolname order by r.rolname), '[]'::json)
                        from (select case when ro = 0 then 'public' else pg_get_userbyid(ro)::text end as rolname from unnest(p.polroles) ro) r),
            'using', pg_get_expr(p.polqual, p.polrelid),
            'check', pg_get_expr(p.polwithcheck, p.polrelid)) order by p.polname)
          from pg_policy p where p.polrelid = c.oid), '[]'::json),
        'definition', case when c.relkind in ('v', 'm') then pg_get_viewdef(c.oid, true) end
      ) as t
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in (${list})
        and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and not c.relispartition
        and not exists (select 1 from pg_depend e where e.classid = 'pg_class'::regclass and e.objid = c.oid and e.deptype = 'e')
    ) x), '[]'::json),
  'functions', coalesce((
    select json_agg(x.f order by x.s, x.n, x.a) from (
      select n.nspname as s, p.proname as n, pg_get_function_identity_arguments(p.oid) as a, json_build_object(
        'schema', n.nspname,
        'name', p.proname,
        'arguments', pg_get_function_identity_arguments(p.oid),
        'returns', pg_get_function_result(p.oid),
        'language', l.lanname,
        'security_definer', p.prosecdef,
        'comment', obj_description(p.oid, 'pg_proc')) as f
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
      where n.nspname in (${list})
        and p.prokind in ('f', 'p')
        and not exists (select 1 from pg_depend e where e.classid = 'pg_proc'::regclass and e.objid = p.oid and e.deptype = 'e')
    ) x), '[]'::json)
) as snapshot`;
}

// ---------------------------------------------------------------------------------------------------------
// parsing + normalisation
// ---------------------------------------------------------------------------------------------------------

function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`schema snapshot: ${what} must be an object`);
  return v as Record<string, unknown>;
}
function str(v: unknown, what: string): string {
  if (typeof v !== "string" || !v) throw new Error(`schema snapshot: ${what} must be a non-empty string`);
  return v;
}
function optStr(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const KINDS = new Set<SchemaRelationKind>(["table", "view", "materialized_view", "foreign_table"]);
const COMMANDS = new Set(["select", "insert", "update", "delete", "all"]);

/** Validate a snapshot (as returned by the catalog query, or stored earlier) and put it in canonical order. */
export function parseSchemaSnapshot(raw: unknown): SchemaSnapshot {
  const root = obj(typeof raw === "string" ? JSON.parse(raw) : raw, "snapshot");
  const tables: SchemaTable[] = arr(root.tables).map((t0, i) => {
    const t = obj(t0, `tables[${i}]`);
    const kind = (typeof t.kind === "string" && KINDS.has(t.kind as SchemaRelationKind) ? t.kind : "table") as SchemaRelationKind;
    return {
      schema: str(t.schema, `tables[${i}].schema`),
      name: str(t.name, `tables[${i}].name`),
      kind,
      comment: optStr(t.comment),
      rls_enabled: t.rls_enabled === true,
      columns: arr(t.columns).map((c0, j) => {
        const c = obj(c0, `tables[${i}].columns[${j}]`);
        return { name: str(c.name, "column name"), type: str(c.type, "column type"), nullable: c.nullable !== false, default: optStr(c.default), comment: optStr(c.comment) };
      }),
      primary_key: arr(t.primary_key).filter((x): x is string => typeof x === "string"),
      foreign_keys: arr(t.foreign_keys).map((f0) => {
        const f = obj(f0, "foreign key");
        return { name: str(f.name, "foreign key name"), definition: str(f.definition, "foreign key definition") };
      }).sort(byName),
      policies: arr(t.policies).map((p0) => {
        const p = obj(p0, "policy");
        const command = typeof p.command === "string" && COMMANDS.has(p.command) ? p.command as SchemaPolicy["command"] : "all";
        return {
          name: str(p.name, "policy name"), command, permissive: p.permissive !== false,
          roles: arr(p.roles).filter((x): x is string => typeof x === "string").sort(cmp),
          using: optStr(p.using), check: optStr(p.check),
        };
      }).sort(byName),
      definition: optStr(t.definition),
    };
  }).sort((a, b) => cmp(a.schema, b.schema) || cmp(a.name, b.name));
  const functions: SchemaFunction[] = arr(root.functions).map((f0, i) => {
    const f = obj(f0, `functions[${i}]`);
    return {
      schema: str(f.schema, "function schema"), name: str(f.name, "function name"),
      arguments: typeof f.arguments === "string" ? f.arguments : "", returns: typeof f.returns === "string" ? f.returns : "",
      language: typeof f.language === "string" ? f.language : "", security_definer: f.security_definer === true, comment: optStr(f.comment),
    };
  }).sort((a, b) => cmp(a.schema, b.schema) || cmp(a.name, b.name) || cmp(a.arguments, b.arguments));
  return { tables, functions };
}

export const qualified = (t: { schema: string; name: string }) => `${t.schema}.${t.name}`;
export const functionSignature = (f: SchemaFunction) => `${f.schema}.${f.name}(${f.arguments})`;

// ---------------------------------------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------------------------------------

export interface SchemaDocument {
  /** `table:<schema>.<name>` or `schema:<schema>` */
  externalId: string;
  title: string;
  content: string;
}

export const tableDocumentId = (qualifiedName: string) => `table:${qualifiedName}`;
export const schemaDocumentId = (schema: string) => `schema:${schema}`;

const KIND_LABEL: Record<SchemaRelationKind, string> = { table: "table", view: "view", materialized_view: "materialized view", foreign_table: "foreign table" };

function code(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.includes("`") ? `\`\` ${one} \`\`` : `\`${one}\``;
}
function cell(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

function renderTable(t: SchemaTable): string {
  const name = qualified(t);
  const out: string[] = [`# ${name}`, "", `${KIND_LABEL[t.kind][0]!.toUpperCase()}${KIND_LABEL[t.kind].slice(1)} in schema ${code(t.schema)}.`];
  if (t.comment) out.push("", t.comment.trim());
  out.push("", "## Columns", "", "| Column | Type | Nullable | Default | Comment |", "|---|---|---|---|---|");
  for (const c of t.columns) {
    out.push(`| ${code(c.name)} | ${cell(c.type)} | ${c.nullable ? "yes" : "no"} | ${c.default ? cell(code(c.default)) : ""} | ${cell(c.comment)} |`);
  }
  if (t.primary_key.length) out.push("", `Primary key: ${t.primary_key.map(code).join(", ")}`);
  if (t.foreign_keys.length) {
    out.push("", "## Foreign keys", "");
    for (const f of t.foreign_keys) out.push(`- ${code(f.name)}: ${code(f.definition)}`);
  }
  if (t.kind === "table" || t.kind === "foreign_table") {
    out.push("", "## Row level security", "");
    if (!t.rls_enabled) {
      out.push("RLS is disabled: every role with privileges on the table reads and writes every row.");
    } else if (!t.policies.length) {
      out.push("RLS is enabled and there are no policies: only roles that bypass RLS (the owner, service role) see rows.");
    } else {
      out.push("RLS is enabled. Policies:", "");
      for (const p of t.policies) {
        const parts = [`${p.command}`, p.permissive ? "permissive" : "restrictive", `roles ${p.roles.length ? p.roles.join(", ") : "public"}`];
        out.push(`- ${code(p.name)} (${parts.join(", ")})`);
        if (p.using) out.push(`  - using ${code(p.using)}`);
        if (p.check) out.push(`  - with check ${code(p.check)}`);
      }
    }
  }
  if (t.definition) out.push("", "## Definition", "", "```sql", t.definition.trim(), "```");
  return out.join("\n") + "\n";
}

function renderSchemaOverview(schema: string, tables: SchemaTable[], functions: SchemaFunction[]): string {
  const out: string[] = [`# Schema ${schema}`];
  if (tables.length) {
    out.push("", "## Tables and views", "", "| Name | Kind | Columns | RLS | Comment |", "|---|---|---|---|---|");
    for (const t of tables) {
      const rls = t.kind === "table" || t.kind === "foreign_table" ? (t.rls_enabled ? `on, ${t.policies.length} policies` : "off") : "";
      out.push(`| ${code(qualified(t))} | ${KIND_LABEL[t.kind]} | ${t.columns.length} | ${rls} | ${cell(t.comment)} |`);
    }
  }
  if (functions.length) {
    out.push("", "## Functions", "", "| Signature | Returns | Language | Security | Comment |", "|---|---|---|---|---|");
    for (const f of functions) {
      out.push(`| ${cell(code(functionSignature(f)))} | ${cell(f.returns)} | ${cell(f.language)} | ${f.security_definer ? "definer" : "invoker"} | ${cell(f.comment)} |`);
    }
  }
  return out.join("\n") + "\n";
}

/** One overview document per schema plus one document per table or view, in a stable order. */
export function renderSchemaDocuments(s: SchemaSnapshot): SchemaDocument[] {
  const schemas = [...new Set([...s.tables.map((t) => t.schema), ...s.functions.map((f) => f.schema)])].sort(cmp);
  const docs: SchemaDocument[] = [];
  for (const schema of schemas) {
    const tables = s.tables.filter((t) => t.schema === schema);
    docs.push({ externalId: schemaDocumentId(schema), title: `Schema ${schema}`, content: renderSchemaOverview(schema, tables, s.functions.filter((f) => f.schema === schema)) });
    for (const t of tables) docs.push({ externalId: tableDocumentId(qualified(t)), title: `${qualified(t)} (${KIND_LABEL[t.kind]})`, content: renderTable(t) });
  }
  return docs;
}

// ---------------------------------------------------------------------------------------------------------
// drift
// ---------------------------------------------------------------------------------------------------------

export type SchemaChange =
  | { kind: "table_added"; table: string }
  | { kind: "table_removed"; table: string; renamed_to: string | null }
  | { kind: "column_added"; table: string; column: string; type: string }
  | { kind: "column_removed"; table: string; column: string; type: string; renamed_to: string | null }
  | { kind: "column_type_changed"; table: string; column: string; from: string; to: string }
  | { kind: "access_changed"; table: string; rls: "enabled" | "disabled" | null; policies_added: string[]; policies_removed: string[]; policies_changed: string[] }
  | { kind: "function_removed"; function: string; schema: string; name: string; replaced_by: string | null };

/** Pair removed and added items that share a signature, but only when the pairing is unambiguous. */
function pairUnique<T>(removed: T[], added: T[], sig: (x: T) => string): Map<T, T> {
  const pairs = new Map<T, T>();
  const groups = new Map<string, { r: T[]; a: T[] }>();
  for (const r of removed) (groups.get(sig(r)) ?? groups.set(sig(r), { r: [], a: [] }).get(sig(r))!).r.push(r);
  for (const a of added) (groups.get(sig(a)) ?? groups.set(sig(a), { r: [], a: [] }).get(sig(a))!).a.push(a);
  for (const g of groups.values()) if (g.r.length === 1 && g.a.length === 1) pairs.set(g.r[0]!, g.a[0]!);
  return pairs;
}

const policyKey = (p: SchemaPolicy) => JSON.stringify([p.command, p.permissive, p.roles, p.using, p.check]);

/**
 * What changed between two snapshots. Likely renames are detected heuristically: a column dropped from a table
 * that also gained exactly one column of the same type (and no other dropped column has that type) is reported
 * as `renamed_to` that column; a dropped table whose columns (names and types) match exactly one new table of the
 * same kind in the same schema likewise.
 */
export function diffSchemas(prev: SchemaSnapshot, next: SchemaSnapshot): SchemaChange[] {
  const changes: SchemaChange[] = [];
  const before = new Map(prev.tables.map((t) => [qualified(t), t]));
  const after = new Map(next.tables.map((t) => [qualified(t), t]));

  const removedTables = prev.tables.filter((t) => !after.has(qualified(t)));
  const addedTables = next.tables.filter((t) => !before.has(qualified(t)));
  const tableSig = (t: SchemaTable) => `${t.schema}|${t.kind}|${t.columns.map((c) => `${c.name}:${c.type}`).sort(cmp).join(",")}`;
  const tableRenames = pairUnique(removedTables, addedTables, tableSig);
  const renamedTargets = new Set([...tableRenames.values()].map(qualified));
  for (const t of removedTables) changes.push({ kind: "table_removed", table: qualified(t), renamed_to: tableRenames.has(t) ? qualified(tableRenames.get(t)!) : null });
  for (const t of addedTables) if (!renamedTargets.has(qualified(t))) changes.push({ kind: "table_added", table: qualified(t) });

  for (const t of next.tables) {
    const old = before.get(qualified(t));
    if (!old) continue;
    const table = qualified(t);
    const oldCols = new Map(old.columns.map((c) => [c.name, c]));
    const newCols = new Map(t.columns.map((c) => [c.name, c]));
    const removed = old.columns.filter((c) => !newCols.has(c.name));
    const added = t.columns.filter((c) => !oldCols.has(c.name));
    const renames = pairUnique(removed, added, (c) => c.type);
    const renamedTo = new Set([...renames.values()].map((c) => c.name));
    for (const c of removed) changes.push({ kind: "column_removed", table, column: c.name, type: c.type, renamed_to: renames.get(c)?.name ?? null });
    for (const c of added) if (!renamedTo.has(c.name)) changes.push({ kind: "column_added", table, column: c.name, type: c.type });
    for (const c of t.columns) {
      const o = oldCols.get(c.name);
      if (o && o.type !== c.type) changes.push({ kind: "column_type_changed", table, column: c.name, from: o.type, to: c.type });
    }
    const oldPol = new Map(old.policies.map((p) => [p.name, p]));
    const newPol = new Map(t.policies.map((p) => [p.name, p]));
    const access = {
      rls: old.rls_enabled === t.rls_enabled ? null : t.rls_enabled ? "enabled" as const : "disabled" as const,
      policies_added: t.policies.filter((p) => !oldPol.has(p.name)).map((p) => p.name),
      policies_removed: old.policies.filter((p) => !newPol.has(p.name)).map((p) => p.name),
      policies_changed: t.policies.filter((p) => oldPol.has(p.name) && policyKey(oldPol.get(p.name)!) !== policyKey(p)).map((p) => p.name),
    };
    if (access.rls || access.policies_added.length || access.policies_removed.length || access.policies_changed.length) {
      changes.push({ kind: "access_changed", table, ...access });
    }
  }

  const nextFns = new Set(next.functions.map(functionSignature));
  for (const f of prev.functions) {
    if (nextFns.has(functionSignature(f))) continue;
    const same = next.functions.filter((g) => g.schema === f.schema && g.name === f.name && !prev.functions.some((p) => functionSignature(p) === functionSignature(g)));
    changes.push({ kind: "function_removed", function: functionSignature(f), schema: f.schema, name: f.name, replaced_by: same.length === 1 ? functionSignature(same[0]!) : null });
  }
  return changes;
}

/** Changes that can break what a data-access concept says (additions alone cannot). */
export function isBreakingChange(c: SchemaChange): boolean {
  return c.kind !== "table_added" && c.kind !== "column_added";
}

/** A short line per change, for logs and run summaries. */
export function describeChange(c: SchemaChange): string {
  switch (c.kind) {
    case "table_added": return `table ${c.table} added`;
    case "table_removed": return c.renamed_to ? `table ${c.table} probably renamed to ${c.renamed_to}` : `table ${c.table} dropped`;
    case "column_added": return `column ${c.table}.${c.column} (${c.type}) added`;
    case "column_removed": return c.renamed_to ? `column ${c.table}.${c.column} probably renamed to ${c.renamed_to}` : `column ${c.table}.${c.column} dropped`;
    case "column_type_changed": return `column ${c.table}.${c.column} changed type from ${c.from} to ${c.to}`;
    case "access_changed": return `access to ${c.table} changed`;
    case "function_removed": return c.replaced_by ? `function ${c.function} replaced by ${c.replaced_by}` : `function ${c.function} dropped`;
  }
}

// ---------------------------------------------------------------------------------------------------------
// drift -> flags
// ---------------------------------------------------------------------------------------------------------

export interface DriftConcept {
  id: string;
  path: string;
  body: string;
  /** when given, only `data_access` concepts are considered */
  kind?: string;
}

export interface DriftFlag {
  concept_id: string;
  concept_path: string;
  kind: "outdated";
  /** dedupe key: one open flag per concept and key */
  key: string;
  observation: string;
  suggested_fix: string | null;
  /** external id of the schema document to cite */
  document: string;
  change: SchemaChange;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does `text` mention the identifier as a whole word (case-insensitive)? Double quotes are ignored, so
 * `"public"."orders"` mentions `public.orders`; `acme.public.orders` and `` `orders` `` mention `orders`.
 */
export function mentionsIdentifier(text: string, ident: string): boolean {
  const flat = text.replace(/"/g, "");
  return new RegExp(`(?<![A-Za-z0-9_$])${escapeRe(ident.replace(/"/g, ""))}(?![A-Za-z0-9_$])`, "i").test(flat);
}

function splitQualified(q: string): { schema: string; name: string } {
  const i = q.indexOf(".");
  return { schema: q.slice(0, i), name: q.slice(i + 1) };
}

function mentionsTable(body: string, table: string): boolean {
  return mentionsIdentifier(body, table) || mentionsIdentifier(body, splitQualified(table).name);
}

/** Which identifier must the concept mention for this change to concern it, and what to tell it. */
function flagFor(c: SchemaChange, body: string): Omit<DriftFlag, "concept_id" | "concept_path" | "kind" | "change"> | null {
  switch (c.kind) {
    case "table_removed": {
      if (!mentionsTable(body, c.table)) return null;
      const { schema } = splitQualified(c.table);
      return c.renamed_to
        ? {
          key: `table:${c.table}`,
          observation: `Table ${c.table} no longer exists. ${c.renamed_to} has the same columns, so it was probably renamed to ${c.renamed_to}. This concept still refers to ${c.table}.`,
          suggested_fix: `Refer to ${c.renamed_to} instead of ${c.table}, after checking it holds the same data.`,
          document: tableDocumentId(c.renamed_to),
        }
        : {
          key: `table:${c.table}`,
          observation: `Table ${c.table} no longer exists in the database. This concept still refers to it.`,
          suggested_fix: `Find where this data lives now (see the current tables of schema ${schema}) or deprecate the guidance.`,
          document: schemaDocumentId(schema),
        };
    }
    case "column_removed": {
      if (!mentionsTable(body, c.table) || !mentionsIdentifier(body, c.column)) return null;
      return c.renamed_to
        ? {
          key: `column:${c.table}.${c.column}`,
          observation: `Column ${c.table}.${c.column} (${c.type}) no longer exists, and ${c.table} gained ${c.renamed_to} with the same type: probably renamed to ${c.renamed_to}. This concept still refers to ${c.column}.`,
          suggested_fix: `Use ${c.table}.${c.renamed_to} instead of ${c.column}, after checking it has the same meaning and unit.`,
          document: tableDocumentId(c.table),
        }
        : {
          key: `column:${c.table}.${c.column}`,
          observation: `Column ${c.table}.${c.column} (${c.type}) no longer exists. This concept still refers to it.`,
          suggested_fix: `Remove ${c.column} from the guidance for ${c.table} or point to where the value lives now.`,
          document: tableDocumentId(c.table),
        };
    }
    case "column_type_changed":
      if (!mentionsTable(body, c.table) || !mentionsIdentifier(body, c.column)) return null;
      return {
        key: `column:${c.table}.${c.column}`,
        observation: `Column ${c.table}.${c.column} changed type from ${c.from} to ${c.to}. This concept refers to it.`,
        suggested_fix: `Check the documented type, casts, comparisons and formatting of ${c.column} against ${c.to}.`,
        document: tableDocumentId(c.table),
      };
    case "access_changed": {
      if (!mentionsTable(body, c.table)) return null;
      const parts = [
        c.rls ? `row level security was ${c.rls}` : null,
        c.policies_added.length ? `policies added: ${c.policies_added.join(", ")}` : null,
        c.policies_removed.length ? `policies removed: ${c.policies_removed.join(", ")}` : null,
        c.policies_changed.length ? `policies changed: ${c.policies_changed.join(", ")}` : null,
      ].filter(Boolean);
      return {
        key: `access:${c.table}`,
        observation: `Access rules on ${c.table} changed (${parts.join("; ")}), so who can read which rows may differ from what this concept says.`,
        suggested_fix: `Check what this concept says about access to ${c.table} against the current policies.`,
        document: tableDocumentId(c.table),
      };
    }
    case "function_removed":
      if (!mentionsIdentifier(body, `${c.schema}.${c.name}`) && !mentionsIdentifier(body, c.name)) return null;
      return c.replaced_by
        ? {
          key: `function:${c.function}`,
          observation: `Function ${c.function} no longer exists; it now has the signature ${c.replaced_by}. This concept refers to ${c.name}.`,
          suggested_fix: `Update calls to ${c.name} to the signature ${c.replaced_by}.`,
          document: schemaDocumentId(c.schema),
        }
        : {
          key: `function:${c.function}`,
          observation: `Function ${c.function} no longer exists. This concept refers to ${c.name}.`,
          suggested_fix: `Remove or replace calls to ${c.name}.`,
          document: schemaDocumentId(c.schema),
        };
    default:
      return null;
  }
}

/**
 * One flag per (concept, changed identifier) for every data-access concept whose body refers to a dropped,
 * renamed or retyped identifier, or to a table whose access rules changed. Column changes need the concept to
 * mention both the table and the column, so a generic column name (`id`, `status`) does not flag every concept.
 */
export function driftFlags(changes: SchemaChange[], concepts: DriftConcept[], limit = 200): DriftFlag[] {
  const out: DriftFlag[] = [];
  const seen = new Set<string>();
  const candidates = concepts.filter((c) => c.kind === undefined || c.kind === "data_access").sort((a, b) => cmp(a.path, b.path));
  for (const change of changes.filter(isBreakingChange)) {
    for (const concept of candidates) {
      const f = flagFor(change, concept.body);
      if (!f) continue;
      const k = `${concept.id}|${f.key}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ concept_id: concept.id, concept_path: concept.path, kind: "outdated", ...f, change });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
