/**
 * Resolve a markdown link inside a concept to a Studio URL, with the same rules as the importer's link extraction
 * (packages/core/src/links.ts): relative to the linking file, "/" = bundle root, "?query" dropped, ".md" and a
 * trailing "/SKILL" or "/index" stripped. `fromFile` is the linking file without ".md": a skill's body lives in
 * skills/<name>/SKILL.md, so pass `${path}/SKILL` for skills (see conceptFile). External URLs, same-page anchors and
 * links that escape the bundle root return null.
 */
export function resolveConceptHref(href: string, fromFile: string | undefined, knowledgeBase: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) return null;
  const hashAt = href.indexOf("#");
  const hash = hashAt >= 0 ? href.slice(hashAt + 1) : "";
  let target = (hashAt >= 0 ? href.slice(0, hashAt) : href).split("?")[0];
  if (!target) return null;
  try {
    target = decodeURIComponent(target);
  } catch {
    /* keep raw */
  }
  const parts = target.startsWith("/") || !fromFile ? [] : fromFile.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null; // escapes the bundle root
      parts.pop();
    } else parts.push(seg);
  }
  const file = parts.join("/").replace(/\.md$/i, "");
  if (!file || /^(index|SKILL)$/i.test(file)) return null;
  const path = file.replace(/\/(SKILL|index)$/i, "");
  return `${knowledgeBase}/${path.split("/").map(encodeURIComponent).join("/")}${hash ? `#${hash}` : ""}`;
}

/** The file a concept's body comes from (without ".md"): skills/<name>/SKILL for skills, the path otherwise. */
export function conceptFile(path: string, kind: string | undefined): string {
  return kind === "skill" ? `${path}/SKILL` : path;
}
