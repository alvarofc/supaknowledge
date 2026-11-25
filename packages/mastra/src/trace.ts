// Record a Mastra agent run into a Supaknowledge trace: the user input, assistant text, every tool call with its
// result or error, run errors, and token usage. The curator mines these traces (failed tool calls, user
// corrections, flags) to improve the knowledge base.
//
//   const run = traceRun(kf, { name: "weekly revenue", input });
//   try {
//     const result = await agent.generate(input, { ...run.options, maxSteps: 8 });
//     await run.end(result);
//   } catch (e) {
//     await run.fail(e);
//     throw e;
//   }
//
// or, in one call: `const { result, traceId } = await generateWithTrace(agent, kf, input, { trace: { name } })`.
//
// Steps are recorded as they finish (Mastra's `onStepFinish`), so a run that crashes half way still leaves
// a useful trace. Nothing here ever throws into the host agent: recording errors go to the Supaknowledge client's
// `onError` (console.warn by default).
import { RequestContext } from "@mastra/core/request-context";
import type { Supaknowledge, TraceOptions, TraceOutcome, TraceRecorder } from "@supaknowledge/sdk";
import { SUPAKNOWLEDGE_TRACE_KEY } from "./tools.ts";

type AnyRecord = Record<string, unknown>;

/** The parts of a Mastra step / result this module reads (kept structural so minor Mastra changes do not break it). */
export interface StepLike {
  text?: string;
  content?: readonly unknown[];
  toolCalls?: readonly { payload?: unknown }[];
  toolResults?: readonly { payload?: unknown }[];
  usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
  finishReason?: string;
  response?: { modelId?: string };
}

export interface ResultLike extends StepLike {
  steps?: readonly StepLike[];
  error?: unknown;
  tripwire?: unknown;
}

export interface TraceRunOptions extends TraceOptions {
  /** What the agent was asked (string, message, or message list as passed to generate/stream); recorded first. */
  input?: unknown;
  /** Reuse your RequestContext (the trace is added under SUPAKNOWLEDGE_TRACE_KEY); a new one otherwise. */
  requestContext?: RequestContext<any>;
}

export interface TracedRun {
  readonly trace: TraceRecorder;
  readonly requestContext: RequestContext<any>;
  /** Spread into `agent.generate()` / `agent.stream()` options. */
  readonly options: {
    requestContext: RequestContext<any>;
    onStepFinish: (step: any) => void;
    onAbort: (event: { steps?: unknown[]; text?: string }) => void;
  };
  /** Record a step by hand (normally `options.onStepFinish` does it). Never throws. */
  recordStep(step: StepLike): void;
  /** Close the trace. Records any steps of `result` not seen yet and derives the outcome from it. Never rejects. */
  end(result?: ResultLike | null, opts?: { outcome?: TraceOutcome; metadata?: AnyRecord }): Promise<string | null>;
  /** Record a run error and close the trace with outcome "failure". Never rejects. */
  fail(error: unknown, opts?: { metadata?: AnyRecord }): Promise<string | null>;
}

function safe(fn: () => void, onError: (e: unknown) => void): void {
  try {
    fn();
  } catch (e) {
    try {
      onError(e);
    } catch {
      /* never throw into the host agent */
    }
  }
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (e && typeof e === "object" && typeof (e as AnyRecord).message === "string") return (e as AnyRecord).message as string;
  return typeof e === "string" ? e : JSON.stringify(e);
}

function partsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p && typeof p === "object" && typeof (p as AnyRecord).text === "string" ? ((p as AnyRecord).text as string) : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const c = content as AnyRecord;
    if (typeof c.text === "string") return c.text;
    if (Array.isArray(c.parts)) return partsText(c.parts);
    if ("content" in c) return partsText(c.content);
  }
  return "";
}

/** Record what the agent was asked: a string, a message `{ role, content }`, or a list of them. */
export function recordInput(trace: TraceRecorder, input: unknown): void {
  const items = Array.isArray(input) ? input : [input];
  for (const m of items) {
    if (m === undefined || m === null) continue;
    if (typeof m === "string") {
      if (m.trim()) trace.user(m);
      continue;
    }
    if (typeof m !== "object") continue;
    const role = (m as AnyRecord).role;
    const text = partsText((m as AnyRecord).content ?? m);
    if (!text.trim()) continue;
    if (role === "system") trace.system(text);
    else if (role === "assistant") trace.assistant(text);
    else if (role === "tool") continue; // earlier tool results carry no new signal for this run
    else trace.user(text);
  }
}

