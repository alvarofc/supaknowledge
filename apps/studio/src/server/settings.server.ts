import { SpaceSettingsSchema, parseSettings } from "@supaknowledge/core";
import type { SpaceSettings } from "@supaknowledge/core";
import type { Json } from "@/lib/database.types";
import { errorMessage } from "@/lib/format";
import { getSupabase } from "@/server/supabase.server";

export type SaveSettingsResult = { ok: true } | { ok: false; message: string; fieldErrors?: Record<string, string> };

function friendly(code: string, message: string): string {
  if (code === "invalid_type" && /number/.test(message)) return "Enter a number";
  return message.replace(/^Too small: expected number to be >=?/, "Must be at least ").replace(/^Too big: expected number to be <=?/, "Must be at most ");
}

/** Parsed space settings with defaults (the same parser the curator and policy engine use). */
export function readSettings(raw: unknown): SpaceSettings {
  return parseSettings(raw);
}

/**
 * Validates space settings with the shared SpaceSettingsSchema (the same schema the curator and policy engine
 * parse with) and saves them as the signed-in user. Runs on the server so the core package (and its LLM
 * client) never ships to the browser. RLS decides whether the update is allowed (space admins only).
 */
export async function saveSettings(spaceId: string, input: unknown): Promise<SaveSettingsResult> {
  const parsed = SpaceSettingsSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.map(String).join(".");
      fieldErrors[key] ??= friendly(issue.code, issue.message);
    }
    return { ok: false, message: "Some settings are invalid. Fix the highlighted fields.", fieldErrors };
  }

  const supabase = getSupabase();
  const { data: current, error: readError } = await supabase.from("spaces").select("settings").eq("id", spaceId).maybeSingle();
  if (readError || !current) return { ok: false, message: readError ? errorMessage(readError) : "Space not found" };

  // keep unknown top-level keys other tools may have written
  const previous = current.settings && typeof current.settings === "object" && !Array.isArray(current.settings) ? current.settings : {};
  const merged = { ...previous, ...parsed.data } as unknown as NonNullable<Json>;

  const { data, error } = await supabase.from("spaces").update({ settings: merged }).eq("id", spaceId).select("id");
  if (error) return { ok: false, message: errorMessage(error) };
  if (!data?.length) return { ok: false, message: "Only space admins can change settings." };
  return { ok: true };
}
