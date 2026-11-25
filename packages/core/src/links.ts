// OKF §6 links: standard markdown links are untyped directed edges between concepts.
//   scheme ("https:", "mailto:")  -> external
//   leading "/"                   -> bundle-root relative
//   otherwise                     -> relative to the linking file
// [[wikilinks]] are NOT links. Broken links are allowed. Links in code (fenced blocks, inline code) are not edges.
import { fencedLines, stripCodeSpans } from "./fences.ts";

export interface ExtractedLink {
  /** resolved concept path (no ".md", no leading "/") or null for external links */
  path: string | null;
  href: string;
  anchor: string;
  external: boolean;
}

const LINK_RE = /(!?)\[((?:[^\[\]]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

export function isExternal(href: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) || href.startsWith("//");
}

/** Normalise a/b/../c -> a/c. Returns null if the path escapes the bundle root. */
export function normalizePath(p: string): string | null {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Resolve an href found in the concept at `fromPath` to a concept path. */
export function resolveHref(fromPath: string, href: string): string | null {
  if (isExternal(href)) return null;
  let target = href.split("#")[0]!.split("?")[0]!;
  if (target === "") return null; // same-file anchor
  try {
    target = decodeURIComponent(target);
  } catch {
    /* keep raw */
  }
  const joined = target.startsWith("/") ? target.slice(1) : [dirname(fromPath), target].filter(Boolean).join("/");
  const norm = normalizePath(joined);
  if (norm === null || norm === "") return null;
  const path = norm.replace(/\.md$/i, "");
  // a bundle-root index.md / SKILL.md is not a concept
  if (/^(index|SKILL)$/i.test(path)) return null;
  return path.replace(/\/(index|SKILL)$/i, "") || null;
}

export function extractLinks(fromPath: string, markdown: string): ExtractedLink[] {
  const lines = markdown.split(/\r?\n/);
  const fenced = fencedLines(lines);
  const text = stripCodeSpans(lines.map((l, i) => (fenced[i] ? "" : l)).join("\n"));
  const seen = new Map<string, ExtractedLink>();
  for (const m of text.matchAll(LINK_RE)) {
    if (m[1] === "!") continue; // images are assets, not edges
    const anchor = (m[2] ?? "").trim();
    const href = m[3] ?? "";
    const external = isExternal(href);
    const path = external ? null : resolveHref(fromPath, href);
    const key = path ?? href;
    if (!external && path === null) continue;
    if (!seen.has(key)) seen.set(key, { path, href, anchor, external });
  }
  return [...seen.values()];
}

/** Relative href from one concept to another, as OKF producers should write it. */
export function relativeHref(fromPath: string, toPath: string): string {
  const from = dirname(fromPath).split("/").filter(Boolean);
  const to = toPath.split("/").filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const up = from.slice(i).map(() => "..");
  return [...up, ...to.slice(i)].join("/") + ".md";
}
