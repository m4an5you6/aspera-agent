"""Tests for headless AutoGoalRuntime."""

from __future__ import annotations

import os
from typing import Any, Dict, Optional, Tuple

from gpucloud_cli.autogoal_runtime import (
    AUTO_GOAL_OPERATING_CONTRACT,
    PROFILE_CLUSTER_INFERENCE,
    AutoGoalRuntime,
    ContractCompletion,
    format_kickoff_prompt,
    wrap_objective_with_operating_contract,
)


def _parse_simple(payload: Optional[Dict[str, Any]]) -> Tuple[bool, str, Dict[str, Any]]:
    if not isinstance(payload, dict):
        return False, "missing contract", {"phase": "agent_error"}
    success = bool(payload.get("success"))
    return success, str(payload.get("summary") or ""), dict(payload.get("details") or {})


def _extract_json(text: str) -> Optional[Dict[str, Any]]:
    raw = (text or "").strip()
    if raw.startswith("{"):
        import json

        try:
            obj = json.loads(raw)
            return obj if isinstance(obj, dict) else None
        except json.JSONDecodeError:
            return None
    return None


def test_format_kickoff_includes_shared_contract():
    text = format_kickoff_prompt("deploy model", config_context="(none)")
    assert "deploy model" in text
    assert "AUTO_GOAL_BLOCKED" in text
    assert "Do not ask the user questions" in text
    assert AUTO_GOAL_OPERATING_CONTRACT.splitlines()[0] in text


def test_cluster_inference_profile_keeps_context_files_skips_memory():
    assert PROFILE_CLUSTER_INFERENCE.skip_context_files is False
    assert PROFILE_CLUSTER_INFERENCE.skip_memory is True
    assert PROFILE_CLUSTER_INFERENCE.verbose_logging is True
    assert PROFILE_CLUSTER_INFERENCE.default_segment_max_turns == 100
    assert PROFILE_CLUSTER_INFERENCE.default_max_segments == 20
    assert PROFILE_CLUSTER_INFERENCE.default_max_iterations == 100


def test_wrap_objective_with_operating_contract():
    wrapped = wrap_objective_with_operating_contract("do the thing", host_label="cluster_inference")
    assert "cluster_inference" in wrapped
    assert "do the thing" in wrapped
    assert "AUTO_GOAL_BLOCKED" in wrapped


def test_runtime_multi_segment_continues_with_summary(monkeypatch, tmp_path):
    monkeypatch.setenv("GPUCLOUD_HOME", str(tmp_path / ".gpucloud"))
    (tmp_path / ".gpucloud").mkdir(parents=True, exist_ok=True)

    calls = {"n": 0, "prompts": [], "agents": 0, "histories": []}
    reported_box: Dict[str, Any] = {"payload": None}

    class FakeAgent:
        def __init__(self, **kwargs):
            calls["agents"] += 1
            assert kwargs.get("max_iterations") == 3

        def run_conversation(self, user_message="", task_id=None, conversation_history=None):
            calls["n"] += 1
            calls["prompts"].append(user_message)
            calls["histories"].append(conversation_history)
            if calls["n"] == 1:
                return {
                    "final_response": "still installing vllm, not ready",
                    "messages": [
                        {"role": "user", "content": user_message},
                        {"role": "assistant", "content": "still installing vllm, not ready"},
                    ],
                }
            reported_box["payload"] = {
                "success": True,
                "summary": "ready after segment 2",
                "details": {"phase": "ready", "visit_port": 8000},
            }
            return {"final_response": '{"success": true}'}

        def interrupt(self, reason=""):
            return None

        def get_activity_summary(self):
            return {"seconds_since_activity": 0.0}

    result = AutoGoalRuntime().run(
        objective="deploy inference",
        profile=PROFILE_CLUSTER_INFERENCE,
        session_id="sess-multi",
        completion=ContractCompletion(
            pop_reported=lambda: reported_box.pop("payload", None),
            parse_contract=_parse_simple,
            extract_json=_extract_json,
        ),
        agent_factory=FakeAgent,
        runtime_provider={
            "provider": "test",
            "api_key": "k",
            "base_url": "http://x",
            "api_mode": "chat_completions",
            "model": "m",
        },
        inactivity_seconds=1800,
        segment_max_turns=3,
        max_segments=5,
    )

    assert result.success is True
    assert calls["n"] == 2
    assert calls["agents"] == 1  # CLI-style: reuse one agent across segments
    assert calls["histories"][0] is None
    assert isinstance(calls["histories"][1], list)
    assert "deploy inference" in calls["prompts"][0]
    assert "[Continuing AutoGoal]" in calls["prompts"][1]
    assert "still installing vllm" in calls["prompts"][1]
    assert "skill_manage" not in calls["prompts"][1]
    assert result.details.get("segment_index") == 2


