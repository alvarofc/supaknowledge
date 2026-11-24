// OKF / Agent Skills import and export (CLI: kf pull / kf import / kf export / kf lint; Studio: import & export).
//
//   GET  /bundle/export?space=<id|ws/space>&public=true|false   -> { space, files: BundleFile[], concepts }
//   POST /bundle/import  { space, files, apply?, title? }        -> { proposal_id, status, created, updated, unchanged, warnings, ... }
//   POST /bundle/lint    { files, space? }                        -> { ok, concepts: [{path, kind, problems}], warnings }
//   POST /bundle/sync-files { proposal_id }                       -> { files_synced, concepts }
//
// Reads go through the caller's RLS client, so an export contains exactly what the caller can see.
// Imports never write concepts directly: they create ONE proposal (the single audited write path) and,
// with apply=true, apply it as the caller (reviewer+). Skill files ride along in each op's `after.files`
// and are copied into Storage only once the proposal is applied (see syncProposalFiles).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  type AudienceMap,
  type BundleFile,
  type ConceptDraft,
  type ConceptFile,
  type ExportConcept,
  exportBundle,
  importBundle,
  lintConcept,
} from "../_shared/core/index.ts";
import { authenticate, type Caller } from "../_shared/auth.ts";
import { adminClient } from "../_shared/env.ts";
import { handler, HttpError, json, readJson } from "../_shared/http.ts";
import { dbError, isUuid, must, resolveSpace, type SpaceInfo, subpath } from "../_lib/api.ts";

const CONCEPT_COLS =
  "id, path, kind, type, title, description, body, frontmatter, tags, status, superseded_by, stale_after, audience, revision, generated_by, generated_at";
const PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
const MAX_FILES_BYTES = 8 * 1024 * 1024; // skill files carried inside a proposal
const PAGE = 1000;

interface ConceptRow {
  id: string;
  path: string;
  kind: ConceptDraft["kind"];
  type: string;
  title: string;
  description: string;
  body: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  status: ConceptDraft["status"];
  superseded_by: string | null;
  stale_after: string | null;
  audience: string[];
  revision: number;
  generated_by: string | null;
  generated_at: string;
}

// ---------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------
function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function fileBytes(f: { content: string; encoding?: string }): Uint8Array {
  return f.encoding === "base64" ? b64decode(f.content) : new TextEncoder().encode(f.content);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const CONTENT_TYPES: Record<string, string> = {
  md: "text/markdown", markdown: "text/markdown", txt: "text/plain", py: "text/x-python", sh: "text/x-shellscript",
  js: "text/javascript", mjs: "text/javascript", ts: "text/plain", json: "application/json", yaml: "application/yaml",
  yml: "application/yaml", toml: "text/plain", sql: "application/sql", csv: "text/csv", html: "text/html", css: "text/css",
  xml: "application/xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml",
  pdf: "application/pdf", zip: "application/zip",
};

function contentType(path: string, encoding?: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? (encoding === "base64" ? "application/octet-stream" : "text/plain");
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

const sameTime = (a?: string | null, b?: string | null) => (a ? Date.parse(a) : null) === (b ? Date.parse(b) : null);
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

async function allRows<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string; code?: string } | null }>, what: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await fetchPage(from, from + PAGE - 1);
    if (error) throw dbError(error, what);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

async function audienceMapFor(caller: Caller, space: SpaceInfo): Promise<AudienceMap> {
  const groups = must(await caller.db.from("groups").select("id, slug").eq("workspace_id", space.workspace_id), "groups") as { id: string; slug: string }[];
  return {
    toSlug: (id) => groups.find((g) => g.id === id)?.slug,
    toId: (slugOrId) => groups.find((g) => g.slug === slugOrId || g.id === slugOrId)?.id,
  };
}

function validateFiles(files: unknown): BundleFile[] {
  if (!Array.isArray(files)) throw new HttpError(400, "files must be an array of {path, content, encoding?}");
  return files.map((f, i) => {
    if (!f || typeof f !== "object" || typeof f.path !== "string" || typeof f.content !== "string") {
      throw new HttpError(400, `files[${i}] must be {path: string, content: string, encoding?: "utf8"|"base64"}`);
    }
    if (f.encoding !== undefined && f.encoding !== "utf8" && f.encoding !== "base64") throw new HttpError(400, `files[${i}].encoding must be utf8 or base64`);
    return { path: f.path, content: f.content, encoding: f.encoding ?? "utf8" };
  });
}

