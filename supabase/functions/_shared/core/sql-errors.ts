// SQL tool calls in agent traces: the Supabase MCP server's tools (execute_sql, apply_migration, list_tables,
// list_migrations) and any other tool that runs SQL. Recognises the tool, parses Postgres errors (SQLSTATE codes
// and messages) into a condition plus the identifiers involved, and redacts SQL so literals and row data never
// reach a flag or a stored trace.
//
// Pure and dependency-free: trace ingest (supabase/functions/traces) imports this file directly, and the
// curator's correction mining (curator/corrections.ts) turns the parsed errors into synthetic flags.

/** Tools of the Supabase MCP server that Supaknowledge recognises by name. */
export const SUPABASE_MCP_TOOLS = ["execute_sql", "apply_migration", "list_tables", "list_migrations"] as const;
export type SupabaseMcpTool = (typeof SUPABASE_MCP_TOOLS)[number];
/** The Supabase MCP tools whose input is SQL (`query`). */
export const SUPABASE_MCP_SQL_TOOLS: readonly SupabaseMcpTool[] = ["execute_sql", "apply_migration"];

export interface McpToolName {
  /** the tool's own name, e.g. "execute_sql" */
  tool: string;
  /** the MCP server name the client put in front of it ("supabase"), or null for a bare name */
  server: string | null;
}

const SEPARATORS = new Set(["_", ".", "/", ":", "-"]);

/**
 * Split a tool name as MCP clients present it into server and tool, when the tool is one of `tools`:
 * `mcp__supabase__execute_sql` (Claude Code), `supabase_execute_sql` (Mastra's MCP client), `supabase.execute_sql`,
 * `supabase/execute_sql` and a bare `execute_sql` all give `{ tool: "execute_sql" }`.
 */
export function splitToolName(name: unknown, tools: readonly string[]): McpToolName | null {
  if (typeof name !== "string" || !name) return null;
  const n = name.trim().toLowerCase();
  for (const tool of tools) {
    if (n === tool) return { tool, server: null };
    if (n.length > tool.length && n.endsWith(tool) && SEPARATORS.has(n[n.length - tool.length - 1]!)) {
      let prefix = n.slice(0, n.length - tool.length);
      while (prefix && SEPARATORS.has(prefix[prefix.length - 1]!)) prefix = prefix.slice(0, -1);
      prefix = prefix.replace(/^mcp(?:__|[_.:/-])/, "");
      return { tool, server: prefix || null };
    }
  }
  return null;
}

/** A Supabase MCP tool name (`mcp__supabase__execute_sql`, `supabase_list_tables`, `execute_sql`...), or null. */
export function supabaseMcpTool(name: unknown): (McpToolName & { tool: SupabaseMcpTool }) | null {
  return splitToolName(name, SUPABASE_MCP_TOOLS) as (McpToolName & { tool: SupabaseMcpTool }) | null;
}

/** Supaknowledge's own knowledge tools, by any prefix (`mcp__supaknowledge__read_concept`, `kf_read_concept`...). */
export function knowledgeTool(name: unknown): McpToolName | null {
  return splitToolName(name, ["read_concept", "load_skill", "search_knowledge"]);
}

