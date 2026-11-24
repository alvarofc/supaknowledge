// Embedding worker (automatic embeddings pattern). Invoked by cron via util.process_queue('kf_embed').
// For each changed concept or source document: chunk -> embed with gte-small -> swap chunks (upsert + trim).
// For concepts it also rebuilds the link graph (concept_links) from markdown links.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { chunkMarkdown, extractLinks } from "../_shared/core/formats.ts";
import { requireInternal } from "../_shared/auth.ts";
import { adminClient } from "../_shared/env.ts";
import { embed, toVector } from "../_shared/embed.ts";
import { handler, json, readJson } from "../_shared/http.ts";
import { processBatch, type QueueBatch } from "../_shared/queue.ts";

interface EmbedJob {
  table: "concepts" | "source_documents";
  id: string;
}

const db = adminClient();
/** Chunk caps per entity. */
const MAX_CONCEPT_CHUNKS = 200;
const MAX_DOCUMENT_CHUNKS = 400;
/** rows per insert/upsert request */
const WRITE_BATCH = 100;
/**
 * gte-small runs on the worker's CPU, and Edge Functions get ~2 s of CPU per request (hosted and local), so a
 * request embeds at most this many NEW chunks across all its jobs. Unchanged chunks reuse their stored
 * embedding. A job that runs out of budget writes what it has and re-queues itself (see `Budget`).
 */
const EMBEDS_PER_REQUEST = Math.max(1, Number(Deno.env.get("KF_EMBEDS_PER_REQUEST") ?? "") || 4);

/** Per-request embedding budget shared by the jobs of one batch. */
class Budget {
  constructor(public left: number) {}
  take(): boolean {
    if (this.left <= 0) return false;
    this.left--;
    return true;
  }
}

/** Thrown inside a job when the budget ran out: the job is re-queued instead of failed. */
class OutOfBudget extends Error {
  constructor(public progressed: boolean) {
    super("embedding budget exhausted");
  }
}

type ChunkRow = { ord: number; content: string; embedding: string | null };

/**
 * Embeddings for `contents`, reusing stored vectors for identical chunk text. Returns null entries for chunks
 * that could not be embedded within the budget (callers write the finished prefix and re-queue).
 */
async function embedWithReuse(contents: string[], previous: ChunkRow[], budget: Budget): Promise<(string | null)[]> {
  const known = new Map(previous.filter((r) => r.embedding).map((r) => [r.content, r.embedding!]));
  const out: (string | null)[] = [];
  for (const c of contents) {
    const hit = known.get(c);
    if (hit) out.push(hit);
    else if (budget.take()) out.push(toVector(await embed(c)));
    else out.push(null);
  }
  return out;
}

async function writeInBatches(rows: Record<string, unknown>[], write: (rows: Record<string, unknown>[]) => PromiseLike<{ error: { message: string } | null }>) {
  for (let i = 0; i < rows.length; i += WRITE_BATCH) {
    const { error } = await write(rows.slice(i, i + WRITE_BATCH));
    if (error) throw new Error(error.message);
  }
}

async function previousChunks(table: "concept_chunks" | "source_chunks", owner: "concept_id" | "document_id", id: string): Promise<ChunkRow[]> {
  const out: ChunkRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select("ord, content, embedding").eq(owner, id).order("ord").range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as ChunkRow[]));
    if (!data || data.length < 1000) return out;
  }
}

/**
 * Replace an entity's chunks without a window where it has none: embeddings are computed first, then rows
 * are upserted on their natural key (owner, ord) and only the surplus tail is deleted. Concurrent jobs for
 * the same entity cannot hit a unique violation, and each job re-checks that it is still embedding the
 * current version right before writing (a newer version has its own queued job).
 * With an exhausted budget, only the embedded chunks are written (old chunks keep serving search for the
 * rest) and OutOfBudget re-queues the job; the next run reuses what was written.
 */
async function swapChunks(
  table: "concept_chunks" | "source_chunks",
  owner: "concept_id" | "document_id",
  id: string,
  rows: (Record<string, unknown> & { embedding: string | null })[],
  embedded: number,
) {
  const ready = rows.filter((r) => r.embedding !== null);
  await writeInBatches(ready, (b) => db.from(table).upsert(b, { onConflict: `${owner},ord` }));
  if (ready.length < rows.length) throw new OutOfBudget(embedded > 0);
  const del = await db.from(table).delete().eq(owner, id).gte("ord", rows.length);
  if (del.error) throw new Error(del.error.message);
}

