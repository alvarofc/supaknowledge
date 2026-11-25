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


# The trailers below are recognised by their exact rendered shape, anchored at the END of the text, rather than by
# scanning the body for markers: the body is free-form markdown (unclosed fences, fences inside list items, inline
# ``` spans, its own "Files:" / "## Files" sections), so its fence state must not decide where the trailer starts.
# A section only counts when everything from it to the end of the text is a well-formed renderer trailer.

# read_concept: "---" "Links:" "- <path>[ (<anchor>)][ [missing]]"..., "Referenced by:" "- <path> (<title>)"...,
# "Files:" "- <path> (<n> bytes|unknown size)"... ['Use load_skill("<name>") to get the file contents.'], each part separated by
# a blank line and each optional; with an empty body the first one starts the remainder.
_ITEMS = r"((?:\n\n- [^\n]+)+)"
_FILES_TRAILER = re.compile(r"(?:^|\n\n)Files:" + _ITEMS + r'(?:\n\nUse load_skill\("[^"\n]*"\) to get the file contents\.)?\Z')
_BACKLINKS_TRAILER = re.compile(r"(?:^|\n\n)Referenced by:" + _ITEMS + r"\Z")
_LINKS_TRAILER = re.compile(r"(?:^|\n\n)---\n\nLinks:" + _ITEMS + r"\Z")

# load_skill: "---" "## Files", then per file "### <path>" and either a ```-fenced block (the renderer escapes ``` in
# the content, so no content line starts with ```) or a "(binary|not inlined; <n> bytes; storage: ...)" note.
_SKILL_FILE = r"\n\n### ([^\n]+)\n\n(?:```[^\n]*\n(?:(?!```)[^\n]*\n)*```|\((?:binary|not inlined); [^\n]*\))"
_SKILL_TRAILER = re.compile(r"(?:^|\n\n)---\n\n## Files((?:" + _SKILL_FILE + r")+)\Z")


def _split_trailer(text: str, pattern: re.Pattern[str]) -> tuple[str, str | None]:
    """Split `text` into the part before a trailer matching `pattern` (anchored at the end) and its first group."""
    m = pattern.search(text)
    return (text[: m.start()], m.group(1)) if m else (text, None)


def _items(group: str | None) -> list[str]:
    return [line[2:] for line in group.split("\n\n") if line] if group else []


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
    before_files, files_group = _split_trailer(rest, _FILES_TRAILER)
    before_backlinks, _ = _split_trailer(before_files, _BACKLINKS_TRAILER)
    body, links_group = _split_trailer(before_backlinks, _LINKS_TRAILER)
    links = []
    for item in _items(links_group):
        lm = re.match(r"^(\S+)(.*)$", item)
        if lm:
            links.append({"path": lm.group(1), "exists": "[missing]" not in lm.group(2)})
    # the renderer always prints a size suffix ("(<n> bytes)" or "(unknown size)"); older servers omitted it for 0 / unknown
    files: list[dict[str, Any]] = []
    for item in _items(files_group):
        fm = re.match(r"^(.+?)(?: \((?:(\d+) bytes|unknown size)\))?$", item)
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
        "body": body.strip(),
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
    body, files_group = _split_trailer(rest, _SKILL_TRAILER)
    files = [{"path": m.group(1).strip()} for m in re.finditer(_SKILL_FILE, files_group)] if files_group else []
    out: dict[str, Any] = {
        "name": name,
        "path": _field(header, "path") or name,
        "kind": "skill",
        "type": "Skill",
        "title": name,
        "description": _field(header, "description") or "",
        "status": _field(header, "status") or "stable",
        "revision": _int(_field(header, "revision")),
        "body": body.strip(),
        "markdown": text,
    }
    if files:
        out["files"] = files
    return out