const SQL_START = /^\s*(?:\(\s*)*(?:with|select|insert|update|delete|merge|create|alter|drop|grant|revoke|truncate|explain|copy|do|call|comment|begin|set|values|table)\b/i;

/** The SQL text of a tool input: `query` (Supabase MCP), `sql`, or the input itself when it is SQL text. */
export function sqlOfInput(input: unknown): string | null {
  if (typeof input === "string") return SQL_START.test(input) ? input : null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  for (const k of ["query", "sql", "statement"]) {
    const v = o[k];
    if (typeof v === "string" && SQL_START.test(v)) return v;
  }
  return null;
}

export interface SqlToolCall {
  /** "execute_sql", "apply_migration", or the event's own tool name for other SQL tools */
  tool: string;
  server: string | null;
  /** true for the Supabase MCP server's tools (recognised by name) */
  supabase_mcp: boolean;
  sql: string | null;
}

/**
 * Is this tool event a SQL call? The Supabase MCP server's SQL tools are recognised by name (whatever the client
 * prefix); any other tool counts when its input is SQL (`{ query }`, `{ sql }`).
 */
export function sqlToolCall(e: { tool_name?: string | null; tool_input?: unknown }): SqlToolCall | null {
  const mcp = supabaseMcpTool(e.tool_name);
  if (mcp && SUPABASE_MCP_SQL_TOOLS.includes(mcp.tool)) return { tool: mcp.tool, server: mcp.server, supabase_mcp: true, sql: sqlOfInput(e.tool_input) };
  const sql = sqlOfInput(e.tool_input);
  if (sql && e.tool_name) return { tool: e.tool_name, server: null, supabase_mcp: false, sql };
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Postgres errors
// ---------------------------------------------------------------------------------------------------------

export type PgCondition =
  | "undefined_column"
  | "undefined_table"
  | "undefined_function"
  | "undefined_object"
  | "invalid_schema_name"
  | "insufficient_privilege"
  | "rls_violation"
  | "invalid_enum_value"
  | "syntax_error"
  | "other";

/** Conditions that point at missing or wrong knowledge (a wrong name, a missing permission, an unknown enum value). */
export const KNOWLEDGE_CONDITIONS: ReadonlySet<PgCondition> = new Set([
  "undefined_column",
  "undefined_table",
  "undefined_function",
  "undefined_object",
  "invalid_schema_name",
  "insufficient_privilege",
  "rls_violation",
  "invalid_enum_value",
]);

const CONDITION_CODES: Record<string, PgCondition> = {
  "42703": "undefined_column",
  "42P01": "undefined_table",
  "42883": "undefined_function",
  "42704": "undefined_object",
  "3F000": "invalid_schema_name",
  "42501": "insufficient_privilege",
  "42601": "syntax_error",
};

const DEFAULT_CODES: Partial<Record<PgCondition, string>> = {
  undefined_column: "42703",
  undefined_table: "42P01",
  undefined_function: "42883",
  undefined_object: "42704",
  invalid_schema_name: "3F000",
  insufficient_privilege: "42501",
  rls_violation: "42501",
  invalid_enum_value: "22P02",
  syntax_error: "42601",
};

export interface PgIdentifiers {
  column?: string;
  relation?: string;
  schema?: string;
  function?: string;
  operator?: string;
  type?: string;
  role?: string;
  /** the rejected enum value (a label the agent wrote, not row data) */
  value?: string;
  /** what Postgres suggested in its hint ("Perhaps you meant to reference the column ...") */
  suggestion?: string;
}

export interface PgError {
  /** SQLSTATE, from the error or implied by the message */
  code: string | null;
  condition: PgCondition;
  /** the primary message, values redacted */
  message: string;
  detail?: string;
  hint?: string;
  identifiers: PgIdentifiers;
  /** whether knowledge could have prevented it (see KNOWLEDGE_CONDITIONS) */
  knowledge: boolean;
}

const SQLSTATE = /^(?:[0-5][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}$/;
const ID = String.raw`"?([A-Za-z_\u0080-￿][\w$\u0080-￿]*(?:"?\."?[A-Za-z_\u0080-￿][\w$\u0080-￿]*)*)"?`;

const PATTERNS: [RegExp, PgCondition, (m: RegExpExecArray) => PgIdentifiers][] = [
  [/column "([^"]+)" of relation "([^"]+)" does not exist/i, "undefined_column", (m) => ({ column: m[1], relation: m[2] })],
  [/column "([^"]+)" does not exist/i, "undefined_column", (m) => ({ column: m[1] })],
  [new RegExp(String.raw`column ${ID} does not exist`, "i"), "undefined_column", (m) => ({ column: unquote(m[1]!) })],
  [/relation "([^"]+)" does not exist/i, "undefined_table", (m) => ({ relation: m[1] })],
  [/table "([^"]+)" does not exist/i, "undefined_table", (m) => ({ relation: m[1] })],
  [/schema "([^"]+)" does not exist/i, "invalid_schema_name", (m) => ({ schema: m[1] })],
  [/function ([^\s(]+)\(([^)]*)\) does not exist/i, "undefined_function", (m) => ({ function: `${unquote(m[1]!)}(${m[2]})` })],
  [/operator does not exist: ([^\n]+)/i, "undefined_function", (m) => ({ operator: m[1]!.trim() })],
  [/type "([^"]+)" does not exist/i, "undefined_object", (m) => ({ type: m[1] })],
  [/role "([^"]+)" does not exist/i, "undefined_object", (m) => ({ role: m[1] })],
  [/new row violates row-level security policy(?: "[^"]*")? for table "([^"]+)"/i, "rls_violation", (m) => ({ relation: m[1] })],
  [new RegExp(String.raw`permission denied for (table|relation|view|materialized view|sequence) ${ID}`, "i"), "insufficient_privilege", (m) => ({ relation: unquote(m[2]!) })],
  [new RegExp(String.raw`permission denied for schema ${ID}`, "i"), "insufficient_privilege", (m) => ({ schema: unquote(m[1]!) })],
  [new RegExp(String.raw`permission denied for function ${ID}`, "i"), "insufficient_privilege", (m) => ({ function: unquote(m[1]!) })],
  [/permission denied/i, "insufficient_privilege", () => ({})],
  [/invalid input value for enum ([^:]+): "([^"]*)"/i, "invalid_enum_value", (m) => ({ type: unquote(m[1]!.trim()), value: m[2] })],
  [/syntax error at or near "[^"]*"|syntax error at end of input/i, "syntax_error", () => ({})],
];

