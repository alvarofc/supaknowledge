/**
 * Untrusted URLs (source documents, citations, OAuth client metadata, frontmatter) are only rendered as links when
 * they are absolute http(s) URLs. Anything else (javascript:, data:, custom schemes, relative paths) returns null so
 * callers render plain text instead.
 */
export function safeHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}
