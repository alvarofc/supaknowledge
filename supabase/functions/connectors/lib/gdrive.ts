// Google Drive connector (Drive API v3).
//   config: { folder_ids: string[], subject?: string (impersonated user for domain-wide delegation),
//             include_pdfs?: boolean (default true), max_file_bytes?: number (default 10 MB), acl_strict?: boolean }
//   token:  service-account key JSON (share the folders with its client_email, or use domain-wide delegation
//           + subject), an OAuth authorized_user JSON with a refresh_token, or a bare access token.
//           Scope: https://www.googleapis.com/auth/drive.readonly
//   cursor: { since: "<max modifiedTime synced>", changes_token: "<changes page token>" }
// Each run walks the folder tree (folders only), lists files modified since the cursor (ascending), exports
// Google Docs as markdown (text/plain fallback), Sheets as CSV, Slides as text, and downloads md/txt/html/pdf.
// Deletions/trash/moves-out come from the changes feed; a full sync also reconciles with a snapshot.
// ACL: files not shared with "anyone"/the whole domain are restricted and map to groups whose external_ref
// has {"gdrive_folder": "<id of the file's folder or any ancestor up to the configured root>"},
// {"google_group": "<group email the file is shared with>"} or {"gdrive_drive": "<shared drive id>"}.
import { googleAccessToken } from "./google-auth.ts";
import { bytesToText, ensureOk, getJson, request } from "./http.ts";
import { htmlToMarkdown } from "./markdown.ts";
import { extractPdfText } from "./pdf.ts";
import { type AclHint, asObject, type Connector, type DocumentChange, optBool, optNumber, optString, type RawExport, stringList, type SyncContext } from "./types.ts";

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

export function driveAcl(f: DriveFile, ancestors: string[]): AclHint {
  const perms = f.permissions;
  // shared-drive items do not return permissions in files.list: treat them as restricted
  const open = !!perms?.some((p) => p.type === "anyone" || p.type === "domain");
  const refs: AclHint["refs"] = ancestors.map((id) => ({ gdrive_folder: id }));
  for (const p of perms ?? []) if (p.type === "group" && p.emailAddress) refs.push({ google_group: p.emailAddress });
  if (f.driveId) refs.push({ gdrive_drive: f.driveId });
  return { restricted: !open, refs };
}

