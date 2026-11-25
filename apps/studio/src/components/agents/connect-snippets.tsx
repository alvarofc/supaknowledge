import { useState } from "react";
import { CopyBlock } from "@/components/ui/copy-button";
import { Segmented } from "@/components/ui/tabs";
import { mcpSnippets } from "@/lib/mcp";

type Client = "claude" | "cursor" | "generic" | "env";

/**
 * Ready-to-paste MCP configs for a space. With `agentKey` the configs authenticate as that headless agent;
 * without it, the client goes through the OAuth flow and acts as the person who approves it.
 */
export function ConnectSnippets({ wsSlug, spaceSlug, agentKey }: { wsSlug: string; spaceSlug: string; agentKey?: string }) {
  const [client, setClient] = useState<Client>("claude");
  const s = mcpSnippets(wsSlug, spaceSlug, agentKey);
  const options: { value: Client; label: string }[] = [
    { value: "claude", label: "Claude Code" },
    { value: "cursor", label: "Cursor" },
    { value: "generic", label: "Other clients" },
    ...(agentKey ? [{ value: "env" as const, label: "Env vars" }] : []),
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <Segmented label="MCP client" value={client} onChange={setClient} options={options} />
      </div>
      {client === "claude" ? (
        <>
          <CopyBlock label="Terminal" value={s.claudeCode} wrap />
          <p className="text-xs text-subtle">
            {agentKey
              ? "Adds the server to Claude Code with the agent's key as a bearer token."
              : "Claude Code opens your browser to sign in on first use (run /mcp to authenticate). You approve access on Studio's consent screen."}
          </p>
        </>
      ) : null}
      {client === "cursor" ? (
        <>
          <CopyBlock label=".cursor/mcp.json" value={s.cursor} />
          <p className="text-xs text-subtle">
            {agentKey ? "Merge into your project's .cursor/mcp.json (keep it out of git)." : "Cursor detects that the server needs OAuth and prompts you to sign in."}
          </p>
        </>
      ) : null}
      {client === "generic" ? (
        <>
          <CopyBlock label="MCP server config (Streamable HTTP)" value={s.generic} />
          <p className="text-xs text-subtle">
            Any MCP client that speaks Streamable HTTP works.{" "}
            {agentKey
              ? "Send the key as `Authorization: Bearer <key>`."
              : "Clients discover the OAuth endpoints from the server and register themselves (dynamic client registration)."}
          </p>
        </>
      ) : null}
      {client === "env" ? <CopyBlock label=".env" value={s.env} /> : null}
      <div>
        <div className="mono-label mb-1 text-subtle">Endpoint</div>
        <code className="block overflow-x-auto rounded bg-surface-2 px-2 py-1 font-mono text-xs whitespace-nowrap">{s.url}</code>
      </div>
    </div>
  );
}
