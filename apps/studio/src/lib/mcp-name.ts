/** Longest server name we emit: clients prefix tool names with it (mcp__<server>__<tool>), and those are length-capped. */
export const MAX_SERVER_NAME = 40;

/** FNV-1a, 8 hex chars: a stable short suffix for names that had to be shortened. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * MCP server name for a space in client configs: distinct (workspace, space) pairs never share a name, so several
 * spaces fit in one client config. Slugs are [a-z0-9-] only, so "_" marks the workspace/space boundary
 * ("supaknowledge_<ws>_<space>"). Names over the cap are shortened deterministically to
 * "supaknowledge-<prefix>-<hash of the full name>"; the "-" after "supaknowledge" keeps them apart from every
 * unshortened name.
 */
export function serverName(wsSlug: string, spaceSlug: string): string {
  const full = `supaknowledge_${wsSlug}_${spaceSlug}`;
  if (full.length <= MAX_SERVER_NAME) return full;
  const hash = shortHash(full);
  const head = `supaknowledge-${full.slice("supaknowledge_".length)}`;
  return `${head.slice(0, MAX_SERVER_NAME - hash.length - 1).replace(/[-_]+$/, "")}-${hash}`;
}
