// Pure helpers for the space settings form (unit tested in test/settings-form.test.ts).

/** Number input → number; blank becomes NaN so the schema reports "Enter a number" instead of saving 0. */
export function parseIntField(text: string): number {
  return text.trim() === "" ? Number.NaN : Number(text);
}

/** Optional day count (retention): blank means "keep forever" and is stored as null. */
export function parseOptionalDays(text: string): number | null {
  return text.trim() === "" ? null : Number(text);
}

/** Value for a number <input>: NaN and null render as an empty field. */
export function numberInputValue(v: number | null | undefined): string | number {
  return v === null || v === undefined || Number.isNaN(v) ? "" : v;
}

/** Add or remove one value of a multi-select list, keeping the order of `all` and no duplicates. */
export function toggleInList<T extends string>(all: readonly T[], current: readonly T[], value: T, on: boolean): T[] {
  const next = new Set(current);
  if (on) next.add(value);
  else next.delete(value);
  return all.filter((x) => next.has(x));
}

/** Connector kinds (public.connector_kind) for auto_apply.untrusted_source_kinds. */
export const SOURCE_KINDS = [
  { value: "web", label: "Web pages", hint: "Anyone on the internet can write them" },
  { value: "github", label: "GitHub", hint: "Issues and files may come from outside contributors" },
  { value: "slack", label: "Slack", hint: "Includes shared and guest channels" },
  { value: "notion", label: "Notion", hint: "Pages can be edited by guests" },
  { value: "gdrive", label: "Google Drive", hint: "Files can be shared in from other organizations" },
  { value: "upload", label: "Uploads", hint: "Files a person uploaded by hand" },
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number]["value"];
export const SOURCE_KIND_VALUES: readonly SourceKind[] = SOURCE_KINDS.map((k) => k.value);

/**
 * Limits of packages/core SpaceSettingsSchema (and private.validate_space_settings in the database). Kept as plain
 * constants so the browser bundle does not pull in core; test/settings-form.test.ts checks they match core.
 */
export const CURATOR_LIMITS = {
  modelIdMax: 200,
  maxFallbackModels: 5,
  instructionsMax: 8000,
  stuckAfterMin: 10,
  stuckAfterMax: 1440,
} as const;

/** The curator fields the form edits as text (plus stuck_after_minutes), checked before saving. */
export type CuratorLimitInput = {
  model: string;
  fast_model: string;
  fallback_models: readonly string[];
  instructions: string;
  stuck_after_minutes: number;
};

/**
 * Client-side check of the curator limits, keyed like the server's field errors ("curator.model", ...). Empty
 * when everything is within bounds; the server still validates with the core schema.
 */
export function validateCuratorLimits(c: CuratorLimitInput): Record<string, string> {
  const L = CURATOR_LIMITS;
  const errors: Record<string, string> = {};
  const tooLong = (n: number) => `Too long: at most ${n.toLocaleString("en-US")} characters`;
  if (c.model.length > L.modelIdMax) errors["curator.model"] = tooLong(L.modelIdMax);
  if (c.fast_model.length > L.modelIdMax) errors["curator.fast_model"] = tooLong(L.modelIdMax);
  if (c.fallback_models.length > L.maxFallbackModels) errors["curator.fallback_models"] = `At most ${L.maxFallbackModels} fallback models`;
  else {
    const long = c.fallback_models.findIndex((m) => m.length > L.modelIdMax);
    if (long >= 0) errors["curator.fallback_models"] = `Line ${long + 1}: model ids are at most ${L.modelIdMax} characters`;
  }
  if (c.instructions.length > L.instructionsMax) errors["curator.instructions"] = `${tooLong(L.instructionsMax)} (now ${c.instructions.length.toLocaleString("en-US")})`;
  const stuck = c.stuck_after_minutes;
  if (!Number.isFinite(stuck)) errors["curator.stuck_after_minutes"] = "Enter a number";
  else if (!Number.isInteger(stuck)) errors["curator.stuck_after_minutes"] = "Enter a whole number of minutes";
  else if (stuck < L.stuckAfterMin) errors["curator.stuck_after_minutes"] = `Must be at least ${L.stuckAfterMin}`;
  else if (stuck > L.stuckAfterMax) errors["curator.stuck_after_minutes"] = `Must be at most ${L.stuckAfterMax}`;
  return errors;
}

/** Turn a zod issue into a short field message (the server reports these for SpaceSettingsSchema failures). */
export function friendlyIssue(code: string, message: string): string {
  if (code === "invalid_type" && /number/.test(message)) return "Enter a number";
  return message
    .replace(/^Too small: expected number to be >=?\s*/, "Must be at least ")
    .replace(/^Too big: expected number to be <=?\s*/, "Must be at most ")
    .replace(/^Too big: expected string to have <=?\s*(\d+) characters?$/, "Too long: at most $1 characters")
    .replace(/^Too big: expected array to have <=?\s*(\d+) items?$/, "At most $1 entries");
}
