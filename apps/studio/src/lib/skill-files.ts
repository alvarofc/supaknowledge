// Skill files carried in a proposal op (`after.files`). Before bundle/sync-files runs they hold the content
// (utf8 or base64); after sync the content is stripped and only metadata stays:
//   {path, encoding, content_type?, size_bytes, sha256, stripped: true}
// Unit tested in test/skill-files.test.ts.

export interface SkillFileSummary {
  path: string;
  /** bytes, when known (metadata or computed from the content) */
  size: number | null;
  /** content was removed after it was copied into Storage */
  stripped: boolean;
}

function byteLength(content: string, encoding: unknown): number {
  if (encoding === "base64") {
    const clean = content.replace(/\s+/g, "");
    const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((clean.length * 3) / 4) - pad);
  }
  return new TextEncoder().encode(content).length;
}

/** File list of an op's `after` payload; tolerant of any shape (never throws). */
export function skillFiles(after: unknown): SkillFileSummary[] {
  if (!after || typeof after !== "object" || Array.isArray(after)) return [];
  const files = (after as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];
  const out: SkillFileSummary[] = [];
  for (const f of files) {
    if (!f || typeof f !== "object") continue;
    const r = f as { path?: unknown; content?: unknown; encoding?: unknown; size_bytes?: unknown; sha256?: unknown; stripped?: unknown };
    if (typeof r.path !== "string" || !r.path) continue;
    const size = typeof r.size_bytes === "number" && Number.isFinite(r.size_bytes)
      ? r.size_bytes
      : typeof r.content === "string"
        ? byteLength(r.content, r.encoding)
        : null;
    out.push({ path: r.path, size, stripped: r.stripped === true || (typeof r.content !== "string" && typeof r.sha256 === "string") });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Message for a failed `bundle/sync-files` call. The function needs a space reviewer or admin and never accepts
 * OAuth-client tokens, so a 403 means "not allowed", not "try again".
 */
export function syncFilesErrorMessage(e: unknown): string {
  const status = typeof e === "object" && e !== null && typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : null;
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (status === 403) {
    return "only a reviewer or admin of this space, signed in to Studio or the CLI, can sync skill files. Ask one of them to use “Retry file sync”";
  }
  if (status === 401) return "your session expired. Sign in again and use “Retry file sync”";
  return message || "something went wrong";
}
