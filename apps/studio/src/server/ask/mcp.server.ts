// A small client for the `mcp` Edge Function, used by the Ask page with the signed-in person's access token, so the
// agent gets exactly what an MCP client gets: the same tool list, descriptions, input schemas and result text, under
// the person's RLS. The server is stateless (no session id), so every call is one JSON-RPC POST.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  /** the text content the server returned (what an MCP client hands its model) */
  text: string;
  isError: boolean;
}

export class McpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** JSON-RPC messages in a Streamable HTTP response body (SSE `data:` lines or plain JSON). */
export function parseRpcBody(text: string, contentType: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const push = (v: unknown) => {
    for (const m of Array.isArray(v) ? v : [v]) if (m && typeof m === "object") out.push(m as Record<string, unknown>);
  };
  if (!contentType.includes("text/event-stream")) {
    try {
      push(JSON.parse(text));
    } catch {
      /* not JSON: no messages */
    }
    return out;
  }
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      push(JSON.parse(data));
    } catch {
      /* ignore non-JSON events */
    }
  }
  return out;
}

export interface McpClientOptions {
  /** `<project>/functions/v1/mcp` */
  endpoint: string;
  /** "<workspace>/<space>": every call is scoped to this space, as with `?space=` in an MCP client's URL */
  space: string;
  accessToken: string;
  publishableKey?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class McpClient {
  private nextId = 1;
  private readonly o: McpClientOptions;
  private readonly url: string;

  constructor(opts: McpClientOptions) {
    this.o = opts;
    this.url = `${opts.endpoint.replace(/\/$/, "")}?space=${encodeURIComponent(opts.space)}`;
  }

  /** The server's instructions for agents (sent on initialize). */
  async instructions(): Promise<string> {
    const r = (await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "supaknowledge-studio-ask", version: "0.1.0" },
    })) as { instructions?: unknown };
    return typeof r?.instructions === "string" ? r.instructions : "";
  }

  async listTools(): Promise<McpTool[]> {
    const r = (await this.request("tools/list", {})) as { tools?: unknown };
    if (!Array.isArray(r?.tools)) return [];
    return r.tools
      .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object" && typeof (t as { name?: unknown }).name === "string")
      .map((t) => ({
        name: t.name as string,
        description: typeof t.description === "string" ? t.description : "",
        inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? (t.inputSchema as Record<string, unknown>) : { type: "object", properties: {} },
      }));
  }

  /** Call a tool. A tool-level failure (isError) is a result, not an exception, exactly as an MCP client sees it. */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const r = (await this.request("tools/call", { name, arguments: args }, signal)) as { content?: unknown; isError?: unknown };
    const parts = Array.isArray(r?.content) ? (r.content as { type?: unknown; text?: unknown }[]) : [];
    const text = parts
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n");
    return { text, isError: r?.isError === true };
  }

  private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const f = this.o.fetch ?? fetch;
    const timeout = AbortSignal.timeout(this.o.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await f(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.o.accessToken}`,
          ...(this.o.publishableKey ? { apikey: this.o.publishableKey } : {}),
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(method === "initialize" ? {} : { "mcp-protocol-version": "2025-06-18" }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new McpError(`Could not reach the mcp function (${(e as Error)?.message ?? e}). Is it deployed, or is \`supabase functions serve\` running?`, 0);
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { error?: unknown; message?: unknown };
        msg = String(j.error ?? j.message ?? msg);
      } catch {
        /* keep the raw text */
      }
      if (res.status === 404) throw new McpError(`The mcp function is not available (404): ${msg}`, 404);
      throw new McpError(`mcp ${method} failed (${res.status}): ${msg}`, res.status);
    }
    const msgs = parseRpcBody(text, res.headers.get("content-type") ?? "");
    const msg = msgs.find((m) => m.id === id) ?? msgs.find((m) => "result" in m || "error" in m);
    if (!msg) throw new McpError(`mcp ${method}: no response`, res.status);
    if (msg.error && typeof msg.error === "object") throw new McpError(`mcp ${method}: ${String((msg.error as { message?: unknown }).message)}`, res.status);
    return msg.result;
  }
}

/** Arguments the Ask route sets itself on every call, so they are hidden from the model's view of the tools. */
export const SERVER_ARGS = ["space", "trace_id"] as const;

/** A tool's JSON Schema without the server-set arguments (and the `$schema` key some model providers reject). */
export function modelInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema;
  const props = rest.properties && typeof rest.properties === "object" ? { ...(rest.properties as Record<string, unknown>) } : {};
  for (const k of SERVER_ARGS) delete props[k];
  const required = Array.isArray(rest.required) ? (rest.required as unknown[]).filter((k) => !SERVER_ARGS.includes(k as (typeof SERVER_ARGS)[number])) : undefined;
  return { ...rest, type: "object", properties: props, ...(required ? { required } : {}) };
}

/** Tools the Ask agent gets: every MCP tool except list_spaces (the page is scoped to one space). */
export function askTools(tools: McpTool[]): McpTool[] {
  return tools.filter((t) => t.name !== "list_spaces").map((t) => ({ ...t, inputSchema: modelInputSchema(t.inputSchema) }));
}

/** The arguments sent to the server: the model's, with `space` and `trace_id` set by the route. */
export function serverArgs(input: unknown, traceId: string | null): Record<string, unknown> {
  const args = input && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
  for (const k of SERVER_ARGS) delete args[k];
  if (traceId) args.trace_id = traceId;
  return args;
}
