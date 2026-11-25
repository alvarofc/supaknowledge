import json
from typing import Any, Callable

import httpx
import pytest

from supaknowledge import Supaknowledge, SupaknowledgeError, TraceRecorder, build_mcp_config, parse_concept_markdown, parse_skill_markdown

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
        assert args == {"kind": "incorrect", "observation": "renamed", "concept_path": "data/orders", "evidence": {"error": "42703"}}
        return {"flag_id": "f-1", "status": "open"}

    kf = client(Recorder(mcp(tool)))
    assert kf.flag("incorrect", "renamed", concept_path="data/orders", evidence={"error": "42703"})["id"] == "f-1"
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


def test_mcp_config_key_env_validation_and_placeholder_notes():
    for bad in ['X"; rm -rf ~; "', "1KEY", "A-B", "$(id)", ""]:
        with pytest.raises(ValueError, match="environment variable name"):
            build_mcp_config("https://p.supabase.co", "a/b", api_key_env=bad)
    assert build_mcp_config("https://p.supabase.co", "a/b", api_key_env="_MY_KEY2")["command"].endswith('Bearer $_MY_KEY2"')
    for kind in ("claude-desktop", "generic"):
        cfg = build_mcp_config("https://p.supabase.co", "a/b", client=kind, api_key_env="MY_KEY")
        assert "<MY_KEY>" in json.dumps(cfg["config"])
        assert cfg["notes"][0].startswith("Replace <MY_KEY> in the config")
    assert build_mcp_config("https://p.supabase.co", "a/b", client="cursor")["notes"][0].startswith("Set SUPAKNOWLEDGE_API_KEY")


def test_constructor_validation():
    with pytest.raises(SupaknowledgeError):
        Supaknowledge(URL, "a/b")
    with pytest.raises(SupaknowledgeError):
        Supaknowledge(URL, "a/b", api_key=KEY, transport="rest")


def test_parse_concept_without_links():
    c = parse_concept_markdown("# T\n\npath: a/b\nkind: domain | type: X | status: stable | revision: 1\ntrust: unverified | STALE (stale_after 2020-01-01)\n\n---\n\nhello")
    assert c["stale"] is True and c["trust"] == "unverified" and c["body"] == "hello" and "links" not in c


def test_parse_skill_files_only_from_trailer_outside_fences():
    md = "\n\n".join([
        "# Skill: r\n\npath: skills/r | revision: 1\n\ndescription: d.",
        "---",
        "### Step heading in the instructions\n\n```md\n## Files\n\n### not/a/file.md\n```",
        "---",
        "## Files",
        "### scripts/q.sql",
        "```sql\nselect 1\n~~~\n### inside/content.txt\n```",
        "### assets/logo.png",
        "(binary; 10 bytes; storage: concept-files/x)",
    ])
    s = parse_skill_markdown(md)
    assert s["files"] == [{"path": "scripts/q.sql"}, {"path": "assets/logo.png"}]
    assert s["body"].startswith("### Step heading in the instructions") and "scripts/q.sql" not in s["body"]
    assert "files" not in parse_skill_markdown("# Skill: r\n\npath: skills/r\n\n---\n\n### Only a heading")


def test_parse_concept_files_trailer():
    c = parse_concept_markdown(
        "# R\n\npath: skills/r\nkind: skill | type: Skill | status: stable | revision: 1\ntrust: human_reviewed\n\n---\n\n"
        "Body\n\n```\nFiles:\n\n- fake\n```\n\nFiles:\n\n- scripts/q.sql (12 bytes)\n\n- README\n\nUse load_skill(\"r\") to get the file contents."
    )
    assert c["files"] == [{"path": "scripts/q.sql", "size_bytes": 12}, {"path": "README"}]
    assert c["body"] == "Body\n\n```\nFiles:\n\n- fake\n```"


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


