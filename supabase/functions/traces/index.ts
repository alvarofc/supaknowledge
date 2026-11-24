// Agent trace ingest. Everything is written through the caller's RLS client, so principal_id is always
// the authenticated agent/user and a sender can only append to its own traces.
//
//   POST  /traces                 simple JSON shape (idempotent on external_id: appends events)
//   PATCH /traces/:id             set outcome / ended_at / name / metadata / audience, append events
//   POST  /traces/otlp?space=...  OTLP/HTTP JSON (ExportTraceServiceRequest) with GenAI semantic conventions
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { authenticate, type Caller } from "../_shared/auth.ts";
import { handler, HttpError, json, readJson } from "../_shared/http.ts";
import { dbError, isUuid, must, resolveGroups, resolveSpace, type SpaceInfo, subpath } from "../_lib/api.ts";
import {
  attrs,
  audienceParam,
  clipPayload,
  compareSpans,
  type EventIn,
  hexId,
  type Mapped,
  mapSpan,
  nanoToIso,
  type OtlpRequest,
  type OtlpSpan,
  ROLES,
} from "./otlp.ts";

const OUTCOMES = ["unknown", "success", "failure", "corrected"] as const;
type Outcome = (typeof OUTCOMES)[number];

const MAX_EVENTS = 2000;
const MAX_CONTENT = 100_000;
/** page size for reading stored events (<= PostgREST api.max_rows) and how many we compare against */
const EVENTS_PAGE = 1000;
const MAX_DEDUP_EVENTS = 50_000;

interface TraceIn {
  space?: string;
  external_id?: string | null;
  name?: string | null;
  outcome?: Outcome;
  on_behalf_of?: string | null;
  metadata?: Record<string, unknown>;
  started_at?: string | null;
  ended_at?: string | null;
  audience?: string[];
  events?: EventIn[];
}

// ---------------------------------------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------------------------------------
function ts(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw new HttpError(400, `${field} must be an RFC 3339 timestamp`);
  return new Date(v).toISOString();
}

function clip(s: unknown): string | null {
  if (s === undefined || s === null) return null;
  const t = typeof s === "string" ? s : JSON.stringify(s);
  return t.length > MAX_CONTENT ? t.slice(0, MAX_CONTENT) + "\n…[truncated]" : t;
}

function validateEvents(events: unknown): EventIn[] {
  if (events === undefined || events === null) return [];
  if (!Array.isArray(events)) throw new HttpError(400, "events must be an array");
  if (events.length > MAX_EVENTS) throw new HttpError(413, `at most ${MAX_EVENTS} events per request`);
  return events.map((e, i) => {
    if (!e || typeof e !== "object") throw new HttpError(400, `events[${i}] must be an object`);
    if (!ROLES.includes(e.role)) throw new HttpError(400, `events[${i}].role must be one of ${ROLES.join(", ")}`);
    if (e.metadata !== undefined && (typeof e.metadata !== "object" || e.metadata === null || Array.isArray(e.metadata))) throw new HttpError(400, `events[${i}].metadata must be an object`);
    if (e.tool_name != null && (typeof e.tool_name !== "string" || e.tool_name.length > 200)) throw new HttpError(400, `events[${i}].tool_name must be a string (max 200)`);
    return { ...e, at: ts(e.at, `events[${i}].at`) ?? null };
  });
}

function validateTrace(b: TraceIn, partial: boolean) {
  if (b.outcome !== undefined && !OUTCOMES.includes(b.outcome)) throw new HttpError(400, `outcome must be one of ${OUTCOMES.join(", ")}`);
  if (b.on_behalf_of != null && !isUuid(b.on_behalf_of)) throw new HttpError(400, "on_behalf_of must be a user id (uuid)");
  if (b.metadata !== undefined && (typeof b.metadata !== "object" || b.metadata === null || Array.isArray(b.metadata))) throw new HttpError(400, "metadata must be an object");
  if (b.external_id != null && (typeof b.external_id !== "string" || !b.external_id.trim() || b.external_id.length > 256)) {
    throw new HttpError(400, "external_id must be a non-empty string (max 256)");
  }
  if (!partial && !b.space) throw new HttpError(400, "space is required (uuid or \"<workspace>/<space>\")");
}

