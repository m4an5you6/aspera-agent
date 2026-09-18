"""Ray worker join polls until head is up (rank0 may still be installing)."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from plugins.inference_adapters.agent_tools import handle_inference_ray_join
from plugins.inference_adapters.ray_runtime import (
    _classify_join_failure,
    _parse_host_port,
    join_ray_worker,
    probe_ray_head,
)


@pytest.fixture
def inference_py(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    py = tmp_path / ".cache/gpu_platform/inference_venvs/cu128/bin/python"
    py.parent.mkdir(parents=True)
    py.write_text("#!/bin/sh\n")
    py.chmod(0o755)
    ray = py.parent / "ray"
    ray.write_text("#!/bin/sh\n")
    ray.chmod(0o755)
    return py


def test_parse_host_port_ok():
    assert _parse_host_port("10.0.21.105:6425") == ("10.0.21.105", 6425)


def test_parse_host_port_rejects_bad():
    with pytest.raises(ValueError, match="host:port"):
        _parse_host_port("not-an-address")


def test_probe_ray_head_bad_address():
    out = probe_ray_head("bad")
    assert out["reachable"] is False
    assert out["reason"] == "bad_address"


def test_probe_ray_head_not_listening():
    # High unused port on loopback
    out = probe_ray_head("127.0.0.1:1", timeout=0.5)
    assert out["reachable"] is False
    assert out["reason"] == "head_not_listening"
    assert "not accepting TCP" in out["detail"]


def test_classify_stale_ray():
    reason = _classify_join_failure(
        probe={"reachable": True},
        exit_code=1,
        stdout="",
        stderr="Ray is already running on this node",
        timed_out=False,
    )
    assert reason == "stale_ray"


def test_classify_head_down_from_probe():
    reason = _classify_join_failure(
        probe={"reachable": False, "reason": "head_not_listening"},
        exit_code=None,
        stdout="",
        stderr="",
        timed_out=False,
    )
    assert reason == "head_not_listening"


def test_join_polls_until_head_then_succeeds(inference_py, monkeypatch):
    monkeypatch.delenv("GPUCLOUD_INFERENCE_NODE_RANK", raising=False)
    monkeypatch.delenv("NODE_RANK", raising=False)

    calls = {"probe": 0, "attempt": 0}

    def fake_probe(address, timeout=3.0):
        calls["probe"] += 1
        if calls["probe"] < 3:
            return {
                "reachable": False,
                "reason": "head_not_listening",
                "detail": "down",
                "host": "10.0.0.1",
                "port": 6379,
            }
        return {
            "reachable": True,
            "reason": "ok",
            "detail": "up",
            "host": "10.0.0.1",
            "port": 6379,
        }

    def fake_attempt(**kwargs):
        calls["attempt"] += 1
        return {
            "success": True,
            "timed_out": False,
            "exit_code": 0,
            "stdout": "joined",
            "stderr": "",
            "cmd": [],
        }

    with patch("plugins.inference_adapters.ray_runtime.probe_ray_head", side_effect=fake_probe), patch(
        "plugins.inference_adapters.ray_runtime._attempt_ray_join", side_effect=fake_attempt
    ), patch("plugins.inference_adapters.ray_runtime.time.sleep"):
        result = join_ray_worker(
            address="10.0.0.1:6379",
            python_executable=str(inference_py),
            timeout_seconds=30,
            poll_seconds=0.01,
            attempt_timeout_seconds=30,
        )
    assert result["success"] is True
    assert calls["probe"] >= 3
    assert calls["attempt"] == 1
    assert result["attempts"] >= 3
    assert result.get("waited_for_head") is True


def test_join_finite_timeout_when_head_never_up(inference_py):
    with patch(
        "plugins.inference_adapters.ray_runtime.probe_ray_head",
        return_value={
            "reachable": False,
            "reason": "head_not_listening",
            "detail": "still down",
            "host": "10.0.0.1",
            "port": 6379,
        },
    ), patch("plugins.inference_adapters.ray_runtime.time.sleep"), patch(
        "plugins.inference_adapters.ray_runtime._attempt_ray_join"
    ) as attempt:
        result = join_ray_worker(
            address="10.0.0.1:6379",
            python_executable=str(inference_py),
            timeout_seconds=0.05,
            poll_seconds=0.01,
        )
    assert result["success"] is False
    assert result["reason"] == "head_not_listening"
    assert "not listening" in result["error"].lower() or "not listening" in result["error"]
    assert "forever" in result["hint"]
    attempt.assert_not_called()


def test_handle_ray_join_passes_poll_kwargs(monkeypatch, inference_py):
    monkeypatch.setenv("GPUCLOUD_INFERENCE_NODE_RANK", "1")
    monkeypatch.setenv("GPUCLOUD_INFERENCE_NNODES", "2")
    from plugins.inference_adapters.compat_chain import store_compat_chain

    store_compat_chain(
        "job-join-1",
        {
            "status": "verified",
            "venv_python": str(inference_py),
            "fingerprint": "abc",
            "driver": {"nvidia_smi_cuda": "12.4", "driver_version": "550"},
            "model_family": "qwen",
            "pins": {"torch": "torch==2.10.0", "vllm": "vllm==0.17.0"},
            "install_order": ["torch==2.10.0", "vllm==0.17.0"],
            "pip_index": "https://mirrors.aliyun.com/pypi/simple/",
            "rationale": "test",
            "rejected_alternatives": ["x"],
            "smoke_cmd": "true",
        },
    )

    captured = {}

    def fake_join(**kwargs):
        captured.update(kwargs)
        return {"success": True, "role": "worker", "address": kwargs["address"]}

    with patch("plugins.inference_adapters.ray_runtime.join_ray_worker", side_effect=fake_join):
        raw = handle_inference_ray_join(
            {
                "job_id": "job-join-1",
                "address": "10.0.21.105:6425",
                "python_executable": str(inference_py),
                "timeout_seconds": 0,
                "poll_seconds": 20,
            }
        )
    data = json.loads(raw)
    assert data["success"] is True
    assert captured["timeout_seconds"] == 0.0
    assert captured["poll_seconds"] == 20.0
