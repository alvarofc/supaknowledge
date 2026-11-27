// Schema connector: the schema of an application database on Supabase, as source documents the curator can cite.
//
// It runs ONE read-only catalog query through the Supabase Management API
// (POST https://api.supabase.com/v1/projects/{ref}/database/query) with an access token stored in Vault, and
// renders one overview document per schema plus one document per table or view (columns, types, comments,
// keys, RLS policies, view definitions; function signatures in the overview). Why the Management API and not a
// connection string: the request is plain HTTPS to one fixed host, so it goes through the same outbound guard
// as every other connector (lib/net-guard.ts) and the token can only ever reach api.supabase.com, while a
// Postgres connection would be a raw TCP socket to an admin-chosen host that the guard cannot see.
//
// The snapshot is also returned as the cursor (`cursor.snapshot`); index.ts compares it with the previous one
// after the documents are written and records schema drift flags (lib/schema-drift.ts).
import { sha256 } from "../../_shared/core/chunk.ts";
import { parseSchemaSnapshot, renderSchemaDocuments, SCHEMA_NAME_RE, schemaSnapshotSql } from "../../_shared/core/schema.ts";
import { readJson, readText, request } from "./http.ts";
import { asObject, AuthError, type Connector, ConfigError, stringList, UpstreamError } from "./types.ts";

export const MANAGEMENT_API = "https://api.supabase.com";
const REF_RE = /^[a-z]{20}$/;

export interface SchemaConfig {
  project_ref: string;
  schemas: string[];
}

/** A project ref, or a project URL (`https://<ref>.supabase.co`, a dashboard link). */
export function normaliseProjectRef(v: string): string | null {
  const s = v.trim();
  if (REF_RE.test(s)) return s;
  const m = /^https:\/\/([a-z]{20})\.supabase\.co\/?$/.exec(s) ?? /^https:\/\/supabase\.com\/dashboard\/project\/([a-z]{20})(?:[/?#].*)?$/.exec(s);
  return m ? m[1]! : null;
}

export const schema: Connector<SchemaConfig> = {
  kind: "schema",
  parseConfig(raw) {
    const o = asObject(raw);
    if (typeof o.project_ref !== "string" || !o.project_ref.trim()) throw new ConfigError("config.project_ref is required (the 20-letter project ref)");
    const ref = normaliseProjectRef(o.project_ref);
    if (!ref) throw new ConfigError("config.project_ref must be a Supabase project ref (20 lowercase letters) or the project URL");
    const schemas = o.schemas === undefined || o.schemas === null ? ["public"] : stringList(o, "schemas", { required: true });
    const bad = schemas.find((s) => !SCHEMA_NAME_RE.test(s));
    if (bad !== undefined) throw new ConfigError(`config.schemas: "${bad}" is not a plain schema name`);
    if (schemas.length > 20) throw new ConfigError("config.schemas: at most 20 schemas");
    return { project_ref: ref, schemas: [...new Set(schemas)].sort() };
  },

  async *sync(ctx) {
    if (!ctx.token) throw new ConfigError("no access token: store a Supabase access token as the source secret (kf sources secret <name>)");
    const url = `${MANAGEMENT_API}/v1/projects/${ctx.config.project_ref}/database/query`;
    const res = await request(ctx, url, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query: schemaSnapshotSql(ctx.config.schemas), read_only: true }),
    });
    if (!res.ok) {
      const body = (await readText(res, 64 * 1024).catch(() => "")).slice(0, 300);
      if (res.status === 401) throw new AuthError(`Supabase Management API rejected the access token (401) ${body}`);
      if (res.status === 403) throw new AuthError(`the access token cannot query project ${ctx.config.project_ref} (403) ${body}`);
      if (res.status === 404) throw new ConfigError(`project ${ctx.config.project_ref} not found, or the token's account cannot see it (404)`);
      if (res.status === 400) throw new ConfigError(`the schema query failed on project ${ctx.config.project_ref}: ${body}`);
      throw new UpstreamError(res.status, `POST ${MANAGEMENT_API}/v1/projects/…/database/query: HTTP ${res.status} ${body}`);
    }
    const rows = await readJson<unknown>(res, undefined, "schema query");
    const first = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined;
    if (!first || first.snapshot === undefined || first.snapshot === null) throw new UpstreamError(200, "schema query: unexpected response shape");
    let snapshot;
    try {
      snapshot = parseSchemaSnapshot(first.snapshot);
    } catch (e) {
      throw new UpstreamError(200, e instanceof Error ? e.message : String(e));
    }

    const docs = renderSchemaDocuments(snapshot);
    let emitted = 0;
    for (const d of docs) {
      const prev = ctx.previous(d.externalId);
      // one query returns everything: skip documents whose markdown did not change so they do not count
      // against the per-run cap
      if (prev && !prev.deleted && prev.contentHash === await sha256(d.content)) continue;
      if (emitted >= ctx.limit) {
        // the rest on the next run; index.ts keeps the previous snapshot until a run completes
        yield { type: "cursor", cursor: {}, more: true };
        return;
      }
      emitted++;
      yield {
        type: "upsert",
        doc: {
          externalId: d.externalId,
          title: d.title,
          content: d.content,
          mimeType: "text/markdown",
          metadata: { project_ref: ctx.config.project_ref },
        },
      };
    }
    // dropped tables and emptied schemas lose their documents
    yield { type: "snapshot", externalIds: docs.map((d) => d.externalId) };
    yield { type: "cursor", cursor: { project_ref: ctx.config.project_ref, schemas: ctx.config.schemas, snapshot } };
  },
};