function q(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

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
    if (!ctx.token) throw new Error("gdrive source has no token; call set_source_secret with a service-account key JSON");
    const access = await googleAccessToken(ctx, ctx.token, { subject: config.subject });
    const headers = { Authorization: `Bearer ${access}` };
    const common = { supportsAllDrives: "true", includeItemsFromAllDrives: "true" };
    const cursor = { ...(ctx.cursor as { since?: string; changes_token?: string }) };

    const list = async <T>(params: Record<string, string>, key: string): Promise<T[]> => {
      const out: T[] = [];
      let pageToken: string | undefined;
      do {
        const u = new URL(`${API}/files`);
        for (const [k, v] of Object.entries({ ...common, ...params })) u.searchParams.set(k, v);
        if (pageToken) u.searchParams.set("pageToken", pageToken);
        const r = await getJson<Record<string, unknown> & { nextPageToken?: string }>(ctx, u, { headers });
        out.push(...((r[key] as T[]) ?? []));
        pageToken = r.nextPageToken;
      } while (pageToken);
      return out;
    };

    // ---- folder tree: id -> ancestor chain (folder itself first, configured root last)
    const ancestors = new Map<string, string[]>();
    for (const root of config.folder_ids) ancestors.set(root, [root]);
    let frontier = [...config.folder_ids];
    while (frontier.length) {
      const next: string[] = [];
      for (let i = 0; i < frontier.length; i += 10) {
        const batch = frontier.slice(i, i + 10);
        const folders = await list<{ id: string; parents?: string[] }>({
          q: `(${batch.map((id) => `'${q(id)}' in parents`).join(" or ")}) and mimeType = '${FOLDER}' and trashed = false`,
          fields: "nextPageToken,files(id,parents)",
          pageSize: "1000",
        }, "files");
        for (const f of folders) {
          if (ancestors.has(f.id)) continue;
          const parent = f.parents?.find((p) => ancestors.has(p));
          ancestors.set(f.id, [f.id, ...(parent ? ancestors.get(parent)! : [])]);
          next.push(f.id);
        }
      }
      frontier = next;
    }
    const folderSet = new Set(ancestors.keys());

    // ---- deletions / trash / moved out, from the changes feed
    let changesToken = ctx.full ? undefined : cursor.changes_token;
    if (changesToken) {
      let pageToken: string | undefined = changesToken;
      while (pageToken) {
        const u = new URL(`${API}/changes`);
        for (const [k, v] of Object.entries(common)) u.searchParams.set(k, v);
        u.searchParams.set("pageToken", pageToken);
        u.searchParams.set("pageSize", "1000");
        u.searchParams.set("includeRemoved", "true");
        u.searchParams.set("fields", "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,trashed,parents,mimeType))");
        const r = await getJson<{
          nextPageToken?: string;
          newStartPageToken?: string;
          changes: { fileId: string; removed?: boolean; file?: { trashed?: boolean; parents?: string[]; mimeType?: string } }[];
        }>(ctx, u, { headers });
        for (const c of r.changes ?? []) {
          const prev = ctx.previous(c.fileId);
          if (!prev || prev.deleted) continue;
          const gone = c.removed || c.file?.trashed || (c.file?.parents && !c.file.parents.some((p) => folderSet.has(p)));
          if (gone) yield { type: "delete", externalId: c.fileId, reason: c.removed ? "removed" : c.file?.trashed ? "trashed" : "moved out of synced folders" };
        }
        if (r.newStartPageToken) changesToken = r.newStartPageToken;
        pageToken = r.nextPageToken;
      }
    } else {
      const u = new URL(`${API}/changes/startPageToken`);
      u.searchParams.set("supportsAllDrives", "true");
      changesToken = (await getJson<{ startPageToken: string }>(ctx, u, { headers })).startPageToken;
    }

    // deletions up to here are emitted: the new token is safe to persist with the next checkpoint
    cursor.changes_token = changesToken;

    // ---- files modified since the cursor
    const since = ctx.full ? undefined : cursor.since;
    const folders = [...folderSet];
    const files: DriveFile[] = [];
    for (let i = 0; i < folders.length; i += 10) {
      const batch = folders.slice(i, i + 10);
      files.push(...await list<DriveFile>({
        q: `(${batch.map((id) => `'${q(id)}' in parents`).join(" or ")}) and mimeType != '${FOLDER}' and trashed = false` +
          (since ? ` and modifiedTime >= '${q(since)}'` : ""),
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: "200",
        orderBy: "modifiedTime",
      }, "files"));
    }
    const unique = [...new Map(files.map((f) => [f.id, f])).values()].sort((a, b) => a.modifiedTime.localeCompare(b.modifiedTime) || a.id.localeCompare(b.id));

    let fetched = 0;
    let capped = false;
    for (const f of unique) {
      const kind = driveKind(f, config.include_pdfs);
      const version = `${f.modifiedTime}${f.md5Checksum ? `:${f.md5Checksum}` : ""}`;
      const prev = ctx.previous(f.id);
      if (kind && !(prev && !prev.deleted && prev.version === version) && !(Number(f.size ?? 0) > config.max_file_bytes)) {
        if (fetched >= ctx.limit) {
          capped = true;
          break;
        }
        fetched++;
        const converted = await convert(ctx, headers, f, kind);
        const folder = f.parents?.find((p) => folderSet.has(p));
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
            acl: driveAcl(f, folder ? ancestors.get(folder)! : []),
          },
        };
      }
      if (!cursor.since || f.modifiedTime > cursor.since) cursor.since = f.modifiedTime;
      yield { type: "cursor", cursor: { ...cursor } };
    }
    if (!capped && ctx.full) yield { type: "snapshot", externalIds: unique.map((f) => f.id) };
    yield { type: "cursor", cursor: { ...cursor }, more: capped };
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
    return new Uint8Array(await res.arrayBuffer());
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
      const text = await (await ensureOk(res, `export ${f.name}`)).text();
      return { content: text, raw: { body: text, ext: as === "text/markdown" ? "md" : "txt", contentType: as }, exportedAs: as, meta: {} };
    }
    case "gsheet": {
      const text = await (await ensureOk(await exportAs("text/csv"), `export ${f.name}`)).text();
      return { content: `# ${f.name}\n\n${text}`, raw: { body: text, ext: "csv", contentType: "text/csv" }, exportedAs: "text/csv", meta: { note: "first sheet only" } };
    }
    case "gslides": {
      const text = await (await ensureOk(await exportAs("text/plain"), `export ${f.name}`)).text();
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
