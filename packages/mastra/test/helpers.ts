// Test doubles: a mock OpenAI-compatible chat-completions endpoint and a scripted Supaknowledge fetch.
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface ChatRequest {
  model: string;
  messages: { role: string; content?: unknown; tool_call_id?: string; tool_calls?: unknown[] }[];
  tools?: { type: string; function: { name: string; description?: string } }[];
  authorization?: string;
}

export type Reply = { status: number } | { content?: string | null; tool_calls?: { id: string; name: string; arguments: unknown }[] };

/** Each request gets `handler(request, index)`; returns an assistant message (text and/or tool calls) or an HTTP error. */
export function mockModel(handler: (req: ChatRequest, i: number) => Reply) {
  const requests: ChatRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = { ...(JSON.parse(raw || "{}") as ChatRequest), authorization: req.headers.authorization };
      requests.push(body);
      const reply = handler(body, requests.length - 1);
      if ("status" in reply) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid request", type: "invalid_request_error" } }));
        return;
      }
      const toolCalls = reply.tool_calls?.map((t) => ({
        id: t.id,
        type: "function",
        function: { name: t.name, arguments: typeof t.arguments === "string" ? t.arguments : JSON.stringify(t.arguments) },
      }));
      if ((body as { stream?: boolean }).stream) {
        // agent.stream(): server-sent chat.completion.chunk events
        const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
          `data: ${JSON.stringify({ id: `chatcmpl-${requests.length}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(chunk({ role: "assistant", content: reply.content ?? null, ...(toolCalls ? { tool_calls: toolCalls.map((t, index) => ({ index, ...t })) } : {}) }, null));
        res.write(chunk({}, toolCalls ? "tool_calls" : "stop", { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }));
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `chatcmpl-${requests.length}`,
          object: "chat.completion",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: reply.content ?? null, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
              finish_reason: toolCalls ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        }),
      );
    });
  });
  return new Promise<{ url: string; requests: ChatRequest[]; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests, close: () => server.close() }),
    ),
  );
}

export interface Call {
  method: string;
  url: string;
  body: any;
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * Fake Supaknowledge: the `mcp` function (initialize + tools/call -> `tool(name, args)`) and the `traces` function.
 * Set `tracesDown` to make the traces function fail.
 */
export function fakeSupaknowledge(tool: (name: string, args: any) => unknown, opts: { tracesDown?: boolean } = {}) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    const call: Call = { method: (init.method ?? "GET").toUpperCase(), url: String(input), body };
    calls.push(call);
    if (call.url.includes("/functions/v1/traces")) {
      if (opts.tracesDown) return json({ error: "boom" }, 503);
      return call.method === "POST" ? json({ trace_id: "t-1" }) : json({ ok: true });
    }
    if (call.url.includes("/functions/v1/mcp")) {
      if (body.method === "initialize") {
        return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "supaknowledge" } } }, 200, { "mcp-session-id": "s-1" });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      let result: unknown;
      try {
        const out = tool(body.params.name, body.params.arguments);
        result = { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }] };
      } catch (e) {
        result = { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
      return json({ jsonrpc: "2.0", id: body.id, result });
    }
    return json({ message: "no mock" }, 599);
  };
  const toolCalls = () => calls.filter((c) => c.body?.method === "tools/call").map((c) => c.body.params as { name: string; arguments: any });
  const traceWrites = () => calls.filter((c) => c.url.includes("/functions/v1/traces"));
  const events = () => traceWrites().flatMap((c) => (c.body?.events ?? []) as any[]);
  return { fetch, calls, toolCalls, traceWrites, events };
}
