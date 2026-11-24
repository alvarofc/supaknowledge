// Ready-to-paste MCP client configuration for the Supaknowledge `mcp` Edge Function.
import { trimUrl } from "./http.ts";

export type McpClientKind = "claude-code" | "cursor" | "claude-desktop" | "generic";

export interface McpConfigOptions {
  url: string;
  /** "<workspace>/<space>" */
  space: string;
  client?: McpClientKind;
  /** Server name in the client config. Default "supaknowledge". */
  name?: string;
  /**
   * "agent-key": send `Authorization: Bearer <key>` (headless agents, CI).
   * "oauth": no header; the client signs the user in through Supabase Auth's OAuth 2.1 server.
   */
  auth?: "agent-key" | "oauth";
  /** The agent key to inline. When omitted, an environment variable placeholder is used. */
  apiKey?: string;
  /** Env var holding the key when it is not inlined. Default SUPAKNOWLEDGE_API_KEY. */
  apiKeyEnv?: string;
}

export interface McpConfig {
  client: McpClientKind;
  name: string;
  /** MCP endpoint URL */
  url: string;
  /** JSON to merge into the client's config file (null when the client is configured another way) */
  config: Record<string, unknown> | null;
  /** Where that JSON goes */
  file?: string;
  /** Shell command alternative (Claude Code) */
  command?: string;
  notes: string[];
}

export function mcpEndpoint(url: string, space: string): string {
  return `${trimUrl(url)}/functions/v1/mcp?space=${encodeURIComponent(space).replace(/%2F/gi, "/")}`;
}

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\-./:=%@]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function buildMcpConfig(o: McpConfigOptions): McpConfig {
  const client = o.client ?? "claude-code";
  const name = o.name ?? "supaknowledge";
  const endpoint = mcpEndpoint(o.url, o.space);
  const oauth = o.auth === "oauth";
  const envName = o.apiKeyEnv ?? "SUPAKNOWLEDGE_API_KEY";
  const notes: string[] = [];

  if (oauth) {
    notes.push("The client will open a browser to sign in with your Supaknowledge (Supabase Auth) account; it sees exactly what you can see.");
  } else if (!o.apiKey) {
    notes.push(`Set ${envName} to an agent key (kf agents create <name>) before starting the client.`);
  } else {
    notes.push("This config contains a secret agent key. Do not commit it.");
  }

  switch (client) {
    case "claude-code": {
      const keyRef = o.apiKey ?? `\${${envName}}`;
      const entry: Record<string, unknown> = { type: "http", url: endpoint };
      if (!oauth) entry.headers = { Authorization: `Bearer ${keyRef}` };
      const cmd = ["claude", "mcp", "add", "--transport", "http", shellQuote(name), shellQuote(endpoint)];
      if (!oauth) cmd.push("--header", o.apiKey ? shellQuote(`Authorization: Bearer ${o.apiKey}`) : `"Authorization: Bearer \$${envName}"`);
      if (oauth) notes.push("After adding, run /mcp inside Claude Code and choose Authenticate.");
      return { client, name, url: endpoint, config: { mcpServers: { [name]: entry } }, file: ".mcp.json (project) or `claude mcp add --scope user`", command: cmd.join(" "), notes };
    }
    case "cursor": {
      const entry: Record<string, unknown> = { url: endpoint };
      if (!oauth) entry.headers = { Authorization: `Bearer ${o.apiKey ?? `\${env:${envName}}`}` };
      return { client, name, url: endpoint, config: { mcpServers: { [name]: entry } }, file: ".cursor/mcp.json (project) or ~/.cursor/mcp.json (global)", notes };
    }
    case "claude-desktop": {
      if (oauth) {
        notes.push(`In Claude Desktop open Settings > Connectors > Add custom connector, and paste ${endpoint}`);
        return { client, name, url: endpoint, config: null, notes };
      }
      // Desktop config only launches local (stdio) servers; mcp-remote bridges to the HTTP endpoint.
      const entry = {
        command: "npx",
        args: ["-y", "mcp-remote", endpoint, "--header", "Authorization:${SUPAKNOWLEDGE_AUTH}"],
        env: { SUPAKNOWLEDGE_AUTH: `Bearer ${o.apiKey ?? `<${envName}>`}` },
      };
      return {
        client, name, url: endpoint,
        config: { mcpServers: { [name]: entry } },
        file: "claude_desktop_config.json (Settings > Developer > Edit Config)",
        notes: [...notes, "Uses the mcp-remote bridge (needs Node). Replace the placeholder with the key if it was not inlined."],
      };
    }
    default: {
      const entry: Record<string, unknown> = { transport: "streamable-http", url: endpoint };
      if (!oauth) entry.headers = { Authorization: `Bearer ${o.apiKey ?? `<${envName}>`}` };
      return { client: "generic", name, url: endpoint, config: { mcpServers: { [name]: entry } }, notes };
    }
  }
}
