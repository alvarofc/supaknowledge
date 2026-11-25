// OTLP/HTTP JSON -> Supaknowledge trace events (best effort, OpenTelemetry GenAI semantic conventions).
// Pure functions; unit tested in traces/test/otlp.test.ts.

export const ROLES = ["system", "user", "assistant", "tool", "feedback"] as const;
export type Role = (typeof ROLES)[number];

export interface EventIn {
  role: Role;
  content?: string | null;
  tool_name?: string | null;
  tool_input?: unknown;
  tool_output?: unknown;
  is_error?: boolean;
  at?: string | null;
  metadata?: Record<string, unknown>;
}

// deno-lint-ignore no-explicit-any
type AnyValue = any;
interface KeyValue { key: string; value: AnyValue }
interface OtlpEvent { timeUnixNano?: string | number; name?: string; attributes?: KeyValue[] }
export interface OtlpSpan {
  traceId?: string; spanId?: string; parentSpanId?: string; name?: string; kind?: number | string;
  startTimeUnixNano?: string | number; endTimeUnixNano?: string | number;
  attributes?: KeyValue[]; events?: OtlpEvent[]; status?: { code?: number | string; message?: string };
}
export interface OtlpRequest {
  resourceSpans?: { resource?: { attributes?: KeyValue[] }; scopeSpans?: { scope?: { name?: string }; spans?: OtlpSpan[] }[] }[];
}

function anyValue(v: AnyValue): unknown {
  if (!v || typeof v !== "object") return v;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("boolValue" in v) return !!v.boolValue;
  if ("arrayValue" in v) return (v.arrayValue?.values ?? []).map(anyValue);
  if ("kvlistValue" in v) return attrs(v.kvlistValue?.values);
  if ("bytesValue" in v) return v.bytesValue;
  return null;
}

export function attrs(kvs?: KeyValue[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of kvs ?? []) if (kv?.key) out[kv.key] = anyValue(kv.value);
  return out;
}

/** traceId/spanId: hex per the OTLP JSON spec; some exporters send base64. Normalise to lowercase hex. */
export function hexId(id: unknown): string {
  if (typeof id !== "string" || !id) return "";
  if (/^[0-9a-f]+$/i.test(id)) return id.toLowerCase();
  try {
    return [...atob(id)].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  } catch {
    return id;
  }
}

export function nanoToIso(n: unknown): string | null {
  if (n === undefined || n === null || n === "" || n === "0" || n === 0) return null;
  const k = nanoKey(n);
  if (k === 0n) return null;
  try {
    return new Date(Number(k / 1_000_000n)).toISOString();
  } catch {
    return null;
  }
}

/** Sort key for an OTLP unix-nano timestamp (string or number); malformed values sort first instead of throwing. */
export function nanoKey(n: unknown): bigint {
  if (typeof n === "bigint") return n;
  if (typeof n === "number") return Number.isFinite(n) && n >= 0 ? BigInt(Math.trunc(n)) : 0n;
  if (typeof n === "string" && /^\d{1,30}$/.test(n.trim())) return BigInt(n.trim());
  return 0n;
}

