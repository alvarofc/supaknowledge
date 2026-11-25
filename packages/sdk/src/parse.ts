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

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Start offsets of the lines of `text` that open, close or sit inside a fenced code block (CommonMark rules). */
function fencedLines(text: string): Set<number> {
  const fenced = new Set<number>();
  let open: string | null = null;
  let pos = 0;
  for (const line of text.split("\n")) {
    const m = FENCE.exec(line);
    if (open !== null) {
      fenced.add(pos);
      // closed by a fence of the same character, at least as long, with nothing after it
      if (m && m[1]![0] === open[0] && m[1]!.length >= open.length && !m[2]!.trim()) open = null;
    } else if (m) {
      fenced.add(pos);
      open = m[1]!;
    }
    pos += line.length + 1;
  }
  return fenced;
}

/**
 * Last index of `marker` in `text` where the marker's last line is a whole line outside any fenced code block
 * (so a "## Files" or "Files:" inside a code sample in the body never counts), or -1.
 */
function lastMarker(text: string, marker: string, fenced = fencedLines(text)): number {
  const lineStartInMarker = marker.lastIndexOf("\n") + 1;
  for (let i = text.lastIndexOf(marker); i >= 0; i = i > 0 ? text.lastIndexOf(marker, i - 1) : -1) {
    const lineStart = i + lineStartInMarker;
    const end = i + marker.length;
    if ((lineStart === 0 || text[lineStart - 1] === "\n") && (end === text.length || text[end] === "\n") && !fenced.has(lineStart)) return i;
  }
  return -1;
}

function cutTrailer(rest: string, markers: string[]): string {
  const fenced = fencedLines(rest);
  let end = rest.length;
  for (const m of markers) {
    const i = lastMarker(rest, m, fenced);
    if (i >= 0 && i < end) end = i;
  }
  return rest.slice(0, end).trim();
}

/** Lines of `text` outside fenced code blocks. */
function linesOutsideFences(text: string): string[] {
  const fenced = fencedLines(text);
  const out: string[] = [];
  let pos = 0;
  for (const line of text.split("\n")) {
    if (!fenced.has(pos)) out.push(line);
    pos += line.length + 1;
  }
  return out;
}

export function parseConceptMarkdown(text: string): Concept {
  const i = text.indexOf(SEP);
  const header = i >= 0 ? text.slice(0, i) : text;
  const rest = i >= 0 ? text.slice(i + SEP.length) : "";
  const title = /^#\s+(.+)$/m.exec(header)?.[1]?.trim() ?? "";
  const description = /^_(.+)_$/m.exec(header)?.[1]?.trim() ?? "";
  const trustLine = /^trust:\s*(.+)$/m.exec(header)?.[1] ?? ""; // whole line: "human_reviewed | STALE (...)"
  const li = rest.lastIndexOf(`${SEP}Links:`);
  const linksText = li >= 0 ? cutTrailer(rest.slice(li + SEP.length), ["\n\nReferenced by:", "\n\nFiles:"]) : "";
  const links = [...linksText.matchAll(/^- (\S+)(.*)$/gm)].map((m) => ({ path: m[1]!, exists: !m[2]!.includes("[missing]") }));
  // read_concept ends with "Files:" and one "- <path> (<n> bytes)" line per attached file
  const fi = lastMarker(rest, "\n\nFiles:");
  const files =
    fi >= 0
      ? linesOutsideFences(rest.slice(fi + 2)).flatMap((line) => {
          const m = /^- (.+?)(?: \((\d+) bytes\))?$/.exec(line);
          return m ? [{ path: m[1]!, ...(m[2] ? { size_bytes: Number(m[2]) } : {}) }] : [];
        })
      : [];
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
    body: cutTrailer(rest, [`${SEP}Links:`, "\n\nReferenced by:", "\n\nFiles:"]),
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
  // load_skill ends with "---", "## Files" and one "### <path>" heading (then a fenced block or a note) per file;
  // headings in the instructions or inside file contents are not files
  const ti = lastMarker(rest, `${SEP}## Files`);
  const files =
    ti >= 0
      ? linesOutsideFences(rest.slice(ti + SEP.length)).flatMap((line) => {
          const m = /^### (.+)$/.exec(line);
          return m ? [{ path: m[1]!.trim() }] : [];
        })
      : [];
  return {
    name,
    path: field(header, "path") ?? name,
    kind: "skill",
    type: "Skill",
    title: name,
    description: field(header, "description") ?? "",
    status: (field(header, "status") ?? "stable") as ConceptStatus,
    revision: Number(field(header, "revision")) || undefined,
    body: cutTrailer(rest, [`${SEP}## Files`]),
    ...(files.length ? { files } : {}),
    markdown: text,
  };
}
