// Terminal output: colors (off for --json, pipes, NO_COLOR), tables, relative times and diffs.
import { createTwoFilesPatch } from "diff";
import { styleText } from "node:util";

type Style = Parameters<typeof styleText>[0];

export interface Colors {
  enabled: boolean;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  dim(s: string): string;
  bold(s: string): string;
  magenta(s: string): string;
}

export function makeColors(enabled: boolean): Colors {
  const f = (style: Style) => (s: string) => (enabled ? styleText(style, s, { validateStream: false }) : s);
  return {
    enabled,
    red: f("red"),
    green: f("green"),
    yellow: f("yellow"),
    cyan: f("cyan"),
    dim: f("dim"),
    bold: f("bold"),
    magenta: f("magenta"),
  };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
export const visibleLength = (s: string): number => s.replace(ANSI, "").length;

export function table(headers: string[], rows: (string | number | null | undefined)[][], c: Colors): string {
  if (!rows.length) return c.dim("(none)");
  const cells = rows.map((r) => r.map((x) => (x === null || x === undefined ? "" : String(x))));
  const widths = headers.map((h, i) => Math.max(visibleLength(h), ...cells.map((r) => visibleLength(r[i] ?? ""))));
  const pad = (s: string, i: number) => s + " ".repeat(Math.max(0, widths[i]! - visibleLength(s)));
  const line = (r: string[], isHead = false) =>
    r.map((s, i) => (i === r.length - 1 ? s : pad(s, i))).map((s) => (isHead ? c.bold(s) : s)).join("  ").trimEnd();
  return [line(headers, true), ...cells.map((r) => line(r))].join("\n");
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (Number.isNaN(s)) return iso;
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "";
}

export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

/** Unified diff, colored. Returns "" when there is no change. */
export function unifiedDiff(oldName: string, newName: string, before: string, after: string, c: Colors): string {
  if (before === after) return "";
  const patch = createTwoFilesPatch(oldName, newName, before, after, "", "", { context: 3 });
  return patch
    .split("\n")
    .filter((l) => !/^=+$/.test(l) && !l.startsWith("Index:"))
    .map((l) => {
      if (l.startsWith("+++") || l.startsWith("---")) return c.bold(l);
      if (l.startsWith("@@")) return c.cyan(l);
      if (l.startsWith("+")) return c.green(l);
      if (l.startsWith("-")) return c.red(l);
      if (l.startsWith("\\")) return c.dim(l);
      return l;
    })
    .join("\n")
    .trimEnd();
}

export function statusColor(status: string, c: Colors): string {
  switch (status) {
    case "pending":
    case "open":
    case "queued":
    case "running":
      return c.yellow(status);
    case "applied":
    case "resolved":
    case "succeeded":
    case "human_reviewed":
      return c.green(status);
    case "rejected":
    case "conflicted":
    case "failed":
    case "dismissed":
      return c.red(status);
    default:
      return status;
  }
}
