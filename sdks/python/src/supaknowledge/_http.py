"""HTTP plumbing: errors, JSON requests and a minimal MCP (Streamable HTTP) client."""

from __future__ import annotations

import json
from typing import Any, Callable

import httpx

MCP_PROTOCOL_VERSION = "2025-06-18"


class SupaknowledgeError(Exception):
    """An error from Supaknowledge. ``status`` is the HTTP status when there was one."""

    def __init__(self, message: str, *, status: int | None = None, code: str | int | None = None, details: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.details = details


def is_not_deployed(e: BaseException) -> bool:
    """True when an Edge Function route is missing or a placeholder (404 / 501)."""
    return isinstance(e, SupaknowledgeError) and e.status in (404, 501)


def error_from(res: httpx.Response) -> SupaknowledgeError:
    try:
        body: Any = res.json()
    except ValueError:
        body = res.text
    msg = None
    if isinstance(body, dict):
        msg = body.get("message") or body.get("error_description") or body.get("error") or body.get("msg")
    return SupaknowledgeError(str(msg or body or f"HTTP {res.status_code}"), status=res.status_code, code=(body.get("code") if isinstance(body, dict) else None), details=body)


def request_json(client: httpx.Client, method: str, url: str, *, headers: dict[str, str], body: Any = None) -> Any:
    try:
        res = client.request(method, url, headers={"Accept": "application/json", **headers}, json=body if body is not None else None)
    except httpx.HTTPError as e:
        raise SupaknowledgeError(f"network error calling {url}: {e}") from e
    if res.status_code >= 400:
        raise error_from(res)
    if not res.content:
        return None
    try:
        return res.json()
    except ValueError:
        return res.text


def parse_sse(text: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for block in text.replace("\r\n", "\n").split("\n\n"):
        data = "\n".join(line[5:].lstrip(" ") if line.startswith("data: ") else line[5:] for line in block.split("\n") if line.startswith("data:"))
        if not data:
            continue
        try:
            msg = json.loads(data)
        except ValueError:
            continue
        out.extend(msg if isinstance(msg, list) else [msg])
    return out


class McpClient:
    """Just enough MCP for tools/call over Streamable HTTP (JSON or SSE responses)."""

    def __init__(self, client: httpx.Client, endpoint: str, headers: Callable[[], dict[str, str]], client_version: str) -> None:
        self._client = client
        self._endpoint = endpoint
        self._headers = headers
        self._version = client_version
        self._session_id: str | None = None
        self._protocol = MCP_PROTOCOL_VERSION
        self._initialized = False
        self._next_id = 1

    def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        """Return structuredContent, else parsed JSON text, else the text. Raises SupaknowledgeError on tool errors."""
        r = self._request("tools/call", {"name": name, "arguments": arguments}) or {}
        text = "\n".join(c.get("text", "") for c in r.get("content", []) if c.get("type") == "text")
        if r.get("isError"):
            raise SupaknowledgeError(text or f"tool {name} failed", code="tool_error", details=r)
        if r.get("structuredContent") is not None:
            return r["structuredContent"]
        if not text:
            return None
        try:
            return json.loads(text)
        except ValueError:
            return text

    def _ensure_init(self) -> None:
        if self._initialized:
            return
        r = self._send(
            "initialize",
            {"protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {}, "clientInfo": {"name": "supaknowledge-python", "version": self._version}},
        )
        if isinstance(r, dict) and r.get("protocolVersion"):
            self._protocol = r["protocolVersion"]
        self._send("notifications/initialized", None, notification=True)
        self._initialized = True

    def _request(self, method: str, params: Any) -> Any:
        self._ensure_init()
        try:
            return self._send(method, params)
        except SupaknowledgeError as e:
            if e.status == 404 and self._session_id:  # session expired server-side
                self._session_id = None
                self._initialized = False
                self._ensure_init()
                return self._send(method, params)
            raise

    def _send(self, method: str, params: Any, notification: bool = False) -> Any:
        msg: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        msg_id = None
        if not notification:
            msg_id = self._next_id
            self._next_id += 1
            msg["id"] = msg_id
        headers = {**self._headers(), "Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if self._session_id:
            headers["mcp-session-id"] = self._session_id
        if method != "initialize":
            headers["mcp-protocol-version"] = self._protocol
        try:
            res = self._client.post(self._endpoint, headers=headers, content=json.dumps(msg))
        except httpx.HTTPError as e:
            raise SupaknowledgeError(f"network error calling MCP {method}: {e}") from e
        sid = res.headers.get("mcp-session-id")
        if sid:
            self._session_id = sid
        if res.status_code >= 400:
            raise error_from(res)
        if notification or res.status_code == 202:
            return None
        if "text/event-stream" in res.headers.get("content-type", ""):
            msgs = parse_sse(res.text)
        else:
            try:
                parsed = res.json()
            except ValueError:
                # a proxy / login page / misrouted URL answered instead of the MCP server
                ct = res.headers.get("content-type") or "no content-type"
                raise SupaknowledgeError(
                    f"MCP {method}: expected a JSON or SSE response from {self._endpoint}, got {ct}: {res.text[:200]}",
                    status=res.status_code,
                    code="invalid_response",
                    details=res.text[:2000],
                ) from None
            msgs = parsed if isinstance(parsed, list) else [parsed]
        msgs = [m for m in msgs if isinstance(m, dict)]
        reply = next((m for m in msgs if m.get("id") == msg_id), None) or next((m for m in msgs if "result" in m or "error" in m), None)
        if reply is None:
            raise SupaknowledgeError(f"MCP {method}: no response", status=res.status_code)
        if reply.get("error"):
            err = reply["error"]
            raise SupaknowledgeError(err.get("message", "MCP error"), code=err.get("code"), details=err.get("data"))
        return reply.get("result")
