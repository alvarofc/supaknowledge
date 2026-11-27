// Monthly knowledge recap: the shape of rpc knowledge_recap, month helpers, and the KPI list that the page, the
// PNG export and the Slack text all render from (so the three never disagree). Pure: no React, no Supabase.

export interface Recap {
  /** YYYY-MM */
  month: string;
  /** spaces counted (1 for a space recap) */
  spaces: number;
  concepts_added: number;
  concepts_changed: number;
  revisions: number;
  most_corrected: { path: string; title: string; kind: string; space_slug: string; space_name: string; n: number } | null;
  applied_by_people: number;
  applied_by_agents: number;
  applied_by_policy: number;
  flags_raised: number;
  flags_fixed: number;
  top_flagger: { display_name: string | null; kind: "human" | "agent"; n: number } | null;
  /** seconds; null when no flag was fixed in the month */
  median_fix_seconds: number | null;
  went_stale: number;
  stale_fixed: number;
}

export interface Kpi {
  key: string;
  /** names the measure */
  label: string;
  value: string;
  /** at most one line of context */
  context?: string;
  /** the value is a placeholder ("None"), not a number */
  empty?: boolean;
  /** concept to link to, for the page */
  concept?: { space_slug: string; path: string };
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The current calendar month in UTC, as YYYY-MM. */
export function currentMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** A valid YYYY-MM that is not in the future, or the current month. */
export function normalizeMonth(input: unknown, now: Date = new Date()): string {
  const cur = currentMonth(now);
  if (typeof input !== "string" || !MONTH_RE.test(input)) return cur;
  return input > cur ? cur : input;
}

/** YYYY-MM moved by `delta` months. */
export function shiftMonth(month: string, delta: number): string {
  const m = MONTH_RE.exec(month);
  if (!m) return month;
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** "November 2026". Always English and UTC, so server and browser render the same text. */
export function monthLabel(month: string): string {
  const m = MONTH_RE.exec(month);
  if (!m) return month;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** The `count` months up to and including `latest`, newest first. */
export function recentMonths(latest: string, count = 24): string[] {
  return Array.from({ length: count }, (_, i) => shiftMonth(latest, -i));
}

/** 2700 -> "45 min", 18000 -> "5 hours", 270000 -> "3.1 days". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, seconds);
  const fmt = (n: number, unit: string) => {
    const v = n < 10 ? Math.round(n * 10) / 10 : Math.round(n);
    return `${v} ${unit}${v === 1 ? "" : "s"}`;
  };
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 48 * 3600) return fmt(s / 3600, "hour");
  return fmt(s / 86400, "day");
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** True when nothing happened in the month (as far as the caller can see). */
export function isEmptyRecap(r: Recap): boolean {
  return (
    r.revisions === 0 &&
    r.flags_raised === 0 &&
    r.flags_fixed === 0 &&
    r.went_stale === 0 &&
    r.applied_by_people + r.applied_by_agents + r.applied_by_policy === 0
  );
}

/** The recap's KPIs, in display order. */
export function recapKpis(r: Recap): Kpi[] {
  const kpis: Kpi[] = [
    { key: "added", label: "Concepts added", value: String(r.concepts_added) },
    { key: "changed", label: "Concepts changed", value: String(r.concepts_changed), context: plural(r.revisions, "revision") + " in total" },
    r.most_corrected
      ? {
          key: "corrected",
          label: "Most corrected concept",
          value: r.most_corrected.title,
          context: r.spaces > 1 ? `${plural(r.most_corrected.n, "change")} in ${r.most_corrected.space_name}` : plural(r.most_corrected.n, "change"),
          concept: { space_slug: r.most_corrected.space_slug, path: r.most_corrected.path },
        }
      : { key: "corrected", label: "Most corrected concept", value: "None", context: "No concept was changed after it was created", empty: true },
    r.top_flagger
      ? {
          key: "flagger",
          label: "Top flagger",
          value: r.top_flagger.display_name ?? (r.top_flagger.kind === "agent" ? "Unnamed agent" : "Unnamed person"),
          context: `${plural(r.top_flagger.n, "flag")} led to applied fixes`,
        }
      : { key: "flagger", label: "Top flagger", value: "None", context: "No flag led to an applied fix", empty: true },
    { key: "people", label: "Applied by people", value: String(r.applied_by_people), context: r.applied_by_agents ? `${r.applied_by_agents} more by agent reviewers` : undefined },
    { key: "policy", label: "Applied by policy", value: String(r.applied_by_policy) },
    r.median_fix_seconds === null
      ? { key: "median", label: "Median time from flag to fix", value: "None", context: "No flag was fixed this month", empty: true }
      : { key: "median", label: "Median time from flag to fix", value: formatDuration(r.median_fix_seconds), context: `Across ${plural(r.flags_fixed, "fixed flag")}` },
    { key: "flags", label: "Flags raised", value: String(r.flags_raised) },
    { key: "stale", label: "Went stale", value: String(r.went_stale), context: r.went_stale ? `${r.stale_fixed} fixed by month end` : undefined },
  ];
  return kpis;
}

/** Plain text for Slack (its mrkdwn reads *bold*; everything else is plain). */
export function recapText(r: Recap, scopeName: string): string {
  const lines = [`*Knowledge recap: ${scopeName}, ${monthLabel(r.month)}*`];
  if (isEmptyRecap(r)) {
    lines.push("No knowledge changed and no flags were raised this month.");
    return lines.join("\n");
  }
  for (const k of recapKpis(r)) {
    lines.push(`• ${k.label}: ${k.value}${k.context ? ` (${k.context})` : ""}`);
  }
  return lines.join("\n");
}