// ---------------------------------------------------------------------------------------------------------
// writes (all through caller.db)
// ---------------------------------------------------------------------------------------------------------
async function appendEvents(caller: Caller, traceId: string, spaceId: string, events: EventIn[]): Promise<number> {
  if (!events.length) return 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const last = must(
      await caller.db.from("trace_events").select("seq").eq("trace_id", traceId).order("seq", { ascending: false }).limit(1),
      "read events",
    ) as { seq: number }[];
    const base = (last[0]?.seq ?? -1) + 1;
    // every row carries `at`: in a bulk insert PostgREST sends null (not the column default) for keys that only
    // some rows have, which violates NOT NULL when one event lacks a timestamp
    const now = new Date().toISOString();
    const rows = events.map((e, i) => ({
      trace_id: traceId,
      space_id: spaceId,
      seq: base + i,
      role: e.role,
      content: clip(e.content),
      tool_name: e.tool_name ?? null,
      tool_input: clipPayload(e.tool_input),
      tool_output: clipPayload(e.tool_output),
      is_error: !!e.is_error,
      metadata: (clipPayload(e.metadata ?? {}) ?? {}) as Record<string, unknown>,
      at: e.at || now,
    }));
    const { error } = await caller.db.from("trace_events").insert(rows);
    if (!error) return rows.length;
    if (error.code !== "23505") throw dbError(error, "append events"); // concurrent append: retry with a new base
  }
  throw new HttpError(409, "could not append events (concurrent writers); retry");
}

interface UpsertResult {
  trace_id: string;
  created: boolean;
  appended: number;
}

/** Create a trace, or (same space + external_id, owned by the caller) update it and append events. */
async function upsertTrace(caller: Caller, space: SpaceInfo, b: TraceIn, events: EventIn[], audience: string[] | undefined): Promise<UpsertResult> {
  const fields: Record<string, unknown> = {};
  if (b.name !== undefined) fields.name = b.name;
  if (b.outcome !== undefined) fields.outcome = b.outcome;
  if (b.on_behalf_of !== undefined) fields.on_behalf_of = b.on_behalf_of;
  if (b.started_at) fields.started_at = ts(b.started_at, "started_at");
  if (b.ended_at) fields.ended_at = ts(b.ended_at, "ended_at");
  if (audience !== undefined) fields.audience = audience;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (b.external_id) {
      const found = must(
        await caller.db.from("traces").select("id, principal_id, metadata").eq("space_id", space.id).eq("external_id", b.external_id).limit(1),
        "find trace",
      ) as { id: string; principal_id: string | null; metadata: Record<string, unknown> }[];
      const t = found[0];
      if (t) {
        if (t.principal_id !== caller.userId) throw new HttpError(409, "a trace with this external_id was sent by someone else");
        const upd = { ...fields, ...(b.metadata ? { metadata: { ...t.metadata, ...b.metadata } } : {}) };
        if (Object.keys(upd).length) must(await caller.db.from("traces").update(upd).eq("id", t.id), "update trace");
        return { trace_id: t.id, created: false, appended: await appendEvents(caller, t.id, space.id, events) };
      }
    }
    const ins = await caller.db.from("traces").insert({
      space_id: space.id,
      principal_id: caller.userId,
      external_id: b.external_id ?? null,
      metadata: b.metadata ?? {},
      ...fields,
    }).select("id").single();
    if (ins.error) {
      // someone (likely ourselves, concurrently) created the same external_id: go round again and append.
      // If the existing row belongs to another principal it is invisible to us and we report a conflict.
      if (ins.error.code === "23505" && b.external_id && attempt === 0) continue;
      if (ins.error.code === "23505") throw new HttpError(409, "a trace with this external_id already exists in this space");
      throw dbError(ins.error, "create trace");
    }
    const id = (ins.data as { id: string }).id;
    return { trace_id: id, created: true, appended: await appendEvents(caller, id, space.id, events) };
  }
  throw new HttpError(409, "could not create trace");
}