/**
 * Keys that exportBundle derives from database state (generated / verified events, skill metadata.supaknowledge-*).
 * core importBundle keeps them in `frontmatter`, which would make every re-import of an export look like a
 * change and copy stale provenance into the concept. Strip them here until core does it.
 */
function normalizeImported(d: ConceptDraft): ConceptDraft {
  const fm: Record<string, unknown> = { ...(d.frontmatter ?? {}) };
  delete fm.generated;
  delete fm.verified;
  if (fm.metadata && typeof fm.metadata === "object" && !Array.isArray(fm.metadata)) {
    const meta = Object.fromEntries(Object.entries(fm.metadata as Record<string, unknown>).filter(([k]) => !k.startsWith("supaknowledge-")));
    if (Object.keys(meta).length) fm.metadata = meta;
    else delete fm.metadata;
  }
  return { ...d, frontmatter: fm };
}

// ---------------------------------------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------------------------------------
async function exportSpace(req: Request): Promise<Response> {
  const caller = await authenticate(req);
  const params = new URL(req.url).searchParams;
  const space = await resolveSpace(caller.db, params.get("space"));
  const publicOnly = params.get("public") === "true";
  const db = caller.db;

  const concepts = await allRows<ConceptRow>((a, b) => db.from("concepts").select(CONCEPT_COLS).eq("space_id", space.id).order("path").range(a, b), "concepts");
  const verifications = await allRows<{ concept_id: string; revision: number; actor: string; created_at: string }>(
    (a, b) => db.from("verifications").select("concept_id, revision, actor, created_at").eq("space_id", space.id).order("created_at").range(a, b),
    "verifications",
  );
  const fileRows = await allRows<{ concept_id: string; path: string; storage_path: string; content_type: string | null }>(
    (a, b) => db.from("concept_files").select("concept_id, path, storage_path, content_type").eq("space_id", space.id).order("path").range(a, b),
    "concept files",
  );
  const exported = new Set(concepts.filter((c) => !publicOnly || c.audience.length === 0).map((c) => c.id));

  // file bytes through the caller's client: Storage RLS lets readers of a concept read its files
  const files = new Map<string, ConceptFile[]>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const f of fileRows) {
    if (!exported.has(f.concept_id)) continue;
    const dl = await db.storage.from("concept-files").download(f.storage_path);
    if (dl.error || !dl.data) {
      console.warn(`export: cannot read ${f.storage_path}: ${dl.error?.message}`);
      continue;
    }
    const bytes = new Uint8Array(await dl.data.arrayBuffer());
    let file: ConceptFile;
    try {
      file = { path: f.path, content: decoder.decode(bytes), encoding: "utf8", content_type: f.content_type ?? undefined };
    } catch {
      file = { path: f.path, content: b64encode(bytes), encoding: "base64", content_type: f.content_type ?? undefined };
    }
    if (!files.has(f.concept_id)) files.set(f.concept_id, []);
    files.get(f.concept_id)!.push(file);
  }

  const revs = (must(
    await db.from("concept_revisions").select("path, revision, status, reason, actor, audience, created_at").eq("space_id", space.id)
      .order("created_at", { ascending: false }).limit(200),
    "revisions",
  ) ?? []) as { path: string; revision: number; status: string; reason: string | null; actor: string; audience: string[]; created_at: string }[];
  const log = revs
    .filter((r) => !publicOnly || r.audience.length === 0)
    .map((r) => ({
      at: r.created_at,
      kind: (r.revision === 1 ? "Creation" : r.status === "deprecated" ? "Deprecation" : "Update") as "Creation" | "Update" | "Deprecation",
      path: r.path,
      summary: (r.reason ?? `revision ${r.revision}`).replace(/\s+/g, " ").slice(0, 200) + ` (${r.actor})`,
    }));

  const items: ExportConcept[] = concepts.map((c) => ({
    path: c.path, kind: c.kind, type: c.type, title: c.title, description: c.description, body: c.body,
    frontmatter: c.frontmatter ?? {}, tags: c.tags ?? [], status: c.status, superseded_by: c.superseded_by,
    stale_after: c.stale_after, audience: c.audience ?? [], revision: c.revision, generated_by: c.generated_by,
    generated_at: c.generated_at,
    verified: verifications.filter((v) => v.concept_id === c.id && v.revision === c.revision).map((v) => ({ by: v.actor, at: v.created_at })),
    files: files.get(c.id) ?? [],
  }));

  const out = exportBundle(items, {
    title: space.name,
    description: space.description ?? undefined,
    audienceMap: await audienceMapFor(caller, space),
    log,
    publicOnly,
  });
  return json({ space: { id: space.id, ref: space.ref }, concepts: exported.size, files: out });
}

