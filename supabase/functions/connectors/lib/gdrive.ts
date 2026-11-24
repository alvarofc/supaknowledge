// Google Drive connector (Drive API v3).
//   config: { folder_ids: string[], subject?: string (impersonated user for domain-wide delegation),
//             include_pdfs?: boolean (default true), max_file_bytes?: number (default 10 MB), acl_strict?: boolean }
//   token:  service-account key JSON (share the folders with its client_email, or use domain-wide delegation
//           + subject), an OAuth authorized_user JSON with a refresh_token, or a bare access token.
//           Scope: https://www.googleapis.com/auth/drive.readonly
//   cursor: { since: "<modifiedTime lower bound of the next cycle>", changes_token: "<changes page token>",
//             pending?: { since, next_since, after, batch_first, page_token } (position of a capped cycle) }
// Each run walks the folder tree (folders only), lists files modified since the cursor page by page, exports
// Google Docs as markdown (text/plain fallback), Sheets as CSV, Slides as text, and downloads md/txt/html/pdf.
// Deletions/trash/moves-out come from the changes feed; a full sync also reconciles with a snapshot.
// ACL: files not shared with "anyone"/the whole domain are restricted and map to groups whose external_ref
// has {"gdrive_folder": "<id>"} for the MOST SPECIFIC mapped folder of the file (its folder, else the nearest
// mapped ancestor up to the configured root; never a union of ancestors), else {"gdrive_drive": "<shared drive
// id>"}; groups the file is shared with directly ({"google_group": "<email>"}) narrow that result.
// Permission changes and moves are picked up from the changes feed (the ACL is part of the document version).
import { googleAccessToken } from "./google-auth.ts";
import { bytesToText, ensureOk, getJson, maxBodyBytes, readBody, readText, request, TooLargeError } from "./http.ts";
import { htmlToMarkdown } from "./markdown.ts";
import { extractPdfText } from "./pdf.ts";
import { type AclHint, asObject, ConfigError, type Connector, type DocumentChange, optBool, optNumber, optString, type RawExport, stringList, type SyncContext } from "./types.ts";

export interface GdriveConfig {
  folder_ids: string[];
  subject?: string;
  include_pdfs: boolean;
  max_file_bytes: number;
}

const API = "https://www.googleapis.com/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const GDOC = "application/vnd.google-apps.document";
const GSHEET = "application/vnd.google-apps.spreadsheet";
const GSLIDES = "application/vnd.google-apps.presentation";
const FILE_FIELDS =
  "id,name,mimeType,modifiedTime,createdTime,webViewLink,size,md5Checksum,parents,driveId,trashed," +
  "owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress),permissions(type,role,emailAddress,domain)";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  createdTime?: string;
  webViewLink?: string;
  size?: string;
  md5Checksum?: string;
  parents?: string[];
  driveId?: string;
  trashed?: boolean;
  owners?: { displayName?: string; emailAddress?: string }[];
  lastModifyingUser?: { displayName?: string; emailAddress?: string };
  permissions?: { type: string; role: string; emailAddress?: string; domain?: string }[];
}

type Kind = "gdoc" | "gsheet" | "gslides" | "text" | "markdown" | "html" | "pdf";

export function driveKind(f: Pick<DriveFile, "mimeType" | "name">, includePdfs = true): Kind | null {
  const name = f.name.toLowerCase();
  if (f.mimeType === GDOC) return "gdoc";
  if (f.mimeType === GSHEET) return "gsheet";
  if (f.mimeType === GSLIDES) return "gslides";
  if (f.mimeType === "text/markdown" || f.mimeType === "text/x-markdown" || /\.(md|markdown|mdx)$/.test(name)) return "markdown";
  if (f.mimeType === "text/html" || /\.html?$/.test(name)) return "html";
  if (f.mimeType === "text/plain" || /\.txt$/.test(name)) return "text";
  if (includePdfs && (f.mimeType === "application/pdf" || name.endsWith(".pdf"))) return "pdf";
  return null;
}

/**
 * ACL hint for a Drive file. Folder mappings are hierarchical: the most specific mapped folder wins (a file in
 * FINANCE_SUB mapped to `finance` does NOT also get the `all-staff` group mapped on the root), the shared drive
 * only counts when no folder matched, and groups the file is shared with directly narrow that result.
 */
