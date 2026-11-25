// PostgREST fallbacks for the `bundle` Edge Function, used when it is not deployed (404/501).
// They run the same @supaknowledge/core import/export code as the function, under the caller's RLS.
// Limits vs. the function: skill attachments are not uploaded on import (Storage writes are service-role
// only) and lint runs locally. Proposals are created with the same atomic create_proposal RPC.
import { exportBundle, importBundle, lintConcept, type AudienceMap, type ConceptDraft, type ExportConcept } from "@supaknowledge/core";
import { encodeFile, type BundleFile } from "./files.ts";
import { must, type Ctx, type SpaceRef } from "./context.ts";

/** `bundle/import` response. The function returns path lists for created/updated/unchanged. */
export interface ImportResponse {
  proposal_id: string | null;
  created: string[] | number;
  updated: string[] | number;
  unchanged: string[] | number;
  warnings: string[];
  problems?: unknown[];
  status?: string;
  files_synced?: number;
  /** REST fallback: the proposal was created but apply_proposal failed */
  apply_error?: string;
  [k: string]: unknown;
}

export interface LintResponse {
  ok?: boolean;
  warnings: string[];
  problems?: unknown[];
  concepts?: { path: string; source?: string; kind?: string; problems: string[] }[];
}

async function audienceMap(ctx: Ctx, sp: SpaceRef): Promise<AudienceMap> {
  const db = await ctx.db();
  const groups = (await must(db.from("groups").select("id, slug").eq("workspace_id", sp.workspace_id))) as { id: string; slug: string }[];
  const bySlug = new Map(groups.map((g) => [g.slug, g.id]));
  const byId = new Map(groups.map((g) => [g.id, g.slug]));
  return { toSlug: (id) => byId.get(id), toId: (slug) => bySlug.get(slug) ?? (byId.has(slug) ? slug : undefined) };
}

export function lintLocal(files: BundleFile[]): LintResponse {
  const r = importBundle(files);
  const problems: { path: string; problems: string[] }[] = [];
  for (const c of r.concepts) {
    const p = lintConcept(c.draft, c.files);
    if (p.length) problems.push({ path: c.sourcePath, problems: p });
  }
  return { warnings: r.warnings, problems };
}

const COMPARED: (keyof ConceptDraft)[] = ["kind", "type", "title", "description", "body", "frontmatter", "tags", "status", "superseded_by", "stale_after", "audience"];