function unquote(s: string): string {
  return s.replace(/"/g, "");
}

interface Collected {
  texts: string[];
  code?: string;
  hint?: string;
  detail?: string;
}

/** Pull the text out of an error payload: strings, JSON strings, `{ error }`, `{ message, code, hint, details }`, MCP content parts. */
function collect(v: unknown, out: Collected, depth = 0): void {
  if (depth > 6 || v === null || v === undefined) return;
  if (typeof v === "string") {
    const t = v.trim();
    if ((t.startsWith("{") || t.startsWith("[")) && t.length < 200_000) {
      try {
        collect(JSON.parse(t), out, depth + 1);
        return;
      } catch {
        /* not JSON: keep the text */
      }
    }
    out.texts.push(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v.slice(0, 20)) collect(x, out, depth + 1);
    return;
  }
  if (typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  if (typeof o.code === "string" && SQLSTATE.test(o.code) && !out.code) out.code = o.code;
  if (typeof o.hint === "string" && !out.hint) out.hint = o.hint;
  const detail = typeof o.details === "string" ? o.details : typeof o.detail === "string" ? o.detail : undefined;
  if (detail && !out.detail) out.detail = detail;
  for (const k of ["message", "error", "text", "content", "value", "cause", "result"]) if (k in o) collect(o[k], out, depth + 1);
}

/** Remove values from error text: unique-violation keys, failing rows, invalid input values. */
export function redactErrorText(s: string): string {
  return s
    .replace(/(Key \(([^)]*)\))=\((?:[^()]|\([^()]*\))*\)/g, "$1=(?)")
    .replace(/(Failing row contains )\((?:[^()]|\([^()]*\))*\)/g, "$1(?)")
    .replace(/(invalid input syntax for (?:type )?[\w ]+: )"[^"]*"/gi, '$1"?"')
    .replace(/(value too long for type [^\n]*?)(?:: "[^"]*")?$/gim, "$1");
}

function firstLine(s: string, re: RegExp): string {
  const line = s.split("\n").find((l) => re.test(l)) ?? s.split("\n").find((l) => l.trim()) ?? s;
  return line.trim();
}

/**
 * Parse a Postgres error out of a tool result (a string, JSON, `{ error: { message } }`, PostgREST's
 * `{ code, message, details, hint }` or an MCP `content` array). Returns null when there is no recognisable
 * Postgres error. Messages are redacted (see redactErrorText) and clipped.
 */
export function parsePgError(output: unknown): PgError | null {
  const c: Collected = { texts: [] };
  collect(output, c);
  const text = c.texts.join("\n");
  if (!text && !c.code) return null;
  let code = c.code ?? null;
  if (!code) {
    const m = /\b(?:ERROR|FATAL):\s+([0-9A-Z]{5}):/.exec(text) ?? /SQLSTATE[\s:=[(]*([0-9A-Z]{5})/i.exec(text) ?? /"code"\s*:\s*"([0-9A-Z]{5})"/.exec(text);
    if (m && SQLSTATE.test(m[1]!)) code = m[1]!;
  }
  let condition: PgCondition | null = null;
  let identifiers: PgIdentifiers = {};
  let message = "";
  for (const [re, cond, ids] of PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    // a bare "permission denied" only counts as a Postgres error when a SQLSTATE says so
    if (cond === "insufficient_privilege" && !Object.keys(ids(m)).length && code !== "42501") continue;
    condition = cond;
    identifiers = ids(m);
    message = firstLine(text.slice(Math.max(0, text.lastIndexOf("\n", m.index) + 1)), re);
    break;
  }
  if (!condition) {
    if (!code) return null;
    condition = CONDITION_CODES[code] ?? "other";
    message = firstLine(text, /ERROR|error/);
  }
  const hint = c.hint ?? /HINT:\s+([^\n]+)/.exec(text)?.[1];
  const detail = c.detail ?? /DETAIL:\s+([^\n]+)/.exec(text)?.[1];
  const suggestion = hint ? /Perhaps you meant to reference the column "([^"]+)"/i.exec(hint)?.[1] : undefined;
  if (suggestion) identifiers.suggestion = suggestion;
  message = message.replace(/^(?:\{?"?error"?:?\s*)?(?:Failed to run sql query:\s*)?(?:ERROR|FATAL):\s+(?:[0-9A-Z]{5}:\s*)?/i, "");
  return {
    code: code ?? DEFAULT_CODES[condition] ?? null,
    condition,
    message: clip(redactErrorText(message), 300),
    ...(detail ? { detail: clip(redactErrorText(detail.trim()), 300) } : {}),
    ...(hint ? { hint: clip(redactErrorText(hint.trim()), 300) } : {}),
    identifiers,
    knowledge: KNOWLEDGE_CONDITIONS.has(condition),
  };
}

/** An MCP CallToolResult that reports a tool error (`{ content, isError: true }`), also as a JSON string. */
export function isMcpErrorResult(output: unknown): boolean {
  let o = output;
  if (typeof o === "string" && o.trimStart().startsWith("{") && o.length < 200_000) {
    try {
      o = JSON.parse(o);
    } catch {
      return false;
    }
  }
  return !!o && typeof o === "object" && !Array.isArray(o) && (o as Record<string, unknown>).isError === true;
}

// ---------------------------------------------------------------------------------------------------------
// redaction
// ---------------------------------------------------------------------------------------------------------

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function skipQuoted(sql: string, i: number, q: string, backslash = false): number {
  let j = i + 1;
  while (j < sql.length) {
    const ch = sql[j]!;
    if (backslash && ch === "\\") j += 2;
    else if (ch === q) {
      if (sql[j + 1] === q) j += 2;
      else return j + 1;
    } else j++;
  }
  return sql.length;
}

const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_PART = /[A-Za-z0-9_$\u0080-￿]/;

/**
 * Redact SQL for evidence: string literals become `'?'`, numbers `?`, comments are dropped; identifiers,
 * keywords, quoted identifiers and `$1` parameters stay, so the statement's shape (tables, columns, joins) is
 * kept without any value it carried. Dollar-quoted bodies (function code) are redacted the same way.
 */
export function redactSql(sql: string, max = 4000): string {
  return clip(redactTokens(sql).replace(/[ \t]+\n/g, "\n").trim(), max);
}

function redactTokens(sql: string): string {
  const out: string[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const j = sql.indexOf("\n", i);
      i = j < 0 ? n : j;
      continue;
    }
    if (ch === "/" && next === "*") {
      const j = sql.indexOf("*/", i + 2);
      i = j < 0 ? n : j + 2;
      out.push(" ");
      continue;
    }
    if (ch === "'") {
      i = skipQuoted(sql, i, "'");
      out.push("'?'");
      continue;
    }
    if (ch === '"') {
      const j = skipQuoted(sql, i, '"');
      out.push(sql.slice(i, j));
      i = j;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 66))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        const body = sql.slice(i + tag.length, end < 0 ? n : end);
        out.push(tag, redactTokens(body), tag);
        i = end < 0 ? n : end + tag.length;
        continue;
      }
      const param = /^\$\d+/.exec(sql.slice(i, i + 12))?.[0];
      if (param) {
        out.push(param);
        i += param.length;
        continue;
      }
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(sql[j]!)) j++;
      const word = sql.slice(i, j);
      if (sql[j] === "'" && /^[ebxn]$/i.test(word)) {
        i = skipQuoted(sql, j, "'", word.toLowerCase() === "e");
        out.push("'?'");
        continue;
      }
      if (/^u$/i.test(word) && sql[j] === "&" && sql[j + 1] === "'") {
        i = skipQuoted(sql, j + 1, "'");
        out.push("'?'");
        continue;
      }
      out.push(word);
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(next ?? ""))) {
      let j = i;
      while (j < n && /[0-9.]/.test(sql[j]!)) j++;
      if (/[eE]/.test(sql[j] ?? "") && /[-+0-9]/.test(sql[j + 1] ?? "")) {
        j += 2;
        while (j < n && /[0-9]/.test(sql[j]!)) j++;
      }
      out.push("?");
      i = j;
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join("");
}

