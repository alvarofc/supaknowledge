"""Supaknowledge as tools for any tool-calling LLM loop.

Default definitions are OpenAI-compatible function tools, accepted by OpenAI-compatible endpoints (your own
gateway, Vercel AI Gateway, OpenRouter, vLLM, Ollama, LiteLLM...) and most agent frameworks:

    tools = [*my_tools, *kf.knowledge_tools()]            # [{"type": "function", "function": {...}}]
    msg = client.chat.completions.create(model=..., messages=messages, tools=tools).choices[0].message
    for r in kf.handle_tool_calls(msg.tool_calls or []):  # Supaknowledge calls only; others are skipped
        messages.append({"role": "tool", "tool_call_id": r["tool_call_id"], "content": r["content"]})

`knowledge_tools(format="json-schema")` returns plain `{"name", "description", "input_schema"}` dicts for any
other framework. Definitions are plain dicts: no provider SDK dependency.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Iterable, Literal

from .types import CONCEPT_KINDS, FLAG_KINDS, Concept, SearchResult, SkillSummary, ToolCallResult

if TYPE_CHECKING:
    from .client import Supaknowledge
    from .trace import TraceRecorder

KNOWLEDGE_TOOL_NAMES = ("search_knowledge", "read_concept", "list_skills", "load_skill", "flag_knowledge")

ToolFormat = Literal["openai", "json-schema"]

TOOL_DESCRIPTIONS: dict[str, str] = {
    "search_knowledge": (
        "Search the team's curated knowledge base: skills (how to do the work), domain knowledge (how the business works: "
        "definitions, policies, metrics) and data-access notes (where live data lives and how to query it). Use it before "
        "answering questions about internal processes, metrics, systems or data, and before writing queries against internal "
        "data. Results include a trust tier and a staleness marker; read the full concept with read_concept."
    ),
    "read_concept": "Read one knowledge concept in full (markdown body, frontmatter, links) by its path, as returned by search_knowledge.",
    "list_skills": "List the available skills (name and one-line description). Load one with load_skill when it matches your task.",
    "load_skill": (
        "Load a skill (step-by-step procedure for a task) by name, including its instructions and attached files. "
        "Use when search_knowledge or list_skills shows a relevant skill."
    ),
    "flag_knowledge": (
        "Report knowledge that is missing, wrong, outdated, conflicting or unclear, so the curator can fix it. Call it whenever the "
        "knowledge base did not have what you needed, when reality (an error, a tool result, a user correction) contradicted it, "
        "or when you had to work something out yourself that the next agent should not have to rediscover. "
        "It is cheap; do not ask for permission."
    ),
}

_PARAMETERS: dict[str, dict[str, Any]] = {
    "search_knowledge": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What you are looking for, in natural language."},
            "kinds": {"type": "array", "items": {"type": "string", "enum": list(CONCEPT_KINDS)}, "description": "Optional filter by kind."},
            "limit": {"type": "integer", "minimum": 1, "maximum": 20, "description": "Maximum results (default 8)."},
        },
        "required": ["query"],
        "additionalProperties": False,
    },
    "read_concept": {
        "type": "object",
        "properties": {"path": {"type": "string", "description": 'Concept path, e.g. "metrics/arr".'}},
        "required": ["path"],
        "additionalProperties": False,
    },
    "list_skills": {"type": "object", "properties": {}, "additionalProperties": False},
    "load_skill": {
        "type": "object",
        "properties": {"name": {"type": "string", "description": 'Skill name, e.g. "revenue-report".'}},
        "required": ["name"],
        "additionalProperties": False,
    },
    "flag_knowledge": {
        "type": "object",
        "properties": {
            "kind": {"type": "string", "enum": list(FLAG_KINDS)},
            "observation": {"type": "string", "description": "What you observed, with specifics (error messages, the correct value if known)."},
            "concept_path": {"type": "string", "description": "Path of the concept this is about (omit for missing knowledge)."},
            "query": {"type": "string", "description": "What you were trying to do or find."},
            "suggested_fix": {"type": "string", "description": "How the knowledge should change, if you know."},
        },
        "required": ["kind", "observation"],
        "additionalProperties": False,
    },
}


def knowledge_tools(prefix: str = "", include: Iterable[str] | None = None, format: ToolFormat = "openai") -> list[dict[str, Any]]:
    """Tool definitions. format="openai" (default): {"type": "function", "function": {name, description, parameters}};
    format="json-schema": {"name", "description", "input_schema"}."""
    names = list(include) if include is not None else list(KNOWLEDGE_TOOL_NAMES)
    out: list[dict[str, Any]] = []
    for n in names:
        params = json.loads(json.dumps(_PARAMETERS[n]))
        if format == "json-schema":
            out.append({"name": prefix + n, "description": TOOL_DESCRIPTIONS[n], "input_schema": params})
        else:
            out.append({"type": "function", "function": {"name": prefix + n, "description": TOOL_DESCRIPTIONS[n], "parameters": params}})
    return out


def format_search_results(results: list[SearchResult]) -> str:
    if not results:
        return 'No knowledge found. If you needed it, consider calling flag_knowledge with kind "missing".'
    rows = []
    for r in results:
        row: dict[str, Any] = {k: r.get(k) for k in ("path", "title", "kind", "trust", "description", "snippet")}
        if r.get("stale"):
            row["stale"] = True
        if r.get("status") not in (None, "stable"):
            row["status"] = r.get("status")
        rows.append(row)
    return json.dumps(rows, indent=1, ensure_ascii=False)


def format_skill_list(skills: list[SkillSummary]) -> str:
    if not skills:
        return 'No skills yet. If you needed one, consider calling flag_knowledge with kind "missing".'
    return json.dumps([{"name": s.get("name"), "description": s.get("description")} for s in skills], indent=1, ensure_ascii=False)


def format_concept(c: Concept) -> str:
    if c.get("markdown"):
        return c["markdown"]
    meta = [f"path: {c.get('path')}", f"kind: {c.get('kind')}"]
    for k in ("type", "trust", "revision"):
        if c.get(k):
            meta.append(f"{k}: {c.get(k)}")
    if c.get("stale"):
        meta.append("stale: true (verify before relying on it)")
    parts = [f"# {c.get('title', '')}", "", *meta, ""]
    if c.get("description"):
        parts += [f"> {c['description']}", ""]
    parts.append((c.get("body") or "").strip())
    if c.get("links"):
        parts += ["", "Links:", *[f"- {l['path']}" for l in c["links"]]]
    if c.get("files"):
        parts += ["", "Files:", *[f"- {f['path']}" for f in c["files"]]]
    return "\n".join(parts)


def _str(args: dict[str, Any], field: str, required: bool = True) -> str | None:
    v = args.get(field)
    if v is None or v == "":
        if required:
            raise ValueError(f'"{field}" is required')
        return None
    if not isinstance(v, str):
        raise ValueError(f'"{field}" must be a string')
    return v


def handle_tool_call(kf: "Supaknowledge", name: str, input: Any, *, prefix: str = "", trace: "TraceRecorder | None" = None) -> ToolCallResult | None:
    """Run one Supaknowledge tool call. None when `name` is not a Supaknowledge tool. Never raises."""
    if not name.startswith(prefix):
        return None
    tool = name[len(prefix):]
    if tool not in KNOWLEDGE_TOOL_NAMES:
        return None
    args: dict[str, Any] = input if isinstance(input, dict) else {}
    result: ToolCallResult
    try:
        if tool == "search_knowledge":
            kinds = [k for k in (args.get("kinds") or []) if k in CONCEPT_KINDS] or None
            limit = args.get("limit")
            limit = max(1, min(20, int(limit))) if isinstance(limit, (int, float)) else None
            rs = kf.search(_str(args, "query") or "", kinds=kinds, limit=limit, trace_id=trace.id if trace else None)
            result = {"content": format_search_results(rs)}
        elif tool == "read_concept":
            path = _str(args, "path") or ""
            c = kf.read(path)
            result = {"content": format_concept(c)} if c else {"content": f'No concept at "{path}". Use search_knowledge to find the right path.', "is_error": True}
        elif tool == "list_skills":
            result = {"content": format_skill_list(kf.list_skills())}
        elif tool == "load_skill":
            n = _str(args, "name") or ""
            s = kf.load_skill(n)
            result = {"content": format_concept(s)} if s else {"content": f'No skill named "{n}".', "is_error": True}
        else:
            kind = _str(args, "kind") or ""
            if kind not in FLAG_KINDS:
                raise ValueError(f'"kind" must be one of {", ".join(FLAG_KINDS)}')
            kw = {
                "concept_path": _str(args, "concept_path", False),
                "query": _str(args, "query", False),
                "suggested_fix": _str(args, "suggested_fix", False),
            }
            observation = _str(args, "observation") or ""
            r = trace.flag(kind, observation, **kw) if trace else kf.flag(kind, observation, **kw)  # type: ignore[arg-type]
            fid = (r or {}).get("id")
            result = {"content": f"Flag recorded ({fid}). The curator will review it; continue with your task." if fid else "Flag recorded. Continue with your task."}
    except Exception as e:  # the model should see the failure and recover
        result = {"content": f"Supaknowledge {tool} failed: {e}", "is_error": True}
    if trace:
        trace.tool(tool, input=args, output=result["content"], is_error=bool(result.get("is_error")))
    return result


def _get(obj: Any, key: str) -> Any:
    return obj.get(key) if isinstance(obj, dict) else getattr(obj, key, None)


def handle_tool_calls(kf: "Supaknowledge", calls: Iterable[Any], *, prefix: str = "", trace: "TraceRecorder | None" = None) -> list[dict[str, Any]]:
    """Answer every Supaknowledge call in `calls`; calls to other tools are skipped. Never raises.

    Accepts {"id", "name", "arguments"} dicts and the OpenAI shape {"id", "function": {"name", "arguments"}}, as dicts
    or SDK objects (attribute access); `arguments` may be a dict or a JSON string.
    Returns [{"tool_call_id", "name", "content", "is_error"?}].
    """
    out: list[dict[str, Any]] = []
    for c in calls or []:
        fn = _get(c, "function")
        name = (_get(fn, "name") if fn is not None else _get(c, "name")) or ""
        raw = _get(fn, "arguments") if fn is not None else (_get(c, "arguments") if _get(c, "arguments") is not None else _get(c, "input"))
        cid = _get(c, "id")
        if not cid or not name:
            continue
        if isinstance(raw, str):
            try:
                raw = json.loads(raw) if raw.strip() else {}
            except ValueError:
                bare = name[len(prefix):]
                if name.startswith(prefix) and bare in KNOWLEDGE_TOOL_NAMES:
                    out.append({"tool_call_id": cid, "name": name, "content": f"Supaknowledge {bare} failed: arguments are not valid JSON", "is_error": True})
                continue
        r = handle_tool_call(kf, name, raw, prefix=prefix, trace=trace)
        if r is not None:
            out.append({"tool_call_id": cid, "name": name, **r})
    return out
