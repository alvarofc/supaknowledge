// Public configuration. Only the publishable key ever reaches Studio: every query runs with the signed-in
// user's session and RLS decides what they can see. Vite inlines VITE_* variables at build time, in both the
// browser and the server bundle.
export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL ?? "";
export const SUPABASE_PUBLISHABLE_KEY: string = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";

export function assertEnv() {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error(
      "Missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY. Copy apps/studio/.env.example to .env.local.",
    );
  }
}

export const FUNCTIONS_URL = `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1`;
