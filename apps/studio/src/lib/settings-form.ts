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
