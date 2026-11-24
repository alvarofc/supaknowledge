// Source connectors worker. Two entry points on one function:
//
//   POST /connectors          internal (x-kf-internal). Invoked by cron via
//                             util.process_queue('kf_ingest', 'connectors', 1, 2, 400) with
//                             { queue, jobs: [{ msg_id, read_ct, message: { source_id, space_id, full? } }] }.
//                             Runs the source's connector incrementally from sources.cursor (from scratch when
//                             full), writes source_documents (embedding follows automatically via kf_embed)
//                             and raw exports in Storage bucket "sources".
//   POST /connectors/upload   authenticated (user JWT / agent key). Adds a document to an `upload` source:
//                             multipart (source_id + file [+ title, external_id, url]) or
//                             JSON { source_id, title?, content, external_id?, format?: "md"|"txt"|"html", url? }.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticate, requireInternal } from "../_shared/auth.ts";
import { adminClient } from "../_shared/env.ts";
import { handler, HttpError, json, readJson } from "../_shared/http.ts";
import { MAX_READS, processBatch, type QueueBatch, type QueueJob } from "../_shared/queue.ts";
import type { GroupRef } from "./lib/acl.ts";
import { type DocumentRow, type DocumentStore, type ExistingDoc, runSync, type SourceRow } from "./lib/engine.ts";
import { guardedFetch } from "./lib/net-guard.ts";
import { connectors } from "./lib/registry.ts";
import { AuthError, ConfigError, type Connector, type Cursor, type RawExport, type SyncedDocument } from "./lib/types.ts";
import { prepareUpload, UPLOAD_MAX_BYTES, UploadError, type UploadInput } from "./lib/upload.ts";

interface IngestJob {
  source_id: string;
  space_id: string;
  full?: boolean;
}

const db = adminClient();
const TIME_BUDGET_MS = Number(Deno.env.get("CONNECTOR_TIME_BUDGET_MS") ?? 120_000);
const DOC_LIMIT = Number(Deno.env.get("CONNECTOR_DOC_LIMIT") ?? 200);
// every outbound connector request goes through the SSRF guard (public destinations only, redirects re-checked)
const outboundFetch = guardedFetch();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------------------------------------
// Supabase-backed document store (service role: this module only runs after requireInternal() or after the
// upload route has authorised the caller through RLS)
// ---------------------------------------------------------------------------------------------------------
class SupabaseStore implements DocumentStore {
  lastUpsertId: string | null = null;
  constructor(private client: SupabaseClient, private source: { id: string; space_id: string }, private only?: string[]) {}

  async existing(): Promise<Map<string, ExistingDoc>> {
    const map = new Map<string, ExistingDoc>();
    const page = 1000;
    for (let from = 0; ; from += page) {
      let q = this.client
        .from("source_documents")
        .select("id, external_id, content_hash, audience, title, deleted_at, storage_path, version:metadata->>version, children:metadata->children")
        .eq("source_id", this.source.id)
        .order("id")
        .range(from, from + page - 1);
      if (this.only) q = q.in("external_id", this.only);
      const { data, error } = await q;
      if (error) throw new Error(`load documents: ${error.message}`);
      for (const d of data ?? []) {
        const row = d as unknown as ExistingDoc & { children: unknown };
        map.set(row.external_id, {
          ...row,
          version: row.version ?? null,
          children: Array.isArray(row.children) ? (row.children as unknown[]).filter((x): x is string => typeof x === "string") : [],
        });
      }
      if (!data || data.length < page) break;
    }
    return map;
  }

  async putRaw(path: string, raw: RawExport): Promise<void> {
    const body = new Blob([raw.body as BlobPart], { type: raw.contentType });
    const { error } = await this.client.storage.from("sources").upload(path, body, { contentType: raw.contentType, upsert: true });
    if (error) throw new Error(`storage upload ${path}: ${error.message}`);
  }

  async upsert(row: DocumentRow): Promise<{ id: string }> {
    const { data, error } = await this.client
      .from("source_documents")
      .upsert({ ...row, source_id: this.source.id, space_id: this.source.space_id }, { onConflict: "source_id,external_id" })
      .select("id")
      .single();
    if (error) throw new Error(`upsert ${row.external_id}: ${error.message}`);
    this.lastUpsertId = data.id;
    return { id: data.id };
  }

  async touch(id: string, patch: { metadata: Record<string, unknown>; synced_at: string }): Promise<void> {
    const { error } = await this.client.from("source_documents").update(patch).eq("id", id);
    if (error) throw new Error(`touch ${id}: ${error.message}`);
  }