function rowCount(v: unknown, depth = 0): number | undefined {
  if (depth > 4) return undefined;
  if (Array.isArray(v)) {
    // an MCP content array: count the rows inside its text parts
    if (v.length && v.every((p) => p && typeof p === "object" && (p as Record<string, unknown>).type === "text")) {
      return rowCount(v.map((p) => (p as { text?: unknown }).text).join("\n"), depth + 1);
    }
    return v.length;
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("{") && t.length < 2_000_000) {
      try {
        return rowCount(JSON.parse(t), depth + 1);
      } catch {
        /* text with a JSON array inside, e.g. rows between untrusted-data tags */
      }
    }
    const start = v.indexOf("[");
    const end = v.lastIndexOf("]");
    if (start < 0 || end <= start) return undefined;
    try {
      const parsed = JSON.parse(v.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed.length : undefined;
    } catch {
      return undefined;
    }
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["rows", "data", "result", "content"]) if (k in o) return rowCount(o[k], depth + 1);
  }
  return undefined;
}

/** What is kept of a successful SQL result: never the rows, only how many there were (when that can be told). */
export function summarizeSqlResult(output: unknown): { omitted: "row data"; rows?: number } {
  const rows = rowCount(output);
  return rows === undefined ? { omitted: "row data" } : { omitted: "row data", rows };
}

