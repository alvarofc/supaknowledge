// Skill file paths (relative to the skill directory) that may become Storage keys / concept_files rows.

/**
 * Safe relative file path: non-empty, no surrounding whitespace, no leading `/`, no backslash, no control
 * characters, no empty / `.` / `..` segments, and no `..` anywhere (concept_files has the same CHECK).
 */
export function isSafeFilePath(p: unknown): p is string {
  if (typeof p !== "string" || !p.trim() || p !== p.trim() || p.length > 512) return false;
  if (p.startsWith("/") || p.includes("\\") || p.includes("..")) return false;
  // deno-lint-ignore no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s.trim() === s);
}
