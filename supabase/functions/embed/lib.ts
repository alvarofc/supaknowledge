// Pure parts of the embed worker (no Edge Runtime globals), unit tested in test/lib.test.ts.
export interface EmbedJob {
  table: "concepts" | "source_documents";
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A queue message we can act on, or null (malformed: retrying it would never succeed). */
export function parseEmbedJob(m: unknown): EmbedJob | null {
  if (!m || typeof m !== "object") return null;
  const { table, id } = m as Record<string, unknown>;
  if (table !== "concepts" && table !== "source_documents") return null;
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  return { table, id };
}

/** Per-request embedding budget shared by the jobs of one batch. */
export class Budget {
  constructor(public left: number) {}
  take(): boolean {
    if (this.left <= 0) return false;
    this.left--;
    return true;
  }
}

/** Thrown inside a job when the budget ran out: the job is re-queued instead of failed. */
export class OutOfBudget extends Error {
  constructor() {
    super("embedding budget exhausted");
  }
}

export type ChunkRow = { ord: number; content: string; embedding: string | null };

/**
 * Embeddings for `contents`, reusing stored vectors for identical chunk text. Returns null entries for chunks
 * that could not be embedded within the budget (callers write the finished ones and re-queue).
 */
export async function embedWithReuse(
  contents: string[],
  previous: ChunkRow[],
  budget: Budget,
  embedOne: (text: string) => Promise<string | null>,
): Promise<(string | null)[]> {
  const known = new Map(previous.filter((r) => r.embedding).map((r) => [r.content, r.embedding!]));
  const out: (string | null)[] = [];
  for (const c of contents) {
    const hit = known.get(c);
    if (hit) out.push(hit);
    else if (budget.take()) out.push(await embedOne(c));
    else out.push(null);
  }
  return out;
}

export interface ChunkWrite {
  ord: number;
  heading: string | null;
  content: string;
  embedding: string | null;
}

/** One compare-and-swap write (kf_embed_write_concept / kf_embed_write_document): false = no longer current. */
export type WriteCall = (chunks: ChunkWrite[], total: number | null, first: boolean) => Promise<boolean>;

/**
 * Write an entity's chunks in batches of `batchSize` through `write`, which re-checks the version on every call
 * (so a newer version written in between is never overwritten). The first call also carries the link graph
 * (callers pass it when `first`), so links follow the current body on the first pass even when embedding takes
 * several requests. The call that completes the version passes `total` (the database trims the tail). Rows
 * without an embedding (budget exhausted) are skipped and OutOfBudget is thrown after the others are written.
 * Returns false when the entity changed since it was read (a newer job owns it).
 */
export async function writeChunks(rows: ChunkWrite[], write: WriteCall, batchSize = 100): Promise<boolean> {
  const ready = rows.filter((r) => r.embedding !== null);
  const complete = ready.length === rows.length;
  let i = 0;
  do {
    const batch = ready.slice(i, i + batchSize);
    const last = i + batchSize >= ready.length;
    if (!(await write(batch, complete && last ? rows.length : null, i === 0))) return false;
    i += batchSize;
  } while (i < ready.length);
  if (!complete) throw new OutOfBudget();
  return true;
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
