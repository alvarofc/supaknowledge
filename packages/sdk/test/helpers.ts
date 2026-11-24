// A scripted fetch for tests: routes by method + URL substring and records every call.
export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

export type Route = (call: Call) => Response | Promise<Response> | undefined;

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

export function sse(data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(data)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

export function mockFetch(routes: Route[]) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    let body: any = init.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep text */
      }
    }
    const call: Call = { method: (init.method ?? "GET").toUpperCase(), url: String(input), headers, body };
    calls.push(call);
    for (const r of routes) {
      const res = await r(call);
      if (res) return res;
    }
    return json({ message: `no mock for ${call.method} ${call.url}` }, 599);
  };
  return { fetch, calls };
}

/** MCP server mock: initialize -> session, notifications -> 202, tools/call -> handler(name, args). */
export function mcpRoute(tool: (name: string, args: any) => unknown, opts: { sseResponses?: boolean } = {}): Route {
  return (c) => {
    if (!c.url.includes("/functions/v1/mcp")) return undefined;
    const msg = c.body;
    if (msg.method === "initialize") {
      return json({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "supaknowledge" } } }, 200, { "mcp-session-id": "sess-1" });
    }
    if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (msg.method === "tools/call") {
      let result: unknown;
      try {
        const out = tool(msg.params.name, msg.params.arguments);
        result = { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }] };
      } catch (e) {
        result = { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
      const payload = { jsonrpc: "2.0", id: msg.id, result };
      return opts.sseResponses ? sse(payload) : json(payload);
    }
    return json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  };
}
