// Markdown + YAML frontmatter, following OKF §4 syntax rules:
//   * the file starts with an exact "---" line
//   * YAML 1.2 core schema, no duplicate keys, no custom tags
//   * unknown keys are preserved untouched
import { parseDocument, stringify } from "yaml";

export interface ParsedMarkdown {
  /** null when the file has no frontmatter block */
  frontmatter: Record<string, unknown> | null;
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export class FrontmatterError extends Error {}

export function parseMarkdown(text: string): ParsedMarkdown {
  const src = text.replace(/^﻿/, "");
  if (!src.startsWith("---")) return { frontmatter: null, body: src };
  const m = FENCE.exec(src);
  if (!m) return { frontmatter: null, body: src };
  const doc = parseDocument(m[1] ?? "", { schema: "core", uniqueKeys: true, customTags: [] });
  if (doc.errors.length > 0) {
    throw new FrontmatterError(doc.errors.map((e) => e.message).join("; "));
  }
  const value = doc.toJS() as unknown;
  if (value === null || value === undefined) return { frontmatter: {}, body: src.slice(m[0].length) };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FrontmatterError("frontmatter must be a YAML mapping");
  }
  return { frontmatter: value as Record<string, unknown>, body: src.slice(m[0].length) };
}

/** Keys that are emitted first, in this order, for readable files. Others keep insertion order. */
const PREFERRED_ORDER = [
  "okf_version",
  "name",
  "type",
  "title",
  "description",
  "resource",
  "tags",
  "status",
  "superseded_by",
  "stale_after",
  "sources",
  "usage_window",
  "generated",
  "verified",
  "license",
  "compatibility",
  "allowed-tools",
  "metadata",
];

export function orderKeys(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PREFERRED_ORDER) if (k in fm && fm[k] !== undefined) out[k] = fm[k];
  for (const [k, v] of Object.entries(fm)) if (!(k in out) && v !== undefined) out[k] = v;
  return out;
}

export function serializeMarkdown(frontmatter: Record<string, unknown> | null, body: string): string {
  const cleanBody = body.replace(/^\n+/, "");
  if (!frontmatter) return cleanBody.endsWith("\n") ? cleanBody : cleanBody + "\n";
  const yaml = stringify(orderKeys(frontmatter), {
    schema: "core",
    lineWidth: 0,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  }).trimEnd();
  const text = `---\n${yaml}\n---\n\n${cleanBody}`;
  return text.endsWith("\n") ? text : text + "\n";
}