function toolOutput(output: unknown): { value: unknown; isError: boolean } {
  if (output && typeof output === "object" && "type" in output && "value" in output) {
    const o = output as { type: unknown; value: unknown };
    return { value: o.value, isError: typeof o.type === "string" && o.type.startsWith("error") };
  }
  return { value: output, isError: false };
}

/** Record one Mastra step (assistant text, tool calls with results or errors). */
export function recordStep(trace: TraceRecorder, step: StepLike): void {
  if (typeof step.text === "string" && step.text.trim()) trace.assistant(step.text);
  const content = Array.isArray(step.content) ? (step.content as AnyRecord[]) : null;
  const calls = new Map<string, { name: string; input: unknown }>();
  if (content?.some((p) => p?.type === "tool-call" || p?.type === "tool-result" || p?.type === "tool-error")) {
    for (const p of content) if (p?.type === "tool-call") calls.set(String(p.toolCallId), { name: String(p.toolName), input: p.input ?? p.args });
    for (const p of content) {
      if (p?.type !== "tool-result" && p?.type !== "tool-error") continue;
      const id = String(p.toolCallId);
      const call = calls.get(id);
      calls.delete(id);
      const out = p.type === "tool-error" ? { value: errorText(p.error), isError: true } : toolOutput(p.output ?? p.result);
      trace.tool({
        name: String(p.toolName ?? call?.name ?? "tool"),
        input: p.input ?? call?.input,
        output: out.value,
        isError: out.isError || p.isError === true,
        metadata: { tool_call_id: id },
      });
    }
  } else {
    for (const c of step.toolCalls ?? []) {
      const p = (c.payload ?? {}) as AnyRecord;
      calls.set(String(p.toolCallId), { name: String(p.toolName), input: p.args });
    }
    for (const r of step.toolResults ?? []) {
      const p = (r.payload ?? {}) as AnyRecord;
      const id = String(p.toolCallId);
      const call = calls.get(id);
      calls.delete(id);
      trace.tool({ name: String(p.toolName ?? call?.name), input: p.args ?? call?.input, output: p.result, isError: p.isError === true, metadata: { tool_call_id: id } });
    }
  }
  // calls without a result: suspended for approval, or the run stopped before executing them
  for (const [id, c] of calls) trace.tool({ name: c.name, input: c.input, output: null, metadata: { tool_call_id: id, no_result: true } });
}

/**
 * Start recording a Mastra agent run. Spread `run.options` into `generate()`/`stream()` options (it carries the
 * RequestContext that links supaknowledgeTools() searches and flags to this trace), then call `run.end(result)` or
 * `run.fail(error)`.
 */
