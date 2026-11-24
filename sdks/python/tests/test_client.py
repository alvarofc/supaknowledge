import json
from typing import Any, Callable

import httpx
import pytest

from supaknowledge import Supaknowledge, SupaknowledgeError, TraceRecorder, build_mcp_config, parse_concept_markdown

URL = "http://kf.test"
KEY = "skn_11111111-1111-1111-1111-111111111111_" + "x" * 40
SPACE_ID = "22222222-2222-2222-2222-222222222222"


class Recorder:
    def __init__(self, handler: Callable[[httpx.Request, Any], httpx.Response | None]) -> None:
        self.calls: list[tuple[httpx.Request, Any]] = []
        self.handler = handler

    def __call__(self, req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content) if req.content else None
        self.calls.append((req, body))
        res = self.handler(req, body)
        return res if res is not None else httpx.Response(599, json={"message": f"unmocked {req.method} {req.url}"})


def mcp(tool: Callable[[str, dict], Any], sse: bool = False) -> Callable[[httpx.Request, Any], httpx.Response | None]:
    def handle(req: httpx.Request, body: Any) -> httpx.Response | None:
        if "/functions/v1/mcp" not in str(req.url):
            return None
        if body["method"] == "initialize":
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": {"protocolVersion": "2025-06-18"}}, headers={"mcp-session-id": "s1"})
        if body["method"] == "notifications/initialized":
            return httpx.Response(202)
        try:
            out = tool(body["params"]["name"], body["params"]["arguments"])
            result = {"content": [{"type": "text", "text": out if isinstance(out, str) else json.dumps(out)}]}
        except Exception as e:  # noqa: BLE001
            result = {"content": [{"type": "text", "text": str(e)}], "isError": True}
        payload = {"jsonrpc": "2.0", "id": body["id"], "result": result}
        if sse:
            return httpx.Response(200, text=f"event: message\ndata: {json.dumps(payload)}\n\n", headers={"content-type": "text/event-stream"})
        return httpx.Response(200, json=payload)

    return handle


def client(handler: Recorder, **kw: Any) -> Supaknowledge:
    kw.setdefault("api_key", KEY)
    return Supaknowledge(URL, "acme/finance", http_client=httpx.Client(transport=httpx.MockTransport(handler)), **kw)


def test_search_over_mcp_with_sse_and_session():
    def tool(name: str, args: dict) -> Any:
        assert name == "search_knowledge"
        assert args == {"query": "arr", "kinds": ["domain"], "limit": 2}
        return {"results": [{"path": "metrics/arr", "title": "ARR", "kind": "domain"}]}

    rec = Recorder(mcp(tool, sse=True))
    kf = client(rec)
    assert kf.search("arr", kinds=["domain"], limit=2)[0]["path"] == "metrics/arr"
    kf.search("arr", kinds=["domain"], limit=2)
    methods = [b["method"] for _, b in rec.calls]
    assert methods == ["initialize", "notifications/initialized", "tools/call", "tools/call"]
    req = rec.calls[2][0]
    assert req.headers["authorization"] == f"Bearer {KEY}"
    assert req.headers["mcp-session-id"] == "s1"
    assert str(rec.calls[0][0].url) == f"{URL}/functions/v1/mcp?space=acme/finance"


def test_read_parses_markdown_and_missing_is_none():
    text = "# ARR\n\n_ARR is annual._\n\npath: metrics/arr\nkind: domain | type: Metric | status: stable | revision: 3\ntrust: human_reviewed\n\n---\n\nBody line\n\n---\n\nLinks:\n\n- data/orders\n\n- data/missing [missing]"

    def tool(name: str, args: dict) -> Any:
        if args["path"] == "metrics/arr":
            return text
        raise Exception(f'No concept at "{args["path"]}"')

    kf = client(Recorder(mcp(tool)))
    c = kf.read("metrics/arr")
    assert c is not None
    assert (c["path"], c["type"], c["revision"], c["trust"], c["body"]) == ("metrics/arr", "Metric", 3, "human_reviewed", "Body line")
    assert c["links"] == [{"path": "data/orders", "exists": True}, {"path": "data/missing", "exists": False}]
    assert c["markdown"] == text
    assert kf.read("nope") is None


