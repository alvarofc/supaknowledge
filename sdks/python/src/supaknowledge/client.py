"""Supaknowledge client (sync, httpx)."""

from __future__ import annotations

import re
from typing import Any, Callable, Iterable, Literal

import httpx

from ._http import McpClient, SupaknowledgeError, is_not_deployed, request_json
from ._parse import parse_concept_markdown, parse_skill_markdown
from .mcp_config import McpClientKind, build_mcp_config, mcp_endpoint
from .tools import ToolFormat, handle_tool_call, handle_tool_calls, knowledge_tools
from .trace import TraceRecorder
from .types import Concept, ConceptKind, FlagKind, SearchResult, Skill, SkillSummary, ToolCallResult

__version__ = "0.1.0"
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

Transport = Literal["mcp", "rest", "auto"]


def _as_list(v: Any, *keys: str) -> list[Any]:
    if isinstance(v, list):
        return v
    if isinstance(v, dict):
        for k in keys:
            if isinstance(v.get(k), list):
                return v[k]
    return []


def _skill_name(path: str) -> str:
    return path.rstrip("/").split("/")[-1]


class Supaknowledge:
    """Client for one Supaknowledge space.

    Args:
        url: Supabase project URL.
        space: ``"<workspace>/<space>"`` (or a space uuid with transport "rest").
        api_key: agent key ``skn_<agent>_<secret>`` (sent as ``Authorization: Bearer``).
        access_token: user JWT / OAuth token, or a callable returning a fresh one.
        publishable_key: sent as ``apikey``; needed for transport "rest".
        transport: "mcp" (semantic search, any credential), "rest" (PostgREST RPCs, full-text search only,
            user tokens only) or "auto" (MCP, falling back to REST when the mcp function is not deployed).
        http_client: bring your own ``httpx.Client`` (tests: ``httpx.Client(transport=httpx.MockTransport(...))``).
        on_error: receives background trace errors (default: ignore).
    """

    def __init__(
        self,
        url: str,
        space: str,
        *,
        api_key: str | None = None,
        access_token: str | Callable[[], str] | None = None,
        publishable_key: str | None = None,
        transport: Transport = "auto",
        timeout: float = 30.0,
        http_client: httpx.Client | None = None,
        headers: dict[str, str] | None = None,
        on_error: Callable[[BaseException], None] | None = None,
    ) -> None:
        if not url:
            raise SupaknowledgeError("url is required")
        if not space:
            raise SupaknowledgeError('space is required ("<workspace>/<space>")')
        if not api_key and not access_token:
            raise SupaknowledgeError("pass api_key (agent key) or access_token (user token)")
        self.url = url.rstrip("/")
        self.space = space
        self._api_key = api_key
        self._access_token = access_token
        self._publishable_key = publishable_key
        self._headers = headers or {}
        self._on_error = on_error
        self._mode: Transport = transport
        if transport == "rest" and not self._can_rest():
            raise SupaknowledgeError('transport "rest" needs access_token (a user JWT) and publishable_key')
        self._http = http_client or httpx.Client(timeout=timeout)
        self._owns_http = http_client is None
        self._space_id: str | None = None
        self._mcp = McpClient(self._http, mcp_endpoint(self.url, space), self._auth_headers, __version__)

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    def __enter__(self) -> "Supaknowledge":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # ------------------------------------------------------------------ knowledge
    def search(self, query: str, *, kinds: Iterable[ConceptKind] | None = None, limit: int | None = None, trace_id: str | None = None) -> list[SearchResult]:
        """Hybrid search (semantic + full-text via MCP; full-text only via REST)."""
        kinds_l = list(kinds) if kinds else None

        def via_mcp() -> list[SearchResult]:
            args: dict[str, Any] = {"query": query}
            if kinds_l:
                args["kinds"] = kinds_l
            if limit:
                args["limit"] = limit
            if trace_id:
                args["trace_id"] = trace_id
            return _as_list(self._mcp.call_tool("search_knowledge", args), "results", "items")

        def via_rest() -> list[SearchResult]:
            sid = self.space_id()
            rows = self._rpc("search_knowledge", {"p_space": sid, "p_query": query, "p_kinds": kinds_l, "p_limit": limit or 8}) or []
            self._log_usage(sid, [r["concept_id"] for r in rows if r.get("concept_id")], "search", query, trace_id)
            return rows

        return self._route(via_mcp, via_rest)

    def read(self, path: str) -> Concept | None:
        """One concept by path, or None when it does not exist (or you cannot see it)."""

        def via_mcp() -> Concept | None:
            try:
                r = self._mcp.call_tool("read_concept", {"path": path})
            except SupaknowledgeError as e:
                if e.code == "tool_error" and re.search(r"not found|no concept|does not exist", str(e), re.I):
                    return None
                raise
            if not r:
                return None
            return parse_concept_markdown(r) if isinstance(r, str) else (r.get("concept") or r)

        def via_rest() -> Concept | None:
            sid = self.space_id()
            c = self._rpc("read_concept", {"p_space": sid, "p_path": path})
            if c and c.get("id"):
                self._log_usage(sid, [c["id"]], "read", path, None)
            return c or None

        return self._route(via_mcp, via_rest)

    def list_skills(self) -> list[SkillSummary]:
        def via_mcp() -> list[SkillSummary]:
            skills = _as_list(self._mcp.call_tool("list_skills", {}), "skills")
            return [{**s, "name": s.get("name") or _skill_name(s.get("path", ""))} for s in skills]

        def via_rest() -> list[SkillSummary]:
            sid = self.space_id()
            rows = self._rest_get(f"concepts?select=path,title,description&space_id=eq.{sid}&kind=eq.skill&status=eq.stable&order=path")
            return [{"name": _skill_name(r["path"]), **r} for r in rows]

        return self._route(via_mcp, via_rest)

    def load_skill(self, name: str) -> Skill | None:
        def via_mcp() -> Skill | None:
            try:
                r = self._mcp.call_tool("load_skill", {"name": name})
            except SupaknowledgeError as e:
                if e.code == "tool_error" and re.search(r"not found|no skill|does not exist", str(e), re.I):
                    return None
                raise
            if not r:
                return None
            s = parse_skill_markdown(r) if isinstance(r, str) else (r.get("skill") or r)
            s.setdefault("name", _skill_name(s.get("path", name)))
            return s

        def via_rest() -> Skill | None:
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", name):
                return None
            sid = self.space_id()
            rows = self._rest_get(f"concepts?select=path&space_id=eq.{sid}&kind=eq.skill&or=(path.eq.{name},path.like.*/{name})&limit=1")
            if not rows:
                return None
            c = self._rpc("read_concept", {"p_space": sid, "p_path": rows[0]["path"]})
            if not c:
                return None
            self._log_usage(sid, [c["id"]], "load_skill", name, None)
            return {**c, "name": _skill_name(c["path"])}

        return self._route(via_mcp, via_rest)

    def flag(
        self,
        kind: FlagKind,
        observation: str,
        *,
        concept_path: str | None = None,
        query: str | None = None,
        suggested_fix: str | None = None,
        trace_id: str | None = None,
        evidence: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Report missing / incorrect / outdated / conflicting / unclear knowledge. Returns {"id": ...}."""
        if not observation or not observation.strip():
            raise SupaknowledgeError("observation is required")

        def via_mcp() -> dict[str, Any]:
            args = {"kind": kind, "observation": observation, "concept_path": concept_path, "query": query, "suggested_fix": suggested_fix, "trace_id": trace_id}
            r = self._mcp.call_tool("flag_knowledge", {k: v for k, v in args.items() if v})
            if isinstance(r, str):
                m = re.search(r"[0-9a-f-]{36}", r, re.I)
                return {"id": m.group(0) if m else None, "message": r}
            r = r or {}
            return {**r, "id": r.get("id") or r.get("flag_id")}

        def via_rest() -> dict[str, Any]:
            fid = self._rpc(
                "flag_knowledge",
                {
                    "p_space": self.space_id(),
                    "p_kind": kind,
                    "p_observation": observation,
                    "p_concept_path": concept_path,
                    "p_query": query,
                    "p_suggested_fix": suggested_fix,
                    "p_trace": trace_id,
                    "p_evidence": evidence or {},
                },
            )
            return {"id": fid}

        return self._route(via_mcp, via_rest)

    def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        """Call any tool on the Supaknowledge MCP server."""
        return self._mcp.call_tool(name, arguments or {})

    # ------------------------------------------------------------------ traces
    def trace(self, name: str | None = None, external_id: str | None = None, metadata: dict[str, Any] | None = None, *, max_batch: int = 50) -> TraceRecorder:
        """Start recording a trace. Recording never raises; flush()/end() send it."""
        client = self

        class _T:
            def create(self, body: dict[str, Any]) -> dict[str, Any]:
                return request_json(client._http, "POST", f"{client.url}/functions/v1/traces", headers=client._auth_headers(), body={"space": client.space, **body})

            def update(self, trace_id: str, body: dict[str, Any]) -> None:
                request_json(client._http, "PATCH", f"{client.url}/functions/v1/traces/{trace_id}", headers=client._auth_headers(), body=body)

            def flag(self, **kwargs: Any) -> dict[str, Any]:
                return client.flag(**kwargs)

        return TraceRecorder(_T(), name=name, external_id=external_id, metadata=metadata, max_batch=max_batch, on_error=self._on_error)

    # ------------------------------------------------------------------ integrations
    def knowledge_tools(self, prefix: str = "", include: Iterable[str] | None = None, format: ToolFormat = "openai") -> list[dict[str, Any]]:
        """Tool definitions for search_knowledge, read_concept, list_skills, load_skill and flag_knowledge.

        format="openai" (default): OpenAI-compatible function tools; format="json-schema": {name, description, input_schema}.
        """
        return knowledge_tools(prefix, include, format)

    def handle_tool_call(self, name: str, input: Any, *, prefix: str = "", trace: TraceRecorder | None = None) -> ToolCallResult | None:
        """Execute a Supaknowledge tool call. None when `name` is not a Supaknowledge tool. Never raises."""
        return handle_tool_call(self, name, input, prefix=prefix, trace=trace)

    def handle_tool_calls(self, calls: Iterable[Any], *, prefix: str = "", trace: TraceRecorder | None = None) -> list[dict[str, Any]]:
        """[{tool_call_id, name, content, is_error?}] for every Supaknowledge call in `calls` (e.g. an OpenAI message.tool_calls)."""
        return handle_tool_calls(self, calls, prefix=prefix, trace=trace)

    def mcp_server_config(self, client: McpClientKind = "claude-code", *, name: str = "supaknowledge", auth: Literal["agent-key", "oauth"] | None = None) -> dict[str, Any]:
        mode = auth or ("agent-key" if self._api_key else "oauth")
        return build_mcp_config(self.url, self.space, client=client, name=name, auth=mode, api_key=self._api_key if mode == "agent-key" else None)

    # ------------------------------------------------------------------ plumbing
    def _can_rest(self) -> bool:
        return bool(self._access_token and self._publishable_key)

    def _token(self) -> str:
        if self._api_key:
            return self._api_key
        t = self._access_token
        return t() if callable(t) else str(t)

    def _auth_headers(self) -> dict[str, str]:
        h = {**self._headers, "Authorization": f"Bearer {self._token()}"}
        if self._publishable_key:
            h["apikey"] = self._publishable_key
        return h

    def _route(self, via_mcp: Callable[[], Any], via_rest: Callable[[], Any]) -> Any:
        if self._mode == "rest":
            return via_rest()
        if self._mode == "mcp" or not self._can_rest():
            return via_mcp()
        try:
            return via_mcp()
        except SupaknowledgeError as e:
            if not is_not_deployed(e):
                raise
            self._mode = "rest"
            return via_rest()

    def _rest_get(self, path: str) -> Any:
        return request_json(self._http, "GET", f"{self.url}/rest/v1/{path}", headers=self._auth_headers())

    def _rpc(self, fn: str, args: dict[str, Any]) -> Any:
        return request_json(self._http, "POST", f"{self.url}/rest/v1/rpc/{fn}", headers=self._auth_headers(), body=args)

    def _log_usage(self, space: str, ids: list[str], via: str, query: str | None, trace_id: str | None) -> None:
        if not ids:
            return
        try:
            self._rpc("log_concept_usage", {"p_space": space, "p_concepts": ids, "p_via": via, "p_query": query, "p_trace": trace_id})
        except SupaknowledgeError:
            pass

    def space_id(self) -> str:
        """Resolve the space uuid (REST transport)."""
        if self._space_id:
            return self._space_id
        if _UUID.match(self.space):
            self._space_id = self.space
            return self._space_id
        m = re.fullmatch(r"([a-z0-9][a-z0-9-]*)/([a-z0-9][a-z0-9-]*)", self.space)
        if not m:
            raise SupaknowledgeError(f'space must be "<workspace>/<space>" or a uuid, got "{self.space}"')
        rows = self._rest_get(f"spaces?select=id,workspaces!inner(slug)&slug=eq.{m.group(2)}&workspaces.slug=eq.{m.group(1)}&limit=1")
        if not rows:
            raise SupaknowledgeError(f'space "{self.space}" not found or not accessible', status=404)
        self._space_id = rows[0]["id"]
        return self._space_id
