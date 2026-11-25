import { FUNCTIONS_URL } from "@/lib/env";
import { serverName } from "@/lib/mcp-name";

/** The MCP endpoint for a space: one server per space, addressed as <workspace>/<space>. */
export function mcpUrl(wsSlug: string, spaceSlug: string): string {
  return `${FUNCTIONS_URL}/mcp?space=${encodeURIComponent(`${wsSlug}/${spaceSlug}`)}`;
}

/** Ready-to-paste client configs. `key` = an agent API key; omit it for the OAuth ("connect as yourself") flow. */
export function mcpSnippets(wsSlug: string, spaceSlug: string, key?: string) {
  const url = mcpUrl(wsSlug, spaceSlug);
  const name = serverName(wsSlug, spaceSlug);
  const auth = key ? ` --header "Authorization: Bearer ${key}"` : "";
  const headers = key ? { headers: { Authorization: `Bearer ${key}` } } : {};
  return {
    url,
    claudeCode: `claude mcp add --transport http ${name} "${url}"${auth}`,
    cursor: JSON.stringify({ mcpServers: { [name]: { url, ...headers } } }, null, 2),
    generic: JSON.stringify({ mcpServers: { [name]: { type: "http", url, ...headers } } }, null, 2),
    env: key ? `SUPAKNOWLEDGE_MCP_URL="${url}"\nSUPAKNOWLEDGE_API_KEY="${key}"` : `SUPAKNOWLEDGE_MCP_URL="${url}"`,
  };
}