// ---------------------------------------------------------------------------------------------------------
// JSON routes
// ---------------------------------------------------------------------------------------------------------
async function postTrace(req: Request): Promise<Response> {
  const caller = await authenticate(req);
  const b = await readJson<TraceIn>(req);
  validateTrace(b, false);
  const events = validateEvents(b.events);
  const space = await resolveSpace(caller.db, b.space);
  const audience = b.audience !== undefined ? await resolveGroups(caller.db, space.workspace_id, b.audience) : undefined;
  const r = await upsertTrace(caller, space, b, events, audience);
  return json(r, r.created ? 201 : 200);
}

async function patchTrace(req: Request, id: string): Promise<Response> {
  const caller = await authenticate(req);
  if (!isUuid(id)) throw new HttpError(400, "invalid trace id");
  const b = await readJson<TraceIn>(req);
  validateTrace(b, true);
  const events = validateEvents(b.events);
  const rows = must(
    await caller.db.from("traces").select("id, space_id, principal_id, metadata, spaces(workspace_id)").eq("id", id).limit(1),
    "load trace",
  ) as { id: string; space_id: string; principal_id: string; metadata: Record<string, unknown>; spaces: { workspace_id: string } | { workspace_id: string }[] }[];
  const t = rows[0];
  if (!t || t.principal_id !== caller.userId) throw new HttpError(404, "trace not found (you can only update traces you sent)");
  const upd: Record<string, unknown> = {};
  if (b.name !== undefined) upd.name = b.name;
  if (b.outcome !== undefined) upd.outcome = b.outcome;
  if (b.on_behalf_of !== undefined) upd.on_behalf_of = b.on_behalf_of;
  if (b.ended_at !== undefined) upd.ended_at = ts(b.ended_at, "ended_at") ?? null;
  if (b.started_at) upd.started_at = ts(b.started_at, "started_at");
  if (b.metadata) upd.metadata = { ...t.metadata, ...b.metadata };
  if (b.audience !== undefined) {
    const ws = Array.isArray(t.spaces) ? t.spaces[0]?.workspace_id : t.spaces?.workspace_id;
    upd.audience = await resolveGroups(caller.db, ws, b.audience);
  }
  if (Object.keys(upd).length) must(await caller.db.from("traces").update(upd).eq("id", id), "update trace");
  const appended = await appendEvents(caller, id, t.space_id, events);
  return json({ trace_id: id, created: false, appended });
}

