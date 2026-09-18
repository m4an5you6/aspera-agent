"""verbose_logging tool log helpers: args (incl. command) + full result at INFO."""

from __future__ import annotations

import logging

from agent.tool_logging import (
    _VERBOSE_TOOL_LOG_CHARS,
    _log_tool_finish,
    _log_tool_start,
    _tool_args_for_log,
    _tool_result_for_log,
)


def test_tool_args_for_log_includes_command_when_verbose():
    args = {"command": "python /tmp/parse_distcp.py --path /data", "timeout": 60}
    text = _tool_args_for_log(args, verbose=True)
    assert "parse_distcp.py" in text
    assert '"timeout": 60' in text


def test_tool_args_for_log_truncates_when_not_verbose():
    args = {"command": "x" * 2000}
    text = _tool_args_for_log(args, verbose=False, limit=100)
    assert len(text) <= 103  # 100 + "..."
    assert text.endswith("...")


def test_tool_result_for_log_full_when_verbose():
    result = "ok\n" + ("line\n" * 50)
    text = _tool_result_for_log(result, verbose=True)
    assert text == result


def test_tool_result_for_log_caps_huge_verbose_payload():
    huge = "a" * (_VERBOSE_TOOL_LOG_CHARS + 500)
    text = _tool_result_for_log(huge, verbose=True)
    assert "truncated" in text
    assert len(text) < len(huge)


def test_log_tool_start_and_finish_emit_info_with_args_and_result(caplog):
    caplog.set_level(logging.INFO, logger="agent.tool_executor")
    args = {"command": "ls -la /models"}
    result = "total 4\ndrwxr-xr-x 2 root root 4096 Jan 1 00:00 ."

    _log_tool_start(function_name="terminal", function_args=args, verbose=True)
    _log_tool_finish(
        function_name="terminal",
        function_args=args,
        function_result=result,
        duration=1.25,
        is_error=False,
        verbose=True,
    )

    joined = "\n".join(r.getMessage() for r in caplog.records)
    assert "tool terminal starting args=" in joined
    assert "ls -la /models" in joined
    assert "tool terminal completed" in joined
    assert "total 4" in joined


def test_log_tool_finish_error_includes_args(caplog):
    caplog.set_level(logging.WARNING, logger="agent.tool_executor")
    _log_tool_finish(
        function_name="terminal",
        function_args={"command": "bad &"},
        function_result="Error: illegal foreground",
        duration=0.1,
        is_error=True,
        verbose=True,
    )
    msg = caplog.records[-1].getMessage()
    assert "returned error" in msg
    assert "bad &" in msg
    assert "illegal foreground" in msg


def test_log_llm_reasoning_verbose_at_info(caplog):
    from agent.tool_logging import log_llm_reasoning

    caplog.set_level(logging.INFO, logger="agent.tool_executor")
    text = "I should call inference_start_vllm next."
    log_llm_reasoning(text, verbose=True)
    msg = caplog.records[-1].getMessage()
    assert "llm reasoning" in msg
    assert text in msg
    assert caplog.records[-1].levelno == logging.INFO


def test_log_llm_reasoning_caps_huge_payload(caplog):
    from agent.tool_logging import _VERBOSE_TOOL_LOG_CHARS, log_llm_reasoning

    caplog.set_level(logging.INFO, logger="agent.tool_executor")
    huge = "r" * (_VERBOSE_TOOL_LOG_CHARS + 200)
    log_llm_reasoning(huge, verbose=True)
    msg = caplog.records[-1].getMessage()
    assert "truncated" in msg
    assert len(msg) < len(huge) + 100


def test_log_llm_reasoning_non_verbose_is_debug_only(caplog):
    from agent.tool_logging import log_llm_reasoning

    caplog.set_level(logging.DEBUG, logger="agent.tool_executor")
    log_llm_reasoning("secret thoughts", verbose=False)
    assert any(r.levelno == logging.DEBUG for r in caplog.records)
    assert not any(
        r.levelno >= logging.INFO and "secret thoughts" in r.getMessage()
        for r in caplog.records
    )
