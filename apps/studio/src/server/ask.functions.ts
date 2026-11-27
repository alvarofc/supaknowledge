import { createServerFn } from "@tanstack/react-start";
import { ASK_FLAG_KINDS, ASK_LIMITS, isUuid, normalizePath } from "@/lib/ask";
import type { AskFlagKind } from "@/lib/ask";
import { FUNCTIONS_URL, SUPABASE_PUBLISHABLE_KEY } from "@/lib/env";
import { errorMessage } from "@/lib/format";
import { askModel, askPerMinute } from "@/server/ask/config.server";
import { McpClient } from "@/server/ask/mcp.server";
import { readSettings } from "@/server/settings.server";
import { spaceParams } from "@/server/shell.functions";
import type { SpaceParams } from "@/server/shell.functions";
import { getSpaceContext } from "@/server/space.server";
import { getSupabase } from "@/server/supabase.server";

/** What the Ask page needs before the first question: is a model configured, and are conversations recorded. */
export const loadAsk = createServerFn({ method: "GET" })
  .validator((d: SpaceParams) => spaceParams(d))
  .handler(async ({ data }) => {
    const ctx = await getSpaceContext(data.workspace, data.space);
    const model = askModel();
    return {
      model: model.ok ? model.config.model : null,
      modelProblem: model.ok ? null : { reason: model.reason, message: model.message },
      recordTraces: readSettings(ctx.space.settings).ask.record_traces,
      perMinute: askPerMinute(),
    };
  });

export interface FlagAnswerInput extends SpaceParams {
  kind: AskFlagKind;
  note: string;
  /** the concept the flag is about; null for knowledge that is missing */
  conceptPath: string | null;
  question: string;
  answer: string;
  /** every concept the answer used */
  concepts: string[];
  traceId: string | null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function validateFlag(d: FlagAnswerInput): FlagAnswerInput {
  const input = spaceParams(d);
  if (!ASK_FLAG_KINDS.includes(input.kind)) throw new Error("Choose what is wrong with the answer.");
  if (typeof input.note !== "string" || !input.note.trim()) throw new Error("Describe what is wrong.");
  if (input.note.length > ASK_LIMITS.noteMax) throw new Error(`Notes can be at most ${ASK_LIMITS.noteMax.toLocaleString("en-US")} characters.`);
  if (input.conceptPath !== null && !normalizePath(input.conceptPath)) throw new Error("Unknown concept.");
  if (input.traceId !== null && !isUuid(input.traceId)) throw new Error("Bad trace id.");
  if (typeof input.question !== "string" || typeof input.answer !== "string" || !Array.isArray(input.concepts)) throw new Error("Bad request");
  return input;
}

/**
 * "Flag this answer": raises a flag through the MCP server's flag_knowledge tool as the signed-in person, exactly as an
 * agent would, linked to the conversation's trace when it is recorded. The flag then shows in the inbox.
 */
export const flagAnswer = createServerFn({ method: "POST" })
  .validator((d: FlagAnswerInput) => validateFlag(d))
  .handler(async ({ data }): Promise<{ ok: true; flagId: string | null } | { ok: false; message: string }> => {
    await getSpaceContext(data.workspace, data.space);
    const token = (await getSupabase().auth.getSession()).data.session?.access_token;
    if (!token) return { ok: false, message: "Your session expired. Sign in again." };
    const mcp = new McpClient({
      endpoint: `${FUNCTIONS_URL}/mcp`,
      space: `${data.workspace}/${data.space}`,
      accessToken: token,
      publishableKey: SUPABASE_PUBLISHABLE_KEY,
    });
    const concepts = data.concepts.map(normalizePath).filter((p): p is string => Boolean(p)).slice(0, 50);
    try {
      const r = await mcp.callTool("flag_knowledge", {
        kind: data.kind,
        observation: data.note.trim(),
        ...(data.conceptPath ? { concept_path: normalizePath(data.conceptPath) } : {}),
        ...(data.question.trim() ? { query: clip(data.question.trim(), 1000) } : {}),
        evidence: { source: "studio-ask", answer: clip(data.answer, 6000), concepts_used: concepts },
        ...(data.traceId ? { trace_id: data.traceId } : {}),
      });
      if (r.isError) return { ok: false, message: r.text || "The flag was not recorded." };
      let flagId: string | null = null;
      try {
        const j = JSON.parse(r.text) as { flag_id?: unknown };
        flagId = typeof j.flag_id === "string" ? j.flag_id : null;
      } catch {
        /* the flag was raised; its id is only informative */
      }
      return { ok: true, flagId };
    } catch (e) {
      return { ok: false, message: errorMessage(e) };
    }
  });
