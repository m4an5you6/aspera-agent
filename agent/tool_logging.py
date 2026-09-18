"""Tool start/finish logging helpers shared by the tool executor.

Kept separate from ``agent.tool_executor`` so unit tests can import without
pulling terminal/environment stacks.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from agent.tool_dispatch_helpers import _multimodal_text_summary

logger = logging.getLogger("agent.tool_executor")

# Cap verbose tool payload lines so a runaway dump cannot explode agent.log.
_VERBOSE_TOOL_LOG_CHARS = 100_000


def _tool_args_for_log(function_args: Any, *, verbose: bool, limit: int = 500) -> str:
    """Serialize tool args for logger lines (full JSON when verbose)."""
    try:
        raw = json.dumps(
            function_args if isinstance(function_args, dict) else {"_": function_args},
            ensure_ascii=False,
        )
    except Exception:
        raw = str(function_args)
    if verbose:
        if len(raw) > _VERBOSE_TOOL_LOG_CHARS:
            return (
                raw[:_VERBOSE_TOOL_LOG_CHARS]
                + f"... [truncated {len(raw) - _VERBOSE_TOOL_LOG_CHARS} chars]"
            )
        return raw
    if len(raw) > limit:
        return raw[:limit] + "..."
    return raw


def _tool_result_for_log(function_result: Any, *, verbose: bool, limit: int = 200) -> str:
    """Serialize tool result for logger lines (full text when verbose, capped)."""
    text = _multimodal_text_summary(function_result)
    if verbose:
        if len(text) > _VERBOSE_TOOL_LOG_CHARS:
            return (
                text[:_VERBOSE_TOOL_LOG_CHARS]
                + f"... [truncated {len(text) - _VERBOSE_TOOL_LOG_CHARS} chars]"
            )
        return text
    if len(text) > limit:
        return text[:limit] + "..."
    return text


def _log_tool_finish(
    *,
    function_name: str,
    function_args: Any,
    function_result: Any,
    duration: float,
    is_error: bool,
    verbose: bool,
) -> None:
    """Write tool finish to the process logger (lands in agent.log at INFO+)."""
    args_s = _tool_args_for_log(function_args, verbose=verbose)
    result_s = _tool_result_for_log(function_result, verbose=verbose)
    result_len = len(function_result) if isinstance(function_result, str) else len(str(function_result))
    if is_error:
        logger.warning(
            "Tool %s returned error (%.2fs) args=%s result=%s",
            function_name,
            duration,
            args_s,
            result_s,
        )
    elif verbose:
        logger.info(
            "tool %s completed (%.2fs, %d chars) args=%s result=%s",
            function_name,
            duration,
            result_len,
            args_s,
            result_s,
        )
    else:
        logger.info(
            "tool %s completed (%.2fs, %d chars)",
            function_name,
            duration,
            result_len,
        )


def _log_tool_start(*, function_name: str, function_args: Any, verbose: bool) -> None:
    if not verbose:
        return
    logger.info(
        "tool %s starting args=%s",
        function_name,
        _tool_args_for_log(function_args, verbose=True),
    )


def _cap_verbose_text(text: str, *, limit: int = _VERBOSE_TOOL_LOG_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"... [truncated {len(text) - limit} chars]"


def log_llm_reasoning(reasoning_text: str, *, verbose: bool) -> None:
    """Write LLM thinking/reasoning to agent.log at INFO when verbose.

    Non-verbose callers get a short DEBUG line only (legacy behavior).
    """
    if not reasoning_text:
        return
    n = len(reasoning_text)
    if verbose:
        logger.info(
            "llm reasoning (%d chars): %s",
            n,
            _cap_verbose_text(reasoning_text),
        )
    else:
        logger.debug("Captured reasoning (%d chars)", n)