  async markDeleted(ids: string[]): Promise<void> {
    const at = new Date().toISOString();
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const up = await this.client.from("source_documents").update({ deleted_at: at }).in("id", batch);
      if (up.error) throw new Error(`mark deleted: ${up.error.message}`);
      // search_sources already hides deleted documents; dropping chunks keeps them out of the ANN candidates
      const del = await this.client.from("source_chunks").delete().in("document_id", batch);
      if (del.error) throw new Error(`delete chunks: ${del.error.message}`);
    }
  }

  async reembed(id: string): Promise<void> {
    const { error } = await this.client.rpc("kf_queue_send", { p_queue: "kf_embed", p_messages: [{ table: "source_documents", id }], p_delay: 0 });
    if (error) throw new Error(`enqueue embed: ${error.message}`);
  }

  async saveCursor(cursor: Cursor): Promise<void> {
    const { error } = await this.client.from("sources").update({ cursor }).eq("id", this.source.id);
    if (error) throw new Error(`save cursor: ${error.message}`);
  }
}

async function loadGroups(spaceId: string): Promise<GroupRef[]> {
  const { data: space, error } = await db.from("spaces").select("workspace_id").eq("id", spaceId).single();
  if (error) throw new Error(`load space: ${error.message}`);
  const { data, error: gErr } = await db.from("groups").select("id, external_ref").eq("workspace_id", space.workspace_id).neq("external_ref", "{}");
  if (gErr) throw new Error(`load groups: ${gErr.message}`);
  return (data ?? []) as GroupRef[];
}

async function isPaused(id: string): Promise<boolean> {
  const { data } = await db.from("sources").select("status").eq("id", id).maybeSingle();
  return data?.status === "paused";
}

function errorText(e: unknown): string {
  const m = e instanceof Error ? `${e.name !== "Error" ? `${e.name}: ` : ""}${e.message}` : String(e);
  return m.slice(0, 1000);
}

// ---------------------------------------------------------------------------------------------------------
// queue worker
// ---------------------------------------------------------------------------------------------------------
async function syncSource(msg: IngestJob, job: QueueJob<IngestJob>): Promise<void> {
  const { data: source, error } = await db
    .from("sources")
    .select("id, space_id, name, connector, config, audience, cursor, status")
    .eq("id", msg.source_id)
    .maybeSingle();
  if (error) throw new Error(`load source: ${error.message}`);
  if (!source) return; // deleted since enqueue: ack
  if (source.status === "paused") return;

  const connector = connectors[source.connector as keyof typeof connectors];
  const log = (m: string, extra?: Record<string, unknown>) => console.log(`[connectors:${source.connector}:${source.id}] ${m}`, extra ?? "");
  if (!connector || source.connector === "upload") {
    // uploads have nothing to pull; just record the heartbeat
    await db.from("sources").update({ last_synced_at: new Date().toISOString(), last_error: null }).eq("id", source.id);
    return;
  }

  const started = Date.now();
  try {
    const { data: token, error: tErr } = await db.rpc("kf_get_source_secret", { p_source: source.id });
    if (tErr) throw new Error(`read secret: ${tErr.message}`);
    const groups = await loadGroups(source.space_id);
    const store = new SupabaseStore(db, source);
    const result = await runSync({
      source: source as SourceRow,
      connector,
      store,
      groups,
      token: (token as string | null) ?? null,
      full: msg.full === true || !source.cursor || Object.keys(source.cursor).length === 0,
      fetch: outboundFetch,
      log,
      limit: DOC_LIMIT,
      deadline: started + TIME_BUDGET_MS,
    });
    const { error: uErr } = await db
      .from("sources")
      .update({ cursor: result.cursor, last_synced_at: new Date().toISOString(), last_error: null })
      .eq("id", source.id);
    if (uErr) throw new Error(`update source: ${uErr.message}`);
    // clear an earlier 'error' state, but never un-pause a source an admin paused while this run was going
    const { error: sErr } = await db.from("sources").update({ status: "active" }).eq("id", source.id).eq("status", "error");
    if (sErr) throw new Error(`update source status: ${sErr.message}`);
    log(`synced in ${Date.now() - started} ms`, { upserted: result.upserted, unchanged: result.unchanged, deleted: result.deleted, skipped: result.skipped, more: result.more });
    if (result.more && !(await isPaused(source.id))) {
      // continue from the saved cursor soon instead of waiting for the next sync_interval
      await db.rpc("kf_queue_send", { p_queue: "kf_ingest", p_messages: [{ source_id: source.id, space_id: source.space_id }], p_delay: 5 });
    }
  } catch (e) {
    const permanent = e instanceof ConfigError || e instanceof AuthError;
    const giveUp = permanent || job.read_ct >= MAX_READS;
    await db.from("sources").update({ last_error: errorText(e) }).eq("id", source.id);
    if (giveUp) await db.from("sources").update({ status: "error" }).eq("id", source.id).neq("status", "paused");
    if (permanent) {
      log(`permanent error, source set to 'error': ${errorText(e)}`);
      return; // ack: retrying cannot help until an admin fixes the config/secret (then request_source_sync)
    }
    throw e; // retried after the visibility timeout; archived after MAX_READS
  }
}

