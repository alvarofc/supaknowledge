// Runs one connector against one source and applies its DocumentChanges through a DocumentStore.
// Storage-agnostic so the bookkeeping (hash dedupe, audiences, soft deletes, cursor checkpoints, caps)
// is unit-tested with an in-memory store; index.ts provides the Supabase-backed store.
import { sha256 } from "../../_shared/core/chunk.ts";
import { decideAudience, resolveAudience, type GroupRef, isNarrowerOrEqual } from "./acl.ts";
import type { Connector, ConnectorKind, Cursor, FetchLike, Logger, PreviousDoc, RawExport, SyncContext, SyncedDocument } from "./types.ts";

export interface SourceRow {
  id: string;
  space_id: string;
  connector: ConnectorKind;
  config: Record<string, unknown>;
  audience: string[];
  cursor: Cursor;
  status: "active" | "paused" | "error";
}

export interface ExistingDoc {
  id: string;
  external_id: string;
  content_hash: string;
  audience: string[];
  title: string | null;
  deleted_at: string | null;
  storage_path: string | null;
  version: string | null;
  children: string[];
  /** metadata.acl as recorded by the last upsert: the upstream restriction and the groups it mapped to */
  acl?: unknown;
}

/** Row written to public.source_documents (minus source_id/space_id, which the store adds). */
export interface DocumentRow {
  external_id: string;
  title: string | null;
  url: string | null;
  storage_path: string | null;
  mime_type: string | null;
  content: string;
  content_hash: string;
  audience: string[];
  author: string | null;
  metadata: Record<string, unknown>;
  external_updated_at: string | null;
  synced_at: string;
  deleted_at: null;
}

export interface DocumentStore {
  existing(): Promise<Map<string, ExistingDoc>>;
  putRaw(path: string, raw: RawExport): Promise<void>;
  upsert(row: DocumentRow): Promise<{ id: string }>;
  /** small update for unchanged content: a new version marker, or a narrower audience after a re-check */
  touch(id: string, patch: { metadata?: Record<string, unknown>; synced_at?: string; audience?: string[] }): Promise<void>;
  markDeleted(ids: string[]): Promise<void>;
  /** content unchanged but the row came back from deleted: chunks were dropped, re-embed */
  reembed(id: string): Promise<void>;
  saveCursor(cursor: Cursor): Promise<void>;
}

export interface RunOptions {
  source: SourceRow;
  connector: Connector<unknown>;
  store: DocumentStore;
  groups: GroupRef[];
  token: string | null;
  full: boolean;
  fetch: FetchLike;
  log: Logger;
  /** per-run document cap (default 200) */
  limit?: number;
  /** stop pulling changes after this epoch ms and continue next run */
  deadline?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  env?: (name: string) => string | undefined;
}

export interface RunResult {
  upserted: number;
  unchanged: number;
  deleted: number;
  skipped: number;
  cursor: Cursor;
  /** the connector (or the time budget) stopped early; re-enqueue to continue */
  more: boolean;
}

export const MAX_CONTENT_CHARS = 2_000_000;
export const DEFAULT_LIMIT = 200;

/** `<space_id>/<source_id>/<safe-external-id>.<ext>`; a short hash keeps distinct ids distinct after sanitising. */
export async function storagePath(spaceId: string, sourceId: string, externalId: string, ext: string): Promise<string> {
  const safe = externalId.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+|_+$/g, "").slice(0, 120) || "doc";
  const h = (await sha256(externalId)).slice(0, 10);
  const e = (ext || "bin").replace(/[^A-Za-z0-9]/g, "").toLowerCase().slice(0, 10) || "bin";
  return `${spaceId}/${sourceId}/${safe}-${h}.${e}`;
}

function storedAcl(v: unknown): { restricted: boolean; groups: string[] } | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  if (typeof a.restricted !== "boolean" || !Array.isArray(a.groups)) return null;
  return { restricted: a.restricted, groups: a.groups.filter((g): g is string => typeof g === "string") };
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

