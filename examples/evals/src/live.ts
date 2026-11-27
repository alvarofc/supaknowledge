// Live mode: the same tasks against a local Supaknowledge stack (`npx supabase start`). It creates a fresh
// workspace (prefix "kf-eval-"), imports the revenue-report bundle plus the eval's concepts, registers a headless
// agent, runs every task (phase "before"), asks the curator to run (the Edge Functions' KF_LLM_MODEL drafts),
// approves pending proposals that are not escalations as the workspace owner (the simulated reviewer; skip with
// --no-review), runs every task again (phase "after") and reports. Everything it creates is removed by --reset.
//
// The working agent is a Mastra agent on KF_LLM_MODEL (same variables as the curator) when that is set in this
// shell, otherwise the scripted agent over the real SDK and MCP server (--agent scripted forces it).
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ModelChainEntry } from "@supaknowledge/core";
import { agentModelFromEnv } from "@supaknowledge/example-revenue-report/agent";
import { sleep } from "@supaknowledge/example-revenue-report/lib";
import { traceRun, withSupaknowledge } from "@supaknowledge/mastra";
import { Supaknowledge, type TraceRecorder } from "@supaknowledge/sdk";
import { z } from "zod";
import { type CuratorSummary, type EvalResults, summarize, TaskLog, type TaskRun } from "./harness.ts";
import { evalBundle } from "./offline.ts";
import { type AgentEnv, type EvalTask, TASKS } from "./tasks.ts";
import { executeSql, listTables, runWarehouseQuery, WarehouseError } from "./worlds.ts";

const URL = (process.env.SUPAKNOWLEDGE_URL ?? "http://127.0.0.1:54321").replace(/\/+$/, "");
// Fallbacks are the Supabase CLI's public local-development defaults (printed by `supabase status`), not real secrets.
const PUBLISHABLE_KEY = process.env.SUPAKNOWLEDGE_PUBLISHABLE_KEY ?? "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
const SECRET_KEY = process.env.SUPAKNOWLEDGE_SECRET_KEY ?? "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const CURATOR_TIMEOUT_MS = Number(process.env.EVAL_CURATOR_TIMEOUT_S ?? 900) * 1000;

const EMAIL_DOMAIN = "kf-eval.test";
const WORKSPACE_PREFIX = "kf-eval-";
const PASSWORD = "kf-eval-password";
const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

export class EvalError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

function must<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new EvalError(`${what}: ${res.error.message}`);
  return res.data;
}

