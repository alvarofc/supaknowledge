// Review presence: who else has a proposal open. Pure helpers (no React, no Supabase) so they can be tested in Node.
//
// Each tab tracks { user_id, state } on the private channel proposal:<id> with its user id as the presence key.
// Realtime Authorization only lets people who can see the proposal join, never agents. Presence payloads are written
// by clients, so a member could claim another member's id: names are looked up from `profiles` through RLS, and
// presence is a hint to coordinate, never an access decision.

export type ReviewState = "viewing" | "reviewing";

export interface Viewer {
  userId: string;
  state: ReviewState;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Other people present, from a Realtime presence state ({ key: metas[] }). One entry per person (several tabs count
 * once, reviewing if any tab is), without the current user, reviewing first.
 */
export function viewersFrom(state: Record<string, unknown[]>, selfId: string): Viewer[] {
  const out: Viewer[] = [];
  for (const [key, metas] of Object.entries(state)) {
    if (key === selfId || !UUID.test(key) || !Array.isArray(metas)) continue;
    const own = metas.filter((m): m is { user_id: string; state?: unknown } => !!m && typeof m === "object" && (m as { user_id?: unknown }).user_id === key);
    if (!own.length) continue;
    out.push({ userId: key, state: own.some((m) => m.state === "reviewing") ? "reviewing" : "viewing" });
  }
  return out.sort((a, b) => (a.state === b.state ? a.userId.localeCompare(b.userId) : a.state === "reviewing" ? -1 : 1));
}

/** "AL" for "Ana López", "B" for "bob", "E" for "Eli (engineer)", "?" for nothing. */
export function initials(name: string): string {
  // a parenthetical is a role or note, not part of the name; only letters and digits start a part
  const parts = name.replace(/@.*$/, "").replace(/\([^)]*\)/g, " ").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!parts.length) return "?";
  const first = [...(parts[0] ?? "")][0] ?? "";
  const last = parts.length > 1 ? ([...parts.at(-1)!][0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

/** "Ana", "Ana and Bob", "Ana, Bob and Cleo", "Ana, Bob and 2 others" */
export function nameList(names: string[], max = 3): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= max) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const rest = names.length - (max - 1);
  return `${names.slice(0, max - 1).join(", ")} and ${rest} others`;
}
