// Minimal MCP client for the Streamable HTTP transport (JSON-RPC 2.0 over POST, responses as JSON or SSE).
// Only what the SDK needs: initialize, tools/list, tools/call. No server-initiated requests.
import { errorFrom, SupaknowledgeError } from "./http.ts";
import type { FetchLike } from "./types.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolResult {
  content?: { type: string; text?: string; [k: string]: unknown }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpClientOptions {
  endpoint: string;
  headers: () => Promise<Record<string, string>>;
  fetch: FetchLike;
  clientName?: string;
  clientVersion?: string;
  timeoutMs?: number;
}

/** Parse an SSE body and return every JSON-RPC message in it. */
export function parseSse(text: string): JsonRpcResponse[] {
  const out: JsonRpcResponse[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      const msg = JSON.parse(data) as JsonRpcResponse | JsonRpcResponse[];
      out.push(...(Array.isArray(msg) ? msg : [msg]));
    } catch {
      /* ignore non-JSON events */
    }
  }
  return out;
}

export class McpClient {
  private sessionId: string | null = null;
  private protocolVersion = MCP_PROTOCOL_VERSION;
  private init: Promise<void> | null = null;
  private nextId = 1;
  private readonly o: McpClientOptions;

  constructor(opts: McpClientOptions) {
    this.o = opts;
  }

  async listTools(): Promise<{ name: string; description?: string; inputSchema?: unknown }[]> {
    const r = (await this.request("tools/list", {})) as { tools?: { name: string }[] };
    return r?.tools ?? [];
  }

  /** Call a tool and return its structured result (structuredContent, else parsed JSON text, else text). */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const r = (await this.request("tools/call", { name, arguments: args })) as McpToolResult;
    const text = (r?.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
    if (r?.isError) throw new SupaknowledgeError(text || `tool ${name} failed`, { code: "tool_error", details: r });
    if (r?.structuredContent !== undefined && r.structuredContent !== null) return r.structuredContent;
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private ensureInit(): Promise<void> {
    this.init ??= (async () => {
      const r = (await this.send("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: this.o.clientName ?? "supaknowledge-sdk", version: this.o.clientVersion ?? "0.1.0" },
      })) as { protocolVersion?: string };
      if (r?.protocolVersion) this.protocolVersion = r.protocolVersion;
      await this.send("notifications/initialized", undefined, true);
    })().catch((e) => {
      this.init = null;
      throw e;
    });
    return this.init;
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    await this.ensureInit();
    try {
      return await this.send(method, params);
    } catch (e) {
      // session expired on the server: start over once
      if (e instanceof SupaknowledgeError && e.status === 404 && this.sessionId) {
        this.sessionId = null;
        this.init = null;
        await this.ensureInit();
        return this.send(method, params);
      }
      throw e;
    }
  }

  private async send(method: string, params: unknown, notification = false): Promise<unknown> {
    const id = notification ? undefined : this.nextId++;
    const headers: Record<string, string> = {
      ...(await this.o.headers()),
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    if (method !== "initialize") headers["mcp-protocol-version"] = this.protocolVersion;
    const body = JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }), ...(id === undefined ? {} : { id }) });

    const ctl = this.o.timeoutMs && typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(new SupaknowledgeError(`MCP ${method} timed out`)), this.o.timeoutMs) : null;
    let res: Response;
    try {
      res = await this.o.fetch(this.o.endpoint, { method: "POST", headers, body, signal: ctl?.signal });
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (e instanceof SupaknowledgeError) throw e;
      throw new SupaknowledgeError(`network error calling MCP ${method}: ${(e as Error)?.message ?? e}`, { details: e });
    }
    try {
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      if (!res.ok) throw await errorFrom(res);
      if (notification || res.status === 202) return undefined;
      const ct = res.headers.get("content-type") ?? "";
      const text = await res.text();
      const msgs: JsonRpcResponse[] = ct.includes("text/event-stream")
        ? parseSse(text)
        : (() => {
            let parsed: JsonRpcResponse | JsonRpcResponse[];
            try {
              parsed = JSON.parse(text) as JsonRpcResponse | JsonRpcResponse[];
            } catch {
              // a proxy / login page / misrouted URL answered instead of the MCP server
              throw new SupaknowledgeError(
                `MCP ${method}: expected a JSON or SSE response from ${this.o.endpoint}, got ${ct || "no content-type"}: ${text.slice(0, 200)}`,
                { status: res.status, code: "invalid_response", details: text.slice(0, 2000) },
              );
            }
            return Array.isArray(parsed) ? parsed : [parsed];
          })();
      const isMsg = (m: unknown): m is JsonRpcResponse => Boolean(m) && typeof m === "object";
      const msg = msgs.filter(isMsg).find((m) => m.id === id) ?? msgs.filter(isMsg).find((m) => m.result !== undefined || m.error !== undefined);
      if (!msg) throw new SupaknowledgeError(`MCP ${method}: no response`, { status: res.status });
      if (msg.error) throw new SupaknowledgeError(msg.error.message, { code: msg.error.code, details: msg.error.data });
      return msg.result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
