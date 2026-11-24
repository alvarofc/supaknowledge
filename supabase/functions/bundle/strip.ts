// After `sync-files` copied an applied proposal's skill files into Storage, the inline content (base64 for
// binaries) is replaced with metadata so applied proposals stay small. Diff views list the files by name.

export interface InlineFile {
  path: string;
  content?: string;
  encoding?: string;
  content_type?: string;
  size_bytes?: number;
  sha256?: string;
  stripped?: boolean;
}

export interface StrippedFile {
  path: string;
  encoding: string;
  content_type?: string;
  size_bytes: number;
  sha256: string;
  stripped: true;
}

/** Already stripped (no content to sync any more). */
export function isStripped(f: unknown): boolean {
  return !!f && typeof f === "object" && (f as InlineFile).stripped === true && typeof (f as InlineFile).content !== "string";
}

/** Metadata-only copies of `files`; `meta` holds size + sha256 per path (computed from the bytes uploaded). */
export function stripFiles(files: InlineFile[], meta: Map<string, { size_bytes: number; sha256: string; content_type?: string }>): StrippedFile[] {
  return files.map((f) => {
    const m = meta.get(f.path);
    if (!m) throw new Error(`no metadata for ${f.path}`);
    const out: StrippedFile = { path: f.path, encoding: f.encoding ?? "utf8", size_bytes: m.size_bytes, sha256: m.sha256, stripped: true };
    const ct = m.content_type ?? f.content_type;
    if (ct) out.content_type = ct;
    return out;
  });
}
