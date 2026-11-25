// Audience rules, mirrored from supabase/migrations (private.in_audience / private.is_escalation) so the
// curator and UIs can reason about access before touching the database. The database remains the
// enforcement point; these helpers exist to make good decisions earlier and to explain them.
import type { Audience } from "./types.ts";

/** Can a principal in `groups` see something with `audience`? */
export function inAudience(audience: Audience, groups: readonly string[]): boolean {
  if (audience.length === 0) return true;
  const g = new Set(groups);
  return audience.some((a) => g.has(a));
}

/**
 * Would publishing material restricted to `source` into something readable by `target` widen access?
 * Readers(target) ⊆ Readers(source) holds when source is unrestricted, or target is restricted to a
 * subset of source's groups. Anything else is an escalation.
 */
export function isEscalation(source: Audience, target: Audience): boolean {
  if (source.length === 0) return false;
  if (target.length === 0) return true;
  const s = new Set(source);
  return !target.every((t) => s.has(t));
}

/**
 * The widest audience a concept may have without leaking any of the cited material: the intersection
 * of all restricted citation audiences. Returns null when the citations are mutually exclusive (no group
 * may see all of them), which means the knowledge must be split or escalated to a human.
 */
export function narrowestSafeAudience(citationAudiences: Audience[]): Audience | null {
  const restricted = citationAudiences.filter((a) => a.length > 0);
  if (restricted.length === 0) return [];
  let acc = new Set(restricted[0]);
  for (const a of restricted.slice(1)) {
    const next = new Set(a);
    acc = new Set([...acc].filter((x) => next.has(x)));
  }
  return acc.size === 0 ? null : [...acc].sort();
}

export function sameAudience(a: Audience, b: Audience): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}
