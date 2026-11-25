// Remote MCP server (Streamable HTTP) for working agents.
//
//   POST /functions/v1/mcp[?space=<workspace>/<space>|<space-uuid>]      MCP endpoint
//   POST /functions/v1/mcp/<workspace>/<space>                             same, space in the path
//   GET  /functions/v1/mcp/.well-known/oauth-protected-resource            RFC 9728 metadata
//
// Auth: Bearer <Supabase JWT | OAuth 2.1 access token | skn_<agent>_<secret>>. Every tool runs through the
// caller's RLS-scoped client, so an agent sees exactly what its Auth user may see. Unauthenticated
// requests get 401 + WWW-Authenticate pointing at the protected-resource metadata so MCP clients can run
// the Supabase Auth OAuth 2.1 flow.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { skillName } from "../_shared/core/formats.ts";
import { authenticate, type Caller } from "../_shared/auth.ts";
import { embed, toVector } from "../_shared/embed.ts";
import { corsHeaders, errorResponse, HttpError, json } from "../_shared/http.ts";
import { isUuid, listSpaces, resolveSpace, type SpaceInfo, subpath } from "../_lib/api.ts";
import { flagEvidence } from "./evidence.ts";
import { baseCacheHeaders, escapeLike, normalizeConceptPath, publicBase } from "./urls.ts";

const SERVER_INFO = { name: "supaknowledge", version: "0.1.0" };

const INSTRUCTIONS = `Supaknowledge is your team's curated company knowledge: skills (how to do the work), domain knowledge (how the business works) and data-access notes (where live data lives and how to query it).

How to use it:
1. Before starting a task, call search_knowledge with what you are trying to do. Prefer what you find here over guesses.
2. Call read_concept for the full text of a promising result, and list_skills / load_skill for step-by-step procedures.
3. Treat results marked unverified or stale with care and double-check them against reality.
4. ALWAYS call flag_knowledge when knowledge was missing, wrong, outdated, conflicting or unclear, or when you had to work something out yourself (a renamed column, an undocumented step, a workaround). Flags are cheap and are how this knowledge gets fixed; a background curator turns them into updates that a human reviews.`;

// ---------------------------------------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------------------------------------
const mcpUrl = (req: Request) => `${publicBase(req).base}/functions/v1/mcp`;
const metadataUrl = (req: Request) => `${mcpUrl(req)}/.well-known/oauth-protected-resource`;

function protectedResourceMetadata(req: Request) {
  return {
    resource: mcpUrl(req),
    authorization_servers: [`${publicBase(req).base}/auth/v1`],
    bearer_methods_supported: ["header"],
    resource_name: "Supaknowledge knowledge factory",
  };
}

function unauthorized(req: Request, message: string, invalidToken: boolean): Response {
  const challenge = invalidToken
    ? `Bearer error="invalid_token", error_description="${message.replace(/"/g, "'")}", resource_metadata="${metadataUrl(req)}"`
    : `Bearer resource_metadata="${metadataUrl(req)}"`;
  return json({ error: message }, 401, { "WWW-Authenticate": challenge, ...(publicBase(req).fromHeaders ? baseCacheHeaders(req) : {}) });
}

// ---------------------------------------------------------------------------------------------------------
// tool plumbing
// ---------------------------------------------------------------------------------------------------------
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], isError: true });
const asJson = (v: unknown) => JSON.stringify(v, null, 2);

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

interface Ctx {
  caller: Caller;
  /** space from the URL, if any */
  urlSpace: string | null;
  spaceCache: Map<string, SpaceInfo>;
}

