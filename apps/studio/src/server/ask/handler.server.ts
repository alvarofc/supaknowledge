// POST /api/ask: answer one question as the signed-in person and stream the answer back as NDJSON (AskEvent).
// Every read goes through the person's session: the MCP and traces functions get their access token, and the
// space, its settings and concept audiences are read with the RLS-bound server client.
import { STOPPED, askTraceExternalId, exposedConceptPaths, isUuid, modelHistory, traceAudience, usedConcepts, validateConversation } from "@/lib/ask";
import type { AskEvent, AskTraceState } from "@/lib/ask";
import { FUNCTIONS_URL, SUPABASE_PUBLISHABLE_KEY } from "@/lib/env";
import { errorMessage } from "@/lib/format";
import { isSameOriginRequest } from "@/lib/safe-next";
import { readSettings } from "@/server/settings.server";
import { getSupabase, getUser } from "@/server/supabase.server";
import type { Supa } from "@/lib/supabase/client";
import { askInstructions, runAsk } from "./agent.server";
import { askAllowsAnonymous, askLimiter, askModel, mcpMeta } from "./config.server";
import { McpClient, askTools } from "./mcp.server";
import { TraceClient, turnEvents } from "./trace.server";

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function handleAsk(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) return json({ error: "Cross-site requests are refused." }, 403);
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Send a JSON body." }, 400);
  }
  const { workspace, space, conversationId } = body;
  if (typeof workspace !== "string" || typeof space !== "string" || !isUuid(conversationId)) return json({ error: "Bad request." }, 400);
  const conversation = validateConversation(body.messages);
  if (!conversation.ok) return json({ error: conversation.message }, 400);

  const user = await getUser();
  if (!user) return json({ error: "Your session expired. Sign in again." }, 401);
  if (user.isAnonymous && !askAllowsAnonymous()) return json({ error: "Ask is not available to demo visitors. Connect your own agent with the MCP command on the inbox." }, 403);
  const supabase = getSupabase();
  const { data: ws } = await supabase.from("workspaces").select("id").eq("slug", workspace).maybeSingle();
  const { data: sp } = ws
    ? await supabase.from("spaces").select("id, settings").eq("workspace_id", ws.id).eq("slug", space).maybeSingle()
    : { data: null };
  if (!sp) return json({ error: "Space not found." }, 404);

  const model = askModel();
  if (!model.ok) return json({ error: model.message }, 503);
  const token = (await supabase.auth.getSession()).data.session?.access_token;
  if (!token) return json({ error: "Your session expired. Sign in again." }, 401);

  const slot = askLimiter().acquire(user.id);
  if (!slot.ok) return json({ error: slot.message }, 429, { "Retry-After": String(slot.retryAfterSeconds) });

  // narrowed values for the background work below
  const config = model.config;
  const spaceId = sp.id;
  const externalId = askTraceExternalId(conversationId);
  const release = slot.release;
  const ref = `${workspace}/${space}`;
  const recordTraces = readSettings(sp.settings).ask.record_traces;
  const messages = conversation.messages;
  const question = messages[messages.length - 1];
  const askedAt = new Date().toISOString();
  const mcp = new McpClient({ endpoint: `${FUNCTIONS_URL}/mcp`, space: ref, accessToken: token, publishableKey: SUPABASE_PUBLISHABLE_KEY });
  const traces = new TraceClient({ endpoint: `${FUNCTIONS_URL}/traces`, accessToken: token, publishableKey: SUPABASE_PUBLISHABLE_KEY });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    // start() returns at once and the answer is produced in the background, so every chunk reaches the browser as it
    // is enqueued (a pending start() promise would hold back pulls until the whole answer is done)
    start(controller) {
      void answer(controller);
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });

  async function answer(controller: ReadableStreamDefaultController<Uint8Array>) {
    let open = true;
    const emit = (e: AskEvent) => {
      if (!open) return;
      try {
        controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      } catch {
        open = false; // the browser went away
      }
    };
    try {
      let meta;
      try {
        meta = await mcpMeta(mcp);
      } catch (e) {
        emit({ type: "error", message: errorMessage(e) });
        return;
      }

      let trace: AskTraceState = { status: "off" };
      let traceId: string | null = null;
      if (recordTraces) {
        try {
          traceId = await traces.ensure({
            space: ref,
            externalId,
            // the first question names the conversation in Activity → Traces
            ...(messages.length === 1 ? { name: `Ask: ${clip(question.content.replace(/\s+/g, " ").trim(), 80)}` } : {}),
            metadata: { source: "studio-ask", model: config.model },
          });
          trace = { status: "recorded", traceId };
        } catch (e) {
          trace = { status: "failed", message: errorMessage(e) };
        }
      }

      const run = await runAsk({
        config,
        instructions: askInstructions(meta.instructions, ref),
        tools: askTools(meta.tools),
        callTool: (name, args, signal) => mcp.callTool(name, args, signal),
        messages: modelHistory(messages),
        traceId,
        emit,
        signal: request.signal,
      });

      if (traceId) trace = await recordTurn(supabase, traces, spaceId, traceId, { content: question.content, at: askedAt }, run, config.model);
      if (run.error) emit({ type: "error", message: run.error, trace });
      else emit({ type: "done", concepts: usedConcepts(run.calls), trace });
    } catch (e) {
      emit({ type: "error", message: errorMessage(e) });
    } finally {
      release();
      if (open) {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    }
  }
}

/**
 * Append this turn to the conversation's trace. The trace's audience is narrowed to what the concepts the model saw
 * allow (see traceAudience), so restricted knowledge in a trace is only shown to reviewers in its audience. When no
 * audience fits, the turn is not recorded.
 */
async function recordTurn(
  supabase: Supa,
  traces: TraceClient,
  spaceId: string,
  traceId: string,
  question: { content: string; at: string },
  run: Awaited<ReturnType<typeof runAsk>>,
  model: string,
): Promise<AskTraceState> {
  try {
    const paths = exposedConceptPaths(run.calls);
    const [{ data: concepts, error: cErr }, { data: current, error: tErr }] = await Promise.all([
      paths.length
        ? supabase.from("concepts").select("path, audience").eq("space_id", spaceId).in("path", paths)
        : Promise.resolve({ data: [] as { path: string; audience: string[] }[], error: null }),
      supabase.from("traces").select("audience").eq("id", traceId).maybeSingle(),
    ]);
    if (cErr || tErr) throw cErr ?? tErr;
    const now = current?.audience ?? [];
    const audience = traceAudience(
      (concepts ?? []).map((c) => c.audience),
      now,
    );
    if (audience === null) {
      return { status: "skipped", message: "This answer used restricted knowledge from groups that do not overlap, so it was not sent to the curator." };
    }
    const events = turnEvents(question, run.timeline, { model });
    if (run.error && run.error !== STOPPED) {
      events.push({ role: "tool", tool_name: "exception", tool_output: run.error, is_error: true, at: new Date().toISOString() });
    }
    const narrowed = audience.length && JSON.stringify(audience) !== JSON.stringify([...now].sort()) ? audience : undefined;
    await traces.append(traceId, events, narrowed);
    return { status: "recorded", traceId };
  } catch (e) {
    return { status: "failed", message: errorMessage(e) };
  }
}
