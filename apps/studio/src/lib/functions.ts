import { FUNCTIONS_URL, SUPABASE_PUBLISHABLE_KEY } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";

export class FunctionError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/**
 * Call a Supaknowledge Edge Function as the signed-in user (Bearer = the user's access token), so the function
 * can act with the user's permissions and RLS still applies.
 */
export async function callFunction<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; formData?: FormData } = {},
): Promise<T> {
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new FunctionError("Your session expired. Sign in again.", 401);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, apikey: SUPABASE_PUBLISHABLE_KEY };
  let body: BodyInit | undefined;
  if (init.formData) body = init.formData;
  else if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  let res: Response;
  try {
    res = await fetch(`${FUNCTIONS_URL}/${path.replace(/^\//, "")}`, { method: init.method ?? (body ? "POST" : "GET"), headers, body });
  } catch {
    throw new FunctionError(`Could not reach the ${path.split(/[/?]/)[0]} function. Is it deployed (or \`supabase functions serve\` running)?`, 0);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg =
      (json && typeof json === "object" && ("error" in json || "message" in json)
        ? String((json as { error?: unknown; message?: unknown }).error ?? (json as { message?: unknown }).message)
        : text) || res.statusText;
    if (res.status === 501 || res.status === 404) {
      throw new FunctionError(`The ${path.split(/[/?]/)[0]} function is not available yet (${res.status}): ${msg}`, res.status);
    }
    throw new FunctionError(msg, res.status);
  }
  return json as T;
}
