"""Supaknowledge client (sync, httpx)."""

from __future__ import annotations

import re
from urllib.parse import quote
from typing import Any, Callable, Iterable, Literal

import httpx

from ._http import MAX_RETRIES, MAX_RETRY_WAIT, McpClient, RetryPolicy, SupaknowledgeError, is_not_deployed, request_json
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


def _skill_lookup_path(name: str) -> str | None:
    """A load_skill argument as the MCP tool reads it: a skill name ("revenue-report") or its full path
    ("skills/revenue-report", "/skills/revenue-report/SKILL.md"). None when it can't be a concept path."""
    n = str(name or "").strip().lstrip("/")
    n = re.sub(r"/SKILL\.md$", "", n, flags=re.I)
    n = re.sub(r"\.md$", "", n, flags=re.I)
    n = re.sub(r"/SKILL$", "", n, flags=re.I)
    n = n.rstrip("/")
    return n if re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_./-]*", n) and ".." not in n else None


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
        on_error: receives background trace errors (default: a warning on the ``supaknowledge`` logger).
        max_retries / max_retry_wait: retries when the server answers 429 Too Many Requests (e.g. after repeated
            failed agent-key sign-ins), honouring Retry-After. Only idempotent requests are retried: reads
            (search, read, skills, read-only MCP tools, REST reads); writes (flags, traces) raise the 429 as a
            ``SupaknowledgeError`` with ``status`` 429 and ``retry_after``. Default and maximum: 2 retries,
            waiting at most 30 s for one (a longer Retry-After raises right away). ``max_retries=0`` turns them off.
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
        max_retries: int = MAX_RETRIES,
        max_retry_wait: float = MAX_RETRY_WAIT,
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
        self._retry = RetryPolicy.bounded(max_retries, max_retry_wait)
        self._mcp = McpClient(self._http, mcp_endpoint(self.url, space), self._auth_headers, __version__, self._retry)

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
            rows = self._rpc("search_knowledge", {"p_space": sid, "p_query": query, "p_kinds": kinds_l, "p_limit": limit or 8}, idempotent=True) or []
            self._log_usage(sid, [r["concept_id"] for r in rows if r.get("concept_id")], "search", query, trace_id)
            return rows

        return self._route(via_mcp, via_rest)

    def read(self, path: str, *, trace_id: str | None = None) -> Concept | None:
        """One concept by path, or None when it does not exist (or you cannot see it)."""

        def via_mcp() -> Concept | None:
            try:
                r = self._mcp.call_tool("read_concept", {"path": path, **({"trace_id": trace_id} if trace_id else {})})
            except SupaknowledgeError as e:
                if e.code == "tool_error" and re.search(r"not found|no concept|does not exist", str(e), re.I):
                    return None
                raise
            if not r:
                return None
            return parse_concept_markdown(r) if isinstance(r, str) else (r.get("concept") or r)

        def via_rest() -> Concept | None:
            sid = self.space_id()
            c = self._rpc("read_concept", {"p_space": sid, "p_path": path}, idempotent=True)
            if c and c.get("id"):
                self._log_usage(sid, [c["id"]], "read", path, trace_id)
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

    def load_skill(self, name: str, *, trace_id: str | None = None) -> Skill | None:
        def via_mcp() -> Skill | None:
            try:
                r = self._mcp.call_tool("load_skill", {"name": name, **({"trace_id": trace_id} if trace_id else {})})
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
            # a name or a full path, like the MCP tool
            n = _skill_lookup_path(name)
            if not n:
                return None
            sid = self.space_id()
            # same set list_skills shows (stable skills only); an exact path wins over a "<dir>/<name>" match
            # (LIKE's `_` wildcard can over-match: the exact checks below decide)
            v = quote(n, safe="")
            rows = self._rest_get(
                f"concepts?select=path&space_id=eq.{sid}&kind=eq.skill&status=eq.stable&or=(path.eq.{v},path.like.*/{v})&order=path&limit=20"
            ) or []
            match = next((r for r in rows if r["path"] == n), None) or next((r for r in rows if r["path"].endswith(f"/{n}")), None)
            if not match:
                return None
            c = self._rpc("read_concept", {"p_space": sid, "p_path": match["path"]}, idempotent=True)
            if not c:
                return None
            self._log_usage(sid, [c["id"]], "load_skill", name, trace_id)
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

    def call_tool(self, name: str, arguments: dict[str, Any] | None = None, *, idempotent: bool | None = None) -> Any:
        """Call any tool on the Supaknowledge MCP server. A 429 is retried for read-only tools only, unless
        ``idempotent`` says this call is safe to repeat (or not)."""
        return self._mcp.call_tool(name, arguments or {}, idempotent=idempotent)

    # ------------------------------------------------------------------ traces
    def trace(
        self,
        name: str | None = None,
        external_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        *,
        max_batch: int = 50,
        max_buffer: int = 1000,
        on_error: Callable[[BaseException], None] | None = None,
        retry_base: float = 1.0,
        retry_max: float = 60.0,
    ) -> TraceRecorder:
        """Start recording a trace. Recording never raises; flush()/end() send it.

        ``on_error`` overrides the client's ``on_error`` for this trace; ``max_buffer`` caps events kept while the
        server is unreachable (oldest dropped). After a failed flush, automatic flushes back off ``retry_base``
        seconds, doubling up to ``retry_max``."""
        client = self

        class _T:
            def create(self, body: dict[str, Any]) -> dict[str, Any]:
                return request_json(client._http, "POST", f"{client.url}/functions/v1/traces", headers=client._auth_headers(), body={"space": client.space, **body})

            def update(self, trace_id: str, body: dict[str, Any]) -> None:
                request_json(client._http, "PATCH", f"{client.url}/functions/v1/traces/{trace_id}", headers=client._auth_headers(), body=body)

            def flag(self, **kwargs: Any) -> dict[str, Any]:
                return client.flag(**kwargs)

        return TraceRecorder(
            _T(),
            name=name,
            external_id=external_id,
            metadata=metadata,
            max_batch=max_batch,
            max_buffer=max_buffer,
            on_error=on_error or self._on_error,
            retry_base=retry_base,
            retry_max=retry_max,
        )

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

    def mcp_server_config(
        self,
        client: McpClientKind = "claude-code",
        *,
        name: str = "supaknowledge",
        auth: Literal["agent-key", "oauth"] | None = None,
        api_key: str | None = None,
        api_key_env: str = "SUPAKNOWLEDGE_API_KEY",
    ) -> dict[str, Any]:
        """MCP client config for this space. ``api_key`` overrides the client's key; pass ``api_key=""`` to use an
        ``api_key_env`` placeholder instead of inlining the key."""
        mode = auth or ("agent-key" if self._api_key else "oauth")
        key = (self._api_key if api_key is None else api_key) if mode == "agent-key" else None
        return build_mcp_config(self.url, self.space, client=client, name=name, auth=mode, api_key=key or None, api_key_env=api_key_env)

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
        """PostgREST GET (a read: retried on 429)."""
        return request_json(self._http, "GET", f"{self.url}/rest/v1/{path}", headers=self._auth_headers(), retry=self._retry)

    def _rpc(self, fn: str, args: dict[str, Any], *, idempotent: bool = False) -> Any:
        """PostgREST RPC; only reads (``idempotent``) are retried on 429."""
        return request_json(self._http, "POST", f"{self.url}/rest/v1/rpc/{fn}", headers=self._auth_headers(), body=args, retry=self._retry if idempotent else None)

    def _log_usage(self, space: str, ids: list[str], via: str, query: str | None, trace_id: str | None) -> None:
        if not ids:
            return
        try:
            # p_trace is a uuid: an upstream id (OTel / LangSmith) would make the whole call fail, so it is left out
            trace = trace_id if trace_id and _UUID.match(trace_id) else None
            self._rpc("log_concept_usage", {"p_space": space, "p_concepts": ids, "p_via": via, "p_query": query, "p_trace": trace})
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
