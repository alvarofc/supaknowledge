// Upstream ACLs -> audience groups.
//
// Rule: a document NEVER gets a wider audience than its source. Audiences are OR-lists of groups (empty =
// everyone who can read the space), so:
//   * source audience empty      -> doc audience = groups mapped from the upstream ACL (or empty if none)
//   * source audience restricted -> doc audience = mapped ∩ source; when that intersection is empty we
//                                   cannot express "members of both". An upstream-restricted object is then
//                                   skipped (its known readers are all outside the source audience, so the
//                                   source audience would be wider than the upstream ACL); an unrestricted
//                                   one keeps the source audience.
// A restricted upstream object (private channel, private repo, unshared file) with no mapped group either
// inherits the source audience (default) or is skipped when the source sets config.acl_strict = true.
import type { AclHint } from "./types.ts";

export interface GroupRef {
  id: string;
  external_ref: Record<string, unknown>;
}

export type AudienceDecision =
  | { kind: "ok"; audience: string[]; mode: "inherit" | "mapped" | "unmapped" | "disjoint"; groups: string[] }
  | { kind: "skip"; reason: string };

function refValueMatches(v: unknown, want: string): boolean {
  if (typeof v === "string") return v.toLowerCase() === want.toLowerCase();
  if (Array.isArray(v)) return v.some((x) => typeof x === "string" && x.toLowerCase() === want.toLowerCase());
  return false;
}

/** Groups whose external_ref contains every key/value of at least one ref. */
export function matchGroups(refs: AclHint["refs"], groups: GroupRef[]): string[] {
  const out = new Set<string>();
  for (const g of groups) {
    const ext = g.external_ref ?? {};
    for (const ref of refs) {
      const keys = Object.keys(ref);
      if (keys.length && keys.every((k) => refValueMatches(ext[k], ref[k]!))) {
        out.add(g.id);
        break;
      }
    }
  }
  return [...out].sort();
}

/**
 * Groups an AclHint maps to: object-level `refs` (union) combined with the most specific matching `tiers`
 * entry. Combining narrows (intersection). When both map but are disjoint, the object-level mapping wins: it
 * describes this very object (e.g. a Drive file shared directly with a Google group), while a tier is an
 * inherited container mapping that is typically wider (e.g. the synced root folder -> all-staff).
 */
export function matchAcl(acl: AclHint, groups: GroupRef[]): string[] {
  const direct = matchGroups(acl.refs ?? [], groups);
  let tier: string[] = [];
  for (const t of acl.tiers ?? []) {
    tier = matchGroups(t, groups);
    if (tier.length) break;
  }
  if (!tier.length) return direct;
  if (!direct.length) return tier;
  const inter = direct.filter((g) => tier.includes(g));
  return inter.length ? inter : direct;
}

export function resolveAudience(
  sourceAudience: string[],
  acl: AclHint | undefined,
  groups: GroupRef[],
  opts: { strict?: boolean } = {},
): AudienceDecision {
  const source = [...new Set(sourceAudience ?? [])].sort();
  const matched = acl ? matchAcl(acl, groups) : [];
  if (!matched.length) {
    if (acl?.restricted && opts.strict) {
      return { kind: "skip", reason: "restricted upstream object with no group mapped through groups.external_ref (acl_strict)" };
    }
    return { kind: "ok", audience: source, mode: acl?.restricted ? "unmapped" : "inherit", groups: [] };
  }
  if (!source.length) return { kind: "ok", audience: matched, mode: "mapped", groups: matched };
  const inter = matched.filter((g) => source.includes(g));
  if (inter.length) return { kind: "ok", audience: inter, mode: "mapped", groups: matched };
  if (acl?.restricted) {
    // whatever acl_strict says: the upstream readers are known and none of their groups may read the source
    return { kind: "skip", reason: "restricted upstream object whose mapped groups do not overlap the source audience" };
  }
  return { kind: "ok", audience: source, mode: "disjoint", groups: matched };
}

/** Readers(doc) ⊆ Readers(source)? (same rule as private.is_escalation, inverted) */
export function isNarrowerOrEqual(source: string[], doc: string[]): boolean {
  if (!source.length) return true;
  if (!doc.length) return false;
  return doc.every((g) => source.includes(g));
}
