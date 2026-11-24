"""Typed shapes returned by the SDK (plain dicts at runtime)."""

from __future__ import annotations

from typing import Any, Literal, TypedDict

ConceptKind = Literal["skill", "domain", "data_access"]
FlagKind = Literal["missing", "incorrect", "outdated", "conflicting", "unclear"]
TraceOutcome = Literal["unknown", "success", "failure", "corrected"]
TrustTier = Literal["unverified", "machine_confirmed", "human_reviewed"]

CONCEPT_KINDS: tuple[ConceptKind, ...] = ("skill", "domain", "data_access")
FLAG_KINDS: tuple[FlagKind, ...] = ("missing", "incorrect", "outdated", "conflicting", "unclear")


class SearchResult(TypedDict, total=False):
    path: str
    title: str
    kind: ConceptKind
    type: str
    description: str
    snippet: str
    trust: TrustTier
    stale: bool
    status: str
    score: float


class Concept(TypedDict, total=False):
    path: str
    kind: ConceptKind
    type: str
    title: str
    description: str
    body: str
    frontmatter: dict[str, Any]
    tags: list[str]
    status: str
    trust: TrustTier
    stale: bool
    revision: int | None
    links: list[dict[str, Any]]
    files: list[dict[str, Any]]
    markdown: str
    """model-ready rendering from the MCP server, when available"""


class Skill(Concept, total=False):
    name: str


class SkillSummary(TypedDict, total=False):
    name: str
    path: str
    title: str
    description: str


class ToolCallResult(TypedDict, total=False):
    content: str
    is_error: bool