export async function runSync(o: RunOptions): Promise<RunResult> {
  const now = o.now ?? (() => new Date());
  const limit = o.limit ?? DEFAULT_LIMIT;
  const config = o.connector.parseConfig(o.source.config);
  const strict = o.source.config?.acl_strict === true;
  const existing = await o.store.existing();

  const ctx: SyncContext<unknown> = {
    config,
    token: o.token,
    cursor: o.full ? {} : (o.source.cursor ?? {}),
    full: o.full,
    fetch: o.fetch,
    log: o.log,
    limit,
    previous(id: string): PreviousDoc | undefined {
      const d = existing.get(id);
      return d ? { contentHash: d.content_hash, version: d.version, deleted: !!d.deleted_at, children: d.children } : undefined;
    },
    known: () => [...existing.keys()],
    now,
    sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    env: o.env ?? ((n) => Deno.env.get(n)),
  };

  const result: RunResult = { upserted: 0, unchanged: 0, deleted: 0, skipped: 0, cursor: o.source.cursor ?? {}, more: false };
  // A full sync starts from an empty cursor but must not lose the old cursor if it stops early with no checkpoint.
  let cursorDirty = false;
  let emitted = 0;

  const markDeleted = async (ids: string[]) => {
    const rows = ids.map((id) => existing.get(id)).filter((d): d is ExistingDoc => !!d && !d.deleted_at);
    if (!rows.length) return;
    await o.store.markDeleted(rows.map((d) => d.id));
    const at = now().toISOString();
    for (const d of rows) d.deleted_at = at;
    result.deleted += rows.length;
  };

  const applyUpsert = async (doc: SyncedDocument) => {
    const decision = resolveAudience(o.source.audience, doc.acl, o.groups, { strict });
    if (decision.kind === "skip") {
      o.log(`skipping ${doc.externalId}: ${decision.reason}`);
      result.skipped++;
      // if it was synced before under a wider ACL, it must not stay visible
      await markDeleted([doc.externalId]);
      return;
    }
    // belt and braces: the invariant this whole module exists for
    if (!isNarrowerOrEqual(o.source.audience ?? [], decision.audience)) {
      throw new Error(`audience for ${doc.externalId} would be wider than the source audience`);
    }
    let content = doc.content ?? "";
    const metadata: Record<string, unknown> = { ...(doc.metadata ?? {}) };
    if (content.length > MAX_CONTENT_CHARS) {
      content = content.slice(0, MAX_CONTENT_CHARS);
      metadata.truncated = true;
    }
    if (doc.version) metadata.version = doc.version;
    metadata.acl = { mode: decision.mode, restricted: !!doc.acl?.restricted, groups: decision.groups };
    const hash = await sha256(content);
    const prev = existing.get(doc.externalId);
    const syncedAt = now().toISOString();

    if (
      prev && prev.content_hash === hash && sameSet(prev.audience, decision.audience) && !prev.deleted_at &&
      (doc.title ?? null) === prev.title
    ) {
      if ((doc.version ?? null) !== prev.version) {
        await o.store.touch(prev.id, { metadata, synced_at: syncedAt });
        prev.version = doc.version ?? null;
      }
      result.unchanged++;
      return;
    }

    let path: string | null = prev?.storage_path ?? null;
    if (doc.raw) {
      path = await storagePath(o.source.space_id, o.source.id, doc.externalId, doc.raw.ext);
      await o.store.putRaw(path, doc.raw);
    }
    const row: DocumentRow = {
      external_id: doc.externalId,
      title: doc.title ?? null,
      url: doc.url ?? null,
      storage_path: path,
      mime_type: doc.mimeType ?? doc.raw?.contentType ?? null,
      content,
      content_hash: hash,
      audience: decision.audience,
      author: doc.author ?? null,
      metadata,
      external_updated_at: doc.updatedAt ?? null,
      synced_at: syncedAt,
      deleted_at: null,
    };
    const { id } = await o.store.upsert(row);
    // revived with identical content: the embed trigger only fires on hash changes, so ask for it
    if (prev?.deleted_at && prev.content_hash === hash) await o.store.reembed(id);
    existing.set(doc.externalId, {
      id, external_id: doc.externalId, content_hash: hash, audience: decision.audience, title: row.title, deleted_at: null,
      storage_path: path, version: doc.version ?? null, children: Array.isArray(metadata.children) ? metadata.children as string[] : [],
      acl: metadata.acl,
    });
    result.upserted++;
  };

  // Connectors skip upstream items that did not change (blob sha, last_edited_time...), so a stored document is
  // otherwise never re-checked when the source audience, acl_strict or the audience rules change. Re-apply the
  // current rules to what each live document recorded at its last upsert: a document the rules now skip is
  // retracted, one they now narrow is narrowed. Widening waits for the item to be fetched again.
  const retract: string[] = [];
  for (const d of existing.values()) {
    const acl = d.deleted_at ? null : storedAcl(d.acl);
    if (!acl) continue;
    const decision = decideAudience(o.source.audience, acl.groups, acl.restricted, { strict });
    if (decision.kind === "skip") {
      o.log(`retracting ${d.external_id}: ${decision.reason}`);
      retract.push(d.external_id);
    } else if (!sameSet(d.audience, decision.audience) && isNarrowerOrEqual(d.audience, decision.audience)) {
      await o.store.touch(d.id, { audience: decision.audience });
      d.audience = decision.audience;
    }
  }
  await markDeleted(retract);

  const iter = o.connector.sync(ctx)[Symbol.asyncIterator]();
  try {
    loop: while (true) {
      if (o.deadline && Date.now() > o.deadline) {
        o.log("time budget reached; continuing next run");
        result.more = true;
        break;
      }
      const { value: ch, done } = await iter.next();
      if (done) break;
      switch (ch.type) {
        case "upsert":
          if (emitted >= limit * 2) {
            // connector ignored ctx.limit; stop at the last checkpoint
            result.more = true;
            break loop;
          }
          emitted++;
          await applyUpsert(ch.doc);
          break;
        case "delete":
          await markDeleted([ch.externalId]);
          break;
        case "snapshot": {
          const live = new Set(ch.externalIds);
          await markDeleted([...existing.keys()].filter((id) => !live.has(id)));
          break;
        }
        case "cursor":
          result.cursor = ch.cursor;
          cursorDirty = true;
          if (ch.more) result.more = true;
          await o.store.saveCursor(ch.cursor);
          break;
      }
    }
  } finally {
    await iter.return?.();
  }
  if (!cursorDirty && o.full && !result.more) {
    // full run finished without any checkpoint: keep whatever was there
    result.cursor = o.source.cursor ?? {};
  }
  return result;
}
