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

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.base}/projects/${this.ref}${path}`;
    let res: Response;
    try {
      res = await this.fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
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

  project(): Promise<Project> {
    return this.request<Project>("GET", "");
  }

  /** Run SQL as a privileged role; returns the result rows. */
  async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    const rows = await this.request<unknown>("POST", "/database/query", { query: sql });
    return Array.isArray(rows) ? (rows as T[]) : [];
  }

  async secrets(): Promise<SecretEntry[]> {
    const rows = await this.request<unknown>("GET", "/secrets");
    return Array.isArray(rows) ? (rows as SecretEntry[]) : [];
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
