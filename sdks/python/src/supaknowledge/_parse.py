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


_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")


def _fenced_lines(text: str) -> set[int]:
    """Start offsets of the lines that open, close or sit inside a fenced code block (CommonMark rules)."""
    fenced: set[int] = set()
    open_: str | None = None
    pos = 0
    for line in text.split("\n"):
        m = _FENCE.match(line)
        if open_ is not None:
            fenced.add(pos)
            # closed by a fence of the same character, at least as long, with nothing after it
            if m and m.group(1)[0] == open_[0] and len(m.group(1)) >= len(open_) and not m.group(2).strip():
                open_ = None
        elif m:
            fenced.add(pos)
            open_ = m.group(1)
        pos += len(line) + 1
    return fenced


def _last_marker(text: str, marker: str, fenced: set[int] | None = None) -> int:
    """Last index of `marker` whose last line is a whole line outside any fenced code block, or -1."""
    fenced = _fenced_lines(text) if fenced is None else fenced
    line_start_in_marker = marker.rfind("\n") + 1
    i = text.rfind(marker)
    while i >= 0:
        line_start = i + line_start_in_marker
        end = i + len(marker)
        if (line_start == 0 or text[line_start - 1] == "\n") and (end == len(text) or text[end] == "\n") and line_start not in fenced:
            return i
        i = text.rfind(marker, 0, i + len(marker) - 1) if i > 0 else -1
    return -1


def _cut(rest: str, markers: list[str]) -> str:
    fenced = _fenced_lines(rest)
    end = len(rest)
    for m in markers:
        i = _last_marker(rest, m, fenced)
        if 0 <= i < end:
            end = i
    return rest[:end].strip()


def _lines_outside_fences(text: str) -> list[str]:
    fenced = _fenced_lines(text)
    out: list[str] = []
    pos = 0
    for line in text.split("\n"):
        if pos not in fenced:
            out.append(line)
        pos += len(line) + 1
    return out


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
    # read_concept ends with "Files:" and one "- <path> (<n> bytes)" line per attached file
    files: list[dict[str, Any]] = []
    fi = _last_marker(rest, "\n\nFiles:")
    if fi >= 0:
        for line in _lines_outside_fences(rest[fi + 2:]):
            fm = re.match(r"^- (.+?)(?: \((\d+) bytes\))?$", line)
            if fm:
                files.append({"path": fm.group(1), **({"size_bytes": int(fm.group(2))} if fm.group(2) else {})})
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
    if files:
        out["files"] = files
    return out


def parse_skill_markdown(text: str) -> dict[str, Any]:
    header, rest = _split(text)
    name_m = re.search(r"^#\s+Skill:\s*(.+)$", header, re.M)
    name = name_m.group(1).strip() if name_m else ""
    # load_skill ends with "---", "## Files" and one "### <path>" heading per file; headings in the instructions
    # or inside file contents are not files
    ti = _last_marker(rest, SEP + "## Files")
    files = []
    if ti >= 0:
        for line in _lines_outside_fences(rest[ti + len(SEP):]):
            hm = re.match(r"^### (.+)$", line)
            if hm:
                files.append({"path": hm.group(1).strip()})
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
