import assert from "node:assert/strict";
import { test } from "node:test";
import { CURATOR_LIMITS, SOURCE_KIND_VALUES, friendlyIssue, numberInputValue, parseIntField, parseOptionalDays, toggleInList, validateCuratorLimits } from "../src/lib/settings-form.ts";

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

test("CURATOR_LIMITS match packages/core SpaceSettingsSchema", async () => {
  const core = await import("@supaknowledge/core");
  assert.equal(CURATOR_LIMITS.modelIdMax, core.MODEL_ID_MAX);
  assert.equal(CURATOR_LIMITS.maxFallbackModels, core.MAX_FALLBACK_MODELS);
  assert.equal(CURATOR_LIMITS.instructionsMax, core.INSTRUCTIONS_MAX);
  const stuck = (n: number) => core.SpaceSettingsSchema.safeParse({ curator: { stuck_after_minutes: n } }).success;
  assert.equal(stuck(CURATOR_LIMITS.stuckAfterMin), true);
  assert.equal(stuck(CURATOR_LIMITS.stuckAfterMin - 1), false);
  assert.equal(stuck(CURATOR_LIMITS.stuckAfterMax), true);
  assert.equal(stuck(CURATOR_LIMITS.stuckAfterMax + 1), false);
});

test("validateCuratorLimits: valid settings have no errors, each limit has a field error", () => {
  const ok = { model: "", fast_model: "acme/m", fallback_models: ["a", "b"], instructions: "be brief", stuck_after_minutes: 30 };
  assert.deepEqual(validateCuratorLimits(ok), {});
  const long = "x".repeat(201);
  const errs = validateCuratorLimits({ model: long, fast_model: long, fallback_models: ["1", "2", "3", "4", "5", "6"], instructions: "y".repeat(8001), stuck_after_minutes: 5 });
  assert.deepEqual(Object.keys(errs).sort(), ["curator.fallback_models", "curator.fast_model", "curator.instructions", "curator.model", "curator.stuck_after_minutes"]);
  assert.match(errs["curator.fallback_models"], /At most 5/);
  assert.match(errs["curator.stuck_after_minutes"], /at least 10/);
  assert.match(validateCuratorLimits({ ...ok, fallback_models: ["ok", long] })["curator.fallback_models"], /Line 2/);
  assert.equal(validateCuratorLimits({ ...ok, stuck_after_minutes: Number.NaN })["curator.stuck_after_minutes"], "Enter a number");
  assert.match(validateCuratorLimits({ ...ok, stuck_after_minutes: 1441 })["curator.stuck_after_minutes"], /at most 1440/);
});

test("friendlyIssue rewrites core schema messages", () => {
  assert.equal(friendlyIssue("too_small", "Too small: expected number to be >=10"), "Must be at least 10");
  assert.equal(friendlyIssue("too_big", "Too big: expected string to have <=200 characters"), "Too long: at most 200 characters");
  assert.equal(friendlyIssue("too_big", "Too big: expected array to have <=5 items"), "At most 5 entries");
  assert.equal(friendlyIssue("invalid_type", "Invalid input: expected number, received NaN"), "Enter a number");
});