/** Space for a tool call: tool argument > URL > the caller's only space. */
async function pickSpace(ctx: Ctx, arg?: string): Promise<SpaceInfo> {
  const ref = arg?.trim() || ctx.urlSpace;
  if (ref) {
    const hit = ctx.spaceCache.get(ref);
    if (hit) return hit;
    const s = await resolveSpace(ctx.caller.db, ref);
    ctx.spaceCache.set(ref, s);
    return s;
  }
  const spaces = await listSpaces(ctx.caller.db);
  if (spaces.length === 1) return spaces[0];
  if (!spaces.length) throw new HttpError(403, "you do not have access to any knowledge space");
  throw new HttpError(
    400,
    `several spaces are available; pass space="<workspace>/<space>" (one of: ${spaces.map((s) => s.ref).join(", ")}) or connect with ?space=...`,
  );
}

/**
 * trace_id may be a Supaknowledge trace uuid or the upstream id (e.g. an OTel trace id) the agent sent to the
 * traces endpoint. Only the caller's own traces resolve (RLS + explicit principal filter).
 */
async function resolveTrace(ctx: Ctx, space: SpaceInfo, traceId?: string): Promise<string | null> {
  if (!traceId?.trim()) return null;
  const t = traceId.trim();
  let q = ctx.caller.db.from("traces").select("id").eq("space_id", space.id).eq("principal_id", ctx.caller.userId);
  q = isUuid(t) ? q.or(`id.eq.${t},external_id.eq.${t}`) : q.eq("external_id", t);
  const { data } = await q.limit(1);
  return (data?.[0] as { id: string } | undefined)?.id ?? null;
}

/** Usage logging is best-effort: it must never break the agent's actual work. */
async function logUsage(ctx: Ctx, space: SpaceInfo, ids: string[], via: string, query: string | null, trace: string | null) {
  if (!ids.length) return;
  const { error } = await ctx.caller.db.rpc("log_concept_usage", { p_space: space.id, p_concepts: ids, p_via: via, p_query: query, p_trace: trace });
  if (error) console.warn("log_concept_usage failed:", error.message);
}

const spaceArg = z.string().optional().describe(
  'Knowledge space as "<workspace>/<space>" or its uuid. Optional when the MCP URL already selects a space or you can access only one.',
);
const traceArg = z.string().optional().describe(
  "Optional id of the trace you are recording for this task (Supaknowledge trace id or the id you sent as external_id / OTel trace id). Links this call to your trace.",
);

const TEXT_EXT = /\.(md|markdown|txt|py|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|sql|json|jsonc|ya?ml|toml|ini|cfg|csv|tsv|html?|css|xml|r|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|pl|lua|env\.example|tmpl|tpl|j2|jinja|graphql|gql|proto)$/i;
const MAX_INLINE_FILE = 32 * 1024;
const MAX_INLINE_TOTAL = 128 * 1024;

