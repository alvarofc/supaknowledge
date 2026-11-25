import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "@/lib/env";

export type Supa = SupabaseClient<Database>;

let client: Supa | undefined;

/**
 * Browser client (singleton). The session lives in cookies shared with the server, so server functions see the
 * same user. Only call it in the browser (event handlers, effects, client-only code paths).
 */
export function createClient(): Supa {
  client ??= createBrowserClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  return client;
}
