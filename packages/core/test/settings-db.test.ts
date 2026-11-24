// SpaceSettingsSchema and the database validator (private.validate_space_settings) must agree on every key,
// type and bound: Studio writes what the schema allows, and the database rejects anything else on write.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { SpaceSettingsSchema } from "../src/settings.ts";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../../supabase/migrations");

interface Spec {
  path: string;
  typ: string;
  lo: number | null;
  hi: number | null;
}

/** The (path, type, min, max) list of the LATEST migration that defines the validator. */
function dbSpecs(): Spec[] {
  const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
  const latest = files.filter((f) => /function private\.validate_space_settings\(\)/.test(readFileSync(join(migrations, f), "utf8"))).at(-1);
  assert.ok(latest, "no migration defines private.validate_space_settings()");
  const sql = readFileSync(join(migrations, latest), "utf8");
  const body = sql.slice(sql.indexOf("function private.validate_space_settings()"));
  const re = /\('\{(\w+),(\w+)\}', '([^']+)', (null|\d+), (null|\d+)\)/g;
  const out: Spec[] = [];
  for (const m of body.matchAll(re)) {
    out.push({ path: `${m[1]}.${m[2]}`, typ: m[3]!, lo: m[4] === "null" ? null : Number(m[4]), hi: m[5] === "null" ? null : Number(m[5]) });
  }
  return out;
}

function schemaFields(): Map<string, z.ZodType> {
  const out = new Map<string, z.ZodType>();
  for (const [section, sectionSchema] of Object.entries(SpaceSettingsSchema.shape)) {
    // sections are `X.prefault({})`: unwrap to the object schema
    // deno-lint-ignore no-explicit-any
    const inner = ((sectionSchema as any).unwrap?.() ?? (sectionSchema as any)._zod.def.innerType) as z.ZodObject;
    for (const [key, field] of Object.entries(inner.shape)) out.set(`${section}.${key}`, field as z.ZodType);
  }
  return out;
}

const ok = (f: z.ZodType, v: unknown) => f.safeParse(v).success;

test("the database validates exactly the keys of SpaceSettingsSchema", () => {
  const db = dbSpecs().map((s) => s.path).sort();
  const schema = [...schemaFields().keys()].sort();
  assert.ok(db.length > 10, `parsed only ${db.length} keys from the migration`);
  assert.deepEqual(db, schema);
});

test("types and bounds agree", () => {
  const fields = schemaFields();
  for (const s of dbSpecs()) {
    const f = fields.get(s.path)!;
    const where = `${s.path} (${s.typ})`;
    if (s.typ === "boolean") {
      assert.ok(ok(f, true) && ok(f, false), where);
      assert.ok(!ok(f, "true"), where);
    } else if (s.typ === "string") {
      assert.ok(ok(f, "x"), where);
      assert.ok(!ok(f, 1), where);
    } else if (s.typ === "string[]") {
      assert.ok(ok(f, ["a", "b"]) && ok(f, []), where);
      assert.ok(!ok(f, [1]) && !ok(f, "a"), where);
    } else if (s.typ === "integer" || s.typ === "integer?") {
      assert.ok(ok(f, s.lo) && ok(f, s.hi), `${where}: accepts ${s.lo}..${s.hi}`);
      assert.ok(!ok(f, s.lo! - 1) && !ok(f, s.hi! + 1), `${where}: rejects outside ${s.lo}..${s.hi}`);
      assert.ok(!ok(f, s.lo! + 0.5), `${where}: integers only`);
      assert.equal(ok(f, null), s.typ === "integer?", `${where}: null`);
    } else if (s.typ.startsWith("enum:")) {
      for (const v of s.typ.slice(5).split(",")) assert.ok(ok(f, v), `${where}: ${v}`);
      assert.ok(!ok(f, "not-a-value"), where);
    } else if (s.typ.startsWith("enum[]:")) {
      const values = s.typ.slice(7).split(",");
      assert.ok(ok(f, values) && ok(f, []), where);
      assert.ok(!ok(f, ["not-a-value"]), where);
      // the schema must not accept values the database rejects (and vice versa)
      // deno-lint-ignore no-explicit-any
      const opts = ((f as any)._zod.def.innerType ?? f)._zod.def.element?._zod.def.entries;
      if (opts) assert.deepEqual(Object.keys(opts).sort(), [...values].sort(), where);
    } else {
      assert.fail(`unknown type ${s.typ} for ${s.path}`);
    }
  }
});