def test_flag_and_http_errors():
    def tool(name: str, args: dict) -> Any:
        assert args == {"kind": "incorrect", "observation": "renamed", "concept_path": "data/orders"}
        return {"flag_id": "f-1", "status": "open"}

    kf = client(Recorder(mcp(tool)))
    assert kf.flag("incorrect", "renamed", concept_path="data/orders")["id"] == "f-1"
    with pytest.raises(SupaknowledgeError):
        kf.flag("missing", "  ")

    bad = client(Recorder(lambda req, body: httpx.Response(401, json={"error": "invalid or revoked agent key"})))
    with pytest.raises(SupaknowledgeError) as ei:
        bad.search("x")
    assert ei.value.status == 401 and "revoked" in str(ei.value)


def test_rest_fallback_when_mcp_not_deployed():
    def handle(req: httpx.Request, body: Any) -> httpx.Response | None:
        u = str(req.url)
        if "/functions/v1/mcp" in u:
            return httpx.Response(501, json={"error": "not implemented"})
        if "/rest/v1/spaces?" in u:
            return httpx.Response(200, json=[{"id": SPACE_ID}])
        if u.endswith("/rpc/search_knowledge"):
            assert req.headers["apikey"] == "pk"
            assert req.headers["authorization"] == "Bearer jwt"
            assert body == {"p_space": SPACE_ID, "p_query": "arr", "p_kinds": None, "p_limit": 8}
            return httpx.Response(200, json=[{"concept_id": "c1", "path": "metrics/arr"}])
        if u.endswith("/rpc/log_concept_usage"):
            return httpx.Response(200, json=1)
        return None

    rec = Recorder(handle)
    kf = client(rec, api_key=None, access_token=lambda: "jwt", publishable_key="pk")
    assert kf.search("arr")[0]["path"] == "metrics/arr"
    assert any(str(r.url).endswith("/rpc/log_concept_usage") for r, _ in rec.calls)


def test_trace_recorder_buffers_creates_and_patches():
    def handle(req: httpx.Request, body: Any) -> httpx.Response | None:
        if req.method == "POST" and str(req.url).endswith("/functions/v1/traces"):
            return httpx.Response(201, json={"trace_id": "t-1", "created": True})
        if req.method == "PATCH" and str(req.url).endswith("/functions/v1/traces/t-1"):
            return httpx.Response(200, json={"trace_id": "t-1"})
        return None

    rec = Recorder(handle)
    kf = client(rec)
    with kf.trace(name="run", external_id="ext-1") as t:
        t.user("hi").tool("sql", input={"q": 1}, output="err", is_error=True)
        assert rec.calls == []
        t.flush()
        t.feedback("use revenue_usd_net").set_outcome("corrected")
    create, patch = rec.calls[0][1], rec.calls[1][1]
    assert create["space"] == "acme/finance" and create["external_id"] == "ext-1"
    assert [e["role"] for e in create["events"]] == ["user", "tool"]
    assert create["events"][1]["is_error"] is True and "at" in create["events"][0]
    assert patch["outcome"] == "corrected" and patch["ended_at"]
    assert [e["role"] for e in patch["events"]] == ["feedback"]
    assert t.id == "t-1"


def test_trace_never_raises_and_retries_transient_errors():
    state = {"fail": True}
    errors: list[BaseException] = []

    def handle(req: httpx.Request, body: Any) -> httpx.Response | None:
        return httpx.Response(503, json={"error": "down"}) if state["fail"] else httpx.Response(201, json={"trace_id": "t-2"})

    rec = Recorder(handle)
    kf = client(rec, on_error=errors.append)
    t = kf.trace()
    t.user("a")
    t.flush()
    assert len(errors) == 1
    state["fail"] = False
    t.assistant("b")
    t.flush()
    assert t.id == "t-2"
    assert [e["role"] for e in rec.calls[-1][1]["events"]] == ["user", "assistant"]


def test_context_manager_marks_failure():
    rec = Recorder(lambda req, body: httpx.Response(201, json={"trace_id": "t-3"}) if req.method == "POST" else httpx.Response(200, json={}))
    kf = client(rec)
    with pytest.raises(ValueError):
        with kf.trace() as t:
            t.user("x")
            raise ValueError("boom")
    assert rec.calls[-1][1]["outcome"] == "failure"