# ---------------------------------------------------------------------------------------------- review fixes
def test_tool_calls_create_trace_first_and_link_read_and_load_skill():
    seen: dict[str, dict] = {}

    def tool(name: str, args: dict) -> Any:
        seen[name] = args
        if name == "search_knowledge":
            return [{"path": "metrics/arr", "title": "ARR", "kind": "domain"}]
        if name == "read_concept":
            return {"path": "metrics/arr", "kind": "domain", "title": "ARR", "body": "b"}
        return {"skill": {"path": "skills/r", "kind": "skill", "title": "R", "body": "s"}}

    m = mcp(tool)

    def handle(req: httpx.Request, body: Any) -> httpx.Response | None:
        if str(req.url).endswith("/functions/v1/traces") and req.method == "POST":
            return httpx.Response(201, json={"trace_id": "t-9"})
        if "/functions/v1/traces/" in str(req.url):
            return httpx.Response(200, json={})
        return m(req, body)

    rec = Recorder(handle)
    kf = client(rec)
    t = kf.trace()
    kf.handle_tool_call("search_knowledge", {"query": "arr"}, trace=t)
    kf.handle_tool_call("read_concept", {"path": "metrics/arr"}, trace=t)
    kf.handle_tool_call("load_skill", {"name": "r"}, trace=t)
    assert seen["search_knowledge"]["trace_id"] == "t-9"
    assert seen["read_concept"]["trace_id"] == "t-9"
    assert seen["load_skill"]["trace_id"] == "t-9"
    creates = [i for i, (r, _) in enumerate(rec.calls) if r.method == "POST" and str(r.url).endswith("/traces")]
    first_search = next(i for i, (_, b) in enumerate(rec.calls) if b and b.get("params", {}).get("name") == "search_knowledge")
    assert len(creates) == 1 and creates[0] < first_search
    t.end()


def test_invalid_json_tool_args_are_recorded_on_the_trace():
    events: list[dict] = []

    class T:
        def create(self, body: dict) -> dict:
            events.extend(body["events"])
            return {"trace_id": "t"}

        def update(self, trace_id: str, body: dict) -> None:
            events.extend(body.get("events", []))

        def flag(self, **kw: Any) -> dict:
            return {}

    kf = client(Recorder(lambda r, b: None))
    t = TraceRecorder(T())
    out = kf.handle_tool_calls([{"id": "c1", "name": "read_concept", "arguments": "{oops"}], trace=t)
    assert out[0]["is_error"] is True
    t.end()
    assert [(e["tool_name"], e["is_error"], e["tool_input"]) for e in events] == [("read_concept", True, "{oops")]


def test_trace_backoff_no_retry_storm_and_buffer_cap():
    attempts = {"n": 0}
    sent: list[dict] = []
    state = {"down": True}

    class T:
        def create(self, body: dict) -> dict:
            attempts["n"] += 1
            if state["down"]:
                raise SupaknowledgeError("down", status=503)
            sent.extend(body["events"])
            return {"trace_id": "t"}

        def update(self, trace_id: str, body: dict) -> None: ...

        def flag(self, **kw: Any) -> dict:
            return {}

    errors: list[BaseException] = []
    r = TraceRecorder(T(), max_batch=2, max_buffer=5, retry_base=60, on_error=errors.append)
    r.user("1").user("2")  # full batch: one attempt, fails
    assert attempts["n"] == 1
    for i in range(3, 21):
        r.user(str(i))  # backing off: no new requests
    assert attempts["n"] == 1
    assert r.ensure_id() is None and attempts["n"] == 1
    state["down"] = False
    r.flush()  # explicit flush always tries
    assert [e["content"] for e in sent] == ["16", "17", "18", "19", "20"]
    assert r.ensure_id() == "t"


def test_recording_is_not_blocked_by_a_slow_flush():
    import threading

    gate = threading.Event()
    entered = threading.Event()

    class T:
        def create(self, body: dict) -> dict:
            entered.set()
            gate.wait(5)
            return {"trace_id": "t"}

        def update(self, trace_id: str, body: dict) -> None: ...

        def flag(self, **kw: Any) -> dict:
            return {}

    r = TraceRecorder(T())
    r.user("a")
    th = threading.Thread(target=r.flush)
    th.start()
    assert entered.wait(5)
    done = threading.Event()
    threading.Thread(target=lambda: (r.user("b"), done.set())).start()
    assert done.wait(1), "event() blocked on the HTTP call"
    gate.set()
    th.join(5)
    r.end()


def test_default_on_error_warns(caplog: pytest.LogCaptureFixture):
    class T:
        def create(self, body: dict) -> dict:
            raise SupaknowledgeError("down", status=503)

        def update(self, trace_id: str, body: dict) -> None: ...

        def flag(self, **kw: Any) -> dict:
            return {}

    with caplog.at_level("WARNING", logger="supaknowledge"):
        TraceRecorder(T()).user("x").flush()
    assert "down" in caplog.text


def test_trace_accepts_max_buffer_and_on_error():
    errors: list[BaseException] = []
    kf = client(Recorder(lambda r, b: httpx.Response(503, json={"error": "down"})))
    t = kf.trace(max_buffer=2, on_error=errors.append)
    t.user("1").user("2").user("3")
    t.flush()
    assert len(errors) == 1
    assert [e["content"] for e in t._buffer] == ["2", "3"]