// ---------------------------------------------------------------------------------------------------------
// upload route
// ---------------------------------------------------------------------------------------------------------
function oneShot(doc: SyncedDocument): Connector<unknown> {
  return {
    kind: "upload",
    parseConfig: (c) => c,
    async *sync() {
      yield { type: "upsert", doc };
    },
  };
}

function formString(form: FormData, key: string): string | undefined {
  const v = form.get(key);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

async function handleUpload(req: Request): Promise<Response> {
  if (req.method !== "POST") throw new HttpError(405, "POST only");
  const caller = await authenticate(req);

  let sourceId: string | undefined;
  let input: UploadInput;
  const ct = req.headers.get("content-type") ?? "";
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > UPLOAD_MAX_BYTES + 64 * 1024) throw new HttpError(413, "upload too large (max 20 MB)");
  if (ct.startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new HttpError(400, "invalid multipart body");
    }
    sourceId = formString(form, "source_id");
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "multipart field `file` is required");
    if (file.size > UPLOAD_MAX_BYTES) throw new HttpError(413, "file too large (max 20 MB)");
    input = {
      filename: file.name,
      contentType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
      title: formString(form, "title"),
      externalId: formString(form, "external_id"),
      url: formString(form, "url"),
    };
  } else {
    const body = await readJson<{ source_id?: string; title?: string; content?: unknown; external_id?: string; format?: string; url?: string }>(req);
    if (typeof body.content !== "string") throw new HttpError(400, "`content` (string) is required");
    sourceId = body.source_id;
    input = { text: body.content, title: body.title, externalId: body.external_id, format: body.format, url: body.url };
  }
  if (!sourceId || !UUID_RE.test(sourceId)) throw new HttpError(400, "`source_id` (uuid) is required");

  // 1. Authorisation, entirely through the CALLER's RLS-scoped client: the sources SELECT policy only shows
  //    sources to space editors+ who are inside the source audience, and my_space_role() confirms the rank.
  const { data: src, error: sErr } = await caller.db
    .from("sources")
    .select("id, space_id, connector, audience, status")
    .eq("id", sourceId)
    .maybeSingle();
  if (sErr) throw new HttpError(500, sErr.message);
  if (!src) throw new HttpError(404, "source not found (or you cannot see it)");
  const { data: role, error: rErr } = await caller.db.rpc("my_space_role", { p_space: src.space_id });
  if (rErr) throw new HttpError(500, rErr.message);
  if (!["editor", "reviewer", "admin"].includes(String(role))) throw new HttpError(403, "space editor or admin required");
  if (src.connector !== "upload") throw new HttpError(409, `source is a ${src.connector} source; uploads go to 'upload' sources`);
  if (src.status === "paused") throw new HttpError(409, "source is paused");

  let doc: SyncedDocument;
  try {
    doc = await prepareUpload(input);
  } catch (e) {
    if (e instanceof UploadError) throw new HttpError(e.status, e.message);
    throw e;
  }
  doc.metadata = { ...doc.metadata, uploaded_by: caller.userId, uploaded_via: caller.kind };

  // 2. Writes with the service role. Safe because: (a) the caller was authorised above with their own RLS
  //    client for exactly this source; (b) space_id and audience are taken from that RLS-visible source row,
  //    never from the request; (c) the Storage path is derived server-side from space/source/external id, so
  //    the caller cannot write outside <space_id>/<source_id>/; (d) users have no INSERT policy on
  //    source_documents or the `sources` bucket, so there is no RLS path to do this as the caller.
  const store = new SupabaseStore(db, src, [doc.externalId]);
  const result = await runSync({
    source: { id: src.id, space_id: src.space_id, connector: "upload", config: {}, audience: src.audience ?? [], cursor: {}, status: "active" },
    connector: oneShot(doc),
    store,
    groups: [],
    token: null,
    full: false,
    fetch: outboundFetch,
    log: (m) => console.log(`[connectors:upload:${src.id}] ${m}`),
  });
  const { data: row, error: dErr } = await db
    .from("source_documents")
    .select("id, external_id, title, content_hash, storage_path, mime_type, audience, metadata, changed_at")
    .eq("source_id", src.id)
    .eq("external_id", doc.externalId)
    .single();
  if (dErr) throw new HttpError(500, dErr.message);
  return json({ document: row, changed: result.upserted > 0 }, result.upserted > 0 ? 201 : 200);
}

// ---------------------------------------------------------------------------------------------------------
Deno.serve(handler(async (req) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  if (path.endsWith("/upload")) return await handleUpload(req);
  if (req.method !== "POST") throw new HttpError(405, "POST only");

  requireInternal(req);
  const batch = await readJson<QueueBatch<IngestJob>>(req);
  if (!Array.isArray(batch?.jobs)) throw new HttpError(400, "expected { queue, jobs: [...] }");
  const result = await processBatch(db, batch, syncSource, { concurrency: 1 });
  return json(result, 200, { "x-completed-jobs": String(result.completed.length), "x-failed-jobs": String(result.failed.length) });
}));