// ---------------------------------------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------------------------------------
function buildServer(ctx: Ctx): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  const { caller } = ctx;

  server.registerTool(
    "list_spaces",
    {
      title: "List knowledge spaces",
      description:
        "List the knowledge spaces (one knowledge factory per team or agent) you can access, as \"<workspace>/<space>\" references. Call this when a tool asks you to choose a space.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const spaces = await listSpaces(caller.db);
        const current = ctx.urlSpace;
        return text(asJson({
          spaces: spaces.map((s) => ({
            space: s.ref,
            id: s.id,
            name: s.name,
            description: s.description,
            selected: current ? current === s.ref || current === s.id : spaces.length === 1,
          })),
        }));
      } catch (e) {
        return fail(`list_spaces failed: ${errMessage(e)}`);
      }
    },
  );

  server.registerTool(
    "search_knowledge",
    {
      title: "Search company knowledge",
      description:
        "Search the team's curated knowledge before you start a task or whenever you are unsure how something works: procedures (skills), business definitions and policies (domain), and where live data lives / how to query it (data_access). " +
        "Hybrid keyword + semantic search. Returns path, title, description, a snippet, the trust tier (unverified | machine_confirmed | human_reviewed) and whether it is stale. " +
        "Use read_concept(path) for the full text. If nothing relevant comes back, call flag_knowledge with kind=\"missing\".",
      inputSchema: z.object({
        query: z.string().min(1).describe("What you are trying to do or find, in natural language, e.g. \"how is ARR calculated\" or \"which table has invoices\"."),
        kinds: z.array(z.enum(["skill", "domain", "data_access"])).optional().describe("Restrict to these kinds of knowledge."),
        limit: z.number().int().min(1).max(25).optional().describe("Maximum results (default 8)."),
        space: spaceArg,
        trace_id: traceArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, kinds, limit, space, trace_id }) => {
      try {
        const sp = await pickSpace(ctx, space);
        let vector: string | null = null;
        try {
          vector = toVector(await embed(query));
        } catch (e) {
          console.warn("query embedding failed, falling back to keyword search:", errMessage(e));
        }
        const { data, error } = await caller.db.rpc("search_knowledge", {
          p_space: sp.id,
          p_query: query,
          p_embedding: vector,
          p_kinds: kinds?.length ? kinds : null,
          p_limit: limit ?? 8,
        });
        if (error) return fail(`search failed: ${error.message}`);
        const rows = (data ?? []) as {
          concept_id: string; path: string; kind: string; type: string; title: string; description: string;
          snippet: string; trust: string; stale: boolean; status: string; score: number;
        }[];
        const trace = await resolveTrace(ctx, sp, trace_id);
        await logUsage(ctx, sp, rows.map((r) => r.concept_id), "search", query, trace);
        if (!rows.length) {
          return text(asJson({
            space: sp.ref,
            results: [],
            hint: "Nothing matched. If this knowledge should exist, call flag_knowledge with kind=\"missing\", your query, and what you needed it for.",
          }));
        }
        return text(asJson({
          space: sp.ref,
          results: rows.map((r) => ({
            path: r.path,
            title: r.title,
            description: r.description,
            kind: r.kind,
            type: r.type,
            trust: r.trust,
            stale: r.stale,
            ...(r.status !== "stable" ? { status: r.status } : {}),
            snippet: r.snippet,
          })),
          hint: "Call read_concept(path) for the full text (load_skill(name) for skills). Flag anything missing, wrong or outdated with flag_knowledge.",
        }));
      } catch (e) {
        return fail(`search_knowledge failed: ${errMessage(e)}`);
      }
    },
  );

  server.registerTool(
    "read_concept",
    {
      title: "Read a knowledge concept",
      description:
        "Read the full markdown of one knowledge concept by its path (from search_knowledge results or links in other concepts), with its type, trust tier, staleness, outgoing links and attached files. " +
        "If what you read turns out to be wrong or outdated while you work, call flag_knowledge with this path.",
      inputSchema: z.object({
        path: z.string().min(1).describe('Concept path, e.g. "metrics/arr" (no ".md").'),
        space: spaceArg,
        trace_id: traceArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ path, space, trace_id }) => {
      try {
        const sp = await pickSpace(ctx, space);
        const p = normalizeConceptPath(path) ?? "";
        const { data, error } = await caller.db.rpc("read_concept", { p_space: sp.id, p_path: p });
        if (error) return fail(`read_concept failed: ${error.message}`);
        if (!data) {
          return fail(`No concept at "${p}" in ${sp.ref}. Try search_knowledge; if it should exist, call flag_knowledge with kind="missing".`);
        }
        const c = data as {
          id: string; path: string; kind: string; type: string; title: string; description: string; body: string;
          tags: string[]; status: string; superseded_by: string | null; stale: boolean; stale_after: string | null;
          trust: string; revision: number; generated_by: string | null; generated_at: string;
          links: { path: string; anchor: string | null; exists: boolean }[];
          backlinks: { path: string; title: string }[];
          files: { path: string; size_bytes: number | null }[];
        };
        await logUsage(ctx, sp, [c.id], "read", null, await resolveTrace(ctx, sp, trace_id));
        const meta = [
          `path: ${c.path}`,
          `kind: ${c.kind} | type: ${c.type} | status: ${c.status} | revision: ${c.revision}`,
          `trust: ${c.trust}${c.stale ? ` | STALE (stale_after ${c.stale_after})` : ""}`,
          c.tags?.length ? `tags: ${c.tags.join(", ")}` : null,
          c.superseded_by ? `superseded_by: ${c.superseded_by} (read that instead)` : null,
          c.generated_by ? `last changed by ${c.generated_by} at ${c.generated_at}` : null,
        ].filter(Boolean);
        const warn = [
          c.trust === "unverified" ? "> Unverified: no human has reviewed this revision. Double-check before relying on it." : null,
          c.stale ? "> Stale: this may be out of date. Verify against the live system, and flag it if it is wrong." : null,
          c.status === "deprecated" ? "> Deprecated." : null,
        ].filter(Boolean);
        const parts = [
          `# ${c.title}`,
          c.description ? `_${c.description}_` : "",
          meta.join("\n"),
          warn.join("\n"),
          "---",
          c.body.trim(),
        ];
        if (c.links?.length) {
          parts.push("---", "Links:", ...c.links.map((l) => `- ${l.path}${l.anchor ? ` (${l.anchor})` : ""}${l.exists ? "" : " [missing]"}`));
        }
        if (c.backlinks?.length) parts.push("Referenced by:", ...c.backlinks.map((b) => `- ${b.path} (${b.title})`));
        if (c.files?.length) {
          parts.push("Files:", ...c.files.map((f) => `- ${f.path} (${f.size_bytes == null ? "unknown size" : `${f.size_bytes} bytes`})`));
          if (c.kind === "skill") parts.push(`Use load_skill("${skillName(c.path)}") to get the file contents.`);
        }
        return text(parts.filter((x) => x !== "").join("\n\n"));
      } catch (e) {
        return fail(`read_concept failed: ${errMessage(e)}`);
      }
    },
  );

  server.registerTool(
    "list_skills",
    {
      title: "List skills",
      description:
        "List the skills (step-by-step procedures, templates and scripts for doing the work) available in this space: name and a description of what each does and when to use it. " +
        "Check this at the start of a task; then load_skill(name) for the full instructions of any skill that applies.",
      inputSchema: z.object({ space: spaceArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ space }) => {
      try {
        const sp = await pickSpace(ctx, space);
        const { data, error } = await caller.db
          .from("concepts")
          .select("path, title, description, status")
          .eq("space_id", sp.id)
          .eq("kind", "skill")
          .neq("status", "deprecated")
          .neq("status", "draft")
          .order("path")
          .limit(500);
        if (error) return fail(`list_skills failed: ${error.message}`);
        const skills = (data ?? []).map((s: { path: string; title: string; description: string }) => ({
          name: skillName(s.path),
          description: s.description,
          title: s.title,
          path: s.path,
        }));
        return text(asJson({
          space: sp.ref,
          skills,
          hint: skills.length ? "Call load_skill(name) for the full instructions." : "No skills yet. If you needed a procedure that does not exist, flag it with flag_knowledge(kind=\"missing\").",
        }));
      } catch (e) {
        return fail(`list_skills failed: ${errMessage(e)}`);
      }
    },
  );

  server.registerTool(
    "load_skill",
    {
      title: "Load a skill",
      description:
        "Load the full instructions (SKILL.md body) of a skill by name, plus its attached files (scripts, templates, references). Small text files are included inline. " +
        "Follow the skill when doing the task; if a step is wrong or missing, call flag_knowledge with the skill's path.",
      inputSchema: z.object({
        name: z.string().min(1).describe('Skill name from list_skills (e.g. "revenue-report") or its full path (e.g. "skills/revenue-report").'),
        space: spaceArg,
        trace_id: traceArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ name, space, trace_id }) => {
      try {
        const sp = await pickSpace(ctx, space);
        const n = normalizeConceptPath(name) ?? "";
        if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(n) || n.includes("..")) return fail(`invalid skill name "${name}"`);
        type SkillRow = { id: string; path: string; title: string; description: string; body: string; status: string; revision: number; stale_after: string | null };
        const base = () =>
          caller.db
            .from("concepts")
            .select("id, path, title, description, body, status, revision, stale_after")
            .eq("space_id", sp.id)
            .eq("kind", "skill")
            .neq("status", "draft");
        // exact path first; then skills whose last path segment is the name (LIKE wildcards escaped)
        const exact = await base().eq("path", n).limit(1);
        if (exact.error) return fail(`load_skill failed: ${exact.error.message}`);
        let skill = (exact.data ?? [])[0] as SkillRow | undefined;
        if (!skill) {
          const suffix = await base().like("path", `%/${escapeLike(n)}`).order("path").limit(50);
          if (suffix.error) return fail(`load_skill failed: ${suffix.error.message}`);
          const rows = (suffix.data ?? []) as SkillRow[];
          // prefer a non-deprecated match
          const hits = rows.filter((r) => r.path.endsWith(`/${n}`)).sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
          skill = hits.find((r) => r.status !== "deprecated") ?? hits[0];
        }
        if (!skill) {
          return fail(`No skill named "${n}" in ${sp.ref}. Use list_skills to see what exists; if you needed one, call flag_knowledge with kind="missing".`);
        }
        const { data: files } = await caller.db
          .from("concept_files")
          .select("path, storage_path, content_type, size_bytes")
          .eq("concept_id", skill.id)
          .order("path");
        const out: string[] = [
          `# Skill: ${skillName(skill.path)}`,
          `path: ${skill.path} | revision: ${skill.revision}${skill.status !== "stable" ? ` | status: ${skill.status}` : ""}`,
          `description: ${skill.description}`,
          "---",
          skill.body.trim(),
        ];
        const list = (files ?? []) as { path: string; storage_path: string; content_type: string | null; size_bytes: number | null }[];
        if (list.length) {
          out.push("---", "## Files");
          let budget = MAX_INLINE_TOTAL;
          for (const f of list) {
            const size = f.size_bytes ?? 0;
            const isText = (f.content_type?.startsWith("text/") ?? false) || /json|yaml|xml|javascript|x-sh|x-python|sql/.test(f.content_type ?? "") || TEXT_EXT.test(f.path);
            if (isText && size <= MAX_INLINE_FILE && size <= budget) {
              // Storage RLS: readers of the concept can read its files, so the caller's own client is enough.
              const dl = await caller.db.storage.from("concept-files").download(f.storage_path);
              if (!dl.error && dl.data) {
                const content = (await dl.data.text()).replace(/\n+$/, "");
                budget -= content.length;
                const lang = f.path.split(".").pop() ?? "";
                out.push(`### ${f.path}`, "```" + lang + "\n" + content.replace(/```/g, "``​`") + "\n```");
                continue;
              }
            }
            out.push(`### ${f.path}`, `(${isText ? "not inlined" : "binary"}; ${size} bytes; storage: concept-files/${f.storage_path})`);
          }
        }
        await logUsage(ctx, sp, [skill.id], "load_skill", null, await resolveTrace(ctx, sp, trace_id));
        return text(out.join("\n\n"));
      } catch (e) {
        return fail(`load_skill failed: ${errMessage(e)}`);
      }
    },
  );

  server.registerTool(
    "flag_knowledge",
    {
      title: "Flag missing or wrong knowledge",
      description:
        "Report a problem with the team's knowledge. Call this EVERY time knowledge was missing, incorrect, outdated, conflicting or unclear, or when you had to figure something out yourself " +
        "(e.g. a column was renamed, a step was undocumented, you needed a workaround, a human corrected you). It is cheap, never blocks your task, and is the only way the knowledge gets fixed: " +
        "a curator turns flags into reviewed updates. Be specific: what you tried, what you observed (exact errors, names, values), and what the knowledge should say.",
      inputSchema: z.object({
        kind: z.enum(["missing", "incorrect", "outdated", "conflicting", "unclear"]).describe(
          "missing: nothing covers it; incorrect: it is wrong; outdated: it used to be right; conflicting: two concepts disagree; unclear: ambiguous or hard to follow.",
        ),
        observation: z.string().min(1).describe('What you saw, concretely, e.g. "column revenue_usd does not exist in analytics.invoices; found revenue_usd_net".'),
        concept_path: z.string().optional().describe("Path of the concept this is about, if any (omit for missing knowledge)."),
        query: z.string().optional().describe("What you were trying to do or searched for."),
        suggested_fix: z.string().optional().describe("What the knowledge should say instead, if you know."),
        evidence: z
          .record(z.string(), z.unknown())
          .optional()
          .refine((e) => e === undefined || JSON.stringify(e).length <= 16_000, "evidence must be at most 16,000 characters of JSON")
          .describe("Optional structured details (e.g. the failing query and the exact error) as a JSON object."),
        space: spaceArg,
        trace_id: traceArg,
      }),
    },
    async ({ kind, observation, concept_path, query, suggested_fix, evidence, space, trace_id }) => {
      try {
        const sp = await pickSpace(ctx, space);
        const trace = await resolveTrace(ctx, sp, trace_id);
        const { data, error } = await caller.db.rpc("flag_knowledge", {
          p_space: sp.id,
          p_kind: kind,
          p_observation: observation,
          p_concept_path: normalizeConceptPath(concept_path),
          p_query: query ?? null,
          p_suggested_fix: suggested_fix ?? null,
          p_trace: trace,
          // the caller's evidence with the server-owned keys (via, client_id, trace_ref) set or stripped by the server
          p_evidence: flagEvidence(evidence, caller.clientId, trace_id, trace),
        });
        if (error) return fail(`flag_knowledge failed: ${error.message}`);
        return text(asJson({ flag_id: data, space: sp.ref, status: "open", message: "Thanks. The curator will review this flag." }));
      } catch (e) {
        return fail(`flag_knowledge failed: ${errMessage(e)}`);
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------------------------------------
// HTTP entry
// ---------------------------------------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const path = subpath(req, "mcp");

  if (path.endsWith("/.well-known/oauth-protected-resource")) {
    return json(protectedResourceMetadata(req), 200, baseCacheHeaders(req));
  }

  // space from the path (/mcp/<workspace>/<space> or /mcp/<uuid>); malformed percent-encoding is a 400
  let fromPath: string | null = null;
  try {
    fromPath = path === "/" ? null : decodeURIComponent(path.slice(1));
  } catch {
    return json({ error: "malformed URL path" }, 400);
  }

  let caller: Caller;
  try {
    caller = await authenticate(req);
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : "authentication failed";
    return unauthorized(req, msg, !!req.headers.get("authorization"));
  }

  // space from ?space= or the path
  const url = new URL(req.url);
  const urlSpace = url.searchParams.get("space")?.trim() || fromPath || null;

  const ctx: Ctx = { caller, urlSpace, spaceCache: new Map() };
  const handler = createMcpHandler(() => buildServer(ctx), {
    onerror: (e) => console.error("mcp:", e.message),
  });
  try {
    const res = await handler.fetch(req, {
      authInfo: { token: caller.accessToken, clientId: caller.clientId ?? (caller.kind === "agent" ? `agent:${caller.userId}` : "supabase"), scopes: [], extra: { userId: caller.userId, kind: caller.kind } },
    });
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(corsHeaders)) if (!headers.has(k)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  } catch (e) {
    return errorResponse(e);
  }
  // No handler.close() here: it would abort a response that is still streaming (SSE). The handler is
  // per request and holds nothing once the exchange ends.
});