def test_format_concept_status_and_missing_links():
    from supaknowledge import format_concept

    out = format_concept(
        {"path": "a", "kind": "domain", "title": "A", "body": "b", "status": "deprecated", "superseded_by": "b", "revision": 2, "links": [{"path": "x", "exists": False}, {"path": "y"}]}
    )
    assert "status: deprecated (superseded by b)" in out
    assert "- x (missing)" in out and "- y\n" in out + "\n"
    assert out.index("status:") < out.index("revision: 2")


def test_mcp_server_config_api_key_options_and_quoted_name():
    kf = client(Recorder(lambda r, b: None))
    inline = kf.mcp_server_config(name="my kf")
    assert KEY in inline["command"] and "'my kf'" in inline["command"]
    env = kf.mcp_server_config(api_key="", api_key_env="KF_KEY")
    assert KEY not in json.dumps(env) and "$KF_KEY" in env["command"]
    other = kf.mcp_server_config(api_key="skn_other")
    assert "skn_other" in other["command"]


def test_mcp_non_json_body_is_a_clear_error():
    kf = client(Recorder(lambda r, b: httpx.Response(200, text="<html>login</html>", headers={"content-type": "text/html"})))
    with pytest.raises(SupaknowledgeError) as ei:
        kf.search("x")
    assert ei.value.code == "invalid_response" and "text/html" in str(ei.value)


def test_rest_load_skill_stable_only_prefers_exact_path():
    def handle(req: httpx.Request, body: Any) -> httpx.Response | None:
        u = str(req.url)
        if "/rest/v1/concepts?" in u:
            return httpx.Response(200, json=[{"path": "a/revenue"}, {"path": "revenue"}])
        if u.endswith("/rpc/read_concept"):
            return httpx.Response(200, json={"id": "c1", "path": body["p_path"], "kind": "skill", "title": "R", "body": ""})
        if u.endswith("/rpc/log_concept_usage"):
            return httpx.Response(200, json=1)
        return None

    rec = Recorder(handle)
    kf = Supaknowledge(URL, SPACE_ID, access_token="jwt", publishable_key="pk", transport="rest", http_client=httpx.Client(transport=httpx.MockTransport(rec)))
    s = kf.load_skill("revenue", trace_id="otel-abc")
    assert s is not None and s["path"] == "revenue"
    assert "status=eq.stable" in str(rec.calls[0][0].url)
    usage = next(b for r, b in rec.calls if str(r.url).endswith("/rpc/log_concept_usage"))
    assert usage["p_trace"] is None


def test_trace_forwards_retry_base_and_retry_max():
    kf = client(Recorder(lambda r, b: httpx.Response(503, json={"error": "down"})))
    t = kf.trace(retry_base=0.25, retry_max=2.0)
    assert t._retry_base == 0.25 and t._retry_max == 2.0
    d = kf.trace()
    assert d._retry_base == 1.0 and d._retry_max == 60.0


def test_rest_load_skill_accepts_full_paths_like_mcp():
    from urllib.parse import unquote

    def handle(req: httpx.Request, body: Any) -> httpx.Response | None:
        u = str(req.url)
        if "/rest/v1/concepts?" in u:
            return httpx.Response(200, json=[{"path": "skills/revenue-report"}])
        if u.endswith("/rpc/read_concept"):
            return httpx.Response(200, json={"id": "c1", "path": body["p_path"], "kind": "skill", "title": "R", "body": ""})
        if u.endswith("/rpc/log_concept_usage"):
            return httpx.Response(200, json=1)
        return None

    rec = Recorder(handle)
    kf = Supaknowledge(URL, SPACE_ID, access_token="jwt", publishable_key="pk", transport="rest", http_client=httpx.Client(transport=httpx.MockTransport(rec)))
    for ref in ["skills/revenue-report", "/skills/revenue-report/SKILL.md", "revenue-report"]:
        s = kf.load_skill(ref)
        assert s is not None and s["path"] == "skills/revenue-report" and s["name"] == "revenue-report", ref
    assert "path.eq.skills/revenue-report,path.like.*/skills/revenue-report)" in unquote(str(rec.calls[0][0].url))
    assert kf.load_skill("../etc") is None


# ---------------------------------------------------------------- 429 retries
def throttled(match: Callable[[httpx.Request, Any], bool], n: int, then: Callable[[httpx.Request, Any], httpx.Response | None], after: str = "0") -> Callable[[httpx.Request, Any], httpx.Response | None]:
    """429 (Retry-After: ``after``) for the first ``n`` matching calls, then ``then``."""
    left = [n]

    def handle(req: httpx.Request, body: Any) -> httpx.Response | None:
        if match(req, body) and left[0] > 0:
            left[0] -= 1
            return httpx.Response(429, json={"error": "too many failed sign-ins for this agent; retry later"}, headers={"retry-after": after})
        return then(req, body)

    return handle


