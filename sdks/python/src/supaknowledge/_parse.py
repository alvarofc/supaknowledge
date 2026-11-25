"""Recover structured fields from the markdown the `mcp` function renders for read_concept / load_skill."""

from __future__ import annotations

import re
from typing import Any

SEP = "\n\n---\n\n"


def _field(header: str, name: str) -> str | None:
    for line in header.split("\n"):
        for part in line.split(" | "):
            m = re.match(rf"^{name}:\s*(.+)$", part.strip())
            if m:
                return m.group(1).strip()
    return None


def _cut(rest: str, markers: list[str]) -> str:
    end = len(rest)
    for m in markers:
        i = rest.rfind(m)
        if 0 <= i < end:
            end = i
    return rest[:end].strip()


def _split(text: str) -> tuple[str, str]:
    i = text.find(SEP)
    return (text[:i], text[i + len(SEP):]) if i >= 0 else (text, "")


def _int(v: str | None) -> int | None:
    try:
        return int(v) if v is not None else None
    except ValueError:
        return None


def parse_concept_markdown(text: str) -> dict[str, Any]:
    header, rest = _split(text)
    title = re.search(r"^#\s+(.+)$", header, re.M)
    desc = re.search(r"^_(.+)_$", header, re.M)
    trust_m = re.search(r"^trust:\s*(.+)$", header, re.M)  # whole line: "human_reviewed | STALE (...)"
    trust_line = trust_m.group(1) if trust_m else ""
    li = rest.rfind(SEP + "Links:")
    links_text = _cut(rest[li + len(SEP):], ["\n\nReferenced by:", "\n\nFiles:"]) if li >= 0 else ""
    links = [{"path": m.group(1), "exists": "[missing]" not in m.group(2)} for m in re.finditer(r"^- (\S+)(.*)$", links_text, re.M)]
    out: dict[str, Any] = {
        "path": _field(header, "path") or "",
        "kind": _field(header, "kind") or "domain",
        "type": _field(header, "type") or "",
        "title": title.group(1).strip() if title else "",
        "description": desc.group(1).strip() if desc else "",
        "status": _field(header, "status") or "stable",
        "revision": _int(_field(header, "revision")),
        "trust": trust_line.split(" ")[0] or None,
        "stale": "STALE" in trust_line,
        "body": _cut(rest, [SEP + "Links:", "\n\nReferenced by:", "\n\nFiles:"]),
        "markdown": text,
    }
    if links:
        out["links"] = links
    return out


def parse_skill_markdown(text: str) -> dict[str, Any]:
    header, rest = _split(text)
    name_m = re.search(r"^#\s+Skill:\s*(.+)$", header, re.M)
    name = name_m.group(1).strip() if name_m else ""
    files = [{"path": m.group(1).strip()} for m in re.finditer(r"^### (.+)$", rest, re.M)]
    out: dict[str, Any] = {
        "name": name,
        "path": _field(header, "path") or name,
        "kind": "skill",
        "type": "Skill",
        "title": name,
        "description": _field(header, "description") or "",
        "status": _field(header, "status") or "stable",
        "revision": _int(_field(header, "revision")),
        "body": _cut(rest, [SEP + "## Files"]),
        "markdown": text,
    }
    if files:
        out["files"] = files
    return out
