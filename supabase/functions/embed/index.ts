// Embedding worker (automatic embeddings pattern). Invoked by cron via util.process_queue('kf_embed').
// For each changed concept or source document: chunk -> embed with gte-small -> replace chunks.
// For concepts it also rebuilds the link graph (concept_links) from markdown links.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { chunkMarkdown, extractLinks } from "../_shared/core/index.ts";
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

async function embedConcept(id: string) {
  const { data: c, error } = await db
    .from("concepts")
    .select("id, space_id, path, kind, title, description, body, revision")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!c) return; // deleted since enqueue

  const chunks = chunkMarkdown(c.body, { preamble: `${c.title}${c.description ? ` — ${c.description}` : ""}` });
  const rows = [];
  for (const ch of chunks) {
    rows.push({
      concept_id: c.id, space_id: c.space_id, revision: c.revision, ord: ch.ord, heading: ch.heading, content: ch.content,
      embedding: toVector(await embed(ch.content)),
    });
  }
  const del = await db.from("concept_chunks").delete().eq("concept_id", c.id);
  if (del.error) throw new Error(del.error.message);
  if (rows.length) {
    const ins = await db.from("concept_chunks").insert(rows);
    if (ins.error) throw new Error(ins.error.message);
  }

  // link graph
  // a skill's body is its SKILL.md, which lives inside the skill directory
  const links = extractLinks(c.kind === "skill" ? `${c.path}/SKILL` : c.path, c.body).filter((l) => l.path && l.path !== c.path);
  const targets = links.length
    ? (await db.from("concepts").select("id, path").eq("space_id", c.space_id).in("path", links.map((l) => l.path!))).data ?? []
    : [];
  const byPath = new Map(targets.map((t: { id: string; path: string }) => [t.path, t.id]));
  const dl = await db.from("concept_links").delete().eq("from_concept", c.id);
  if (dl.error) throw new Error(dl.error.message);
  if (links.length) {
    const il = await db.from("concept_links").insert(
      links.map((l) => ({ space_id: c.space_id, from_concept: c.id, to_path: l.path!, to_concept: byPath.get(l.path!) ?? null, anchor: l.anchor.slice(0, 200) })),
    );
    if (il.error) throw new Error(il.error.message);
  }
  // links that pointed at this path before it existed
  await db.from("concept_links").update({ to_concept: c.id }).eq("space_id", c.space_id).eq("to_path", c.path).is("to_concept", null);
}

async function embedDocument(id: string) {
  const { data: d, error } = await db
    .from("source_documents")
    .select("id, space_id, title, content, deleted_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!d) return;
  const del = await db.from("source_chunks").delete().eq("document_id", d.id);
  if (del.error) throw new Error(del.error.message);
  if (d.deleted_at || !d.content.trim()) return;
  const chunks = chunkMarkdown(d.content, { preamble: d.title ?? undefined });
  const rows = [];
  for (const ch of chunks.slice(0, 400)) {
    rows.push({ document_id: d.id, space_id: d.space_id, ord: ch.ord, heading: ch.heading, content: ch.content, embedding: toVector(await embed(ch.content)) });
  }
  if (rows.length) {
    const ins = await db.from("source_chunks").insert(rows);
    if (ins.error) throw new Error(ins.error.message);
  }
}

Deno.serve(handler(async (req) => {
  requireInternal(req);
  const batch = await readJson<QueueBatch<EmbedJob>>(req);
  const result = await processBatch(db, batch, async (job) => {
    if (job.table === "concepts") await embedConcept(job.id);
    else if (job.table === "source_documents") await embedDocument(job.id);
    else throw new Error(`unknown table ${(job as EmbedJob).table}`);
  }, { concurrency: 2 });
  return json(result, 200, { "x-completed-jobs": String(result.completed.length), "x-failed-jobs": String(result.failed.length) });
}));
