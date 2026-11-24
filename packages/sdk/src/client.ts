import { isNotDeployed, SupaknowledgeError, requestJson, trimUrl } from "./http.ts";
import { McpClient } from "./mcp.ts";
import { parseConceptMarkdown, parseSkillMarkdown } from "./parse.ts";
import { buildMcpConfig, mcpEndpoint, type McpConfig, type McpConfigOptions } from "./mcp-config.ts";
import { TraceRecorder, type TraceOptions } from "./trace.ts";
import {
  handleToolCall,
  handleToolCalls,
  knowledgeTools,
  type FunctionToolDefinition,
  type JsonSchemaToolDefinition,
  type KnowledgeToolsOptions,
  type ToolCallLike,
  type ToolCallOutput,
  type ToolCallResult,
} from "./tools.ts";
import type {
  Concept,
  FetchLike,
  FlagInput,
  FlagResult,
  ReadOptions,
  SupaknowledgeOptions,
  SearchOptions,
  SearchResult,
  Skill,
  SkillSummary,
} from "./types.ts";

export const SDK_VERSION = "0.1.0";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asArray<T>(v: unknown, ...keys: string[]): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object") {
    for (const k of keys) {
      const x = (v as Record<string, unknown>)[k];
      if (Array.isArray(x)) return x as T[];
    }
  }
  return [];
}

function unwrap<T>(v: unknown, ...keys: string[]): T {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const k of keys) {
      const x = (v as Record<string, unknown>)[k];
      if (x && typeof x === "object") return x as T;
    }
  }
  return v as T;
}

function skillNameOf(path: string): string {
  return path.split("/").pop() ?? path;
}

/**
 * Supaknowledge client. Talks to the `mcp` Edge Function (semantic search; works with agent keys, user tokens and
 * OAuth tokens) and, for user tokens, can fall back to PostgREST RPCs.
 */
export class Supaknowledge {
  readonly url: string;
  readonly space: string;
  private readonly o: SupaknowledgeOptions;
  private readonly fetchFn: FetchLike;
  private readonly mcp: McpClient;
  private mode: "mcp" | "rest" | "auto";
  private spaceIdP: Promise<string> | null = null;

  constructor(options: SupaknowledgeOptions) {
    if (!options?.url) throw new SupaknowledgeError("Supaknowledge: `url` is required");
    if (!options.space) throw new SupaknowledgeError("Supaknowledge: `space` is required (\"<workspace>/<space>\")");
    if (!options.apiKey && !options.accessToken) throw new SupaknowledgeError("Supaknowledge: pass `apiKey` (agent key) or `accessToken` (user token)");
    this.o = options;
    this.url = trimUrl(options.url);
    this.space = options.space;
    const f = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new SupaknowledgeError("Supaknowledge: no global fetch; pass `fetch`");
    this.fetchFn = (input, init) => f(input, init);
    this.mode = options.transport ?? "auto";
    if (this.mode === "rest" && !this.canRest()) {
      throw new SupaknowledgeError('Supaknowledge: transport "rest" needs `accessToken` (a user JWT) and `publishableKey`');
    }
    this.mcp = new McpClient({
      endpoint: mcpEndpoint(this.url, this.space),
      headers: () => this.authHeaders(),
      fetch: this.fetchFn,
      clientName: "supaknowledge-sdk",
      clientVersion: SDK_VERSION,
      timeoutMs: options.timeoutMs ?? 30000,
    });
  }

  // -------------------------------------------------------------------------------------------------------
  // knowledge
  // -------------------------------------------------------------------------------------------------------