export interface ToolEventLike {
  role: string;
  tool_name?: string | null;
  tool_input?: unknown;
  tool_output?: unknown;
  is_error?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Trace ingest for SQL tool events of the Supabase MCP server (`execute_sql`, `apply_migration`, any client
 * prefix): the SQL is redacted, a successful result is replaced by its row count, and a failed one keeps only the
 * parsed Postgres error (values redacted). `metadata.sql_tool` records the tool, server and SQLSTATE. For every
 * tool, an MCP result with `isError: true` marks the event as an error. Other events are returned unchanged.
 */
export function sanitizeToolEvent<E extends ToolEventLike>(e: E): E & ToolEventLike {
  if (e.role !== "tool") return e;
  const mcpError = isMcpErrorResult(e.tool_output);
  const isError = !!e.is_error || mcpError;
  const mcp = supabaseMcpTool(e.tool_name);
  if (!mcp || !SUPABASE_MCP_SQL_TOOLS.includes(mcp.tool)) return isError === !!e.is_error ? e : { ...e, is_error: isError };

  const input = e.tool_input;
  let toolInput: unknown = input;
  if (typeof input === "string") toolInput = redactSql(input);
  else if (input && typeof input === "object" && !Array.isArray(input)) {
    const o = { ...(input as Record<string, unknown>) };
    for (const k of ["query", "sql", "statement"]) if (typeof o[k] === "string") o[k] = redactSql(o[k] as string);
    toolInput = o;
  }
  const err = isError ? parsePgError(e.tool_output) : null;
  const toolOutput = isError
    ? err
      ? { error: err.message, ...(err.code ? { sqlstate: err.code } : {}), ...(err.detail ? { detail: err.detail } : {}), ...(err.hint ? { hint: err.hint } : {}) }
      : { error: "SQL error (not a recognised Postgres error; text omitted)" }
    : summarizeSqlResult(e.tool_output);
  return {
    ...e,
    tool_input: toolInput,
    tool_output: toolOutput,
    is_error: isError,
    metadata: {
      ...(e.metadata ?? {}),
      sql_tool: { tool: mcp.tool, server: mcp.server, ...(err ? { sqlstate: err.code, condition: err.condition } : {}) },
    },
  };
}
