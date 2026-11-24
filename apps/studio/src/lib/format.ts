// Dates render on the server (SSR) and again in the browser. The server cannot know the viewer's time zone or
// locale, so server output uses English + UTC and the <Timestamp> component re-renders in the viewer's locale and
// time zone after hydration (see components/kf/timestamp.tsx). Plain calls default to the runtime's locale.

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

export interface DateFormatOptions {
  /** BCP 47 locale; undefined = the runtime default (the viewer's, in the browser) */
  locale?: string;
  /** IANA time zone; undefined = the runtime default */
  timeZone?: string;
}

export function timeAgo(iso: string | null | undefined, now = Date.now(), opts: DateFormatOptions = {}): string {
  if (!iso) return "never";
  const secs = (new Date(iso).getTime() - now) / 1000;
  if (Number.isNaN(secs)) return "—";
  const rtf = new Intl.RelativeTimeFormat(opts.locale, { numeric: "auto" });
  for (const [unit, s] of UNITS) {
    if (Math.abs(secs) >= s) return rtf.format(Math.round(secs / s), unit);
  }
  return "just now";
}

export function formatDate(iso: string | null | undefined, opts: DateFormatOptions = {}): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const text = d.toLocaleString(opts.locale, { dateStyle: "medium", timeStyle: "short", timeZone: opts.timeZone });
  return opts.timeZone === "UTC" ? `${text} UTC` : text;
}

export function formatTime(iso: string | null | undefined, opts: DateFormatOptions = {}): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(opts.locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: opts.timeZone });
}

export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "";
}

export type ProfileMap = Record<string, { display_name: string | null; kind: "human" | "agent" }>;

/**
 * Human-readable actor labels for the actor strings written by apply_proposal & co:
 *   human:<uuid> | curator/<model> | process:policy | import:okf | user:<uuid> | system
 */
export function actorLabel(actor: string | null | undefined, profiles: ProfileMap = {}): string {
  if (!actor) return "Unknown";
  const [prefix, rest] = actor.includes(":") ? [actor.slice(0, actor.indexOf(":")), actor.slice(actor.indexOf(":") + 1)] : [actor, ""];
  if (prefix === "human" || prefix === "user") return profiles[rest]?.display_name ?? `User ${shortId(rest)}`;
  if (actor.startsWith("curator")) return actor.includes("/") ? `Curator · ${actor.split("/").slice(1).join("/")}` : "Curator";
  if (actor === "process:policy") return "Auto-apply policy";
  if (prefix === "import") return `Import (${rest})`;
  if (actor === "system") return "System";
  return actor;
}

export function slugify(s: string, max = 40): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Postgres/PostgREST errors -> a sentence a human can act on. */
export function errorMessage(e: unknown): string {
  if (!e) return "Something went wrong";
  if (typeof e === "string") return e;
  const err = e as { message?: string; code?: string; details?: string; hint?: string };
  if (err.code === "42501") return err.message?.replace(/^new row violates row-level security policy.*$/, "You don't have permission to do that") ?? "Permission denied";
  if (err.code === "23505") return "That name or slug is already taken";
  if (err.code === "23514") return "Some values are not in the expected format";
  return err.message ?? "Something went wrong";
}