async function embedConcept(id: string, budget: Budget) {
  const { data: c, error } = await db
    .from("concepts")
    .select("id, space_id, path, kind, title, description, body, revision")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!c) return; // deleted since enqueue

  const chunks = chunkMarkdown(c.body, { preamble: `${c.title}${c.description ? ` — ${c.description}` : ""}` }).slice(0, MAX_CONCEPT_CHUNKS);
  const previous = await previousChunks("concept_chunks", "concept_id", c.id);
  const before = budget.left;
  const vectors = await embedWithReuse(chunks.map((ch) => ch.content), previous, budget);
  const embedded = before - budget.left;

  // still the version we embedded? (a newer revision has its own queued job)
  const cur = await db.from("concepts").select("revision, path, body").eq("id", id).maybeSingle();
  if (cur.error) throw new Error(cur.error.message);
  if (!cur.data || cur.data.revision !== c.revision || cur.data.path !== c.path || cur.data.body !== c.body) return;

  const rows = chunks.map((ch, i) => ({
    concept_id: c.id, space_id: c.space_id, revision: c.revision, ord: i, heading: ch.heading, content: ch.content, embedding: vectors[i],
  }));
  await swapChunks("concept_chunks", "concept_id", c.id, rows, embedded);

  // link graph: upsert current links, drop the ones that disappeared (no delete-all window, no duplicate keys)
  // a skill's body is its SKILL.md, which lives inside the skill directory
  const extracted = extractLinks(c.kind === "skill" ? `${c.path}/SKILL` : c.path, c.body).filter((l) => l.path && l.path !== c.path);
  const links = [...new Map(extracted.map((l) => [l.path!, l])).values()];
  const targets = links.length
    ? (await db.from("concepts").select("id, path").eq("space_id", c.space_id).in("path", links.map((l) => l.path!))).data ?? []
    : [];
  const byPath = new Map(targets.map((t: { id: string; path: string }) => [t.path, t.id]));
  if (links.length) {
    await writeInBatches(
      links.map((l) => ({ space_id: c.space_id, from_concept: c.id, to_path: l.path!, to_concept: byPath.get(l.path!) ?? null, anchor: l.anchor.slice(0, 200) })),
      (b) => db.from("concept_links").upsert(b, { onConflict: "from_concept,to_path" }),
    );
  }
  const existing = await db.from("concept_links").select("to_path").eq("from_concept", c.id);
  if (existing.error) throw new Error(existing.error.message);
  const keep = new Set(links.map((l) => l.path!));
  const stale = (existing.data ?? []).map((r: { to_path: string }) => r.to_path).filter((p) => !keep.has(p));
  for (let i = 0; i < stale.length; i += WRITE_BATCH) {
    const dl = await db.from("concept_links").delete().eq("from_concept", c.id).in("to_path", stale.slice(i, i + WRITE_BATCH));
    if (dl.error) throw new Error(dl.error.message);
  }
  // links that pointed at this path before it existed
  await db.from("concept_links").update({ to_concept: c.id }).eq("space_id", c.space_id).eq("to_path", c.path).is("to_concept", null);
}

async function embedDocument(id: string, budget: Budget) {
  const { data: d, error } = await db
    .from("source_documents")
    .select("id, space_id, title, content, content_hash, deleted_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!d) return;
  if (d.deleted_at || !d.content.trim()) {
    const del = await db.from("source_chunks").delete().eq("document_id", d.id);
    if (del.error) throw new Error(del.error.message);
    return;
  }
  const chunks = chunkMarkdown(d.content, { preamble: d.title ?? undefined }).slice(0, MAX_DOCUMENT_CHUNKS);
  const previous = await previousChunks("source_chunks", "document_id", d.id);
  const before = budget.left;
  const vectors = await embedWithReuse(chunks.map((ch) => ch.content), previous, budget);
  const embedded = before - budget.left;

  const cur = await db.from("source_documents").select("content_hash, deleted_at").eq("id", id).maybeSingle();
  if (cur.error) throw new Error(cur.error.message);
  if (!cur.data || cur.data.content_hash !== d.content_hash || cur.data.deleted_at) return; // a newer job handles it

  const rows = chunks.map((ch, i) => ({ document_id: d.id, space_id: d.space_id, ord: i, heading: ch.heading, content: ch.content, embedding: vectors[i] }));
  await swapChunks("source_chunks", "document_id", d.id, rows, embedded);
}

Deno.serve(handler(async (req) => {
  requireInternal(req);
  const batch = await readJson<QueueBatch<EmbedJob>>(req);
  const budget = new Budget(EMBEDS_PER_REQUEST);
  // the same entity can be queued several times (rapid edits): do the work once per batch
  const running = new Map<string, Promise<void>>();
  const requeue = new Map<string, EmbedJob>();
  const result = await processBatch(db, batch, async (job) => {
    const key = `${job.table}:${job.id}`;
    let p = running.get(key);
    if (!p) {
      p = job.table === "concepts"
        ? embedConcept(job.id, budget)
        : job.table === "source_documents"
        ? embedDocument(job.id, budget)
        : Promise.reject(new Error(`unknown table ${(job as EmbedJob).table}`));
      running.set(key, p);
    }
    try {
      await p;
    } catch (e) {
      // out of CPU budget for this request: finish later in a fresh message (acked here, so the original's
      // read count does not creep towards the dead-letter limit)
      if (!(e instanceof OutOfBudget)) throw e;
      if (requeue.has(key)) return;
      requeue.set(key, { table: job.table, id: job.id });
      const { error } = await db.rpc("kf_queue_send", { p_queue: "kf_embed", p_messages: [{ table: job.table, id: job.id }], p_delay: 0 });
      if (error) throw new Error(`re-queue failed: ${error.message}`); // not acked: redelivered after vt
    }
  }, { concurrency: 2 });
  return json({ ...result, requeued: requeue.size }, 200, { "x-completed-jobs": String(result.completed.length), "x-failed-jobs": String(result.failed.length) });
}));
