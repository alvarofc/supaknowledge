// Environment + Supabase clients for Edge Functions.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function env(name: string, fallback?: string): string {
  const v = Deno.env.get(name) ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
}

export const SUPABASE_URL = () => env("SUPABASE_URL");

/** Secret (service role) key: new-style SUPABASE_SECRET_KEYS dictionary first, legacy key second. */
export function secretKey(): string {
  const dict = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (dict) {
    try {
      const parsed = JSON.parse(dict) as Record<string, string>;
      if (parsed.default) return parsed.default;
      const first = Object.values(parsed)[0];
      if (first) return first;
    } catch { /* fall through */ }
  }
  return Deno.env.get("SUPABASE_SECRET_KEY") ?? env("SUPABASE_SERVICE_ROLE_KEY");
}

/** Publishable (anon) key, used to make user-scoped clients. */
export function publishableKey(): string {
  const dict = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (dict) {
    try {
      const parsed = JSON.parse(dict) as Record<string, string>;
      if (parsed.default) return parsed.default;
      const first = Object.values(parsed)[0];
      if (first) return first;
    } catch { /* fall through */ }
  }
  return Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? env("SUPABASE_ANON_KEY");
}

const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

/** Service-role client: bypasses RLS. Only for internal pipelines (embed, connectors, curator). */
export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL(), secretKey(), noSession);
}

/** Client that acts as the caller: every query goes through RLS with their JWT. */
export function userClient(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL(), publishableKey(), {
    ...noSession,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}
