import assert from "node:assert/strict";
import { test } from "node:test";
import { SOURCE_KIND_VALUES, numberInputValue, parseIntField, parseOptionalDays, toggleInList } from "../src/lib/settings-form.ts";

test("parseIntField: blank is NaN (schema says 'Enter a number'), numbers parse", () => {
  assert.ok(Number.isNaN(parseIntField("")));
  assert.ok(Number.isNaN(parseIntField("   ")));
  assert.equal(parseIntField("0"), 0);
  assert.equal(parseIntField("3000000"), 3_000_000);
});

test("parseOptionalDays: blank keeps forever (null)", () => {
  assert.equal(parseOptionalDays(""), null);
  assert.equal(parseOptionalDays(" "), null);
  assert.equal(parseOptionalDays("30"), 30);
});

test("numberInputValue renders NaN and null as an empty field", () => {
  assert.equal(numberInputValue(Number.NaN), "");
  assert.equal(numberInputValue(null), "");
  assert.equal(numberInputValue(undefined), "");
  assert.equal(numberInputValue(0), 0);
});

test("toggleInList keeps canonical order and no duplicates", () => {
  assert.deepEqual(toggleInList(SOURCE_KIND_VALUES, ["web"], "github", true), ["web", "github"]);
  assert.deepEqual(toggleInList(SOURCE_KIND_VALUES, ["upload", "web"], "web", true), ["web", "upload"]);
  assert.deepEqual(toggleInList(SOURCE_KIND_VALUES, ["web", "slack"], "web", false), ["slack"]);
  assert.deepEqual(toggleInList(SOURCE_KIND_VALUES, [], "notion", false), []);
});

test("source kinds match public.connector_kind", () => {
  assert.deepEqual([...SOURCE_KIND_VALUES].sort(), ["gdrive", "github", "notion", "slack", "upload", "web"]);
});