// ---------------------------------------------------------------------------------------------------------
// OTLP/HTTP JSON -> traces (mapping in ./otlp.ts)
// ---------------------------------------------------------------------------------------------------------
async function postOtlp(req: Request): Promise<Response> {
  const caller = await authenticate(req);
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("json")) {
    throw new HttpError(415, "only OTLP/HTTP JSON is supported; set OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json");
  }
  const params = new URL(req.url).searchParams;
  const space = await resolveSpace(caller.db, params.get("space") ?? req.headers.get("x-supaknowledge-space"));
  // optional audience (group slugs) for every trace in this export: ?audience=finance or x-supaknowledge-audience
  const wantedAudience = audienceParam(new URL(req.url), req.headers);
  const audience = wantedAudience === undefined ? undefined : await resolveGroups(caller.db, space.workspace_id, wantedAudience);
  const body = await readJson<OtlpRequest>(req);

  // group spans by trace id
  const groups = new Map<string, { spans: OtlpSpan[]; resource: Record<string, unknown> }>();
  let total = 0;
  for (const rs of body.resourceSpans ?? []) {
    const resource = attrs(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? []) {
      for (const sp of ss.spans ?? []) {
        const tid = hexId(sp.traceId);
        if (!tid) continue;
        total++;
        if (!groups.has(tid)) groups.set(tid, { spans: [], resource });
        groups.get(tid)!.spans.push(sp);
      }
    }
  }

  const results: { external_id: string; trace_id?: string; created?: boolean; appended?: number; error?: string }[] = [];
  let rejected = 0;
  for (const [tid, g] of groups) {
    try {
      const spans = [...g.spans].sort(compareSpans);
      const mapped: Mapped = { events: [], meta: {} };
      for (const sp of spans) mapSpan(sp, mapped);
      mapped.events.sort((x, y) => x.t - y.t);

      // de-duplicate within the batch and against events already stored for this trace
      const seen = new Set<string>();
      const existing = must(
        await caller.db.from("traces").select("id").eq("space_id", space.id).eq("external_id", tid).eq("principal_id", caller.userId).limit(1),
        "find trace",
      ) as { id: string }[];
      if (existing[0]) {
        // page through every stored event: PostgREST caps a single select at api.max_rows (1,000)
        const prev: { role: string; content: string | null; metadata: Record<string, unknown> }[] = [];
        for (let from = 0; ; from += EVENTS_PAGE) {
          const page = must(
            await caller.db.from("trace_events").select("role, content, metadata").eq("trace_id", existing[0].id).order("seq").range(from, from + EVENTS_PAGE - 1),
            "read events",
          ) as typeof prev;
          prev.push(...page);
          if (page.length < EVENTS_PAGE || prev.length >= MAX_DEDUP_EVENTS) break;
        }
        for (const e of prev) {
          if (e.content) seen.add(`msg:${e.role}:${e.content}`);
          if (e.role === "tool" && e.metadata?.span_id) seen.add(`span:${e.metadata.span_id}`);
        }
      }
      // tool results echoed in chat history duplicate real execute_tool spans: keep the spans
      const hasToolSpans = mapped.events.some((e) => e.role === "tool" && e.tool_name) || [...seen].some((k) => k.startsWith("span:"));
      const events: EventIn[] = [];
      for (const e of mapped.events) {
        if (seen.has(e.key)) continue;
        if (hasToolSpans && e.role === "tool" && !e.tool_name) continue;
        seen.add(e.key);
        const { key: _k, t: _t, ...ev } = e;
        events.push(ev);
      }

      const root = spans.find((s) => !s.parentSpanId || !hexId(s.parentSpanId));
      const rootStatus = String(root?.status?.code ?? "");
      const starts = spans.map((s) => nanoToIso(s.startTimeUnixNano)).filter(Boolean) as string[];
      const ends = spans.map((s) => nanoToIso(s.endTimeUnixNano)).filter(Boolean) as string[];
      const rootAttrs = attrs(root?.attributes);
      const trace: TraceIn = {
        external_id: tid,
        name: root ? String(rootAttrs["gen_ai.agent.name"] ?? root.name ?? "") || null : undefined,
        started_at: starts.sort()[0],
        ended_at: root ? ends.sort().reverse()[0] : undefined,
        outcome: root ? (rootStatus === "2" || rootStatus === "STATUS_CODE_ERROR" ? "failure" : rootStatus === "1" || rootStatus === "STATUS_CODE_OK" ? "success" : undefined) : undefined,
        metadata: {
          source: "otlp",
          ...(g.resource["service.name"] ? { "service.name": g.resource["service.name"] } : {}),
          ...mapped.meta,
        },
      };
      const r = await upsertTrace(caller, space, trace, events.slice(0, MAX_EVENTS), audience);
      results.push({ external_id: tid, ...r });
    } catch (e) {
      rejected += g.spans.length;
      results.push({ external_id: tid, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return json({
    partialSuccess: rejected ? { rejectedSpans: String(rejected), errorMessage: results.filter((r) => r.error).map((r) => `${r.external_id}: ${r.error}`).join("; ") } : {},
    spans: total,
    traces: results,
  });
}

Deno.serve(handler(async (req) => {
  const path = subpath(req, "traces");
  if (req.method === "POST" && path === "/") return await postTrace(req);
  if (req.method === "POST" && (path === "/otlp" || path === "/otlp/v1/traces" || path === "/v1/traces")) return await postOtlp(req);
  const m = /^\/([^/]+)$/.exec(path);
  if (req.method === "PATCH" && m) return await patchTrace(req, m[1]);
  throw new HttpError(404, `no route for ${req.method} ${path}`);
}));