export function compareSpans(x: OtlpSpan, y: OtlpSpan): number {
  const a = nanoKey(x.startTimeUnixNano), b = nanoKey(y.startTimeUnixNano);
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

function mapRole(r: unknown): Role {
  const s = String(r ?? "").toLowerCase();
  if (s === "system" || s === "developer") return "system";
  if (s === "user" || s === "human") return "user";
  if (s === "tool" || s === "function" || s === "ipython") return "tool";
  return "assistant";
}

/** Text of a GenAI message in any of the shapes seen in the wild (parts[], content string/array). */
function messageText(m: AnyValue): string {
  if (m == null) return "";
  if (typeof m === "string") return m;
  const parts = Array.isArray(m.parts) ? m.parts : Array.isArray(m.content) ? m.content : null;
  if (parts) {
    return parts.map((p: AnyValue) => {
      if (typeof p === "string") return p;
      if (p?.type === "text" || p?.text || typeof p?.content === "string") return p.text ?? p.content ?? "";
      if (p?.type === "tool_call") return `[tool call ${p.name ?? ""}] ${typeof p.arguments === "string" ? p.arguments : JSON.stringify(p.arguments ?? {})}`;
      if (p?.type === "tool_call_response") return `[tool result] ${typeof p.response === "string" ? p.response : JSON.stringify(p.response ?? null)}`;
      return "";
    }).filter(Boolean).join("\n");
  }
  if (typeof m.content === "string") return m.content;
  if (m.message) return messageText(m.message);
  return "";
}

/**
 * Messages from a GenAI attribute value: a JSON array/object of messages or plain text. Messages without a
 * role (plain strings, role-less objects) get `defaultRole`: "user" for prompts / inputs, "assistant" for
 * completions / outputs, so a correction sent as a plain-string prompt is still a user message.
 */
export function messagesFrom(v: unknown, defaultRole: Role): { role: Role; content: string }[] {
  const parsed = parseMaybeJson(v);
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return list.map((m: AnyValue) => {
    const r = typeof m === "object" && m ? (m.role ?? m.message?.role) : undefined;
    return { role: r === undefined || r === null || r === "" ? defaultRole : mapRole(r), content: messageText(m) };
  }).filter((m) => m.content.trim());
}

/** Legacy indexed attributes: gen_ai.prompt.0.role / gen_ai.prompt.0.content, gen_ai.completion.N.* */
function indexed(a: Record<string, unknown>, prefix: string, defaultRole: Role): { role: Role; content: string }[] {
  const idx = new Set<number>();
  for (const k of Object.keys(a)) {
    const m = new RegExp(`^${prefix.replace(/\./g, "\\.")}\\.(\\d+)\\.`).exec(k);
    if (m) idx.add(Number(m[1]));
  }
  return [...idx].sort((x, y) => x - y).map((i) => ({
    role: a[`${prefix}.${i}.role`] ? mapRole(a[`${prefix}.${i}.role`]) : defaultRole,
    content: String(a[`${prefix}.${i}.content`] ?? ""),
  })).filter((m) => m.content.trim());
}

export interface Mapped { events: (EventIn & { key: string; t: number })[]; meta: Record<string, unknown> }

export function mapSpan(span: OtlpSpan, out: Mapped) {
  const a = attrs(span.attributes);
  const start = nanoToIso(span.startTimeUnixNano);
  const end = nanoToIso(span.endTimeUnixNano) ?? start;
  const t0 = start ? Date.parse(start) : 0;
  const t1 = end ? Date.parse(end) : t0;
  const sid = hexId(span.spanId);
  const op = String(a["gen_ai.operation.name"] ?? "");
  const statusCode = String(span.status?.code ?? "");
  const isErr = statusCode === "2" || statusCode === "STATUS_CODE_ERROR" || !!a["error.type"];
  let n = 0;
  const push = (e: EventIn, t: number, key: string) => out.events.push({ ...e, t: t + n++ * 1e-3, key });

  for (const k of ["gen_ai.system", "gen_ai.provider.name", "gen_ai.request.model", "gen_ai.agent.name", "gen_ai.conversation.id"]) {
    if (a[k] !== undefined && out.meta[k] === undefined) out.meta[k] = a[k];
  }

  // tool executions
  const toolName = a["gen_ai.tool.name"];
  if (op === "execute_tool" || (toolName && !a["gen_ai.input.messages"])) {
    push({
      role: "tool",
      tool_name: String(toolName ?? span.name ?? "tool"),
      tool_input: parseMaybeJson(a["gen_ai.tool.call.arguments"] ?? a["gen_ai.tool.input"] ?? null),
      tool_output: parseMaybeJson(a["gen_ai.tool.call.result"] ?? a["gen_ai.tool.output"] ?? null),
      is_error: isErr,
      content: isErr ? (span.status?.message || String(a["error.type"] ?? "error")) : null,
      at: end,
      metadata: { span_id: sid, ...(a["gen_ai.tool.call.id"] ? { tool_call_id: a["gen_ai.tool.call.id"] } : {}) },
    }, t1, `span:${sid}`);
    return;
  }

  // chat / inference spans: inputs at start, outputs at end. Inputs repeat the whole history on every
  // call, so events are de-duplicated by content later.
  const inputs = [
    ...messagesFrom(a["gen_ai.input.messages"], "user"),
    ...(a["gen_ai.system_instructions"] ? messagesFrom(a["gen_ai.system_instructions"], "system").map((m) => ({ ...m, role: "system" as Role })) : []),
    ...(typeof a["gen_ai.prompt"] === "string" ? messagesFrom(a["gen_ai.prompt"], "user") : []),
    ...indexed(a, "gen_ai.prompt", "user"),
  ];
  const outputs = [
    ...messagesFrom(a["gen_ai.output.messages"], "assistant").map((m) => ({ ...m, role: "assistant" as Role })),
    ...(typeof a["gen_ai.completion"] === "string" ? messagesFrom(a["gen_ai.completion"], "assistant") : []),
    ...indexed(a, "gen_ai.completion", "assistant"),
  ];

  // span events (older semconv: gen_ai.user.message, gen_ai.choice, gen_ai.content.prompt ...)
  for (const ev of span.events ?? []) {
    const ea = attrs(ev.attributes);
    const at = nanoToIso(ev.timeUnixNano) ?? start;
    const t = at ? Date.parse(at) : t0;
    const name = ev.name ?? "";
    let msgs: { role: Role; content: string }[] = [];
    if (name === "gen_ai.content.prompt") msgs = messagesFrom(ea["gen_ai.prompt"], "user");
    else if (name === "gen_ai.content.completion") msgs = messagesFrom(ea["gen_ai.completion"], "assistant").map((m) => ({ ...m, role: "assistant" as Role }));
    else if (name === "gen_ai.client.inference.operation.details") {
      msgs = [...messagesFrom(ea["gen_ai.input.messages"], "user"), ...messagesFrom(ea["gen_ai.output.messages"], "assistant").map((m) => ({ ...m, role: "assistant" as Role }))];
    } else if (/^gen_ai\.(system|user|assistant|tool)\.message$/.test(name) || name === "gen_ai.choice") {
      const role = name === "gen_ai.choice" ? "assistant" : mapRole(name.split(".")[1]);
      const c = ea["content"] ?? ea["gen_ai.event.content"] ?? ea["message"];
      const text = typeof c === "string" ? (messagesFrom(c, role)[0]?.content ?? c) : messageText(c);
      if (text) msgs = [{ role, content: text }];
    } else if (name === "exception") {
      push({ role: "tool", tool_name: span.name ?? "exception", is_error: true, content: String(ea["exception.message"] ?? ea["exception.type"] ?? "exception"), at, metadata: { span_id: sid } }, t, `exc:${sid}:${t}`);
    }
    for (const m of msgs) push({ role: m.role, content: m.content, at, metadata: { span_id: sid } }, t, `msg:${m.role}:${m.content}`);
  }

  for (const m of inputs) push({ role: m.role, content: m.content, at: start, metadata: { span_id: sid } }, t0, `msg:${m.role}:${m.content}`);
  for (const m of outputs) push({ role: m.role, content: m.content, at: end, metadata: { span_id: sid } }, t1, `msg:${m.role}:${m.content}`);
}


/** Max serialized size of one event's tool_input / tool_output / metadata. */
export const MAX_PAYLOAD = 100_000;

/**
 * Bound a JSON payload: values whose JSON is larger than `max` are replaced by a marker object with a text
 * preview, so a single huge tool result cannot bloat trace_events (2,000 events per request).
 */
export function clipPayload(v: unknown, max = MAX_PAYLOAD): unknown {
  if (v === undefined || v === null) return null;
  let text: string;
  try {
    text = JSON.stringify(v) ?? "null";
  } catch {
    return { truncated: true, reason: "not JSON-serializable" };
  }
  if (text.length <= max) return v;
  return { truncated: true, original_bytes: text.length, preview: text.slice(0, Math.max(0, max - 200)) };
}

/** Group slugs from `?audience=a,b` (repeatable) or `x-supaknowledge-audience: a, b`; undefined when absent. */
export function audienceParam(url: URL, headers: Headers): string[] | undefined {
  const fromQuery = url.searchParams.getAll("audience");
  const raw = fromQuery.length ? fromQuery : headers.has("x-supaknowledge-audience") ? [headers.get("x-supaknowledge-audience") ?? ""] : null;
  if (!raw) return undefined;
  return [...new Set(raw.flatMap((r) => r.split(",")).map((s) => s.trim()).filter(Boolean))];
}
