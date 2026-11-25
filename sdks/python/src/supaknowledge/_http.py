"""HTTP plumbing: errors, JSON requests and a minimal MCP (Streamable HTTP) client."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from typing import Any, Callable, TypeVar

import httpx

MCP_PROTOCOL_VERSION = "2025-06-18"

#: Upper bounds of the 429 retry policy: at most 2 retries, never waiting longer than 30 s for one.
MAX_RETRIES = 2
MAX_RETRY_WAIT = 30.0

#: Tools the Supaknowledge MCP server marks read-only (readOnlyHint): a 429 on them is retried. Writes
#: (flag_knowledge, ...) are never retried automatically.
READ_ONLY_TOOLS = frozenset({"list_spaces", "search_knowledge", "read_concept", "list_skills", "load_skill"})

T = TypeVar("T")


class SupaknowledgeError(Exception):
    """An error from Supaknowledge. ``status`` is the HTTP status when there was one."""

    def __init__(
        self, message: str, *, status: int | None = None, code: str | int | None = None, details: Any = None, retry_after: float | None = None
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.details = details
        #: seconds the server asked us to wait (Retry-After), when it said
        self.retry_after = retry_after


def parse_retry_after(value: str | None, now: float | None = None) -> float | None:
    """Retry-After (delay in seconds or an HTTP date) in seconds; None when absent or invalid."""
    if not value:
        return None
    v = value.strip()
    try:
        return max(0.0, float(v))
    except ValueError:
        pass
    try:
        at = parsedate_to_datetime(v).timestamp()
    except (TypeError, ValueError, IndexError):
        return None
    return max(0.0, at - (time.time() if now is None else now))


@dataclass
class RetryPolicy:
    """Retries of idempotent requests answered with 429. ``retries`` 0 turns them off; a Retry-After longer than
    ``max_wait`` seconds is not waited for (the 429 is raised right away, with ``retry_after`` set)."""

    retries: int = MAX_RETRIES
    max_wait: float = MAX_RETRY_WAIT
    sleep: Callable[[float], None] = field(default=time.sleep, repr=False)

    @classmethod
    def bounded(cls, retries: int = MAX_RETRIES, max_wait: float = MAX_RETRY_WAIT, sleep: Callable[[float], None] = time.sleep) -> "RetryPolicy":
        return cls(retries=min(MAX_RETRIES, max(0, int(retries))), max_wait=min(MAX_RETRY_WAIT, max(0.0, float(max_wait))), sleep=sleep)


def with_retry(attempt: Callable[[], T], policy: RetryPolicy | None) -> T:
    """Run ``attempt``, retrying while it raises a 429 (Retry-After, else 1 s / 2 s backoff). Idempotent calls only."""
    i = 0
    while True:
        try:
            return attempt()
        except SupaknowledgeError as e:
            if policy is None or i >= policy.retries or e.status != 429:
                raise
            wait = e.retry_after if e.retry_after is not None else float(2**i)
            if wait > policy.max_wait:
                raise
            policy.sleep(wait)
            i += 1


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
    return SupaknowledgeError(
        str(msg or body or f"HTTP {res.status_code}"),
        status=res.status_code,
        code=(body.get("code") if isinstance(body, dict) else None),
        details=body,
        retry_after=parse_retry_after(res.headers.get("retry-after")),
    )


def request_json(client: httpx.Client, method: str, url: str, *, headers: dict[str, str], body: Any = None, retry: RetryPolicy | None = None) -> Any:
    """JSON request with uniform errors. ``retry``: retry 429s (pass it for idempotent requests only)."""
    return with_retry(lambda: _request_once(client, method, url, headers=headers, body=body), retry)


def _request_once(client: httpx.Client, method: str, url: str, *, headers: dict[str, str], body: Any = None) -> Any:
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

    def __init__(
        self, client: httpx.Client, endpoint: str, headers: Callable[[], dict[str, str]], client_version: str, retry: RetryPolicy | None = None
    ) -> None:
        self._client = client
        self._retry = retry
        self._endpoint = endpoint
        self._headers = headers
        self._version = client_version
        self._session_id: str | None = None
        self._protocol = MCP_PROTOCOL_VERSION
        self._initialized = False
        self._next_id = 1

    def call_tool(self, name: str, arguments: dict[str, Any], *, idempotent: bool | None = None) -> Any:
        """Return structuredContent, else parsed JSON text, else the text. Raises SupaknowledgeError on tool errors.

        A 429 is retried only for idempotent calls (default: the read-only tools)."""
        safe = name in READ_ONLY_TOOLS if idempotent is None else idempotent
        r = self._request("tools/call", {"name": name, "arguments": arguments}, safe) or {}
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
        r = self._send_retrying(
            "initialize",
            {"protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {}, "clientInfo": {"name": "supaknowledge-python", "version": self._version}},
        )
        if isinstance(r, dict) and r.get("protocolVersion"):
            self._protocol = r["protocolVersion"]
        with_retry(lambda: self._send("notifications/initialized", None, notification=True), self._retry)
        self._initialized = True

    def _request(self, method: str, params: Any, idempotent: bool = False) -> Any:
        self._ensure_init()

        def send() -> Any:
            return self._send_retrying(method, params) if idempotent else self._send(method, params)

        try:
            return send()
        except SupaknowledgeError as e:
            if e.status == 404 and self._session_id:  # session expired server-side
                self._session_id = None
                self._initialized = False
                self._ensure_init()
                return send()
            raise

    def _send_retrying(self, method: str, params: Any) -> Any:
        return with_retry(lambda: self._send(method, params), self._retry)

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
