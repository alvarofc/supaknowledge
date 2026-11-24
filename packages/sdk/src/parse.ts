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

function cutTrailer(rest: string, markers: string[]): string {
  let end = rest.length;
  for (const m of markers) {
    const i = rest.lastIndexOf(m);
    if (i >= 0 && i < end) end = i;
  }
  return rest.slice(0, end).trim();
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
    markdown: text,
  };
}

export function parseSkillMarkdown(text: string): Skill {
  const i = text.indexOf(SEP);
  const header = i >= 0 ? text.slice(0, i) : text;
  const rest = i >= 0 ? text.slice(i + SEP.length) : "";
  const name = /^#\s+Skill:\s*(.+)$/m.exec(header)?.[1]?.trim() ?? "";
  const files = [...rest.matchAll(/^### (.+)$/gm)].map((m) => ({ path: m[1]!.trim() }));
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
