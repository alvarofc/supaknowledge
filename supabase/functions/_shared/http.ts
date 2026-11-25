export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, mcp-session-id, mcp-protocol-version, x-kf-internal",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Expose-Headers": "mcp-session-id, www-authenticate",
};

export class HttpError extends Error {
  status: number;
  /** extra response headers (e.g. Retry-After on 429) */
  headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders, ...headers },
  });
}

/**
 * Error -> response. Client errors (4xx) and deliberate transient errors (502-504) carry their message. Internal
 * errors (unexpected exceptions, HttpError 500) can embed database / upstream diagnostics, so the details only go
 * to the function log, under a request id the response returns.
 */
export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError && e.status !== 500) return json({ error: e.message }, e.status, e.headers);
  const requestId = crypto.randomUUID();
  console.error(`request ${requestId}:`, e);
  return json({ error: `internal error (request id ${requestId})`, request_id: requestId }, 500, e instanceof HttpError ? e.headers : {});
}

/** Wrap a handler with CORS preflight + uniform error responses. */
export function handler(fn: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    try {
      return await fn(req);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}
