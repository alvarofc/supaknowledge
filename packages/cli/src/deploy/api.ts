// Minimal Supabase Management API client (https://api.supabase.com/v1) for `kf deploy`. The token is only ever sent
// in the Authorization header; error messages never include it.
import type { FetchFn } from "../context.ts";

export const MANAGEMENT_API = "https://api.supabase.com/v1";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface Project {
  ref?: string;
  id?: string;
  name?: string;
  region?: string;
  status?: string;
}

export interface SecretEntry {
  name: string;
  /** the Management API returns a SHA-256 digest of the value, not the value */
  value?: string;
}

export interface ApiKey {
  name?: string;
  type?: string | null;
  api_key?: string | null;
}

export type AuthConfig = Record<string, unknown>;

/** One Management API call; the error message names the method, path and API message, never the token. */
export async function apiRequest<T>(fetch: FetchFn, token: string, base: string, method: string, path: string, body?: unknown): Promise<T> {
  const url = `${base}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    throw new ApiError(`${method} ${path}: ${(e as Error).message}`, 0);
  }
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const msg =
      (data && typeof data === "object" && ((data as { message?: unknown }).message ?? (data as { error?: unknown }).error)) || (typeof data === "string" ? data.slice(0, 300) : "");
    throw new ApiError(`${method} ${path} failed (HTTP ${res.status})${msg ? `: ${String(msg)}` : ""}`, res.status);
  }
  return data as T;
}

export interface Organization {
  slug: string;
  name?: string;
}

export interface ProjectSummary extends Project {
  organization_slug?: string;
}

/** Account-level calls `kf deploy --login` needs: organizations, projects, creating a project. */
export class AccountApi {
  private readonly fetch: FetchFn;
  private readonly token: string;
  private readonly base: string;

  constructor(fetch: FetchFn, token: string, base = MANAGEMENT_API) {
    this.fetch = fetch;
    this.token = token;
    this.base = base.replace(/\/+$/, "");
  }

  private async list<T>(path: string): Promise<T[]> {
    const rows = await apiRequest<unknown>(this.fetch, this.token, this.base, "GET", path);
    if (!Array.isArray(rows)) throw new ApiError(`GET ${path}: unexpected response (expected an array)`, 0);
    return rows as T[];
  }

  organizations(): Promise<Organization[]> {
    return this.list<Organization>("/organizations");
  }

  projects(): Promise<ProjectSummary[]> {
    return this.list<ProjectSummary>("/projects");
  }

  project(ref: string): Promise<ProjectSummary> {
    return apiRequest<ProjectSummary>(this.fetch, this.token, this.base, "GET", `/projects/${ref}`);
  }

  /** POST /v1/projects. `region` is sent only when given (the API marks it deprecated). */
  createProject(p: { name: string; organizationSlug: string; dbPass: string; region?: string }): Promise<ProjectSummary> {
    return apiRequest<ProjectSummary>(this.fetch, this.token, this.base, "POST", "/projects", {
      name: p.name,
      organization_slug: p.organizationSlug,
      db_pass: p.dbPass,
      ...(p.region ? { region: p.region } : {}),
    });
  }
}

export class ManagementApi {
  private readonly fetch: FetchFn;
  private readonly token: string;
  private readonly ref: string;
  private readonly base: string;

  constructor(fetch: FetchFn, token: string, ref: string, base = MANAGEMENT_API) {
    this.fetch = fetch;
    this.token = token;
    this.ref = ref;
    this.base = base.replace(/\/+$/, "");
  }

  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return apiRequest<T>(this.fetch, this.token, `${this.base}/projects/${this.ref}`, method, path, body);
  }

  project(): Promise<Project> {
    return this.request<Project>("GET", "");
  }

  /** Run SQL as a privileged role; returns the result rows. */
  async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    const rows = await this.request<unknown>("POST", "/database/query", { query: sql });
    if (!Array.isArray(rows)) throw new ApiError("POST /database/query: unexpected response (expected an array of rows)", 0);
    return rows as T[];
  }

  async secrets(): Promise<SecretEntry[]> {
    // an empty list would make step 4 overwrite settings it should keep: refuse anything but an array
    const rows = await this.request<unknown>("GET", "/secrets");
    if (!Array.isArray(rows)) throw new ApiError("GET /secrets: unexpected response (expected an array)", 0);
    return rows as SecretEntry[];
  }

  setSecrets(secrets: { name: string; value: string }[]): Promise<unknown> {
    return this.request("POST", "/secrets", secrets);
  }

  authConfig(): Promise<AuthConfig> {
    return this.request<AuthConfig>("GET", "/config/auth");
  }

  patchAuthConfig(patch: AuthConfig): Promise<AuthConfig> {
    return this.request<AuthConfig>("PATCH", "/config/auth", patch);
  }

  async apiKeys(): Promise<ApiKey[]> {
    const rows = await this.request<unknown>("GET", "/api-keys?reveal=false");
    return Array.isArray(rows) ? (rows as ApiKey[]) : [];
  }
}
