// Import/export between Supaknowledge concepts and portable files:
//   * OKF bundles (Open Knowledge Format v0.3): <concept-path>.md with YAML frontmatter, index.md, log.md
//   * Agent Skills: skills/<name>/SKILL.md (+ scripts/, references/, assets/)
//
// Round-trip rule: unknown frontmatter keys are preserved verbatim in `concept.frontmatter`.
// Supaknowledge-specific state travels in `x-supaknowledge-*` keys (OKF's extension convention).
import { parseMarkdown, serializeMarkdown, FrontmatterError } from "./frontmatter.ts";
import type { Audience, ConceptDraft, ConceptFile, ConceptKind, ConceptStatus } from "./types.ts";

export const OKF_VERSION = "0.3";

/** Keys Supaknowledge maps to columns; everything else stays in `frontmatter`. */
const CORE_OKF_KEYS = ["type", "title", "description", "tags", "status", "superseded_by", "stale_after"] as const;
const SUPAKNOWLEDGE_KEYS = ["x-supaknowledge-kind", "x-supaknowledge-audience"] as const;
const SKILL_KEYS = ["name", "description"] as const;
/** Written by exportBundle from database state; on import they are derived again, never stored. */
const EXPORT_ONLY_KEYS = ["generated", "verified"] as const;

function stripSkillMetadata(fm: Record<string, unknown>): Record<string, unknown> {
  const out = { ...fm };
  if (out.metadata && typeof out.metadata === "object" && !Array.isArray(out.metadata)) {
    const meta = Object.fromEntries(Object.entries(out.metadata as Record<string, unknown>).filter(([k]) => !k.startsWith("supaknowledge-")));
    if (Object.keys(meta).length) out.metadata = meta;
    else delete out.metadata;
  }
  return out;
}

export const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const DATA_TYPE_RE = /\b(table|dataset|view|endpoint|api|query|warehouse|database|schema|column|metric source|attested computation|bigquery|snowflake|postgres|salesforce)\b/i;

export interface ImportedConcept {
  draft: ConceptDraft;
  files: ConceptFile[];
  /** original file path inside the bundle */
  sourcePath: string;
}

export interface ImportResult {
  bundle: { title?: string; description?: string; okf_version?: string; license?: string };
  concepts: ImportedConcept[];
  warnings: string[];
}

export interface BundleFile {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}

/** Group slug <-> id mapping so exported audiences are readable and portable across workspaces. */
export interface AudienceMap {
  toSlug: (id: string) => string | undefined;
  toId: (slug: string) => string | undefined;
}

const identityMap: AudienceMap = { toSlug: (x) => x, toId: (x) => x };

function asString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  return typeof v === "string" ? v : String(v);
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string" && v.trim()) return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

function asStatus(v: unknown): ConceptStatus {
  return v === "draft" || v === "deprecated" ? v : "stable";
}

