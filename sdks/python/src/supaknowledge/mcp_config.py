"""Ready-to-paste MCP client configuration for the Supaknowledge `mcp` Edge Function."""

from __future__ import annotations

import re
import shlex
from typing import Any, Literal
from urllib.parse import quote

McpClientKind = Literal["claude-code", "cursor", "claude-desktop", "generic"]

# env var names usable in shell and client-config references ($NAME, ${NAME}, ${env:NAME})
_ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def _quote(s: str) -> str:
    return s if re.fullmatch(r"[A-Za-z0-9_\-./:=%@]+", s) else shlex.quote(s)


def mcp_endpoint(url: str, space: str) -> str:
    return f"{url.rstrip('/')}/functions/v1/mcp?space={quote(space, safe='/')}"


def build_mcp_config(
    url: str,
    space: str,
    *,
    client: McpClientKind = "claude-code",
    name: str = "supaknowledge",
    auth: Literal["agent-key", "oauth"] = "agent-key",
    api_key: str | None = None,
    api_key_env: str = "SUPAKNOWLEDGE_API_KEY",
) -> dict[str, Any]:
    """Returns {client, name, url, config, file?, command?, notes}."""
    # it is interpolated unquoted into shell text and config references
    if not _ENV_NAME.fullmatch(api_key_env):
        raise ValueError(f"api_key_env must be an environment variable name (letters, digits and _, not starting with a digit), got {api_key_env!r}")
    endpoint = mcp_endpoint(url, space)
    oauth = auth == "oauth"
    notes: list[str] = []
    if oauth:
        notes.append("The client will open a browser to sign in with your Supaknowledge (Supabase Auth) account.")
    elif not api_key:
        # Claude Code and Cursor expand env references in their config; the other configs get a literal placeholder
        notes.append(
            f"Set {api_key_env} to an agent key (kf agents create <name>) before starting the client."
            if client in ("claude-code", "cursor")
            else f"Replace <{api_key_env}> in the config with an agent key (kf agents create <name>): this client does not expand environment variables."
        )
    else:
        notes.append("This config contains a secret agent key. Do not commit it.")

    if client == "claude-code":
        entry: dict[str, Any] = {"type": "http", "url": endpoint}
        if not oauth:
            entry["headers"] = {"Authorization": f"Bearer {api_key or '${' + api_key_env + '}'}"}
        cmd = ["claude", "mcp", "add", "--transport", "http", _quote(name), _quote(endpoint)]
        if not oauth:
            cmd += ["--header", shlex.quote(f"Authorization: Bearer {api_key}") if api_key else f'"Authorization: Bearer ${api_key_env}"']
        else:
            notes.append("After adding, run /mcp inside Claude Code and choose Authenticate.")
        return {"client": client, "name": name, "url": endpoint, "config": {"mcpServers": {name: entry}}, "file": ".mcp.json", "command": " ".join(cmd), "notes": notes}
    if client == "cursor":
        entry = {"url": endpoint}
        if not oauth:
            entry["headers"] = {"Authorization": f"Bearer {api_key or '${env:' + api_key_env + '}'}"}
        return {"client": client, "name": name, "url": endpoint, "config": {"mcpServers": {name: entry}}, "file": ".cursor/mcp.json", "notes": notes}
    if client == "claude-desktop":
        if oauth:
            notes.append(f"In Claude Desktop open Settings > Connectors > Add custom connector, and paste {endpoint}")
            return {"client": client, "name": name, "url": endpoint, "config": None, "notes": notes}
        entry = {
            "command": "npx",
            "args": ["-y", "mcp-remote", endpoint, "--header", "Authorization:${SUPAKNOWLEDGE_AUTH}"],
            "env": {"SUPAKNOWLEDGE_AUTH": f"Bearer {api_key or '<' + api_key_env + '>'}"},
        }
        notes.append("Uses the mcp-remote bridge (needs Node).")
        return {"client": client, "name": name, "url": endpoint, "config": {"mcpServers": {name: entry}}, "file": "claude_desktop_config.json", "notes": notes}
    entry = {"transport": "streamable-http", "url": endpoint}
    if not oauth:
        entry["headers"] = {"Authorization": f"Bearer {api_key or '<' + api_key_env + '>'}"}
    return {"client": "generic", "name": name, "url": endpoint, "config": {"mcpServers": {name: entry}}, "notes": notes}
