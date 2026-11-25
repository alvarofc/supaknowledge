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
  isValidConceptPath,
  lintConcept,
} from "../_shared/core/formats.ts";
import { authenticate, type Caller } from "../_shared/auth.ts";
import { adminClient } from "../_shared/env.ts";
import { handler, HttpError, json, readJson } from "../_shared/http.ts";
import { dbError, isUuid, must, resolveSpace, type SpaceInfo, subpath } from "../_lib/api.ts";
import { isSafeFilePath } from "./paths.ts";
import { type InlineFile, isStripped, stripFiles } from "./strip.ts";

const CONCEPT_COLS =
  "id, path, kind, type, title, description, body, frontmatter, tags, status, superseded_by, stale_after, audience, revision, generated_by, generated_at";
const MAX_FILES_BYTES = 8 * 1024 * 1024; // skill files carried inside a proposal
const PAGE = 1000;
const DOWNLOAD_CONCURRENCY = 6;

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

/** map with at most `limit` promises in flight; results in input order */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  }));
  return out;
}

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

  // file bytes through the caller's client: Storage RLS lets readers of a concept read its files.
  // Downloaded with bounded concurrency; results keep the (path-ordered) row order.
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const wantedFiles = fileRows.filter((f) => exported.has(f.concept_id));
  const downloaded = await mapLimit(wantedFiles, DOWNLOAD_CONCURRENCY, async (f) => {
    const dl = await db.storage.from("concept-files").download(f.storage_path);
    if (dl.error || !dl.data) {
      console.warn(`export: cannot read ${f.storage_path}: ${dl.error?.message}`);
      return null;
    }
    const bytes = new Uint8Array(await dl.data.arrayBuffer());
    try {
      return { path: f.path, content: decoder.decode(bytes), encoding: "utf8", content_type: f.content_type ?? undefined } as ConceptFile;
    } catch {
      return { path: f.path, content: b64encode(bytes), encoding: "base64", content_type: f.content_type ?? undefined } as ConceptFile;
    }
  });
  const files = new Map<string, ConceptFile[]>();
  wantedFiles.forEach((f, i) => {
    const file = downloaded[i];
    if (!file) return;
    if (!files.has(f.concept_id)) files.set(f.concept_id, []);
    files.get(f.concept_id)!.push(file);
  });

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

  const ops: OpRow[] = [];
  const seenPaths = new Map<string, string>(); // concept path -> source file that produced it
  const created: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  let fileBytesTotal = 0;

  for (const ic of parsed.concepts) {
    const d = normalizeImported(ic.draft);
    const lint = lintConcept(d, ic.files);
    if (lint.length) problems.push({ path: d.path, problems: lint });
    if (!isValidConceptPath(d.path) || d.path.split("/").some((s) => s === "index" || s === "log")) {
      warnings.push(`${ic.sourcePath}: skipped, invalid concept path "${d.path}"`);
      continue;
    }
    if (d.audience.length && !d.audience.some((g) => myGroups.includes(g))) {
      warnings.push(`${ic.sourcePath}: skipped, its audience does not include any group you belong to`);
      continue;
    }
    // two bundle entries for the same concept (e.g. skills/x/SKILL.md and skills/x.md): keep the first
    const dupOf = seenPaths.get(d.path);
    if (dupOf) {
      warnings.push(`${ic.sourcePath}: skipped, concept "${d.path}" is already defined by ${dupOf}`);
      continue;
    }
    seenPaths.set(d.path, ic.sourcePath);
    const badFile = ic.files.find((f) => !isSafeFilePath(f.path));
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

  // ONE proposal, created atomically with its ops through the caller's client (public.create_proposal:
  // editors+, author pinned to the caller, agents and OAuth-client tokens refused). Nothing is visible before
  // the transaction commits, and a failure leaves nothing behind.
  const title = body.title?.trim() ||
    `Import ${parsed.bundle.title ? `"${parsed.bundle.title}" ` : ""}(${created.length} new, ${updated.length} updated)`;
  const proposal = must(
    await db.rpc("create_proposal", {
      p_space: space.id,
      p_title: title.slice(0, 200),
      p_rationale: `Imported from an OKF / Agent Skills bundle (${files.length} files).` +
        (warnings.length ? `\n\nImport warnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : ""),
      p_risk: "medium",
      p_ops: ops,
      p_citations: [],
    }),
    "create proposal (editor role required)",
  ) as { id: string };

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
 * Did a revision after `revision` come from another proposal that carried its own files for this concept?
 * Service role on purpose (see the caller); returns a boolean only.
 */
async function laterFilesExist(admin: ReturnType<typeof adminClient>, conceptId: string, revision: number, proposalId: string): Promise<boolean> {
  const later = must(
    await admin.from("concept_revisions").select("proposal_id").eq("concept_id", conceptId).gt("revision", revision),
    "load later revisions",
  ) as { proposal_id: string | null }[];
  const ids = [...new Set(later.map((r) => r.proposal_id).filter((x): x is string => !!x && x !== proposalId))];
  if (!ids.length) return false;
  const newer = must(
    await admin.from("proposal_ops").select("proposal_id").in("proposal_id", ids).eq("concept_id", conceptId).not("after->files", "is", null).limit(1),
    "check later file changes",
  ) as unknown[];
  return newer.length > 0;
}

/**
 * Copy skill files carried in an APPLIED proposal's ops (`after.files`) into Storage + concept_files.
 * Callers: space reviewers / admins (checked server-side) with a user session or an agent key, never OAuth-client
 * tokens; the bytes come from the reviewed proposal, not from the caller. Idempotent (upserts by path, checksums recorded). An op is synced unless a LATER applied proposal
 * carried its own files for the same concept (that one is authoritative); later text-only edits do not block
 * it, so calling sync-files late (Studio calls it right after apply_proposal) still converges.
 * Once an op's files are in Storage (or superseded by a later proposal), its inline content is stripped
 * (public.kf_strip_proposal_files: paths + size/sha256 stay), so applied proposals do not keep MBs of base64.
 * Ops already stripped are skipped.
 */
async function syncProposalFiles(caller: Caller, proposalId: string): Promise<{ files_synced: number; concepts: string[] }> {
  const db = caller.db;
  // MCP / OAuth-client tokens only read and flag; this route writes with the service role below
  if (caller.clientId !== null) {
    throw new HttpError(403, "OAuth client tokens cannot sync proposal files; use a Studio / CLI session or an agent key");
  }
  const p = must(await db.from("proposals").select("id, space_id, status").eq("id", proposalId).limit(1), "load proposal") as { id: string; space_id: string; status: string }[];
  if (!p.length) throw new HttpError(404, "proposal not found");
  const spaceId = p[0].space_id;
  // Server-side role check before any admin-client write: only people who can apply proposals in this space
  // (reviewer / admin, the same callers that just applied it) copy its files into Storage.
  const role = must(await db.rpc("my_space_role", { p_space: spaceId }), "check space role") as string | null;
  if (role !== "reviewer" && role !== "admin") throw new HttpError(403, "space reviewer or admin required to sync proposal files");
  if (p[0].status !== "applied") throw new HttpError(409, `proposal is ${p[0].status}; files are synced only after it is applied`);
  const ops = must(await db.from("proposal_ops").select("id, concept_id, path, after").eq("proposal_id", proposalId).order("ord"), "load ops") as
    { id: string; concept_id: string | null; path: string; after: { files?: ConceptFile[] } }[];

  // Admin client: Storage writes and concept_files have no user write policies. Guarded by: no OAuth-client
  // token, the caller is a reviewer/admin of the space (my_space_role above), the proposal is applied (a reviewer
  // approved these exact files), the caller can see it and the concept (RLS), and the concept is still at the
  // revision this proposal wrote (or no later proposal carried files for it).
  const admin = adminClient();
  let n = 0;
  const touched: string[] = [];
  // Admin client (service-role RPC): only ops of this applied proposal, only after their files are in Storage.
  // Best effort: a failure leaves the content inline (the next sync-files call retries).
  const strip = async (op: { id: string; after: { files?: ConceptFile[] } }, meta: () => Promise<Map<string, { size_bytes: number; sha256: string; content_type?: string }>>) => {
    try {
      const { error } = await admin.rpc("kf_strip_proposal_files", { p_op: op.id, p_files: stripFiles(op.after.files as InlineFile[], await meta()) });
      if (error) throw new Error(error.message);
    } catch (e) {
      console.warn(`sync-files: could not strip inline files of op ${op.id}: ${e instanceof Error ? e.message : e}`);
    }
  };
  const metaOf = async (files: ConceptFile[]) =>
    new Map(await Promise.all(files.map(async (f) => {
      const bytes = fileBytes(f);
      return [f.path, { size_bytes: bytes.length, sha256: await sha256Hex(bytes), content_type: f.content_type ?? contentType(f.path, f.encoding) }] as const;
    })));
  for (const op of ops) {
    if (!Array.isArray(op.after?.files) || !op.concept_id) continue;
    if (op.after.files.some(isStripped)) continue; // synced and stripped earlier
    const c = must(await db.from("concepts").select("id, revision").eq("id", op.concept_id).limit(1), "load concept") as { id: string; revision: number }[];
    if (!c.length) continue;
    const rev = must(
      await db.from("concept_revisions").select("revision").eq("concept_id", op.concept_id).eq("proposal_id", proposalId).order("revision", { ascending: false }).limit(1),
      "load revision",
    ) as { revision: number }[];
    if (!rev.length) continue; // this proposal never wrote the concept
    if (rev[0].revision !== c[0].revision) {
      // Later revisions exist. Text-only edits (no `after.files`) do not touch the skill directory, so this
      // proposal's files are still the newest; only a later proposal that carried files supersedes them.
      // Admin client: the caller may not see a later restricted proposal/revision, and missing it would write
      // these (older) files over newer ones. Only a boolean leaves this block; nothing about the later
      // proposals is returned to the caller.
      if (await laterFilesExist(admin, op.concept_id, rev[0].revision, proposalId)) {
        console.warn(`sync-files: ${op.path} got newer files after proposal ${proposalId}; skipping (sync that proposal instead)`);
        // these files can never be synced any more: do not keep their content around
        await strip(op, () => metaOf(op.after.files!));
        continue;
      }
    }
    // never upload unsafe paths (empty, whitespace, backslashes, `..`, absolute): proposals can be created
    // through PostgREST directly, so the files are not necessarily the ones the import validated
    const wanted = op.after.files.filter((f) => isSafeFilePath(f?.path) && typeof f.content === "string");
    for (const f of op.after.files) if (!wanted.includes(f)) console.warn(`sync-files: ${op.path}: skipping invalid file entry ${JSON.stringify(f?.path)}`);
    const prefix = `${spaceId}/${op.concept_id}/`;
    const meta = new Map<string, { size_bytes: number; sha256: string; content_type?: string }>();
    for (const f of wanted) {
      const bytes = fileBytes(f);
      const ct = f.content_type ?? contentType(f.path, f.encoding);
      const sha256 = await sha256Hex(bytes);
      const up = await admin.storage.from("concept-files").upload(prefix + f.path, bytes, { contentType: ct, upsert: true });
      if (up.error) throw new HttpError(500, `upload ${f.path}: ${up.error.message}`);
      must(
        await admin.from("concept_files").upsert(
          { concept_id: op.concept_id, space_id: spaceId, path: f.path, storage_path: prefix + f.path, content_type: ct, size_bytes: bytes.length, sha256 },
          { onConflict: "concept_id,path" },
        ),
        "record file",
      );
      meta.set(f.path, { size_bytes: bytes.length, sha256, content_type: ct });
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
    // invalid paths were never uploaded: record their metadata anyway (computed, not synced)
    await strip(op, async () => new Map([...meta, ...await metaOf(op.after.files!.filter((f) => !meta.has(f.path)))]));
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