function isTimestamp(v: unknown): v is string {
  return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

function firstHeading(body: string): string | undefined {
  return /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
}

function firstSentence(body: string): string {
  const para = body
    .replace(/^#.*$/gm, "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith("```") && !p.startsWith("|"));
  if (!para) return "";
  const s = /^(.{1,280}?[.!?])(\s|$)/.exec(para.replace(/\s+/g, " "));
  return (s?.[1] ?? para.slice(0, 280)).trim();
}

export function inferKind(type: string, explicit?: unknown): ConceptKind {
  if (explicit === "skill" || explicit === "domain" || explicit === "data_access") return explicit;
  return DATA_TYPE_RE.test(type) ? "data_access" : "domain";
}

function pickExtra(fm: Record<string, unknown>, drop: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) if (!drop.includes(k)) out[k] = v;
  return out;
}

function isReserved(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  return base === "index.md" || base === "log.md" || path.split("/").some((seg) => seg.startsWith("."));
}

/** Parse an OKF bundle and/or Agent Skills tree into concept drafts. */
export function importBundle(files: BundleFile[], audienceMap: AudienceMap = identityMap): ImportResult {
  const warnings: string[] = [];
  const concepts: ImportedConcept[] = [];
  const bundle: ImportResult["bundle"] = {};
  const byPath = new Map(files.map((f) => [f.path.replace(/^\.?\//, ""), f]));

  // Fail closed: a concept restricted to a group we cannot resolve is skipped, never imported as public.
  const toAudience = (v: unknown, where: string): Audience | null => {
    const ids: string[] = [];
    const unknown: string[] = [];
    for (const slug of asStringArray(v)) {
      const id = audienceMap.toId(slug);
      if (id) ids.push(id);
      else unknown.push(slug);
    }
    if (unknown.length) {
      warnings.push(`${where}: skipped, audience group(s) ${unknown.map((u) => `"${u}"`).join(", ")} do not exist in this workspace (create them, then import again)`);
      return null;
    }
    return ids;
  };

  // 1. skills: every SKILL.md owns its directory. A SKILL.md at the bundle root (a bundle that *is* one skill)
  // owns only the Agent Skills resource folders next to it, so OKF concepts in the same bundle still import.
  const skillDirs = new Set<string>();
  const ROOT_SKILL_DIRS = ["scripts/", "references/", "assets/"];
  const ownedByRootSkill = (p: string) => ROOT_SKILL_DIRS.some((d) => p.startsWith(d));
  for (const [path, f] of byPath) {
    if (!/(^|\/)SKILL\.md$/.test(path) || (f.encoding ?? "utf8") !== "utf8") continue;
    const dir = path.replace(/\/?SKILL\.md$/, "");
    let parsed;
    try {
      parsed = parseMarkdown(f.content);
    } catch (e) {
      warnings.push(`${path}: ${(e as Error).message}`);
      continue;
    }
    const fm = parsed.frontmatter ?? {};
    const name = asString(fm.name) ?? dir.split("/").pop() ?? "";
    if (!SKILL_NAME_RE.test(name)) warnings.push(`${path}: skill name "${name}" is not a valid Agent Skills name`);
    const description = asString(fm.description) ?? firstSentence(parsed.body);
    if (!description) warnings.push(`${path}: skill has no description`);
    const meta = (fm.metadata && typeof fm.metadata === "object" ? fm.metadata : {}) as Record<string, unknown>;
    skillDirs.add(dir);
    const skillAudience = toAudience(meta["supaknowledge-audience"], path);
    if (skillAudience === null) continue;
    const conceptPath = dir || `skills/${name}`;
    const skillFiles: ConceptFile[] = [];
    for (const [p, other] of byPath) {
      if (p === path) continue;
      if (dir ? p.startsWith(dir + "/") : ownedByRootSkill(p)) {
        skillFiles.push({ path: dir ? p.slice(dir.length + 1) : p, content: other.content, encoding: other.encoding ?? "utf8" });
      }
    }
    concepts.push({
      sourcePath: path,
      files: skillFiles,
      draft: {
        path: conceptPath,
        kind: "skill",
        type: asString(meta["supaknowledge-type"]) ?? "Skill",
        title: asString(meta["supaknowledge-title"]) ?? firstHeading(parsed.body) ?? name,
        description,
        body: parsed.body.trim() + "\n",
        frontmatter: stripSkillMetadata(pickExtra(fm, [...SKILL_KEYS, ...EXPORT_ONLY_KEYS])),
        tags: asStringArray(meta["supaknowledge-tags"]),
        status: asStatus(meta["supaknowledge-status"]),
        superseded_by: null,
        stale_after: isTimestamp(meta["supaknowledge-stale-after"]) ? (meta["supaknowledge-stale-after"] as string) : null,
        audience: skillAudience,
      },
    });
  }

  // 2. OKF concepts
  for (const [path, f] of byPath) {
    if (!path.endsWith(".md") || (f.encoding ?? "utf8") !== "utf8") continue;
    if (path === "SKILL.md" || [...skillDirs].some((d) => (d === "" ? ownedByRootSkill(path) : path.startsWith(d + "/")))) continue;
    if (path === "index.md") {
      try {
        const fm = parseMarkdown(f.content).frontmatter ?? {};
        bundle.okf_version = asString(fm.okf_version);
        bundle.title = asString(fm.title);
        bundle.description = asString(fm.description);
        bundle.license = asString(fm.license);
      } catch (e) {
        warnings.push(`index.md: ${(e as Error).message}`);
      }
      continue;
    }
    if (isReserved(path)) continue;
    let parsed;
    try {
      parsed = parseMarkdown(f.content);
    } catch (e) {
      warnings.push(`${path}: ${e instanceof FrontmatterError ? e.message : (e as Error).message}`);
      continue;
    }
    const fm = parsed.frontmatter;
    const type = asString(fm?.type);
    if (!fm || !type) continue; // OKF: not a concept (README.md, AGENTS.md, ...)
    const conceptPath = path.replace(/\.md$/, "");
    const audience = toAudience(fm["x-supaknowledge-audience"], path);
    if (audience === null) continue;
    concepts.push({
      sourcePath: path,
      files: [],
      draft: {
        path: conceptPath,
        kind: inferKind(type, fm["x-supaknowledge-kind"]),
        type,
        title: asString(fm.title) ?? firstHeading(parsed.body) ?? conceptPath.split("/").pop()!,
        description: asString(fm.description) ?? firstSentence(parsed.body),
        body: parsed.body.trim() + "\n",
        frontmatter: pickExtra(fm, [...CORE_OKF_KEYS, ...SUPAKNOWLEDGE_KEYS, ...EXPORT_ONLY_KEYS]),
        tags: asStringArray(fm.tags),
        status: asStatus(fm.status),
        superseded_by: asString(fm.superseded_by) ?? null,
        stale_after: isTimestamp(fm.stale_after) ? (fm.stale_after as string) : null,
        audience,
      },
    });
  }

  if (bundle.okf_version && bundle.okf_version !== OKF_VERSION) {
    warnings.push(`bundle declares okf_version ${bundle.okf_version}; read on a best-effort basis (Supaknowledge writes ${OKF_VERSION})`);
  }
  // one concept per path: skills/foo/SKILL.md and skills/foo.md would both become "skills/foo"
  const seen = new Map<string, string>();
  const unique: ImportedConcept[] = [];
  for (const c of concepts) {
    const first = seen.get(c.draft.path);
    if (first) {
      warnings.push(`${c.sourcePath}: skipped, concept path "${c.draft.path}" is already defined by ${first}`);
      continue;
    }
    seen.set(c.draft.path, c.sourcePath);
    unique.push(c);
  }
  unique.sort((a, b) => a.draft.path.localeCompare(b.draft.path));
  return { bundle, concepts: unique, warnings };
}

// ---------------------------------------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------------------------------------

export interface ExportConcept extends ConceptDraft {
  revision?: number;
  generated_by?: string | null;
  generated_at?: string | null;
  verified?: { by: string; at: string }[];
  files?: ConceptFile[];
}

export interface ExportOptions {
  title: string;
  description?: string;
  license?: string;
  audienceMap?: AudienceMap;
  /** newest first; rendered into log.md */
  log?: { at: string; kind: "Creation" | "Update" | "Deprecation"; path: string; summary: string; conceptKind?: ConceptKind }[];
  /** skip concepts whose audience is restricted (for public exports) */
  publicOnly?: boolean;
}

export function skillName(path: string): string {
  return path.split("/").pop()!;
}

/** x-supaknowledge-* keys (and export-only keys) are re-derived from columns on export, never copied. */
function withoutDerivedKeys(fm: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fm).filter(([k]) => !k.startsWith("x-supaknowledge-") && !(EXPORT_ONLY_KEYS as readonly string[]).includes(k)));
}

export function conceptToFiles(c: ExportConcept, audienceMap: AudienceMap = identityMap): BundleFile[] {
  const audience = c.audience.map((id) => audienceMap.toSlug(id) ?? id);
  if (c.kind === "skill") {
    const name = skillName(c.path);
    const prevMeta = (c.frontmatter.metadata && typeof c.frontmatter.metadata === "object" && !Array.isArray(c.frontmatter.metadata)
      ? c.frontmatter.metadata
      : {}) as Record<string, unknown>;
    // supaknowledge-* metadata is always derived from the columns below, never carried over (stale audiences!)
    const metadata: Record<string, unknown> = Object.fromEntries(Object.entries(prevMeta).filter(([k]) => !k.startsWith("supaknowledge-")));
    if (c.type !== "Skill") metadata["supaknowledge-type"] = c.type;
    if (c.title !== (firstHeading(c.body) ?? name)) metadata["supaknowledge-title"] = c.title;
    if (c.tags.length) metadata["supaknowledge-tags"] = c.tags;
    if (c.status !== "stable") metadata["supaknowledge-status"] = c.status;
    if (c.stale_after) metadata["supaknowledge-stale-after"] = c.stale_after;
    if (audience.length) metadata["supaknowledge-audience"] = audience;
    if (c.revision) metadata["supaknowledge-revision"] = String(c.revision);
    const fm: Record<string, unknown> = { ...withoutDerivedKeys(c.frontmatter), name, description: c.description.slice(0, 1024) };
    if (Object.keys(metadata).length) fm.metadata = metadata;
    else delete fm.metadata;
    const dir = c.path;
    return [
      { path: `${dir}/SKILL.md`, content: serializeMarkdown(fm, c.body) },
      ...(c.files ?? []).map((f) => ({ path: `${dir}/${f.path}`, content: f.content, encoding: f.encoding })),
    ];
  }

  const fm: Record<string, unknown> = {
    ...withoutDerivedKeys(c.frontmatter),
    type: c.type,
    title: c.title,
    description: c.description || undefined,
    tags: c.tags.length ? c.tags : undefined,
    status: c.status !== "stable" ? c.status : undefined,
    superseded_by: c.superseded_by ?? undefined,
    stale_after: c.stale_after ?? undefined,
  };
  if (c.generated_by && c.generated_at) fm.generated = { by: c.generated_by, at: c.generated_at };
  if (c.verified?.length) fm.verified = c.verified;
  if (c.kind !== inferKind(c.type)) fm["x-supaknowledge-kind"] = c.kind;
  if (audience.length) fm["x-supaknowledge-audience"] = audience;
  return [{ path: `${c.path}.md`, content: serializeMarkdown(fm, c.body) }];
}

function renderIndex(entries: { title: string; href: string; description: string }[], heading: string): string {
  const lines = [`# ${heading}`, ""];
  for (const e of entries.sort((a, b) => a.href.localeCompare(b.href))) {
    lines.push(`* [${e.title.replace(/[\[\]]/g, "")}](${e.href})${e.description ? ` - ${e.description}` : ""}`);
  }
  return lines.join("\n") + "\n";
}

export function exportBundle(concepts: ExportConcept[], opts: ExportOptions): BundleFile[] {
  const map = opts.audienceMap ?? identityMap;
  const visible = opts.publicOnly ? concepts.filter((c) => c.audience.length === 0) : concepts;
  const out: BundleFile[] = [];
  // the root index.md always exists (it carries okf_version and the bundle title), even for an empty bundle
  const byDir = new Map<string, { title: string; href: string; description: string }[]>([["", []]]);

  for (const c of visible) {
    out.push(...conceptToFiles(c, map));
    const isSkill = c.kind === "skill";
    const file = isSkill ? `${c.path}/SKILL.md` : `${c.path}.md`;
    const dir = isSkill ? c.path.split("/").slice(0, -1).join("/") : c.path.split("/").slice(0, -1).join("/");
    const rel = file.slice(dir ? dir.length + 1 : 0);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push({ title: c.title, href: rel, description: c.description });
  }

  // make sure every ancestor directory is listed in its parent index
  for (const dir of [...byDir.keys()]) {
    let d = dir;
    while (d) {
      const parent = d.split("/").slice(0, -1).join("/");
      const name = d.split("/").pop()!;
      if (!byDir.has(parent)) byDir.set(parent, []);
      const list = byDir.get(parent)!;
      if (!list.some((e) => e.href === `${name}/index.md`)) list.push({ title: name, href: `${name}/index.md`, description: "" });
      d = parent;
    }
  }

  for (const [dir, entries] of byDir) {
    if (dir === "") {
      const fm: Record<string, unknown> = { okf_version: OKF_VERSION, title: opts.title };
      if (opts.description) fm.description = opts.description;
      if (opts.license) fm.license = opts.license;
      out.push({ path: "index.md", content: serializeMarkdown(fm, renderIndex(entries, opts.title)) });
    } else {
      out.push({ path: `${dir}/index.md`, content: renderIndex(entries, dir.split("/").pop()!) });
    }
  }

  if (opts.log?.length) {
    const byDay = new Map<string, string[]>();
    for (const e of opts.log) {
      const day = e.at.slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      const isSkill = (e.conceptKind ?? visible.find((c) => c.path === e.path)?.kind) === "skill";
      byDay.get(day)!.push(`* **${e.kind}** [${e.path}](${isSkill ? `${e.path}/SKILL.md` : `${e.path}.md`}): ${e.summary}`);
    }
    const days = [...byDay.keys()].sort().reverse();
    const body = ["# Log", "", ...days.flatMap((d) => [`## ${d}`, "", ...byDay.get(d)!, ""])].join("\n");
    out.push({ path: "log.md", content: body.trimEnd() + "\n" });
  }

  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * A storable concept path (the database's concepts_path_check; private.valid_concept_path also caps it at 512):
 * letters, digits, _ . / -, starting with a letter, digit or _; no "..", no ".md" suffix, and no empty or "."
 * segment ("a//b", "a/./b", trailing "/"). Reserved names (index, log) are checked separately.
 */
export function isValidConceptPath(path: string): boolean {
  return (
    /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(path) &&
    !path.includes("..") &&
    !path.endsWith(".md") &&
    !path.split("/").some((s) => s === "" || s === ".")
  );
}

/** Validate a concept draft against OKF + Agent Skills rules. Returns human-readable problems. */
export function lintConcept(d: Partial<ConceptDraft> & { path: string }, files: ConceptFile[] = []): string[] {
  const problems: string[] = [];
  if (!isValidConceptPath(d.path)) {
    problems.push(`invalid path "${d.path}" (use letters, digits, _ . / -; no empty or "." segments, no ".md")`);
  }
  if (d.path.split("/").some((s) => s === "index" || s === "log")) problems.push(`"index" and "log" are reserved names`);
  if (d.type !== undefined && !d.type.trim()) problems.push("type is required");
  if (d.title !== undefined && !d.title.trim()) problems.push("title is required");
  if (d.kind === "skill") {
    const name = skillName(d.path);
    if (!SKILL_NAME_RE.test(name)) problems.push(`skill name "${name}" must be lowercase letters, digits and hyphens (1-64)`);
    if (!d.description?.trim()) problems.push("skills need a description that says what they do and when to use them");
    if ((d.description?.length ?? 0) > 1024) problems.push("skill description must be at most 1024 characters");
    const lines = (d.body ?? "").split("\n").length;
    if (lines > 500) problems.push(`skill body is ${lines} lines; keep it under 500 and move detail into references/`);
  } else if (d.description && d.description.length > 400) {
    problems.push("description should be one sentence (OKF); move detail into the body");
  }
  if (d.stale_after && Number.isNaN(Date.parse(d.stale_after))) problems.push("stale_after must be an RFC 3339 timestamp");
  for (const f of files) {
    if (f.path.includes("..") || f.path.startsWith("/")) problems.push(`invalid file path "${f.path}"`);
  }
  return problems;
}
