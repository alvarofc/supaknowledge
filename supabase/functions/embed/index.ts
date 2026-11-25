// Embedding worker (automatic embeddings pattern). Invoked by cron via util.process_queue('kf_embed').
// For each changed concept or source document: chunk -> embed with gte-small -> write chunks (upsert + trim).
// For concepts it also rebuilds the link graph (concept_links) from markdown links.
//
// Writes are compare-and-swap (migration 20261125000023): kf_embed_write_concept / kf_embed_write_document lock
// the entity row and write only when it is still the version this job embedded, so a slow job can never
// overwrite the chunks of a newer version. A job out of CPU budget is re-queued with kf_embed_requeue, which
// keeps at most one queued message per entity.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { chunkMarkdown, extractLinks } from "../_shared/core/formats.ts";
import { requireInternal } from "../_shared/auth.ts";
import { adminClient } from "../_shared/env.ts";
import { embed, toVector } from "../_shared/embed.ts";
import { handler, json, readJson } from "../_shared/http.ts";
import { assertQueueBatch, processBatch } from "../_shared/queue.ts";
import { Budget, type ChunkRow, type ChunkWrite, embedWithReuse, OutOfBudget, parseEmbedJob, sha256Hex, writeChunks } from "./lib.ts";

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

async function previousChunks(table: "concept_chunks" | "source_chunks", owner: "concept_id" | "document_id", id: string): Promise<ChunkRow[]> {
  const out: ChunkRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select("ord, content, embedding").eq(owner, id).order("ord").range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as ChunkRow[]));
    if (!data || data.length < 1000) return out;
  }
}

const embedOne = async (text: string) => toVector(await embed(text));

function rpcWrite(fn: string, args: (chunks: ChunkWrite[], total: number | null, first: boolean) => Record<string, unknown>) {
  return async (chunks: ChunkWrite[], total: number | null, first: boolean): Promise<boolean> => {
    const { data, error } = await db.rpc(fn, args(chunks, total, first));
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data === true;
  };
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
  const vectors = await embedWithReuse(chunks.map((ch) => ch.content), previous, budget, embedOne);

  // link graph: the full current set (the database upserts it and drops links that disappeared). A skill's body is
  // its SKILL.md, which lives inside the skill directory.
  const extracted = extractLinks(c.kind === "skill" ? `${c.path}/SKILL` : c.path, c.body).filter((l) => l.path && l.path !== c.path);
  const links = [...new Map(extracted.map((l) => [l.path!, { to_path: l.path!, anchor: l.anchor.slice(0, 200) }])).values()];
  const bodySha = await sha256Hex(c.body);

  // written only if the concept is still this version (checked under a row lock on every call); a newer
  // revision has its own queued job
  await writeChunks(
    chunks.map((ch, i) => ({ ord: i, heading: ch.heading ?? null, content: ch.content, embedding: vectors[i] })),
    rpcWrite("kf_embed_write_concept", (batch, total, first) => ({
      p_concept: c.id, p_revision: c.revision, p_path: c.path, p_body_sha256: bodySha,
      p_chunks: batch, p_total: total, p_links: first ? links : null,
    })),
    WRITE_BATCH,
  );
}

async function embedDocument(id: string, budget: Budget) {
  const { data: d, error } = await db
    .from("source_documents")
    .select("id, space_id, title, content, content_hash, deleted_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!d) return;
  const live = !d.deleted_at;
  if (!live || !d.content.trim()) {
    // no chunks for a deleted or empty document (only if it is still in that state)
    await writeChunks([], rpcWrite("kf_embed_write_document", (batch, total) => ({
      p_document: d.id, p_content_hash: d.content_hash, p_live: live, p_chunks: batch, p_total: total,
    })));
    return;
  }
  const chunks = chunkMarkdown(d.content, { preamble: d.title ?? undefined }).slice(0, MAX_DOCUMENT_CHUNKS);
  const previous = await previousChunks("source_chunks", "document_id", d.id);
  const vectors = await embedWithReuse(chunks.map((ch) => ch.content), previous, budget, embedOne);
  await writeChunks(
    chunks.map((ch, i) => ({ ord: i, heading: ch.heading ?? null, content: ch.content, embedding: vectors[i] })),
    rpcWrite("kf_embed_write_document", (batch, total) => ({
      p_document: d.id, p_content_hash: d.content_hash, p_live: true, p_chunks: batch, p_total: total,
    })),
    WRITE_BATCH,
  );
}

Deno.serve(handler(async (req) => {
  requireInternal(req);
  const batch = await readJson<unknown>(req);
  assertQueueBatch<unknown>(batch);
  const budget = new Budget(EMBEDS_PER_REQUEST);
  // the same entity can be queued several times (rapid edits): do the work once per batch
  const running = new Map<string, Promise<void>>();
  let requeued = 0;
  const result = await processBatch(db, batch, async (message, qjob) => {
    const job = parseEmbedJob(message);
    if (!job) {
      console.error("[kf_embed] dropping malformed message", JSON.stringify(message)?.slice(0, 200));
      return; // acked: retrying would never succeed
    }
    const key = `${job.table}:${job.id}`;
    let p = running.get(key);
    if (!p) {
      p = job.table === "concepts" ? embedConcept(job.id, budget) : embedDocument(job.id, budget);
      running.set(key, p);
    }
    try {
      await p;
    } catch (e) {
      // out of CPU budget for this request: finish later in a fresh message. kf_embed_requeue acks this one
      // and sends a new one only if no other message for the entity is still queued (duplicates collapse, and
      // the read count does not creep towards the dead-letter limit).
      if (!(e instanceof OutOfBudget)) throw e;
      const { data, error } = await db.rpc("kf_embed_requeue", { p_msg_id: qjob.msg_id, p_message: job, p_delay: 0 });
      if (error) throw new Error(`re-queue failed: ${error.message}`); // not acked: redelivered after vt
      if (data === true) requeued++;
    }
  }, { concurrency: 2 });
  return json({ ...result, requeued }, 200, { "x-completed-jobs": String(result.completed.length), "x-failed-jobs": String(result.failed.length) });
}));