  /** Hybrid search over the space's knowledge (semantic + full-text through MCP; full-text only over REST). */
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    return this.route(
      async () => {
        const r = await this.mcp.callTool("search_knowledge", {
          query,
          ...(opts.kinds?.length ? { kinds: opts.kinds } : {}),
          ...(opts.limit ? { limit: opts.limit } : {}),
          ...(opts.traceId ? { trace_id: opts.traceId } : {}),
        });
        return asArray<SearchResult>(r, "results", "items", "concepts");
      },
      async () => {
        const space = await this.spaceId();
        const rows = await this.rpc<SearchResult[]>("search_knowledge", {
          p_space: space,
          p_query: query,
          p_kinds: opts.kinds?.length ? opts.kinds : null,
          p_limit: opts.limit ?? 8,
        });
        const ids = (rows ?? []).map((r) => r.concept_id).filter(Boolean);
        if (ids.length) await this.logUsage(space, ids as string[], "search", query, opts.traceId);
        return rows ?? [];
      },
    );
  }

  /** Read one concept by path. Resolves to null when it does not exist (or you cannot see it). */
  async read(path: string, opts: ReadOptions = {}): Promise<Concept | null> {
    return this.route(
      async () => {
        try {
          const r = await this.mcp.callTool("read_concept", { path, ...(opts.traceId ? { trace_id: opts.traceId } : {}) });
          if (!r) return null;
          return typeof r === "string" ? parseConceptMarkdown(r) : unwrap<Concept>(r, "concept");
        } catch (e) {
          if (e instanceof SupaknowledgeError && e.code === "tool_error" && /not found|no concept|does not exist/i.test(e.message)) return null;
          throw e;
        }
      },
      async () => {
        const space = await this.spaceId();
        const c = await this.rpc<Concept | null>("read_concept", { p_space: space, p_path: path });
        if (c && typeof c.id === "string") await this.logUsage(space, [c.id], "read", path, opts.traceId);
        return c ?? null;
      },
    );
  }

  /** Skill names and descriptions (progressive disclosure: load the body with loadSkill). */
  async listSkills(): Promise<SkillSummary[]> {
    return this.route(
      async () => {
        const r = await this.mcp.callTool("list_skills", {});
        return asArray<SkillSummary>(r, "skills").map((s) => ({ ...s, name: s.name ?? skillNameOf(String(s.path ?? "")) }));
      },
      async () => {
        const space = await this.spaceId();
        const rows = await this.restGet<{ path: string; title: string; description: string }[]>(
          `concepts?select=path,title,description&space_id=eq.${space}&kind=eq.skill&status=eq.stable&order=path`,
        );
        return rows.map((r) => ({ name: skillNameOf(r.path), ...r }));
      },
    );
  }

  /** Full skill: instructions plus attached files. */
  async loadSkill(name: string, opts: ReadOptions = {}): Promise<Skill | null> {
    return this.route(
      async () => {
        try {
          const r = await this.mcp.callTool("load_skill", { name, ...(opts.traceId ? { trace_id: opts.traceId } : {}) });
          if (!r) return null;
          const s = typeof r === "string" ? parseSkillMarkdown(r) : unwrap<Skill>(r, "skill");
          return { ...s, name: s.name ?? skillNameOf(String(s.path ?? name)) };
        } catch (e) {
          if (e instanceof SupaknowledgeError && e.code === "tool_error" && /not found|no skill|does not exist/i.test(e.message)) return null;
          throw e;
        }
      },
      async () => {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return null;
        const space = await this.spaceId();
        // same set list_skills shows (stable skills only); an exact path wins over a "<dir>/<name>" match
        const rows = await this.restGet<{ path: string }[]>(
          `concepts?select=path&space_id=eq.${space}&kind=eq.skill&status=eq.stable&or=(path.eq.${name},path.like.*/${name})&order=path&limit=5`,
        );
        const path = (rows.find((r) => r.path === name) ?? rows.find((r) => skillNameOf(r.path) === name))?.path;
        if (!path) return null;
        const c = await this.rpc<Concept | null>("read_concept", { p_space: space, p_path: path });
        if (!c) return null;
        if (typeof c.id === "string") await this.logUsage(space, [c.id], "load_skill", name, opts.traceId);
        return { ...c, name: skillNameOf(c.path) };
      },
    );
  }

  /** Report missing / wrong / outdated / conflicting / unclear knowledge. */
  async flag(input: FlagInput): Promise<FlagResult> {
    if (!input?.observation?.trim()) throw new SupaknowledgeError("flag: `observation` is required");
    return this.route(
      async () => {
        const r = await this.mcp.callTool("flag_knowledge", {
          kind: input.kind,
          observation: input.observation,
          ...(input.conceptPath ? { concept_path: input.conceptPath } : {}),
          ...(input.query ? { query: input.query } : {}),
          ...(input.suggestedFix ? { suggested_fix: input.suggestedFix } : {}),
          ...(input.traceId ? { trace_id: input.traceId } : {}),
        });
        if (typeof r === "string") return { id: /[0-9a-f-]{36}/i.exec(r)?.[0] ?? null, message: r };
        const o = (r ?? {}) as Record<string, unknown>;
        return { ...o, id: (o.id ?? o.flag_id ?? null) as string | null };
      },
      async () => {
        const id = await this.rpc<string>("flag_knowledge", {
          p_space: await this.spaceId(),
          p_kind: input.kind,
          p_observation: input.observation,
          p_concept_path: input.conceptPath ?? null,
          p_query: input.query ?? null,
          p_suggested_fix: input.suggestedFix ?? null,
          p_trace: input.traceId ?? null,
          p_evidence: input.evidence ?? {},
        });
        return { id: id ?? null };
      },
    );
  }

  /** Report a background error the way trace recording does: to `onError`, else console.warn. Never throws. */
  reportError(error: unknown): void {
    try {
      (this.o.onError ?? ((err: unknown) => console.warn("[supaknowledge] trace:", err)))(error);
    } catch {
      /* never throw into the host app */
    }
  }

  /** Call any tool on the Supaknowledge MCP server. */
  callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.mcp.callTool(name, args);
  }

  // -------------------------------------------------------------------------------------------------------
  // traces
  // -------------------------------------------------------------------------------------------------------

  /** Start recording a trace. Recording never throws; errors go to `onError`. */
  trace(opts: TraceOptions = {}): TraceRecorder {
    const fnUrl = `${this.url}/functions/v1/traces`;
    return new TraceRecorder(
      {
        create: async (body) =>
          requestJson<{ trace_id: string }>(this.fetchFn, fnUrl, { method: "POST", headers: await this.authHeaders(), body: { space: this.space, ...body }, timeoutMs: this.o.timeoutMs ?? 30000 }),
        update: async (id, body) => {
          await requestJson(this.fetchFn, `${fnUrl}/${encodeURIComponent(id)}`, { method: "PATCH", headers: await this.authHeaders(), body, timeoutMs: this.o.timeoutMs ?? 30000 });
        },
        flag: (input) => this.flag(input),
      },
      opts,
      this.o.onError,
    );
  }

  // -------------------------------------------------------------------------------------------------------
  // integrations
  // -------------------------------------------------------------------------------------------------------

  /**
   * Tool definitions for search_knowledge, read_concept, list_skills, load_skill and flag_knowledge.
   * Default: OpenAI-compatible function tools. `{ format: "json-schema" }`: `{ name, description, inputSchema }`.
   */
  knowledgeTools(opts: KnowledgeToolsOptions & { format: "json-schema" }): JsonSchemaToolDefinition[];
  knowledgeTools(opts?: KnowledgeToolsOptions & { format?: "openai" }): FunctionToolDefinition[];
  knowledgeTools(opts?: KnowledgeToolsOptions): FunctionToolDefinition[] | JsonSchemaToolDefinition[];
  knowledgeTools(opts: KnowledgeToolsOptions = {}): FunctionToolDefinition[] | JsonSchemaToolDefinition[] {
    return knowledgeTools(opts);
  }

  /** Execute one Supaknowledge tool call (arguments as an object). Null when `name` is not a Supaknowledge tool. Never throws. */
  handleToolCall(name: string, input: unknown, opts: { prefix?: string; trace?: TraceRecorder } = {}): Promise<ToolCallResult | null> {
    return handleToolCall(this, name, input, opts);
  }

  /** Answer every Supaknowledge call in `calls` (e.g. an OpenAI `message.tool_calls`): `[{ tool_call_id, name, content, is_error? }]`. */
  handleToolCalls(calls: readonly ToolCallLike[], opts: { prefix?: string; trace?: TraceRecorder } = {}): Promise<ToolCallOutput[]> {
    return handleToolCalls(this, calls, opts);
  }

  /** MCP client config for this space (Claude Code, Cursor, Claude Desktop, generic). */
  mcpServerConfig(opts: Omit<McpConfigOptions, "url" | "space"> = {}): McpConfig {
    const auth = opts.auth ?? (this.o.apiKey ? "agent-key" : "oauth");
    return buildMcpConfig({ url: this.url, space: this.space, ...opts, auth, apiKey: opts.apiKey ?? (auth === "agent-key" ? this.o.apiKey : undefined) });
  }

  // -------------------------------------------------------------------------------------------------------
  // plumbing
  // -------------------------------------------------------------------------------------------------------

  private canRest(): boolean {
    return Boolean(this.o.accessToken && this.o.publishableKey);
  }

  private async token(): Promise<string> {
    if (this.o.apiKey) return this.o.apiKey;
    const t = this.o.accessToken!;
    return typeof t === "function" ? await t() : t;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const h: Record<string, string> = { ...(this.o.headers ?? {}), Authorization: `Bearer ${await this.token()}` };
    if (this.o.publishableKey) h.apikey = this.o.publishableKey;
    return h;
  }

  private async route<T>(viaMcp: () => Promise<T>, viaRest: () => Promise<T>): Promise<T> {
    if (this.mode === "rest") return viaRest();
    if (this.mode === "mcp" || !this.canRest()) return viaMcp();
    try {
      return await viaMcp();
    } catch (e) {
      if (!isNotDeployed(e)) throw e;
      this.mode = "rest"; // the mcp function is not deployed here; stop trying
      return viaRest();
    }
  }

  private async restHeaders(): Promise<Record<string, string>> {
    if (!this.o.publishableKey) throw new SupaknowledgeError("publishableKey is required for PostgREST calls");
    return { ...(this.o.headers ?? {}), apikey: this.o.publishableKey, Authorization: `Bearer ${await this.token()}` };
  }

  private async restGet<T>(path: string): Promise<T> {
    return requestJson<T>(this.fetchFn, `${this.url}/rest/v1/${path}`, { headers: await this.restHeaders(), timeoutMs: this.o.timeoutMs ?? 30000 });
  }

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    return requestJson<T>(this.fetchFn, `${this.url}/rest/v1/rpc/${fn}`, { method: "POST", headers: await this.restHeaders(), body: args, timeoutMs: this.o.timeoutMs ?? 30000 });
  }

  private async logUsage(space: string, ids: string[], via: string, query?: string, traceId?: string): Promise<void> {
    try {
      // p_trace is a uuid: an upstream id (OTel / LangSmith) would make the whole call fail, so it is left out
      const trace = traceId && UUID_RE.test(traceId) ? traceId : null;
      await this.rpc("log_concept_usage", { p_space: space, p_concepts: ids, p_via: via, p_query: query ?? null, p_trace: trace });
    } catch {
      /* usage logging is best effort */
    }
  }

  /** Resolve the space uuid (REST transport). */
  spaceId(): Promise<string> {
    this.spaceIdP ??= (async () => {
      if (UUID_RE.test(this.space)) return this.space;
      const m = /^([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/.exec(this.space);
      if (!m) throw new SupaknowledgeError(`space must be "<workspace>/<space>" or a uuid, got "${this.space}"`);
      const rows = await this.restGet<{ id: string }[]>(
        `spaces?select=id,workspaces!inner(slug)&slug=eq.${m[2]}&workspaces.slug=eq.${m[1]}&limit=1`,
      );
      if (!rows[0]) throw new SupaknowledgeError(`space "${this.space}" not found or not accessible`, { status: 404 });
      return rows[0].id;
    })().catch((e) => {
      this.spaceIdP = null;
      throw e;
    });
    return this.spaceIdP;
  }
}

/** Functional form: `const { tools, handleToolCall } = withSupaknowledge(kf)`. */
export function withSupaknowledge(kf: Supaknowledge, opts: KnowledgeToolsOptions & { trace?: TraceRecorder } = {}) {
  const callOpts = { prefix: opts.prefix, trace: opts.trace };
  return {
    tools: kf.knowledgeTools(opts),
    handleToolCall: (name: string, input: unknown) => kf.handleToolCall(name, input, callOpts),
    handleToolCalls: (calls: readonly ToolCallLike[]) => kf.handleToolCalls(calls, callOpts),
    isKnowledgeTool: (name: string) => knowledgeTools({ ...opts, format: "json-schema" }).some((t) => t.name === name),
  };
}