function norm(k: keyof ConceptDraft, v: unknown): unknown {
  if (v === undefined || v === null || v === "") return null;
  if (k === "stale_after") return Number.isNaN(Date.parse(String(v))) ? v : new Date(String(v)).toISOString();
  if (k === "audience" || k === "tags") return [...(v as string[])].sort();
  if (k === "body") return String(v).trimEnd();
  return v;
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function draftChanged(current: Partial<ConceptDraft>, next: ConceptDraft): boolean {
  return COMPARED.some((k) => stable(norm(k, current[k])) !== stable(norm(k, next[k])));
}

export async function importViaRest(
  ctx: Ctx,
  sp: SpaceRef,
  files: BundleFile[],
  opts: { apply?: boolean; title?: string },
): Promise<ImportResponse> {
  const db = await ctx.db();
  const parsed = importBundle(files, await audienceMap(ctx, sp));
  const warnings = [...parsed.warnings];
  const existing = (await must(
    db.from("concepts").select("id, path, kind, type, title, description, body, frontmatter, tags, status, superseded_by, stale_after, audience, revision").eq("space_id", sp.id),
  )) as (ConceptDraft & { id: string; revision: number })[];
  const byPath = new Map(existing.map((c) => [c.path, c]));

  const ops: Record<string, unknown>[] = [];
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  for (const c of parsed.concepts) {
    const problems = lintConcept(c.draft, c.files);
    if (problems.some((p) => p.startsWith("invalid path") || p.includes("reserved"))) {
      warnings.push(`${c.sourcePath}: skipped (${problems.join("; ")})`);
      continue;
    }
    for (const p of problems) warnings.push(`${c.sourcePath}: ${p}`);
    const after = { ...c.draft } as Record<string, unknown>;
    delete after.path;
    // same convention as the bundle function: skill files ride in the op and are copied into Storage by
    // `bundle/sync-files` once the proposal is applied
    if (c.draft.kind === "skill") after.files = c.files;
    const cur = byPath.get(c.draft.path);
    if (!cur) {
      ops.push({ op: "create", path: c.draft.path, after, rationale: `import ${c.sourcePath}` });
      created.push(c.draft.path);
      continue;
    }
    // keep an existing restriction when the bundle does not state one (never widen access by omission)
    let draft: ConceptDraft = c.draft;
    if (c.draft.audience.length === 0 && cur.audience.length > 0) {
      delete after.audience;
      draft = { ...c.draft, audience: cur.audience };
      warnings.push(`${c.draft.path}: bundle has no audience; keeping the concept's current audience restriction`);
    }
    if (draftChanged(cur, draft)) {
      ops.push({ op: "update", path: c.draft.path, concept_id: cur.id, base_revision: cur.revision, after, rationale: `import ${c.sourcePath}` });
      updated.push(c.draft.path);
    } else unchanged.push(c.draft.path);
  }

  if (!ops.length) return { proposal_id: null, created, updated, unchanged, warnings, status: "unchanged" };

  const title = opts.title ?? `Import ${parsed.bundle.title ?? "bundle"} (${created.length} new, ${updated.length} updated)`;
  // one atomic RPC (proposal + ops commit together; the author is pinned to the caller)
  const prop = (await must(
    db.rpc("create_proposal", {
      p_space: sp.id,
      p_title: title.slice(0, 200),
      p_rationale: "Imported with `kf import`." + (warnings.length ? `\n\nImport warnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : ""),
      p_risk: "medium",
      p_ops: ops,
      p_citations: [],
    }),
  )) as { id: string };

  const hasFiles = ops.some((o) => Array.isArray((o.after as { files?: unknown[] }).files) && ((o.after as { files: unknown[] }).files.length > 0));
  if (!opts.apply) return { proposal_id: prop.id, created, updated, unchanged, warnings, status: "pending" };
  const applied = await db.rpc("apply_proposal", { p_proposal: prop.id, p_note: "kf import --apply" });
  if (applied.error) {
    return { proposal_id: prop.id, created, updated, unchanged, warnings, status: "pending", apply_error: applied.error.message };
  }
  const p = applied.data as { status: string; review_note?: string | null };
  if (p.status === "conflicted") warnings.push(`apply conflicted: ${p.review_note ?? ""}`);
  if (p.status === "applied" && hasFiles) {
    warnings.push("skill files were not copied into Storage: that needs the bundle function, which is not deployed");
  }
  return { proposal_id: prop.id, created, updated, unchanged, warnings, status: p.status };
}

export async function exportViaRest(ctx: Ctx, sp: SpaceRef, opts: { publicOnly?: boolean }): Promise<BundleFile[]> {
  const db = await ctx.db();
  const concepts = (await must(
    db
      .from("concepts")
      .select("id, path, kind, type, title, description, body, frontmatter, tags, status, superseded_by, stale_after, audience, revision, generated_by, generated_at")
      .eq("space_id", sp.id)
      .neq("status", "draft")
      .order("path"),
  )) as (ExportConcept & { id: string })[];
  const ids = concepts.map((c) => c.id);

  const verifications = ids.length
    ? ((await must(db.from("verifications").select("concept_id, revision, actor, created_at").eq("space_id", sp.id).like("actor", "human:%"))) as {
        concept_id: string;
        revision: number;
        actor: string;
        created_at: string;
      }[])
    : [];
  const fileRows = ids.length
    ? ((await must(db.from("concept_files").select("concept_id, path, storage_path, content_type").eq("space_id", sp.id))) as {
        concept_id: string;
        path: string;
        storage_path: string;
        content_type: string | null;
      }[])
    : [];

  const filesBy = new Map<string, ExportConcept["files"]>();
  for (const f of fileRows) {
    const { data, error } = await db.storage.from("concept-files").download(f.storage_path);
    if (error || !data) {
      ctx.warn(`could not download ${f.storage_path}: ${error?.message ?? "no data"}`);
      continue;
    }
    const enc = encodeFile(Buffer.from(await data.arrayBuffer()));
    const list = filesBy.get(f.concept_id) ?? [];
    list.push({ path: f.path, content: enc.content, encoding: enc.encoding, content_type: f.content_type ?? undefined });
    filesBy.set(f.concept_id, list);
  }

  const revs = (await must(
    db.from("concept_revisions").select("path, revision, status, reason, created_at").eq("space_id", sp.id).order("created_at", { ascending: false }).limit(200),
  )) as { path: string; revision: number; status: string; reason: string | null; created_at: string }[];
  const visible = new Set(concepts.filter((c) => !opts.publicOnly || c.audience.length === 0).map((c) => c.path));

  return exportBundle(
    concepts.map((c) => ({
      ...c,
      verified: verifications.filter((v) => v.concept_id === c.id && v.revision === c.revision).map((v) => ({ by: v.actor, at: v.created_at })),
      files: filesBy.get(c.id) ?? [],
    })),
    {
      title: sp.name ?? sp.ref,
      audienceMap: await audienceMap(ctx, sp),
      publicOnly: opts.publicOnly,
      log: revs
        .filter((r) => visible.has(r.path))
        .map((r) => ({
          at: r.created_at,
          kind: r.revision === 1 ? ("Creation" as const) : r.status === "deprecated" ? ("Deprecation" as const) : ("Update" as const),
          path: r.path,
          summary: r.reason ?? "",
        })),
    },
  );
}
