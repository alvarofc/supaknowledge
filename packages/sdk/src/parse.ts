// The `mcp` function renders read_concept / load_skill as model-ready markdown rather than JSON. These
// parsers recover the structured fields from that rendering (best effort) and keep the original text in
// `markdown`, which is what tool handlers pass back to the model.
import type { Concept, ConceptKind, ConceptStatus, Skill, TrustTier } from "./types.ts";

const SEP = "\n\n---\n\n";

function field(header: string, name: string): string | undefined {
  for (const line of header.split("\n")) {
    for (const part of line.split(" | ")) {
      const m = new RegExp(`^${name}:\\s*(.+)$`).exec(part.trim());
      if (m) return m[1]!.trim();
    }
  }
  return undefined;
}

// The trailers below are recognised by their exact rendered shape, anchored at the END of the text, rather than by
// scanning the body for markers: the body is free-form markdown (unclosed fences, fences inside list items, inline
// ``` spans, its own "Files:" / "## Files" sections), so its fence state must not decide where the trailer starts.
// A section only counts when everything from it to the end of the text is a well-formed renderer trailer.

// read_concept: "---" "Links:" "- <path>[ (<anchor>)][ [missing]]"..., "Referenced by:" "- <path> (<title>)"...,
// "Files:" "- <path> (<n> bytes|unknown size)"... [`Use load_skill("<name>") to get the file contents.`], each part separated by
// a blank line and each optional; with an empty body the first one starts the remainder.
const ITEMS = String.raw`((?:\n\n- [^\n]+)+)`;
const FILES_TRAILER = new RegExp(String.raw`(?:^|\n\n)Files:${ITEMS}(?:\n\nUse load_skill\("[^"\n]*"\) to get the file contents\.)?$`);
const BACKLINKS_TRAILER = new RegExp(String.raw`(?:^|\n\n)Referenced by:${ITEMS}$`);
const LINKS_TRAILER = new RegExp(String.raw`(?:^|\n\n)---\n\nLinks:${ITEMS}$`);

// load_skill: "---" "## Files", then per file "### <path>" and either a ```-fenced block (the renderer escapes ``` in
// the content, so no content line starts with ```) or a "(binary|not inlined; <n> bytes; storage: ...)" note.
const T = "```";
const SKILL_FILE = String.raw`\n\n### ([^\n]+)\n\n(?:${T}[^\n]*\n(?:(?!${T})[^\n]*\n)*${T}|\((?:binary|not inlined); [^\n]*\))`;
const SKILL_TRAILER = new RegExp(String.raw`(?:^|\n\n)---\n\n## Files((?:${SKILL_FILE})+)$`);

/** Split `text` into the part before a trailer matching `re` (anchored at the end) and the trailer's first group. */
function splitTrailer(text: string, re: RegExp): [string, string | undefined] {
  const m = re.exec(text);
  return m ? [text.slice(0, m.index), m[1]] : [text, undefined];
}

const items = (list: string | undefined): string[] => (list ? list.split("\n\n").filter(Boolean).map((l) => l.slice(2)) : []);

export function parseConceptMarkdown(text: string): Concept {
  const i = text.indexOf(SEP);
  const header = i >= 0 ? text.slice(0, i) : text;
  const rest = i >= 0 ? text.slice(i + SEP.length) : "";
  const title = /^#\s+(.+)$/m.exec(header)?.[1]?.trim() ?? "";
  const description = /^_(.+)_$/m.exec(header)?.[1]?.trim() ?? "";
  const trustLine = /^trust:\s*(.+)$/m.exec(header)?.[1] ?? ""; // whole line: "human_reviewed | STALE (...)"
  const [beforeFiles, filesList] = splitTrailer(rest, FILES_TRAILER);
  const [beforeBacklinks] = splitTrailer(beforeFiles, BACKLINKS_TRAILER);
  const [body, linksList] = splitTrailer(beforeBacklinks, LINKS_TRAILER);
  const links = items(linksList).flatMap((l) => {
    const m = /^(\S+)(.*)$/.exec(l);
    return m ? [{ path: m[1]!, exists: !m[2]!.includes("[missing]") }] : [];
  });
  // the renderer always prints a size suffix ("(<n> bytes)" or "(unknown size)"); older servers omitted it for 0 / unknown
  const files = items(filesList).map((l) => {
    const m = /^(.+?)(?: \((?:(\d+) bytes|unknown size)\))?$/.exec(l)!;
    return { path: m[1]!, ...(m[2] ? { size_bytes: Number(m[2]) } : {}) };
  });
  return {
    path: field(header, "path") ?? "",
    kind: (field(header, "kind") ?? "domain") as ConceptKind,
    type: field(header, "type") ?? "",
    title,
    description,
    status: (field(header, "status") ?? "stable") as ConceptStatus,
    revision: Number(field(header, "revision")) || undefined,
    trust: (trustLine.split(" ")[0] || undefined) as TrustTier | undefined,
    stale: /STALE/.test(trustLine),
    body: body.trim(),
    ...(links.length ? { links } : {}),
    ...(files.length ? { files } : {}),
    markdown: text,
  };
}

export function parseSkillMarkdown(text: string): Skill {
  const i = text.indexOf(SEP);
  const header = i >= 0 ? text.slice(0, i) : text;
  const rest = i >= 0 ? text.slice(i + SEP.length) : "";
  const name = /^#\s+Skill:\s*(.+)$/m.exec(header)?.[1]?.trim() ?? "";
  const [body, filesTrailer] = splitTrailer(rest, SKILL_TRAILER);
  const files = filesTrailer ? [...filesTrailer.matchAll(new RegExp(SKILL_FILE, "g"))].map((m) => ({ path: m[1]!.trim() })) : [];
  return {
    name,
    path: field(header, "path") ?? name,
    kind: "skill",
    type: "Skill",
    title: name,
    description: field(header, "description") ?? "",
    status: (field(header, "status") ?? "stable") as ConceptStatus,
    revision: Number(field(header, "revision")) || undefined,
    body: body.trim(),
    ...(files.length ? { files } : {}),
    markdown: text,
  };
}
