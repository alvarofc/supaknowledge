/** Studio URL of a concept page. */
export function conceptHref(base: string, path: string): string {
  return `${base}/knowledge/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Mirrors the concepts.path CHECK constraint. Returns an error message or null. */
export function validateConceptPath(path: string): string | null {
  if (!path) return "Path is required";
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(path)) return "Use letters, numbers, _, -, . and / only (start with a letter, number or _)";
  if (path.includes("..")) return "Path cannot contain “..”";
  if (/\.md$/.test(path)) return "Leave off the .md extension";
  if (path.endsWith("/")) return "Path cannot end with /";
  return null;
}
