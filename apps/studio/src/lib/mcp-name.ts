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
 * MCP server name for a space in client configs. Includes the workspace, so "main" in two workspaces does not
 * collide in one client; long names are shortened deterministically (prefix + hash of the full name).
 */
export function serverName(wsSlug: string, spaceSlug: string): string {
  const full = `supaknowledge-${wsSlug}-${spaceSlug}`;
  if (full.length <= MAX_SERVER_NAME) return full;
  const hash = shortHash(full);
  return `${full.slice(0, MAX_SERVER_NAME - hash.length - 1).replace(/-+$/, "")}-${hash}`;
}
