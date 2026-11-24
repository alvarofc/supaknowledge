// Upload "connector": nothing to sync; documents arrive through POST /connectors/upload (Studio / CLI).
// This module turns an uploaded file or JSON body into a SyncedDocument; index.ts does auth + writes.
import { bytesToText, looksBinary } from "./http.ts";
import { htmlToMarkdown } from "./markdown.ts";
import { extractPdfText } from "./pdf.ts";
import { asObject, type Connector, ConfigError, type SyncedDocument } from "./types.ts";

export const upload: Connector<Record<string, unknown>> = {
  kind: "upload",
  parseConfig: (raw) => asObject(raw),
  // deno-lint-ignore require-yield
  async *sync() {
    return;
  },
};

export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

const EXT_TYPES: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  html: "text/html",
  htm: "text/html",
  pdf: "application/pdf",
};

export interface UploadInput {
  /** original file name (multipart) */
  filename?: string;
  /** declared content type */
  contentType?: string;
  bytes?: Uint8Array;
  /** JSON uploads */
  text?: string;
  /** "md" | "txt" | "html" for JSON uploads (default md) */
  format?: string;
  title?: string;
  externalId?: string;
  url?: string;
}

export class UploadError extends ConfigError {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function uploadExt(input: Pick<UploadInput, "filename" | "contentType" | "format">): string {
  const fromName = input.filename && /\.([A-Za-z0-9]+)$/.exec(input.filename)?.[1]?.toLowerCase();
  if (fromName && EXT_TYPES[fromName]) return fromName;
  if (input.format && EXT_TYPES[input.format.toLowerCase()]) return input.format.toLowerCase();
  const ct = (input.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const byType = Object.entries(EXT_TYPES).find(([, t]) => t === ct)?.[0];
  if (byType) return byType;
  if (fromName) throw new UploadError(415, `unsupported file type .${fromName} (supported: .md, .txt, .html, .pdf)`);
  return "md";
}

function slug(s: string): string {
  return s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 200);
}

export async function prepareUpload(input: UploadInput): Promise<SyncedDocument> {
  const ext = uploadExt(input);
  const mime = EXT_TYPES[ext]!;
  const bytes = input.bytes ?? new TextEncoder().encode(input.text ?? "");
  if (bytes.length > UPLOAD_MAX_BYTES) throw new UploadError(413, `file too large (max ${UPLOAD_MAX_BYTES / 1024 / 1024} MB)`);
  if (!bytes.length) throw new UploadError(400, "empty content");

  let content = "";
  let title = input.title?.trim() || null;
  const metadata: Record<string, unknown> = { uploaded: true, original_filename: input.filename ?? null };
  if (ext === "pdf") {
    const pdf = await extractPdfText(bytes);
    content = pdf.text;
    metadata.pdf_pages = pdf.pages;
    if (pdf.error || !pdf.text) metadata.extraction_error = pdf.error ?? "no extractable text (scanned PDF?)";
  } else {
    if (looksBinary(bytes)) throw new UploadError(415, `content does not look like ${ext} text`);
    const text = bytesToText(bytes);
    if (ext === "html" || ext === "htm") {
      const conv = htmlToMarkdown(text, { mainContent: true, baseUrl: input.url });
      content = conv.markdown;
      title ??= conv.title;
    } else {
      content = text;
      title ??= /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? null;
    }
  }
  title ??= input.filename?.replace(/\.[^.]+$/, "") ?? "Untitled";
  const externalId = input.externalId?.trim() || slug(input.filename ?? title) || "upload";
  return {
    externalId,
    title,
    url: input.url ?? null,
    content,
    mimeType: mime,
    raw: { body: bytes, ext, contentType: mime },
    metadata,
  };
}