def test_tool_helpers():
    def tool(name: str, args: dict) -> Any:
        if name == "search_knowledge":
            return {"results": [{"path": "metrics/arr", "title": "ARR", "kind": "domain"}]}
        if name == "list_skills":
            return {"skills": [{"path": "skills/revenue-report", "description": "Weekly revenue"}]}
        if name == "flag_knowledge":
            assert args.get("trace_id") == "t-9"
            return {"flag_id": "f-9"}
        raise Exception("nope")

    def handle(req: httpx.Request, body: Any) -> httpx.Response | None:
        if str(req.url).endswith("/functions/v1/traces"):
            return httpx.Response(201, json={"trace_id": "t-9"})
        if "/functions/v1/traces/" in str(req.url):
            return httpx.Response(200, json={})
        return mcp(tool)(req, body)

    kf = client(Recorder(handle))
    tools = kf.knowledge_tools(prefix="kf_")
    assert [t["function"]["name"] for t in tools] == ["kf_search_knowledge", "kf_read_concept", "kf_list_skills", "kf_load_skill", "kf_flag_knowledge"]
    assert all(t["type"] == "function" and t["function"]["parameters"]["type"] == "object" for t in tools)
    plain = kf.knowledge_tools(format="json-schema", include=["flag_knowledge"])
    assert plain == [{"name": "flag_knowledge", "description": plain[0]["description"], "input_schema": plain[0]["input_schema"]}]
    assert plain[0]["input_schema"]["required"] == ["kind", "observation"]
    assert kf.handle_tool_call("weather", {}) is None
    assert kf.handle_tool_call("flag_knowledge", {"kind": "bad", "observation": "x"})["is_error"] is True
    assert json.loads(kf.handle_tool_call("list_skills", {})["content"]) == [{"name": "revenue-report", "description": "Weekly revenue"}]

    class Obj:  # OpenAI SDK objects are attribute-based
        def __init__(self, **kw: Any) -> None:
            self.__dict__.update(kw)

    trace = kf.trace()
    results = kf.handle_tool_calls(
        [
            Obj(id="a", type="function", function=Obj(name="search_knowledge", arguments='{"query": "arr"}')),
            {"id": "b", "name": "flag_knowledge", "arguments": {"kind": "missing", "observation": "no churn"}},
            {"id": "c", "name": "other", "arguments": "{}"},
            {"id": "d", "type": "function", "function": {"name": "read_concept", "arguments": "{oops"}},
        ],
        trace=trace,
    )
    assert [r["tool_call_id"] for r in results] == ["a", "b", "d"]
    assert "metrics/arr" in results[0]["content"]
    assert "f-9" in results[1]["content"]
    assert results[2]["is_error"] is True
    trace.end()


def test_mcp_config():
    cc = build_mcp_config("https://p.supabase.co", "acme/finance")
    assert cc["url"] == "https://p.supabase.co/functions/v1/mcp?space=acme/finance"
    assert cc["command"].startswith("claude mcp add --transport http supaknowledge 'https://p.supabase.co/functions/v1/mcp?space=acme/finance' --header")
    assert cc["config"]["mcpServers"]["supaknowledge"]["headers"]["Authorization"] == "Bearer ${SUPAKNOWLEDGE_API_KEY}"
    oauth = build_mcp_config("https://p.supabase.co", "acme/finance", client="cursor", auth="oauth")
    assert "headers" not in oauth["config"]["mcpServers"]["supaknowledge"]
    kf = client(Recorder(lambda r, b: None))
    assert KEY in kf.mcp_server_config("cursor")["config"]["mcpServers"]["supaknowledge"]["headers"]["Authorization"]


def test_constructor_validation():
    with pytest.raises(SupaknowledgeError):
        Supaknowledge(URL, "a/b")
    with pytest.raises(SupaknowledgeError):
        Supaknowledge(URL, "a/b", api_key=KEY, transport="rest")


def test_parse_concept_without_links():
    c = parse_concept_markdown("# T\n\npath: a/b\nkind: domain | type: X | status: stable | revision: 1\ntrust: unverified | STALE (stale_after 2020-01-01)\n\n---\n\nhello")
    assert c["stale"] is True and c["trust"] == "unverified" and c["body"] == "hello" and "links" not in c


def test_recorder_standalone_drops_4xx():
    errors: list[BaseException] = []

    class T:
        def create(self, body: dict) -> dict:
            raise SupaknowledgeError("bad", status=400)

        def update(self, trace_id: str, body: dict) -> None: ...

        def flag(self, **kw: Any) -> dict:
            return {}

    r = TraceRecorder(T(), on_error=errors.append)
    r.user("x")
    r.flush()
    r.flush()
    assert len(errors) == 1
