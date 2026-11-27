// Records Ask conversations through the `traces` Edge Function with the person's access token, in the same event
// format the SDK's TraceRecorder sends: one trace per conversation (external_id "studio-ask:<id>"), one batch of
// events per question. The curator mines these traces like any agent's (user corrections after an answer, failed
// tool calls, flags linked to the trace).
import type { AskToolCall } from "../../lib/ask.ts";
import type { FetchLike } from "./mcp.server.ts";

export interface TraceEvent {
  role: "user" | "assistant" | "tool";
  content?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: unknown;
  is_error?: boolean;
  metadata?: Record<string, unknown>;
  at: string;
}

/** What happened in one turn, in order: text the model wrote between tool calls, and the tool calls. */
export type TimelineItem = { kind: "text"; text: string; at: string } | { kind: "tool"; call: AskToolCall; at: string };

/** The trace events for one question: the question, then the agent's text and tool calls in the order they happened. */
export function turnEvents(question: { content: string; at: string }, timeline: readonly TimelineItem[], meta: Record<string, unknown> = {}): TraceEvent[] {
  const events: TraceEvent[] = [{ role: "user", content: question.content, at: question.at }];
  for (const item of timeline) {
    if (item.kind === "text") {
      if (item.text.trim()) events.push({ role: "assistant", content: item.text, at: item.at, ...(Object.keys(meta).length ? { metadata: meta } : {}) });
    } else {
      events.push({
        role: "tool",
        tool_name: item.call.name,
        tool_input: item.call.input,
        tool_output: item.call.output,
        is_error: item.call.isError,
        metadata: { tool_call_id: item.call.id },
        at: item.at,
      });
    }
  }
  return events;
}

export class TraceError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface TraceClientOptions {
  /** `<project>/functions/v1/traces` */
  endpoint: string;
  accessToken: string;
  publishableKey?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class TraceClient {
  private readonly o: TraceClientOptions;

  constructor(opts: TraceClientOptions) {
    this.o = opts;
  }

  /**
   * Create the conversation's trace, or find it again (POST is idempotent on external_id and appends nothing here).
   * Resolves to the trace id.
   */
  async ensure(body: { space: string; externalId: string; name?: string; metadata?: Record<string, unknown> }): Promise<string> {
    const r = await this.send<{ trace_id?: unknown }>("POST", "", {
      space: body.space,
      external_id: body.externalId,
      ...(body.name ? { name: body.name } : {}),
      ...(body.metadata ? { metadata: body.metadata } : {}),
      events: [],
    });
    if (typeof r?.trace_id !== "string") throw new TraceError("the traces function returned no trace id", 0);
    return r.trace_id;
  }

  /** Append events to the trace, and narrow its audience first when `audience` (group ids) is given. */
  async append(traceId: string, events: TraceEvent[], audience?: string[]): Promise<void> {
    await this.send("PATCH", `/${encodeURIComponent(traceId)}`, { events, ...(audience !== undefined ? { audience } : {}) });
  }

  private async send<T>(method: string, path: string, body: unknown): Promise<T> {
    const f = this.o.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.o.endpoint.replace(/\/$/, "")}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.o.accessToken}`,
          ...(this.o.publishableKey ? { apikey: this.o.publishableKey } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
      });
    } catch (e) {
      throw new TraceError(`Could not reach the traces function (${(e as Error)?.message ?? e}).`, 0);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg = json && typeof json === "object" && "error" in json ? String((json).error) : text.slice(0, 300) || res.statusText;
      if (res.status === 404 && !path) throw new TraceError(`The traces function is not available (404): ${msg}`, 404);
      throw new TraceError(`traces ${method} failed (${res.status}): ${msg}`, res.status);
    }
    return json as T;
  }
}
