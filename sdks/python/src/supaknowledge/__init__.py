"""Supaknowledge Python SDK: search, read and flag company knowledge, load skills, record traces."""

from ._http import MCP_PROTOCOL_VERSION, McpClient, SupaknowledgeError, is_not_deployed
from ._parse import parse_concept_markdown, parse_skill_markdown
from .client import Supaknowledge, __version__
from .mcp_config import build_mcp_config, mcp_endpoint
from .tools import KNOWLEDGE_TOOL_NAMES, TOOL_DESCRIPTIONS, format_concept, format_search_results, format_skill_list, handle_tool_call, handle_tool_calls, knowledge_tools
from .trace import TraceRecorder
from .types import CONCEPT_KINDS, FLAG_KINDS, Concept, SearchResult, Skill, SkillSummary, ToolCallResult

__all__ = [
    "Supaknowledge",
    "SupaknowledgeError",
    "TraceRecorder",
    "McpClient",
    "MCP_PROTOCOL_VERSION",
    "is_not_deployed",
    "build_mcp_config",
    "mcp_endpoint",
    "knowledge_tools",
    "handle_tool_call",
    "handle_tool_calls",
    "format_concept",
    "format_search_results",
    "format_skill_list",
    "TOOL_DESCRIPTIONS",
    "parse_concept_markdown",
    "parse_skill_markdown",
    "KNOWLEDGE_TOOL_NAMES",
    "CONCEPT_KINDS",
    "FLAG_KINDS",
    "Concept",
    "SearchResult",
    "Skill",
    "SkillSummary",
    "ToolCallResult",
    "__version__",
]