async function callFunction<T>(path: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(`${URL}/functions/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new EvalError(`/functions/v1/${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function preflight(): Promise<void> {
  const health = await fetch(`${URL}/auth/v1/health`, { headers: { apikey: PUBLISHABLE_KEY } }).catch(() => null);
  if (!health?.ok) throw new EvalError(`no Supaknowledge stack at ${URL}`, "Start it from the repository root: npx supabase start (or run the offline eval: npm run eval:offline)");
  const mcp = await fetch(`${URL}/functions/v1/mcp/.well-known/oauth-protected-resource`).catch(() => null);
  if (!mcp?.ok) throw new EvalError(`the Edge Functions do not answer at ${URL}/functions/v1`, "`npx supabase start` serves them.");
}

// ---------------------------------------------------------------------------------------------------------
// the working agent
// ---------------------------------------------------------------------------------------------------------

/** The scripted agent's tools over the real SDK (MCP) and the trace recorder. */
function sdkEnv(kf: Supaknowledge, trace: TraceRecorder, log: TaskLog): AgentEnv {
  const traceId = trace.externalId;
  return {
    async read(path) {
      const c = await kf.read(path, { traceId });
      trace.tool({ name: "read_concept", input: { path }, output: c?.markdown ?? c?.body ?? `No concept at ${path}`, isError: !c });
      log.tool("read_concept", { path }, c?.body ?? null, !c);
      return c ? { path: c.path, body: c.body } : null;
    },
    async loadSkill(name) {
      const s = await kf.loadSkill(name, { traceId });
      trace.tool({ name: "load_skill", input: { name }, output: s?.markdown ?? s?.body ?? `No skill ${name}`, isError: !s });
      log.tool("load_skill", { name }, s?.body ?? null, !s);
      return s ? { path: s.path, body: s.body } : null;
    },
    async search(query) {
      const hits = await kf.search(query, { limit: 5, traceId });
      trace.tool({ name: "search_knowledge", input: { query }, output: hits.map((h) => h.path) });
      log.tool("search_knowledge", { query }, hits.map((h) => h.path), false);
      return hits.map((h) => ({ path: h.path, title: h.title }));
    },
    async flag(f) {
      await trace.flag({ kind: f.kind, conceptPath: f.conceptPath, observation: f.observation, suggestedFix: f.suggestedFix, query: f.query });
      log.agentFlags++;
      log.tool("flag_knowledge", f, "ok", false);
    },
    async warehouse(sql) {
      try {
        const r = runWarehouseQuery(sql);
        trace.tool({ name: "bigquery.query", input: { sql }, output: { rows: r.rows.length } });
        log.tool("bigquery.query", { sql }, r.rows, false);
        return { rows: r.rows };
      } catch (e) {
        if (!(e instanceof WarehouseError)) throw e;
        trace.tool({ name: "bigquery.query", input: { sql }, output: e.message, isError: true });
        log.tool("bigquery.query", { sql }, e.message, true);
        return { error: e.message };
      }
    },
    async executeSql(query) {
      const r = executeSql(query);
      trace.mcpTool({ server: "supabase", name: "execute_sql", input: { query }, result: r });
      log.tool("mcp__supabase__execute_sql", { query }, r, r.isError === true);
      return r;
    },
    async listTables() {
      const r = listTables();
      trace.mcpTool({ server: "supabase", name: "list_tables", input: {}, result: r });
      log.tool("mcp__supabase__list_tables", {}, r, false);
      return r;
    },
  };
}

const INSTRUCTIONS = [
  "You are Acme Analytics' data agent. Answer the question with data and the company's knowledge.",
  "Search the knowledge base and follow the skills and table guides you find. Query BigQuery with run_warehouse_query and the app database (Supabase Postgres) with execute_sql; list_tables lists the app database's tables.",
  "If a query fails, fix it and retry. When the knowledge turned out to be wrong or missing, call flag_knowledge.",
  "Answer with the result only.",
].join("\n");

function modelAgent(kf: Supaknowledge, model: ModelChainEntry[]): Agent {
  const tools = {
    run_warehouse_query: createTool({
      id: "run_warehouse_query",
      description: "Run a BigQuery SQL query against Acme's warehouse (project acme-prod) and return the rows. Errors come back verbatim.",
      inputSchema: z.object({ sql: z.string() }),
      execute: async ({ sql }) => runWarehouseQuery(sql),
    }),
    // named and shaped like the Supabase MCP server's tools, so trace ingest and the curator treat them the same way
    execute_sql: createTool({
      id: "execute_sql",
      description: "Run a SQL query on Acme's app database (Supabase Postgres). Returns rows, or the Postgres error.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => executeSql(query),
    }),
    list_tables: createTool({
      id: "list_tables",
      description: "List the app database's tables (schema-qualified) and their columns.",
      inputSchema: z.object({}),
      execute: async () => listTables(),
    }),
  };
  return new Agent(withSupaknowledge({ id: "eval-agent", name: "Eval agent", instructions: INSTRUCTIONS, model, tools }, kf));
}

type Part = { type?: string; toolName?: string; input?: unknown; args?: unknown; output?: { type?: string; value?: unknown } | unknown; error?: unknown };

function recordParts(log: TaskLog, content: unknown[] | undefined): void {
  for (const p of (content ?? []) as Part[]) {
    if (p.type !== "tool-result" && p.type !== "tool-error") continue;
    const name = String(p.toolName);
    const out = p.output as { type?: string; value?: unknown } | undefined;
    const wrapped = !!out && typeof out === "object" && "type" in out && "value" in out;
    const value = p.type === "tool-error" ? String((p.error as Error)?.message ?? p.error) : wrapped ? out!.value : p.output;
    const isError = p.type === "tool-error" || (wrapped && String(out!.type).startsWith("error")) || (!!value && typeof value === "object" && (value as { isError?: unknown }).isError === true);
    log.tool(name, p.input ?? p.args, value, isError);
    if (name.endsWith("flag_knowledge") && !isError) log.agentFlags++;
  }
}

// ---------------------------------------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------------------------------------

export interface LiveOptions {
  review?: boolean;
  agent?: "auto" | "scripted" | "model";
  log?: (line: string) => void;
}

interface Person {
  id: string;
  email: string;
  token: string;
  db: SupabaseClient;
}

export async function runLiveEval(opts: LiveOptions = {}): Promise<EvalResults> {
  const say = opts.log ?? ((l: string) => console.log(l));
  const review = opts.review ?? true;
  await preflight();
  const envModel = agentModelFromEnv();
  const useModel = opts.agent === "model" || (opts.agent !== "scripted" && !!envModel);
  if (useModel && !envModel) throw new EvalError("--agent model needs KF_LLM_MODEL (and your endpoint or gateway key) in this shell");

  const admin = createClient(URL, SECRET_KEY, noSession);
  const tag = Date.now().toString(36);
  const email = `owner-${tag}@${EMAIL_DOMAIN}`;
  const created = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { display_name: "Eval owner" } });
  if (created.error) throw new EvalError(`create user: ${created.error.message}`);
  const db = createClient(URL, PUBLISHABLE_KEY, noSession);
  const signIn = await db.auth.signInWithPassword({ email, password: PASSWORD });
  if (signIn.error || !signIn.data.session) throw new EvalError(`sign in: ${signIn.error?.message ?? "no session"}`);
  const owner: Person = { id: signIn.data.user.id, email, token: signIn.data.session.access_token, db };

  const workspaceSlug = `${WORKSPACE_PREFIX}${tag}`;
  const spaceRef = `${workspaceSlug}/revenue`;
  say(`stack ${URL}, workspace ${workspaceSlug} (remove with: npm run eval -- --reset)`);
  const ws = must(await db.rpc("create_workspace", { p_slug: workspaceSlug, p_name: "Acme Analytics (eval)" }), "create_workspace") as { id: string };
  const space = must(
    await db.rpc("create_space", { p_workspace: ws.id, p_slug: "revenue", p_name: "Revenue reporting", p_description: "Eval space", p_visibility: "workspace" }),
    "create_space",
  ) as { id: string };
  // the bundle has a finance-only concept: the group must exist before the import, or it would be unrestricted
  const finance = must(await db.from("groups").insert({ workspace_id: ws.id, slug: "finance", name: "Finance" }).select("id").single(), "create group") as { id: string };
  must(await db.from("group_members").insert({ group_id: finance.id, user_id: owner.id }), "join finance");
  must(await db.from("spaces").update({ settings: { auto_apply: { enabled: true, kinds: ["data_access"], max_risk: "low" } } }).eq("id", space.id), "space settings");
  const imported = await callFunction<{ created: string[] }>("bundle/import", owner.token, { space: spaceRef, files: evalBundle(), apply: true, title: "Import the eval bundle" });
  say(`imported ${imported.created.length} concepts`);
  const agent = await callFunction<{ key: string }>("agents", owner.token, {
    workspace_id: ws.id, name: "eval-agent", description: "Answers the eval tasks", spaces: [{ space_id: space.id, role: "reader" }],
  });
  const kf = new Supaknowledge({ url: URL, space: spaceRef, apiKey: agent.key, timeoutMs: 120_000, onError: (e) => say(`trace: ${String(e)}`) });
  const agentLabel = useModel ? envModel!.label : "scripted";
  say(`working agent: ${useModel ? `Mastra agent on ${agentLabel}` : "scripted agent (set KF_LLM_MODEL in this shell for a real model)"}`);

  const runPhase = async (phase: "before" | "after"): Promise<TaskRun[]> => {
    const runs: TaskRun[] = [];
    for (const task of TASKS) {
      say(`${phase}: ${task.id}`);
      runs.push(useModel ? await modelTask(kf, envModel!.model, task, phase, tag, owner.email) : await scriptedTask(kf, task, phase, tag, owner.email));
    }
    return runs;
  };

  const before = await runPhase("before");
  const curator = await curate(owner, spaceRef, review, say);
  const after = await runPhase("after");
  return {
    mode: "live",
    agent: agentLabel,
    curator_model: "the Edge Functions' KF_LLM_MODEL (supabase/.env)",
    note:
      `Live mode against ${URL}. One run: models are not deterministic, so repeat it before drawing conclusions. ` +
      "The data sources (warehouse, app database) are simulated; the knowledge, traces, curator and review are real.",
    generated_at: new Date().toISOString(),
    tasks: TASKS.map((t, i) => ({ id: t.id, title: t.title, before: before[i]!, after: after[i]! })),
    summary: { before: summarize(before), after: summarize(after) },
    curator,
  };
}

async function scriptedTask(kf: Supaknowledge, task: EvalTask, phase: string, tag: string, requester: string): Promise<TaskRun> {
  const log = new TaskLog();
  const trace = kf.trace({ name: task.title, externalId: `${tag}-${phase}-${task.id}`, metadata: { eval_phase: phase, task: task.id }, flushIntervalMs: 0 });
  trace.user(task.prompt);
  await trace.start();
  const answer = await task.scripted(sdkEnv(kf, trace, log));
  trace.assistant(answer);
  const success = task.check(answer);
  const corrected = !success && !!task.correction;
  if (corrected) trace.feedback(task.correction!, { author: requester });
  const traceId = await trace.end({ outcome: corrected ? "corrected" : success ? "success" : "failure" });
  return log.result(task, answer, success, corrected, traceId);
}

async function modelTask(kf: Supaknowledge, model: ModelChainEntry[], task: EvalTask, phase: string, tag: string, requester: string): Promise<TaskRun> {
  const log = new TaskLog();
  const agent = modelAgent(kf, model);
  const run = traceRun(kf, { name: task.title, externalId: `${tag}-${phase}-${task.id}`, metadata: { eval_phase: phase, task: task.id }, input: task.prompt, flushIntervalMs: 0 });
  const onStepFinish = (step: { content?: unknown[] }) => {
    run.options.onStepFinish(step as never);
    recordParts(log, step.content);
  };
  try {
    const result = await agent.generate(task.prompt, { ...run.options, onStepFinish, maxSteps: 12 });
    const answer = result.text ?? "";
    const success = task.check(answer);
    const corrected = !success && !!task.correction;
    if (corrected) run.trace.feedback(task.correction!, { author: requester });
    const traceId = await run.end(result, { outcome: corrected ? "corrected" : success ? "success" : "failure" });
    return log.result(task, answer, success, corrected, traceId);
  } catch (e) {
    const traceId = await run.fail(e);
    return log.result(task, `agent error: ${e instanceof Error ? e.message : String(e)}`, false, false, traceId);
  }
}

async function curate(owner: Person, spaceRef: string, review: boolean, say: (l: string) => void): Promise<CuratorSummary> {
  const requested = await callFunction<{ run: { id: string } }>("curator/run", owner.token, { space: spaceRef });
  const runId = requested.run.id;
  say(`curator run ${runId.slice(0, 8)} queued`);
  const deadline = Date.now() + CURATOR_TIMEOUT_MS;
  let row: { status: string; error: string | null; stats: Record<string, unknown> };
  for (;;) {
    row = must(await owner.db.from("curator_runs").select("status, error, stats").eq("id", runId).single(), "curator run") as typeof row;
    if (["succeeded", "failed", "cancelled"].includes(row.status)) break;
    if (Date.now() > deadline) throw new EvalError(`the curator run is still ${row.status} after ${CURATOR_TIMEOUT_MS / 1000} s`);
    await sleep(3000);
  }
  if (row.status === "failed" && /no model configured|KF_LLM_MODEL/.test(row.error ?? "")) {
    throw new EvalError("the curator has no model", "Set KF_LLM_MODEL (and your endpoint or gateway key) in supabase/.env and restart the stack; see docs/curator.md#model-configuration");
  }
  say(`curator run ${row.status}`);
  type Row = { id: string; title: string; risk: string; escalation: boolean; status: string; auto_applied: boolean; proposal_ops: { path: string }[] };
  const load = async () =>
    must(await owner.db.from("proposals").select("id, title, risk, escalation, status, auto_applied, proposal_ops(path)").eq("run_id", runId).order("created_at"), "proposals") as Row[];
  let approved = 0;
  if (review) {
    for (const p of await load()) {
      if (p.status !== "pending" || p.escalation) continue;
      const res = await owner.db.rpc("apply_proposal", { p_proposal: p.id, p_note: "eval: simulated reviewer" });
      if (res.error) say(`could not apply "${p.title}": ${res.error.message}`);
      else approved++;
    }
  }
  return {
    run_status: row.status,
    stats: row.stats ?? {},
    proposals: (await load()).map((p) => ({ title: p.title, risk: p.risk, status: p.status, auto_applied: p.auto_applied, escalation: p.escalation, paths: p.proposal_ops.map((o) => o.path) })),
    review: review ? `the workspace owner (simulated reviewer) approved ${approved} pending proposal(s); escalations wait for a space admin` : "no review: pending proposals stay pending",
  };
}

/** Delete every workspace and user earlier live evals created. */
export async function resetLive(say: (l: string) => void = console.log): Promise<void> {
  await preflight();
  const admin = createClient(URL, SECRET_KEY, noSession);
  const workspaces = must(await admin.from("workspaces").select("id").like("slug", `${WORKSPACE_PREFIX}%`), "list workspaces") as { id: string }[];
  const ids = workspaces.map((w) => w.id);
  if (ids.length) {
    const agents = must(await admin.from("agents").select("id").in("workspace_id", ids), "list agents") as { id: string }[];
    for (const a of agents) await admin.auth.admin.deleteUser(a.id);
    must(await admin.from("workspaces").delete().in("id", ids), "delete workspaces");
  }
  let people = 0;
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new EvalError(`list users: ${error.message}`);
    for (const u of data.users) {
      if (u.email?.endsWith(`@${EMAIL_DOMAIN}`)) {
        await admin.auth.admin.deleteUser(u.id);
        people++;
      }
    }
    if (data.users.length < 1000) break;
  }
  say(`removed ${ids.length} eval workspace(s) and ${people} eval user(s)`);
}
