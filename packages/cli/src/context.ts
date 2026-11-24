// Everything a command needs: config, credentials (with refresh), the resolved space, an RLS-scoped
// Supabase client, Edge Function calls and output helpers.
import { Supaknowledge, SupaknowledgeError, requestJson } from "@supaknowledge/sdk";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { findProjectFile, loadConfig, saveConfig, type ConfigFile, type Env, type Profile, type StoredSession } from "./config.ts";
import { makeColors, type Colors } from "./render.ts";

export class CliError extends Error {
  exitCode: number;
  hint?: string;
  /** the command already printed its JSON result; --json mode prints nothing more */
  reported: boolean;
  constructor(message: string, opts: { exitCode?: number; hint?: string; reported?: boolean } = {}) {
    super(message);
    this.exitCode = opts.exitCode ?? 1;
    this.hint = opts.hint;
    this.reported = opts.reported ?? false;
  }
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** Reads all of stdin (for piped secrets). */
  readStdin: () => Promise<string>;
  /** Prompt on the terminal; `hidden` for passwords. Throws when there is no TTY. */
  prompt: (question: string, hidden?: boolean) => Promise<string>;
  /** stdout is a terminal (colors, tables) */
  isTTY: boolean;
  /** stdin is a terminal (so we may prompt instead of reading piped input) */
  stdinIsTTY: boolean;
  env: Env;
  cwd: string;
  fetch: FetchFn;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface GlobalOpts {
  json?: boolean;
  profile?: string;
  space?: string;
  url?: string;
  color?: boolean;
}

export interface SpaceRef {
  id: string;
  /** "<workspace>/<space>" */
  ref: string;
  workspace_id: string;
  name?: string;
}

export const AGENT_KEY_RE = /^skn_([0-9a-f-]{36})_([A-Za-z0-9_-]{32,})$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const agentEmail = (id: string) => `agent-${id}@agents.supaknowledge.internal`;

export function decodeJwt(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const noSession = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;

export class Ctx {
  readonly io: Io;
  readonly g: GlobalOpts;
  readonly c: Colors;
  private cfg: ConfigFile | null = null;
  private tokenP: Promise<string> | null = null;
  private spaceP: Promise<SpaceRef> | null = null;

  constructor(io: Io, g: GlobalOpts) {
    this.io = io;
    this.g = g;
    const colorEnv = io.env.FORCE_COLOR ? true : io.env.NO_COLOR ? false : io.isTTY;
    this.c = makeColors(g.color === false ? false : !g.json && colorEnv);
  }

  // ---------------------------------------------------------------------------------------------------
  // config + credentials
  // ---------------------------------------------------------------------------------------------------

  config(): ConfigFile {
    this.cfg ??= loadConfig(this.io.env);
    return this.cfg;
  }

  saveConfig(): void {
    saveConfig(this.io.env, this.config());
  }

  get profileName(): string {
    return this.g.profile ?? this.io.env.SUPAKNOWLEDGE_PROFILE ?? this.config().current_profile ?? "default";
  }

  profile(): Profile {
    const cfg = this.config();
    cfg.profiles[this.profileName] ??= {};
    return cfg.profiles[this.profileName]!;
  }

  project() {
    return findProjectFile(this.io.cwd);
  }

  url(): string {
    const u = this.g.url ?? this.io.env.SUPAKNOWLEDGE_URL ?? this.profile().url ?? this.project()?.data.url;
    if (!u) throw new CliError("no Supaknowledge URL configured", { hint: "run `kf login --url <supabase-url> --publishable-key <key>` or set SUPAKNOWLEDGE_URL" });
    return u.replace(/\/+$/, "");
  }

  publishableKey(): string {
    const k = this.io.env.SUPAKNOWLEDGE_PUBLISHABLE_KEY ?? this.profile().publishable_key;
    if (!k) throw new CliError("no publishable key configured", { hint: "run `kf login --publishable-key <key>` or set SUPAKNOWLEDGE_PUBLISHABLE_KEY" });
    return k;
  }

  /** Supabase client without a user session (sign-in, refresh). */
  anonClient(): SupabaseClient {
    return createClient(this.url(), this.publishableKey(), { auth: noSession, global: { fetch: this.io.fetch as typeof fetch } });
  }

  /** A valid access token: SUPAKNOWLEDGE_TOKEN (JWT or agent key) or the profile session, refreshed when close to expiry. */
  accessToken(): Promise<string> {
    this.tokenP ??= this.resolveToken().catch((e) => {
      this.tokenP = null;
      throw e;
    });
    return this.tokenP;
  }

  private async resolveToken(): Promise<string> {
    const envTok = this.io.env.SUPAKNOWLEDGE_TOKEN;
    if (envTok) {
      if (envTok.startsWith("skn_")) return (await this.exchangeAgentKey(envTok)).access_token;
      return envTok;
    }
    const prof = this.profile();
    const s = prof.session;
    if (!s?.access_token) throw new CliError("not logged in", { hint: "run `kf login`" });
    const now = Math.floor(this.io.now() / 1000);
    const exp = s.expires_at ?? (decodeJwt(s.access_token)?.exp as number | undefined) ?? null;
    if (exp === null || exp - 60 > now) return s.access_token;
    if (!s.refresh_token) throw new CliError("session expired", { hint: "run `kf login` again" });
    const { data, error } = await this.anonClient().auth.refreshSession({ refresh_token: s.refresh_token });
    if (error || !data.session) throw new CliError(`session refresh failed: ${error?.message ?? "no session"}`, { hint: "run `kf login` again" });
    prof.session = sessionFrom(data.session);
    this.saveConfig();
    return data.session.access_token;
  }

  /** Agent keys are the password of the agent's Auth user; trade one for a session. */
  async exchangeAgentKey(key: string): Promise<StoredSession> {
    const m = AGENT_KEY_RE.exec(key);
    if (!m) throw new CliError("malformed agent key (expected skn_<agent-id>_<secret>)");
    const { data, error } = await this.anonClient().auth.signInWithPassword({ email: agentEmail(m[1]!), password: m[2]! });
    if (error || !data.session) throw new CliError(`agent key rejected: ${error?.message ?? "no session"}`);
    return sessionFrom(data.session);
  }

  async userId(): Promise<string> {
    const sub = decodeJwt(await this.accessToken())?.sub;
    if (typeof sub !== "string") throw new CliError("access token has no subject");
    return sub;
  }

  /** RLS-scoped PostgREST client acting as the logged-in principal. */
  async db(): Promise<SupabaseClient> {
    const token = await this.accessToken();
    return createClient(this.url(), this.publishableKey(), {
      auth: noSession,
      global: { headers: { Authorization: `Bearer ${token}` }, fetch: this.io.fetch as typeof fetch },
    });
  }

  // ---------------------------------------------------------------------------------------------------
  // space
  // ---------------------------------------------------------------------------------------------------

  /** --space > SUPAKNOWLEDGE_SPACE > .supaknowledge.json (walking up from cwd). */
  spaceSpec(): string {
    const s = this.g.space ?? this.io.env.SUPAKNOWLEDGE_SPACE ?? this.project()?.data.space;
    if (!s) throw new CliError("no space selected", { hint: "pass --space <workspace>/<space>, set SUPAKNOWLEDGE_SPACE, or run `kf init`" });
    return s;
  }

  space(): Promise<SpaceRef> {
    this.spaceP ??= this.resolveSpace().catch((e) => {
      this.spaceP = null;
      throw e;
    });
    return this.spaceP;
  }

  private async resolveSpace(): Promise<SpaceRef> {
    const spec = this.spaceSpec();
    const db = await this.db();
    let q = db.from("spaces").select("id, slug, name, workspace_id, workspaces!inner(slug)").limit(1);
    if (UUID_RE.test(spec)) q = q.eq("id", spec);
    else {
      const m = /^([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/.exec(spec);
      if (!m) throw new CliError(`invalid space "${spec}" (expected <workspace>/<space> or a uuid)`, { exitCode: 2 });
      q = q.eq("slug", m[2]!).eq("workspaces.slug", m[1]!);
    }
    const rows = await must(q);
    const row = rows[0] as unknown as { id: string; slug: string; name: string; workspace_id: string; workspaces: { slug: string } } | undefined;
    if (!row) throw new CliError(`space "${spec}" not found or you have no access`, { hint: "check `kf whoami` and the space slug" });
    return { id: row.id, ref: `${row.workspaces.slug}/${row.slug}`, workspace_id: row.workspace_id, name: row.name };
  }

  /** SDK client for knowledge calls (MCP first, PostgREST fallback). */
  async sdk(): Promise<Supaknowledge> {
    const sp = await this.space();
    return new Supaknowledge({
      url: this.url(),
      space: sp.ref,
      accessToken: () => this.accessToken(),
      publishableKey: this.publishableKey(),
      fetch: this.io.fetch,
      transport: (this.io.env.SUPAKNOWLEDGE_TRANSPORT as "mcp" | "rest" | "auto" | undefined) ?? "auto",
    });
  }

  // ---------------------------------------------------------------------------------------------------
  // Edge Functions
  // ---------------------------------------------------------------------------------------------------

  async fn<T>(path: string, opts: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) qs.set(k, v);
    const url = `${this.url()}/functions/v1/${path}${qs.size ? `?${qs}` : ""}`;
    return requestJson<T>(this.io.fetch, url, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers: { Authorization: `Bearer ${await this.accessToken()}`, apikey: this.publishableKey() },
      body: opts.body,
      timeoutMs: 120000,
    });
  }

  // ---------------------------------------------------------------------------------------------------
  // output
  // ---------------------------------------------------------------------------------------------------

  /** Print `data` as JSON with --json, else the human rendering. */
  out(data: unknown, human: () => string | null | undefined): void {
    if (this.g.json) {
      this.io.stdout(JSON.stringify(data, null, 2) + "\n");
      return;
    }
    const s = human();
    if (s) this.io.stdout(s.endsWith("\n") ? s : s + "\n");
  }

  /** Progress / notices: stderr, so stdout stays clean for pipes and --json. */
  note(msg: string): void {
    this.io.stderr(msg.endsWith("\n") ? msg : msg + "\n");
  }

  warn(msg: string): void {
    this.note(`${this.c.yellow("warning:")} ${msg}`);
  }
}

export function sessionFrom(s: { access_token: string; refresh_token?: string | null; expires_at?: number | null; user?: { id: string; email?: string | null; app_metadata?: Record<string, unknown> } | null }): StoredSession {
  return {
    access_token: s.access_token,
    refresh_token: s.refresh_token ?? null,
    expires_at: s.expires_at ?? (decodeJwt(s.access_token)?.exp as number | undefined) ?? null,
    user: s.user ? { id: s.user.id, email: s.user.email ?? null, kind: (s.user.app_metadata?.kind as string | undefined) ?? "human" } : undefined,
  };
}

interface PgResult<T> {
  data: T | null;
  error: { message: string; code?: string; details?: string | null; hint?: string | null } | null;
}

/** Unwrap a supabase-js result or throw a readable CliError. */
export async function must<T>(p: PromiseLike<PgResult<T>>): Promise<T> {
  const { data, error } = await p;
  if (error) {
    const msg = error.message || "request failed";
    const extra = [error.details, error.hint].filter(Boolean).join(" ");
    const hint =
      error.code === "42501" ? "you do not have the role this needs in this space" : error.code === "PGRST301" ? "your session is invalid; run `kf login`" : undefined;
    throw new CliError(extra ? `${msg} (${extra})` : msg, { hint });
  }
  return data as T;
}

/**
 * For UPDATE / DELETE / UPSERT with `.select()`: RLS silently filters rows the caller may not change, so an empty
 * result means nothing happened. Turn that into an error instead of reporting success.
 */
export async function mustRows<T>(p: PromiseLike<PgResult<T[]>>, message: string, hint?: string): Promise<T[]> {
  const rows = await must(p);
  if (!Array.isArray(rows) || rows.length === 0) throw new CliError(message, { hint });
  return rows;
}

export { SupaknowledgeError };

/**
 * Accept a full uuid or a unique prefix (as shown in tables) for rows of `table` in the current space.
 */
export async function resolveId(ctx: Ctx, table: string, idOrPrefix: string, label = table.replace(/s$/, "")): Promise<string> {
  const v = idOrPrefix.trim().toLowerCase();
  if (UUID_RE.test(v)) return v;
  if (!/^[0-9a-f-]{4,}$/.test(v)) throw new CliError(`"${idOrPrefix}" is not a ${label} id`, { exitCode: 2 });
  const sp = await ctx.space();
  const db = await ctx.db();
  const rows = (await must(db.from(table).select("id").eq("space_id", sp.id).order("created_at", { ascending: false }).limit(1000))) as { id: string }[];
  const hits = rows.filter((r) => r.id.startsWith(v));
  if (hits.length === 1) return hits[0]!.id;
  if (!hits.length) throw new CliError(`no ${label} matching "${idOrPrefix}" in ${sp.ref}`);
  throw new CliError(`"${idOrPrefix}" matches ${hits.length} ${label}s; use more characters`, { exitCode: 2 });
}