export function driveAcl(f: DriveFile, ancestors: string[]): AclHint {
  const perms = f.permissions;
  // shared-drive items do not return permissions in files.list: treat them as restricted
  const open = !!perms?.some((p) => p.type === "anyone" || p.type === "domain");
  const refs: AclHint["refs"] = [];
  for (const p of perms ?? []) if (p.type === "group" && p.emailAddress) refs.push({ google_group: p.emailAddress });
  const tiers: NonNullable<AclHint["tiers"]> = ancestors.map((id) => [{ gdrive_folder: id }]);
  if (f.driveId) tiers.push([{ gdrive_drive: f.driveId }]);
  return { restricted: !open, refs, ...(tiers.length ? { tiers } : {}) };
}

/** Short stable hash (FNV-1a) of what determines the audience, folded into the document version. */
function aclHash(acl: AclHint): string {
  const s = JSON.stringify(acl);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function q(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Resumable position inside one listing cycle (lets capped runs continue instead of restarting). */
interface Pending {
  /** modifiedTime lower bound of this cycle (null = everything) */
  since: string | null;
  /** cursor.since once the cycle completes (cycle start minus a clock-skew margin) */
  next_since: string;
  /** folder batches are processed in sorted id order; every folder id <= after is done */
  after?: string;
  /** first folder id of the batch the page token belongs to */
  batch_first?: string;
  page_token?: string;
}

const MAX_RECHECK = 1000;
const SKEW_MS = 5 * 60_000;

export const gdrive: Connector<GdriveConfig> = {
  kind: "gdrive",
  parseConfig(raw) {
    const o = asObject(raw);
    return {
      folder_ids: stringList(o, "folder_ids", { required: true }),
      subject: optString(o, "subject"),
      include_pdfs: optBool(o, "include_pdfs", true),
      max_file_bytes: optNumber(o, "max_file_bytes", 10_000_000, 1, 50_000_000),
    };
  },

  async *sync(ctx: SyncContext<GdriveConfig>): AsyncGenerator<DocumentChange> {
    const { config } = ctx;
    if (!ctx.token) throw new ConfigError("gdrive source has no token; call set_source_secret with a service-account key JSON");
    const access = await googleAccessToken(ctx, ctx.token, { subject: config.subject });
    const headers = { Authorization: `Bearer ${access}` };
    const common = { supportsAllDrives: "true", includeItemsFromAllDrives: "true" };
    const cursor = { ...(ctx.cursor as { since?: string; changes_token?: string; pending?: Pending }) };

    const listPage = async <T>(params: Record<string, string>, key: string, pageToken?: string): Promise<{ items: T[]; next?: string }> => {
      const u = new URL(`${API}/files`);
      for (const [k, v] of Object.entries({ ...common, ...params })) u.searchParams.set(k, v);
      if (pageToken) u.searchParams.set("pageToken", pageToken);
      const r = await getJson<Record<string, unknown> & { nextPageToken?: string }>(ctx, u, { headers });
      return { items: (r[key] as T[]) ?? [], next: r.nextPageToken };
    };

    // ---- folder tree: id -> ancestor chain (folder itself first, configured root last)
    const ancestors = new Map<string, string[]>();
    for (const root of config.folder_ids) ancestors.set(root, [root]);
    let frontier = [...config.folder_ids];
    while (frontier.length) {
      const next: string[] = [];
      for (let i = 0; i < frontier.length; i += 10) {
        const batch = frontier.slice(i, i + 10);
        let pageToken: string | undefined;
        do {
          const page: { items: { id: string; parents?: string[] }[]; next?: string } = await listPage<{ id: string; parents?: string[] }>({
            q: `(${batch.map((id) => `'${q(id)}' in parents`).join(" or ")}) and mimeType = '${FOLDER}' and trashed = false`,
            fields: "nextPageToken,files(id,parents)",
            pageSize: "1000",
          }, "files", pageToken);
          for (const f of page.items) {
            if (ancestors.has(f.id)) continue;
            const parent = f.parents?.find((p) => ancestors.has(p));
            ancestors.set(f.id, [f.id, ...(parent ? ancestors.get(parent)! : [])]);
            next.push(f.id);
          }
          pageToken = page.next;
        } while (pageToken);
      }
      frontier = next;
    }
    const folderSet = new Set(ancestors.keys());

    let fetched = 0;
    let capped = false;
    const versionOf = (f: DriveFile, acl: AclHint) => `${f.modifiedTime}${f.md5Checksum ? `:${f.md5Checksum}` : ""}#${aclHash(acl)}`;
    /** emit one file when it is new / changed (content, permissions or folder); "capped" once the run cap is hit */
    const processFile = async function* (f: DriveFile, recheck: boolean): AsyncGenerator<DocumentChange, "capped" | void> {
      const kind = driveKind(f, config.include_pdfs);
      if (!kind || Number(f.size ?? 0) > config.max_file_bytes) return;
      const folder = f.parents?.find((p) => folderSet.has(p));
      const acl = driveAcl(f, folder ? ancestors.get(folder)! : []);
      const version = versionOf(f, acl);
      const prev = ctx.previous(f.id);
      if (prev && !prev.deleted) {
        if (prev.version === version) return;
        // versions written before ACL hashing: only refetch when the changes feed reported the file
        const legacy = `${f.modifiedTime}${f.md5Checksum ? `:${f.md5Checksum}` : ""}`;
        if (prev.version === legacy && !recheck) return;
      }
      if (fetched >= ctx.limit) return "capped";
      fetched++;
      let converted: Awaited<ReturnType<typeof convert>>;
      try {
        converted = await convert(ctx, headers, f, kind);
      } catch (e) {
        if (e instanceof TooLargeError) {
          ctx.log(`gdrive: skipping ${f.id} (${e.message})`);
          return;
        }
        throw e;
      }
      yield {
        type: "upsert",
        doc: {
          externalId: f.id,
          title: f.name,
          url: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`,
          content: converted.content,
          mimeType: f.mimeType,
          raw: converted.raw,
          author: f.owners?.[0]?.displayName ?? f.owners?.[0]?.emailAddress ?? f.lastModifyingUser?.displayName ?? null,
          updatedAt: f.modifiedTime,
          version,
          metadata: { drive_mime_type: f.mimeType, folder_id: folder ?? null, export: converted.exportedAs, ...converted.meta },
          acl,
        },
      };
    };

    // ---- changes feed: deletions / trash / moves out, plus files whose permissions or folder changed
    //      without a new modifiedTime (re-checked below, before the new page token is persisted)
    let changesToken = ctx.full ? undefined : cursor.changes_token;
    const recheck = new Map<string, DriveFile>();
    if (changesToken) {
      let pageToken: string | undefined = changesToken;
      while (pageToken) {
        const u = new URL(`${API}/changes`);
        for (const [k, v] of Object.entries(common)) u.searchParams.set(k, v);
        u.searchParams.set("pageToken", pageToken);
        u.searchParams.set("pageSize", "1000");
        u.searchParams.set("includeRemoved", "true");
        u.searchParams.set("fields", `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`);
        const r = await getJson<{
          nextPageToken?: string;
          newStartPageToken?: string;
          changes: { fileId: string; removed?: boolean; file?: Partial<DriveFile> }[];
        }>(ctx, u, { headers });
        for (const c of r.changes ?? []) {
          const prev = ctx.previous(c.fileId);
          const inScope = !!c.file?.parents?.some((p) => folderSet.has(p));
          const gone = c.removed || c.file?.trashed || (c.file?.parents && !inScope);
          if (gone) {
            if (prev && !prev.deleted) yield { type: "delete", externalId: c.fileId, reason: c.removed ? "removed" : c.file?.trashed ? "trashed" : "moved out of synced folders" };
            continue;
          }
          const f = c.file;
          if (inScope && f?.id && f.name && f.mimeType && f.modifiedTime && f.mimeType !== FOLDER && recheck.size < MAX_RECHECK) {
            recheck.set(f.id, f as DriveFile);
          }
        }
        if (r.newStartPageToken) changesToken = r.newStartPageToken;
        pageToken = r.nextPageToken;
      }
    } else {
      const u = new URL(`${API}/changes/startPageToken`);
      u.searchParams.set("supportsAllDrives", "true");
      changesToken = (await getJson<{ startPageToken: string }>(ctx, u, { headers })).startPageToken;
    }

    for (const f of [...recheck.values()].sort((a, b) => a.modifiedTime.localeCompare(b.modifiedTime) || a.id.localeCompare(b.id))) {
      if ((yield* processFile(f, true)) === "capped") {
        capped = true;
        break;
      }
    }
    // deletions and re-checks up to here are emitted: the new token is safe to persist with the next checkpoint
    // (when capped, keep the old token so the unprocessed re-checks are seen again)
    if (!capped) cursor.changes_token = changesToken;

    // ---- files modified since the cursor, one folder batch / page at a time (bounded memory, resumable)
    const resume = !ctx.full && cursor.pending ? cursor.pending : undefined;
    const pending: Pending = resume ?? {
      since: ctx.full ? null : cursor.since ?? null,
      next_since: new Date(ctx.now().getTime() - SKEW_MS).toISOString(),
    };
    const folders = [...folderSet].sort().filter((id) => !pending.after || id > pending.after);
    const snapshotIds: string[] = [];
    const checkpoint = (): DocumentChange => ({ type: "cursor", cursor: { ...cursor, pending: { ...pending } } });
    batches: for (let i = 0; i < folders.length && !capped; i += 10) {
      const batch = folders.slice(i, i + 10);
      let pageToken = pending.batch_first === batch[0] ? pending.page_token : undefined;
      pending.batch_first = batch[0];
      do {
        pending.page_token = pageToken;
        const page: { items: DriveFile[]; next?: string } = await listPage<DriveFile>({
          q: `(${batch.map((id) => `'${q(id)}' in parents`).join(" or ")}) and mimeType != '${FOLDER}' and trashed = false` +
            (pending.since ? ` and modifiedTime >= '${q(pending.since)}'` : ""),
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          pageSize: "200",
          orderBy: "modifiedTime",
        }, "files", pageToken);
        for (const f of page.items) {
          if (ctx.full) snapshotIds.push(f.id);
          if (recheck.has(f.id)) continue; // handled above
          if ((yield* processFile(f, false)) === "capped") {
            capped = true;
            yield checkpoint();
            break batches;
          }
        }
        pageToken = page.next;
        pending.page_token = pageToken;
        yield checkpoint();
      } while (pageToken);
      pending.after = batch[batch.length - 1];
      pending.batch_first = undefined;
      pending.page_token = undefined;
      yield checkpoint();
    }
    if (capped) {
      yield { type: "cursor", cursor: { ...cursor, pending: { ...pending } }, more: true };
      return;
    }
    // cycle complete
    delete cursor.pending;
    cursor.since = pending.next_since;
    if (ctx.full) yield { type: "snapshot", externalIds: [...new Set([...snapshotIds, ...recheck.keys()])] };
    yield { type: "cursor", cursor: { ...cursor }, more: false };
  },
};

async function convert(
  ctx: SyncContext<GdriveConfig>,
  headers: Record<string, string>,
  f: DriveFile,
  kind: Kind,
): Promise<{ content: string; raw: RawExport; exportedAs: string; meta: Record<string, unknown> }> {
  const exportAs = async (mime: string) => {
    const u = new URL(`${API}/files/${f.id}/export`);
    u.searchParams.set("mimeType", mime);
    return await request(ctx, u, { headers });
  };
  const download = async () => {
    const u = new URL(`${API}/files/${f.id}`);
    u.searchParams.set("alt", "media");
    u.searchParams.set("supportsAllDrives", "true");
    const res = await ensureOk(await request(ctx, u, { headers }), `download ${f.name}`);
    return await readBody(res, ctx.config.max_file_bytes, `file ${f.id}`);
  };

  switch (kind) {
    case "gdoc": {
      let res = await exportAs("text/markdown");
      let as = "text/markdown";
      if (!res.ok) {
        await res.body?.cancel();
        res = await exportAs("text/plain");
        as = "text/plain";
      }
      const text = await readText(await ensureOk(res, `export ${f.name}`), maxBodyBytes(), `export ${f.id}`);
      return { content: text, raw: { body: text, ext: as === "text/markdown" ? "md" : "txt", contentType: as }, exportedAs: as, meta: {} };
    }
    case "gsheet": {
      const text = await readText(await ensureOk(await exportAs("text/csv"), `export ${f.name}`), maxBodyBytes(), `export ${f.id}`);
      return { content: `# ${f.name}\n\n${text}`, raw: { body: text, ext: "csv", contentType: "text/csv" }, exportedAs: "text/csv", meta: { note: "first sheet only" } };
    }
    case "gslides": {
      const text = await readText(await ensureOk(await exportAs("text/plain"), `export ${f.name}`), maxBodyBytes(), `export ${f.id}`);
      return { content: text, raw: { body: text, ext: "txt", contentType: "text/plain" }, exportedAs: "text/plain", meta: {} };
    }
    case "markdown":
    case "text": {
      const bytes = await download();
      return { content: bytesToText(bytes), raw: { body: bytes, ext: kind === "markdown" ? "md" : "txt", contentType: f.mimeType || "text/plain" }, exportedAs: "original", meta: {} };
    }
    case "html": {
      const bytes = await download();
      const { markdown } = htmlToMarkdown(bytesToText(bytes), { mainContent: true });
      return { content: markdown, raw: { body: bytes, ext: "html", contentType: "text/html" }, exportedAs: "original", meta: {} };
    }
    case "pdf": {
      const bytes = await download();
      const pdf = await extractPdfText(bytes);
      return {
        content: pdf.text,
        raw: { body: bytes, ext: "pdf", contentType: "application/pdf" },
        exportedAs: "original",
        meta: { pdf_pages: pdf.pages, ...(pdf.error ? { extraction_error: pdf.error } : {}) },
      };
    }
  }
}