// ---------------------------------------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------------------------------------
interface ImportBody {
  space?: string;
  files?: unknown;
  apply?: boolean;
  title?: string;
}

type OpRow = {
  proposal_id: string;
  space_id: string;
  ord: number;
  op: "create" | "update";
  path: string;
  concept_id?: string;
  base_revision?: number;
  after: Record<string, unknown>;
  rationale: string;
};

async function importToSpace(req: Request): Promise<Response> {
  const caller = await authenticate(req);
  const body = await readJson<ImportBody>(req);
  const files = validateFiles(body.files);
  const space = await resolveSpace(caller.db, body.space);
  const db = caller.db;

  const parsed = importBundle(files, await audienceMapFor(caller, space));
  const warnings = [...parsed.warnings];
  const problems: { path: string; problems: string[] }[] = [];

  const existing = await allRows<ConceptRow>((a, b) => db.from("concepts").select(CONCEPT_COLS).eq("space_id", space.id).order("path").range(a, b), "concepts");
  const byPath = new Map(existing.map((c) => [c.path, c]));
  const existingFiles = await allRows<{ concept_id: string; path: string; sha256: string | null }>(
    (a, b) => db.from("concept_files").select("concept_id, path, sha256").eq("space_id", space.id).order("path").range(a, b),
    "concept files",
  );

  // groups the caller belongs to: you cannot write knowledge into an audience you are not part of
  // (the proposal_ops policy enforces this; we skip such concepts with a warning instead of failing)
  const myGroups = (must(await db.from("group_members").select("group_id").eq("user_id", caller.userId), "my groups") as { group_id: string }[])
    .map((g) => g.group_id);

  const ops: Omit<OpRow, "proposal_id" | "space_id" | "ord">[] = [];
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  let fileBytesTotal = 0;

  for (const ic of parsed.concepts) {
    const d = normalizeImported(ic.draft);
    const lint = lintConcept(d, ic.files);
    if (lint.length) problems.push({ path: d.path, problems: lint });
    if (!PATH_RE.test(d.path) || d.path.includes("..") || d.path.endsWith(".md") || d.path.split("/").some((s) => s === "index" || s === "log")) {
      warnings.push(`${ic.sourcePath}: skipped, invalid concept path "${d.path}"`);
      continue;
    }
    if (d.audience.length && !d.audience.some((g) => myGroups.includes(g))) {
      warnings.push(`${ic.sourcePath}: skipped, its audience does not include any group you belong to`);
      continue;
    }
    const badFile = ic.files.find((f) => f.path.includes("..") || f.path.startsWith("/") || !f.path.trim());
    if (badFile) {
      warnings.push(`${ic.sourcePath}: skipped, invalid file path "${badFile.path}"`);
      continue;
    }

    const filesWithHash = await Promise.all(ic.files.map(async (f) => {
      const bytes = fileBytes(f);
      fileBytesTotal += bytes.length;
      return { f, sha: await sha256Hex(bytes) };
    }));

    const after: Record<string, unknown> = {
      kind: d.kind, type: d.type, title: d.title, description: d.description, body: d.body,
      frontmatter: d.frontmatter, tags: d.tags, status: d.status,
      superseded_by: d.superseded_by ?? null, stale_after: d.stale_after ?? null, audience: d.audience,
    };
    if (d.kind === "skill") after.files = ic.files.map((f) => ({ path: f.path, content: f.content, encoding: f.encoding ?? "utf8" }));

    const cur = byPath.get(d.path);
    if (!cur) {
      ops.push({ op: "create", path: d.path, after, rationale: `import ${ic.sourcePath}` });
      created.push(d.path);
      continue;
    }

    // keep an existing restriction when the bundle does not state one (never widen access by omission)
    if (d.audience.length === 0 && cur.audience.length > 0) {
      delete after.audience;
      warnings.push(`${d.path}: bundle has no audience; keeping the concept's current audience restriction`);
    }
    const curFiles = existingFiles.filter((f) => f.concept_id === cur.id);
    const filesSame = d.kind !== "skill" ||
      (curFiles.length === filesWithHash.length && filesWithHash.every(({ f, sha }) => curFiles.some((cf) => cf.path === f.path && cf.sha256 === sha)));
    const same = filesSame &&
      cur.kind === d.kind && cur.type === d.type && cur.title === d.title &&
      cur.description.trim() === d.description.trim() && cur.body.trim() === d.body.trim() &&
      stable(cur.frontmatter ?? {}) === stable(d.frontmatter ?? {}) &&
      stable(cur.tags ?? []) === stable(d.tags ?? []) && cur.status === d.status &&
      (cur.superseded_by ?? null) === (d.superseded_by ?? null) && sameTime(cur.stale_after, d.stale_after) &&
      ("audience" in after ? sameSet(cur.audience, d.audience) : true);
    if (same) {
      unchanged.push(d.path);
      continue;
    }
    ops.push({ op: "update", path: d.path, concept_id: cur.id, base_revision: cur.revision, after, rationale: `import ${ic.sourcePath}${filesSame ? "" : " (files changed)"}` });
    updated.push(d.path);
  }

  if (fileBytesTotal > MAX_FILES_BYTES) throw new HttpError(413, `skill files total ${fileBytesTotal} bytes; the limit per import is ${MAX_FILES_BYTES}`);

  const summary = { created, updated, unchanged, warnings, problems, bundle: parsed.bundle };
  if (!ops.length) return json({ proposal_id: null, status: "unchanged", ...summary });

  // 1 proposal through the caller's RLS client (editors+; the policy pins author/created_by to the caller)
  const title = body.title?.trim() ||
    `Import ${parsed.bundle.title ? `"${parsed.bundle.title}" ` : ""}(${created.length} new, ${updated.length} updated)`;
  const proposal = must(
    await db.from("proposals").insert({
      space_id: space.id,
      author: `human:${caller.userId}`,
      created_by: caller.userId,
      title: title.slice(0, 200),
      rationale: `Imported from an OKF / Agent Skills bundle (${files.length} files).` +
        (warnings.length ? `\n\nImport warnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : ""),
      risk: "medium",
    }).select("id").single(),
    "create proposal (editor role required)",
  ) as { id: string };

  const rows: OpRow[] = ops.map((o, i) => ({ ...o, proposal_id: proposal.id, space_id: space.id, ord: i }));
  const ins = await db.from("proposal_ops").insert(rows);
  if (ins.error) {
    // do not leave an empty pending proposal behind (no delete policy for users -> reject it instead)
    await db.rpc("reject_proposal", { p_proposal: proposal.id, p_note: `import failed: ${ins.error.message}` });
    throw dbError(ins.error, "add proposal ops");
  }

  if (!body.apply) return json({ proposal_id: proposal.id, status: "pending", ...summary }, 201);

  const applied = await db.rpc("apply_proposal", { p_proposal: proposal.id, p_note: "Imported from bundle" });
  if (applied.error) {
    const e = dbError(applied.error, "apply_proposal");
    return json({ error: e.message, proposal_id: proposal.id, status: "pending", ...summary }, e.status);
  }
  const p = applied.data as { status: string; review_note: string | null };
  if (p.status !== "applied") {
    return json({ error: `proposal ${p.status}`, conflicts: p.review_note, proposal_id: proposal.id, status: p.status, ...summary }, 409);
  }
  const synced = await syncProposalFiles(caller, proposal.id);
  return json({ proposal_id: proposal.id, status: "applied", files_synced: synced.files_synced, ...summary }, 201);
}

/**
 * Copy skill files carried in an APPLIED proposal's ops (`after.files`) into Storage + concept_files.
 * Safe to call by anyone who can see the proposal: the bytes come from the reviewed proposal, not from the
 * caller, and an op is only synced while the concept is still at the revision that proposal produced.
 */
async function syncProposalFiles(caller: Caller, proposalId: string): Promise<{ files_synced: number; concepts: string[] }> {
  const db = caller.db;
  const p = must(await db.from("proposals").select("id, space_id, status").eq("id", proposalId).limit(1), "load proposal") as { id: string; space_id: string; status: string }[];
  if (!p.length) throw new HttpError(404, "proposal not found");
  if (p[0].status !== "applied") throw new HttpError(409, `proposal is ${p[0].status}; files are synced only after it is applied`);
  const spaceId = p[0].space_id;
  const ops = must(await db.from("proposal_ops").select("concept_id, path, after").eq("proposal_id", proposalId).order("ord"), "load ops") as
    { concept_id: string | null; path: string; after: { files?: ConceptFile[] } }[];

  // Admin client: Storage writes and concept_files have no user write policies. Guarded by: the proposal
  // is applied (a reviewer approved these exact files), the caller can see it and the concept (RLS), and
  // the concept is still at the revision this proposal wrote.
  const admin = adminClient();
  let n = 0;
  const touched: string[] = [];
  for (const op of ops) {
    if (!Array.isArray(op.after?.files) || !op.concept_id) continue;
    const c = must(await db.from("concepts").select("id, revision").eq("id", op.concept_id).limit(1), "load concept") as { id: string; revision: number }[];
    if (!c.length) continue;
    const rev = must(
      await db.from("concept_revisions").select("revision").eq("concept_id", op.concept_id).eq("proposal_id", proposalId).order("revision", { ascending: false }).limit(1),
      "load revision",
    ) as { revision: number }[];
    if (!rev.length || rev[0].revision !== c[0].revision) {
      console.warn(`sync-files: ${op.path} changed after proposal ${proposalId}; skipping`);
      continue;
    }
    const wanted = op.after.files.filter((f) => typeof f?.path === "string" && !f.path.includes("..") && !f.path.startsWith("/"));
    const prefix = `${spaceId}/${op.concept_id}/`;
    for (const f of wanted) {
      const bytes = fileBytes(f);
      const ct = f.content_type ?? contentType(f.path, f.encoding);
      const up = await admin.storage.from("concept-files").upload(prefix + f.path, bytes, { contentType: ct, upsert: true });
      if (up.error) throw new HttpError(500, `upload ${f.path}: ${up.error.message}`);
      must(
        await admin.from("concept_files").upsert(
          { concept_id: op.concept_id, space_id: spaceId, path: f.path, storage_path: prefix + f.path, content_type: ct, size_bytes: bytes.length, sha256: await sha256Hex(bytes) },
          { onConflict: "concept_id,path" },
        ),
        "record file",
      );
      n++;
    }
    // the skill directory is authoritative: drop files that are no longer part of it
    const old = must(await admin.from("concept_files").select("id, path, storage_path").eq("concept_id", op.concept_id), "list files") as
      { id: string; path: string; storage_path: string }[];
    const stale = old.filter((o) => !wanted.some((f) => f.path === o.path));
    if (stale.length) {
      await admin.storage.from("concept-files").remove(stale.map((s) => s.storage_path));
      must(await admin.from("concept_files").delete().in("id", stale.map((s) => s.id)), "remove files");
    }
    touched.push(op.path);
  }
  return { files_synced: n, concepts: touched };
}

// ---------------------------------------------------------------------------------------------------------
// lint
// ---------------------------------------------------------------------------------------------------------
async function lintFiles(req: Request): Promise<Response> {
  const caller = await authenticate(req);
  const body = await readJson<{ files?: unknown; space?: string }>(req);
  const files = validateFiles(body.files);
  // without a space, accept any group slug (nothing to resolve against)
  const map: AudienceMap = body.space ? await audienceMapFor(caller, await resolveSpace(caller.db, body.space)) : { toSlug: (x) => x, toId: (x) => x };
  const parsed = importBundle(files, map);
  const concepts = parsed.concepts.map((c) => ({ path: c.draft.path, kind: c.draft.kind, source: c.sourcePath, problems: lintConcept(c.draft, c.files) }));
  return json({ ok: concepts.every((c) => !c.problems.length) && !parsed.warnings.length, bundle: parsed.bundle, concepts, warnings: parsed.warnings });
}

Deno.serve(handler(async (req) => {
  const path = subpath(req, "bundle");
  if (req.method === "GET" && path === "/export") return await exportSpace(req);
  if (req.method === "POST" && path === "/import") return await importToSpace(req);
  if (req.method === "POST" && path === "/lint") return await lintFiles(req);
  if (req.method === "POST" && path === "/sync-files") {
    const caller = await authenticate(req);
    const body = await readJson<{ proposal_id?: string }>(req);
    if (!isUuid(body.proposal_id)) throw new HttpError(400, "proposal_id (uuid) is required");
    return json(await syncProposalFiles(caller, body.proposal_id));
  }
  throw new HttpError(404, `no route for ${req.method} ${path}`);
}));
