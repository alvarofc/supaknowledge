import { SpaceSettingsSchema, parseSettings } from "@supaknowledge/core";
import type { SpaceSettings } from "@supaknowledge/core";
import type { Json } from "@/lib/database.types";
import { errorMessage } from "@/lib/format";
import { friendlyIssue, mergeSettingsUpdate } from "@/lib/settings-form";
import { getSupabase } from "@/server/supabase.server";

export type SaveSettingsResult = { ok: true; settings: SpaceSettings } | { ok: false; message: string; fieldErrors?: Record<string, string> };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parsed space settings with defaults (the same parser the curator and policy engine use). */
export function readSettings(raw: unknown): SpaceSettings {
  return parseSettings(raw);
}

/**
 * Validates space settings with the shared SpaceSettingsSchema (the same schema the curator and policy engine
 * parse with) and saves them as the signed-in user. Runs on the server so the core package (and its LLM
 * client) never ships to the browser. RLS decides whether the update is allowed (space admins only). `base` is the
 * settings the form was loaded with: fields the user did not change keep what is stored now (see mergeSettingsUpdate).
 * Returns the saved settings so the form can show what is stored.
 */
export async function saveSettings(spaceId: string, input: unknown, base?: unknown): Promise<SaveSettingsResult> {
  const parsed = SpaceSettingsSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      // report an error on one fallback model ("curator.fallback_models.2") on the list field the form shows
      const path = issue.path.map(String);
      const key = (path[1] === "fallback_models" ? path.slice(0, 2) : path).join(".");
      fieldErrors[key] ??= friendlyIssue(issue.code, issue.message);
    }
    return { ok: false, message: "Some settings are invalid. Fix the highlighted fields.", fieldErrors };
  }

  const supabase = getSupabase();
  const { data: current, error: readError } = await supabase.from("spaces").select("settings").eq("id", spaceId).maybeSingle();
  if (readError || !current) return { ok: false, message: readError ? errorMessage(readError) : "Space not found" };

  // keep keys other tools (or newer versions) wrote that this schema does not know, at the top level and inside
  // each section (e.g. curator.stuck_after_minutes, read by the database's run reaper), and other admins' changes
  // to fields this form left alone
  const previous = isPlainObject(current.settings) ? current.settings : {};
  const merged = mergeSettingsUpdate(previous, parsed.data, isPlainObject(base) ? base : undefined);

  const { data, error } = await supabase.from("spaces").update({ settings: merged as NonNullable<Json> }).eq("id", spaceId).select("id");
  // the database re-validates (private.validate_space_settings); its message names the offending key
  if (error) return { ok: false, message: `Could not save settings: ${errorMessage(error)}` };
  if (!data?.length) return { ok: false, message: "Only space admins can change settings." };
  return { ok: true, settings: readSettings(merged) };
}