def is_tool(name: str) -> Callable[[httpx.Request, Any], bool]:
    return lambda req, body: isinstance(body, dict) and body.get("method") == "tools/call" and body["params"]["name"] == name


def test_parse_retry_after_and_bounded_policy():
    from email.utils import formatdate

    from supaknowledge import RetryPolicy, parse_retry_after

    assert parse_retry_after("3") == 3.0
    assert parse_retry_after(None) is None
    assert parse_retry_after("soon") is None
    assert abs((parse_retry_after(formatdate(1_000_010, usegmt=True), now=1_000_000) or 0) - 10) < 1
    p = RetryPolicy.bounded(9, 120)
    assert (p.retries, p.max_wait) == (2, 30.0)
    p = RetryPolicy.bounded(-1, 1)
    assert (p.retries, p.max_wait) == (0, 1.0)


def test_read_only_mcp_calls_retry_on_429():
    rec = Recorder(throttled(lambda r, b: isinstance(b, dict) and b.get("method") == "initialize", 1, throttled(is_tool("search_knowledge"), 2, mcp(lambda n, a: []))))
    kf = client(rec)
    assert kf.search("arr") == []
    assert sum(1 for r, b in rec.calls if is_tool("search_knowledge")(r, b)) == 3
    assert sum(1 for _, b in rec.calls if b and b.get("method") == "initialize") == 2


def test_429_gives_up_after_two_retries_and_on_long_retry_after():
    rec = Recorder(throttled(is_tool("read_concept"), 10, mcp(lambda n, a: {"path": "x"})))
    with pytest.raises(SupaknowledgeError) as ei:
        client(rec).read("x")
    assert ei.value.status == 429 and ei.value.retry_after == 0
    assert sum(1 for r, b in rec.calls if is_tool("read_concept")(r, b)) == 3

    slept: list[float] = []
    rec = Recorder(throttled(is_tool("list_skills"), 10, mcp(lambda n, a: []), after="120"))
    kf = client(rec)
    kf._retry.sleep = slept.append  # noqa: SLF001
    with pytest.raises(SupaknowledgeError) as ei:
        kf.list_skills()
    assert ei.value.retry_after == 120 and slept == []
    assert sum(1 for r, b in rec.calls if is_tool("list_skills")(r, b)) == 1


def test_429_honours_retry_after_delay():
    slept: list[float] = []
    rec = Recorder(throttled(is_tool("load_skill"), 1, mcp(lambda n, a: {"path": "skills/r", "kind": "skill", "title": "R", "body": ""}), after="7"))
    kf = client(rec)
    kf._retry.sleep = slept.append  # noqa: SLF001
    assert kf.load_skill("r") is not None
    assert slept == [7.0]


def test_writes_are_never_retried_on_429():
    rec = Recorder(throttled(is_tool("flag_knowledge"), 10, mcp(lambda n, a: {"id": "f-1"})))
    with pytest.raises(SupaknowledgeError) as ei:
        client(rec).flag("missing", "no ARR definition")
    assert ei.value.status == 429
    assert sum(1 for r, b in rec.calls if is_tool("flag_knowledge")(r, b)) == 1

    def rest(req: httpx.Request, body: Any) -> httpx.Response | None:
        return httpx.Response(200, json=[] if req.url.path.endswith("/search_knowledge") else "f-1")

    rpc = lambda fn: (lambda req, body: req.url.path.endswith(f"/rest/v1/rpc/{fn}"))  # noqa: E731
    rec = Recorder(throttled(rpc("search_knowledge"), 1, throttled(rpc("flag_knowledge"), 1, rest)))
    kf = Supaknowledge(URL, SPACE_ID, access_token="jwt", publishable_key="pk", transport="rest", http_client=httpx.Client(transport=httpx.MockTransport(rec)))
    assert kf.search("arr") == []
    assert sum(1 for r, _ in rec.calls if r.url.path.endswith("/search_knowledge")) == 2
    with pytest.raises(SupaknowledgeError):
        kf.flag("missing", "x")
    assert sum(1 for r, _ in rec.calls if r.url.path.endswith("/flag_knowledge")) == 1


def test_max_retries_zero_turns_retries_off():
    rec = Recorder(throttled(is_tool("search_knowledge"), 1, mcp(lambda n, a: [])))
    with pytest.raises(SupaknowledgeError):
        client(rec, max_retries=0).search("arr")
