/** Only allow same-origin relative redirects (prevents open redirects through ?next=). */
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}

/**
 * The origin the browser used (Host / X-Forwarded-* headers). Server routes must redirect back to the same
 * host the session cookies live on: `new URL(request.url).origin` can differ (e.g. localhost vs 127.0.0.1 in dev).
 */
export function requestOrigin(request: Request): string {
  const h = request.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return new URL(request.url).origin;
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? new URL(request.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}

/** A redirect Response back to `path` on the host the browser used (where the session cookies live). */
export function redirectTo(request: Request, path: string, status = 302): Response {
  return new Response(null, { status, headers: { Location: new URL(path, requestOrigin(request)).toString() } });
}
