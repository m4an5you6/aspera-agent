"""Tests for agent-driven inference outcome contract and launch wiring."""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from plugins.inference_adapters.agent_driver import (
    build_inference_agent_prompt,
    clear_reported_outcome,
    get_inference_driver,
    parse_outcome_contract,
    pop_reported_outcome,
    run_inference_agent,
    store_reported_outcome,
)
from plugins.inference_adapters.agent_tools import handle_inference_report_ready
from plugins.inference_adapters.base import ArtifactPaths, EndpointInfo, ModelAdapter
from plugins.inference_adapters.runtime import stop_job_adapter


@pytest.fixture(autouse=True)
def _env(tmp_path, monkeypatch):
    home = tmp_path / ".gpucloud"
    home.mkdir()
    monkeypatch.setenv("GPUCLOUD_HOME", str(home))
    yield
    clear_reported_outcome("job-1")
    clear_reported_outcome("job-agent-1")
    stop_job_adapter("job-1")
    stop_job_adapter("job-agent-1")


def test_get_inference_driver_defaults_agent(monkeypatch):
    monkeypatch.setattr(
        "plugins.inference_adapters.agent_driver.load_inference_adapters_config",
        lambda: {},
    )
    assert get_inference_driver() == "agent"
    monkeypatch.setattr(
        "plugins.inference_adapters.agent_driver.load_inference_adapters_config",
        lambda: {"driver": "legacy_scheme"},
    )
    assert get_inference_driver() == "legacy_scheme"


def test_parse_outcome_contract_success_and_failure():
    ok, summary, details = parse_outcome_contract(
        {
            "success": True,
            "summary": "inference ready",
            "details": {
                "phase": "ready",
                "visit_host": "10.0.0.1",
                "visit_port": 8000,
            },
        },
        defaults={"adapter_id": "hf_vllm"},
    )
    assert ok is True
    assert summary == "inference ready"
    assert details["visit_host"] == "10.0.0.1"
    assert details["adapter_id"] == "hf_vllm"

    ok2, summary2, details2 = parse_outcome_contract(
        {"success": False, "summary": "no model", "details": {"phase": "ensure_artifacts"}},
        defaults={"adapter_id": "hf_vllm"},
    )
    assert ok2 is False
    assert details2["phase"] == "ensure_artifacts"
    assert "no model" in summary2


def test_build_inference_agent_prompt_includes_hints():
    prompt = build_inference_agent_prompt(
        {"job_id": "job-1"},
        {
            "job_id": "job-1",
            "adapter_id": "hf_vllm",
            "model": {"local_path": "/m"},
            "model_hint": "qwen2.5",
        },
    )
    assert "qwen2.5" in prompt
    assert "inference_report_ready" in prompt
    assert "inference_ensure_runtime" in prompt
    assert "job-1" in prompt


def test_report_ready_tool_stores_outcome():
    raw = handle_inference_report_ready(
        {
            "job_id": "job-1",
            "success": True,
            "summary": "inference ready",
            "visit_host": "10.0.0.3",
            "visit_port": 8000,
            "phase": "ready",
            "adapter_id": "hf_vllm",
            "model_path": "/data/m",
        }
    )
    data = json.loads(raw)
    assert data["success"] is True
    stored = pop_reported_outcome("job-1")
    assert stored is not None
    assert stored["success"] is True
    assert stored["details"]["visit_port"] == 8000


def test_run_inference_agent_uses_reported_outcome():
    class FakeAdapter(ModelAdapter):
        adapter_id = "hf_vllm"

        def validate(self, spec):
            return []

        def ensure_artifacts(self, spec):
            return ArtifactPaths(model_path="/tmp/m")

        def start(self, spec, artifacts):
            return EndpointInfo(host="127.0.0.1", port=8000)

        def health(self):
            return "ready"

        def stop(self):
            return None

    class FakeAgent:
        def __init__(self, *args, **kwargs):
            pass

        def run_conversation(self, user_message="", task_id=None):
            store_reported_outcome(
                "job-agent-1",
                {
                    "success": True,
                    "summary": "inference ready",
                    "details": {
                        "phase": "ready",
                        "visit_host": "10.0.0.9",
                        "visit_port": 8000,
                        "adapter_id": "hf_vllm",
                        "model_path": "/tmp/m",
                    },
                },
            )
            return {"final_response": "done"}

        def interrupt(self, reason=""):
            return None

        def get_activity_summary(self):
            return {"seconds_since_activity": 0.0}

    outcomes = []

    def on_outcome(success, summary, details):
        outcomes.append((success, summary, details))

    with patch(
        "gpucloud_cli.runtime_provider.resolve_runtime_provider",
        return_value={
            "provider": "test",
            "api_key": "k",
            "base_url": "http://x",
            "api_mode": "chat_completions",
            "model": "m",
        },
    ):
        result = run_inference_agent(
            job_spec={
                "job_id": "job-agent-1",
                "job_kind": "inference",
                "adapter_id": "hf_vllm",
                "model": {"local_path": "/tmp/m"},
                "serve": {"port": 8000},
            },
            on_outcome=on_outcome,
            adapter=FakeAdapter(),
            agent_factory=FakeAgent,
        )

    assert result["success"] is True
    assert outcomes and outcomes[0][0] is True
    assert outcomes[0][2]["visit_host"] == "10.0.0.9"
    assert outcomes[0][2]["visit_port"] == 8000