def test_try_complete_ignores_scraped_failure_json():
    """Prose + failure JSON after a segment must NOT end AutoGoal early."""
    completion = ContractCompletion(
        pop_reported=lambda: None,
        parse_contract=_parse_simple,
        extract_json=_extract_json,
    )
    early = completion.try_complete(
        conversation_result={
            "final_response": (
                "Engine core failed again.\n"
                '{"success": false, "summary": "vllm failed", '
                '"details": {"phase": "start"}}'
            )
        },
        defaults={},
    )
    assert early is None


def test_try_complete_accepts_scraped_terminal_success_json():
    completion = ContractCompletion(
        pop_reported=lambda: None,
        parse_contract=_parse_simple,
        extract_json=_extract_json,
    )
    early = completion.try_complete(
        conversation_result={
            "final_response": (
                '{"success": true, "summary": "ok", '
                '"details": {"phase": "ready", "visit_port": 8000}}'
            )
        },
        defaults={},
    )
    assert early is not None
    assert early.success is True
    assert early.status == "done"


def test_try_complete_tool_reported_failure_stops():
    completion = ContractCompletion(
        pop_reported=lambda: {
            "success": False,
            "summary": "gave up",
            "details": {"phase": "start"},
        },
        parse_contract=_parse_simple,
        extract_json=_extract_json,
    )
    early = completion.try_complete(
        conversation_result={"final_response": "still working"},
        defaults={},
    )
    assert early is not None
    assert early.success is False
    assert early.status == "failed"


def test_runtime_scraped_failure_json_continues_to_next_segment(monkeypatch, tmp_path):
    """Regression: max-iterations final text with failure JSON used to stop at segment 1."""
    monkeypatch.setenv("GPUCLOUD_HOME", str(tmp_path / ".gpucloud"))
    (tmp_path / ".gpucloud").mkdir(parents=True, exist_ok=True)

    calls = {"n": 0}
    reported_box: Dict[str, Any] = {"payload": None}

    class FakeAgent:
        def __init__(self, **kwargs):
            pass

        def run_conversation(self, user_message="", task_id=None, conversation_history=None):
            calls["n"] += 1
            if calls["n"] == 1:
                return {
                    "final_response": (
                        "torch_c_dlpack_ext ABI mismatch.\n"
                        '{"success": false, "summary": "engine failed", '
                        '"details": {"phase": "start"}}'
                    ),
                    "messages": [{"role": "assistant", "content": "seg1"}],
                }
            reported_box["payload"] = {
                "success": True,
                "summary": "ready",
                "details": {"phase": "ready", "visit_port": 8000},
            }
            return {"final_response": "done", "messages": [{"role": "assistant", "content": "seg2"}]}

        def interrupt(self, reason=""):
            return None

        def get_activity_summary(self):
            return {"seconds_since_activity": 0.0}

    result = AutoGoalRuntime().run(
        objective="deploy",
        profile=PROFILE_CLUSTER_INFERENCE,
        session_id="sess-fail-json",
        completion=ContractCompletion(
            pop_reported=lambda: reported_box.pop("payload", None),
            parse_contract=_parse_simple,
            extract_json=_extract_json,
        ),
        agent_factory=FakeAgent,
        runtime_provider={
            "provider": "test",
            "api_key": "k",
            "base_url": "http://x",
            "api_mode": "chat_completions",
            "model": "m",
        },
        inactivity_seconds=1800,
        segment_max_turns=3,
        max_segments=5,
    )

    assert calls["n"] == 2
    assert result.success is True
    assert result.details.get("segment_index") == 2


