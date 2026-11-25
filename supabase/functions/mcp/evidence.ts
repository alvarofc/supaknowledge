/**
 * Evidence stored with an MCP flag: the caller's free-form keys, then the server-owned provenance keys, which a
 * caller can never set. trace_ref (the raw trace id an agent cited) is recorded only when the server could not
 * resolve that trace; a caller-supplied trace_ref is always dropped, whether or not a trace_id was given.
 */
export function flagEvidence(
  evidence: Record<string, unknown> | undefined,
  clientId: string | null | undefined,
  traceId: string | undefined,
  resolvedTrace: string | null,
): Record<string, unknown> {
  const { trace_ref: _dropped, ...own } = evidence ?? {};
  const ref = traceId?.trim();
  return { ...own, via: "mcp", client_id: clientId ?? null, ...(ref && !resolvedTrace ? { trace_ref: ref } : {}) };
}