export function traceRun(client: Supaknowledge, opts: TraceRunOptions = {}): TracedRun {
  const { input, requestContext: rc, ...traceOpts } = opts;
  const trace = client.trace({ ...traceOpts, metadata: { framework: "mastra", ...(traceOpts.metadata ?? {}) } });
  // same chain as the recorder itself: the run's onError, else the client's onError, else console.warn
  const onError = (e: unknown) => {
    try {
      if (traceOpts.onError) traceOpts.onError(e);
      else if (typeof client.reportError === "function") client.reportError(e);
      else console.warn("[supaknowledge] trace:", e);
    } catch {
      /* ignore */
    }
  };
  const requestContext = rc ?? new RequestContext();
  safe(() => requestContext.setRaw(SUPAKNOWLEDGE_TRACE_KEY, trace), onError);
  if (input !== undefined) safe(() => recordInput(trace, input), onError);

  let stepsSeen = 0;
  const usage = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };
  let model: string | undefined;
  let closed = false;

  const record = (step: StepLike) =>
    safe(() => {
      stepsSeen++;
      usage.input_tokens += step.usage?.inputTokens ?? 0;
      usage.output_tokens += step.usage?.outputTokens ?? 0;
      usage.cached_input_tokens += step.usage?.cachedInputTokens ?? 0;
      if (step.response?.modelId) model = step.response.modelId;
      recordStep(trace, step);
    }, onError);

  const runMetadata = (extra?: AnyRecord): AnyRecord => ({
    ...(model ? { model } : {}),
    usage: { ...usage },
    steps: stepsSeen,
    ...(extra ?? {}),
  });

  const close = async (outcome: TraceOutcome, metadata: AnyRecord): Promise<string | null> => {
    if (closed) return trace.id;
    closed = true;
    try {
      safe(() => requestContext.deleteRaw(SUPAKNOWLEDGE_TRACE_KEY), onError);
      return await trace.end({ outcome, metadata });
    } catch (e) {
      onError(e);
      return trace.id;
    }
  };

  return {
    trace,
    requestContext,
    options: {
      requestContext,
      onStepFinish: (step: StepLike) => record(step),
      onAbort: (event) =>
        safe(() => {
          if (typeof event?.text === "string" && event.text.trim()) trace.assistant(event.text, { aborted: true });
        }, onError),
    },
    recordStep: record,
    async end(result, endOpts = {}) {
      let finishReason: string | undefined;
      safe(() => {
        const steps = Array.isArray(result?.steps) ? result.steps : [];
        for (const s of steps.slice(stepsSeen)) record(s); // steps the callbacks did not see
        finishReason = result?.finishReason;
        if (result?.error) trace.tool({ name: "exception", output: errorText(result.error), isError: true });
      }, onError);
      const failed = finishReason === "error" || Boolean(result?.error) || Boolean(result?.tripwire);
      return close(endOpts.outcome ?? (failed ? "failure" : "unknown"), runMetadata({ ...(finishReason ? { finish_reason: finishReason } : {}), ...(endOpts.metadata ?? {}) }));
    },
    async fail(error, failOpts = {}) {
      safe(() => trace.tool({ name: "exception", output: errorText(error), isError: true }), onError);
      return close("failure", runMetadata({ error: errorText(error), ...(failOpts.metadata ?? {}) }));
    },
  };
}

/** Anything with Mastra's `agent.generate(messages, options)` shape. */
export interface GenerateCapable<R> {
  generate(messages: any, options?: any): Promise<R>;
}

export interface GenerateWithTraceOptions {
  /** Trace name, external id, metadata... */
  trace?: Omit<TraceRunOptions, "input" | "requestContext">;
  /** Options for `agent.generate()`. Your callbacks still run; your RequestContext is reused. */
  options?: AnyRecord & { requestContext?: RequestContext<any> };
  /** Trace outcome when the run finishes normally. Default "unknown" (the curator only learns from it). */
  outcome?: TraceOutcome;
}

/**
 * `agent.generate(input)` recorded as a Supaknowledge trace. Resolves to the agent's result and the trace id; agent
 * errors are recorded and re-thrown unchanged.
 */
export async function generateWithTrace<R>(
  agent: GenerateCapable<R>,
  client: Supaknowledge,
  input: unknown,
  opts: GenerateWithTraceOptions = {},
): Promise<{ result: R; traceId: string | null; trace: TraceRecorder }> {
  const userOpts = (opts.options ?? {}) as AnyRecord & {
    requestContext?: RequestContext<any>;
    onStepFinish?: (s: unknown) => unknown;
    onAbort?: (e: unknown) => unknown;
  };
  const run = traceRun(client, { ...(opts.trace ?? {}), input, requestContext: userOpts.requestContext });
  const options = {
    ...userOpts,
    requestContext: run.requestContext,
    onStepFinish: async (step: unknown) => {
      run.options.onStepFinish(step);
      await userOpts.onStepFinish?.(step);
    },
    onAbort: async (event: { steps?: unknown[]; text?: string }) => {
      run.options.onAbort(event);
      await userOpts.onAbort?.(event);
    },
  };
  let result: R;
  try {
    result = await agent.generate(input, options);
  } catch (e) {
    await run.fail(e);
    throw e;
  }
  const traceId = await run.end(result as ResultLike, { outcome: opts.outcome });
  return { result, traceId, trace: run.trace };
}