def test_runtime_contract_completion_success(monkeypatch, tmp_path):
    monkeypatch.setenv("GPUCLOUD_HOME", str(tmp_path / ".gpucloud"))
    (tmp_path / ".gpucloud").mkdir(parents=True, exist_ok=True)

    reported = {
        "success": True,
        "summary": "ok",
        "details": {"phase": "ready", "visit_port": 8000},
    }

    class FakeAgent:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        def run_conversation(self, user_message="", task_id=None, conversation_history=None):
            return {"final_response": "done"}

        def interrupt(self, reason=""):
            return None

        def get_activity_summary(self):
            return {"seconds_since_activity": 0.0}

    prev = os.environ.get("GPUCLOUD_YOLO_MODE")
    os.environ.pop("GPUCLOUD_YOLO_MODE", None)

    result = AutoGoalRuntime().run(
        objective="obj",
        profile=PROFILE_CLUSTER_INFERENCE,
        session_id="sess-1",
        completion=ContractCompletion(
            pop_reported=lambda: dict(reported),
            parse_contract=_parse_simple,
            extract_json=_extract_json,
        ),
        agent_factory=FakeAgent,
        runtime_provider={
            "provider": "test",
            "api_key": "k",
            "base_url": "http://x",
            "api_mode": "chat_completions",
            "model": "m",
        },
        inactivity_seconds=1800,
        max_iterations=10,
    )

    assert result.success is True
    assert result.status == "done"
    assert result.details.get("visit_port") == 8000
    # YOLO restored
    if prev is None:
        assert os.environ.get("GPUCLOUD_YOLO_MODE") is None
    else:
        assert os.environ.get("GPUCLOUD_YOLO_MODE") == prev


def test_runtime_passes_verbose_logging_from_profile(monkeypatch, tmp_path):
    monkeypatch.setenv("GPUCLOUD_HOME", str(tmp_path / ".gpucloud"))
    (tmp_path / ".gpucloud").mkdir(parents=True, exist_ok=True)

    captured = {}

    class FakeAgent:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        def run_conversation(self, user_message="", task_id=None, conversation_history=None):
            return {"final_response": "done"}

        def interrupt(self, reason=""):
            return None

        def get_activity_summary(self):
            return {"seconds_since_activity": 0.0}

    AutoGoalRuntime().run(
        objective="obj",
        profile=PROFILE_CLUSTER_INFERENCE,
        session_id="sess-verbose",
        completion=ContractCompletion(
            pop_reported=lambda: {
                "success": True,
                "summary": "ok",
                "details": {},
            },
            parse_contract=_parse_simple,
            extract_json=_extract_json,
        ),
        agent_factory=FakeAgent,
        runtime_provider={
            "provider": "test",
            "api_key": "k",
            "base_url": "http://x",
            "api_mode": "chat_completions",
            "model": "m",
        },
        inactivity_seconds=1800,
        max_iterations=10,
    )

    assert captured.get("verbose_logging") is True


def test_runtime_stop_flag_before_start():
    called = {"agent": False}

    class FakeAgent:
        def __init__(self, **kwargs):
            called["agent"] = True

        def run_conversation(self, user_message="", task_id=None, conversation_history=None):
            return {"final_response": ""}

    result = AutoGoalRuntime().run(
        objective="obj",
        profile=PROFILE_CLUSTER_INFERENCE,
        session_id="sess-stop",
        completion=ContractCompletion(
            pop_reported=lambda: None,
            parse_contract=_parse_simple,
            extract_json=_extract_json,
        ),
        stop_flag=lambda: True,
        agent_factory=FakeAgent,
        runtime_provider={
            "provider": "test",
            "api_key": "k",
            "base_url": "http://x",
            "api_mode": "chat_completions",
            "model": "m",
        },
        defaults={"adapter_id": "hf_vllm"},
    )
    assert result.success is False
    assert result.status == "cancelled"
    assert result.details.get("phase") == "cancelled"
    assert called["agent"] is False


def test_runtime_inactivity_timeout():
    interrupted = []

    class FakeAgent:
        def __init__(self, **kwargs):
            pass

        def run_conversation(self, user_message="", task_id=None, conversation_history=None):
            import time

            time.sleep(5)
            return {"final_response": "still going"}

        def interrupt(self, reason=""):
            interrupted.append(reason)

        def get_activity_summary(self):
            return {"seconds_since_activity": 9999.0}

    result = AutoGoalRuntime().run(
        objective="obj",
        profile=PROFILE_CLUSTER_INFERENCE,
        session_id="sess-idle",
        completion=ContractCompletion(
            pop_reported=lambda: None,
            parse_contract=_parse_simple,
            extract_json=_extract_json,
        ),
        agent_factory=FakeAgent,
        interrupt_agent=lambda sid, reason: interrupted.append((sid, reason)) or True,
        runtime_provider={
            "provider": "test",
            "api_key": "k",
            "base_url": "http://x",
            "api_mode": "chat_completions",
            "model": "m",
        },
        inactivity_seconds=1.0,
        defaults={"adapter_id": "hf_vllm"},
    )
    assert result.success is False
    assert result.status == "timeout"
    assert interrupted
