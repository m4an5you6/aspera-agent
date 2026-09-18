"""Hard gates: worker_ready join+raylet, start_vllm GPU count, wait_workers URL/auth."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from plugins.inference_adapters.agent_tools import (
    handle_inference_cluster_wait_workers,
    handle_inference_report_ready,
    handle_inference_start_vllm,
)
from plugins.inference_adapters.compat_chain import store_compat_chain
from plugins.inference_adapters.ray_runtime import (
    clear_ray_join_success,
    normalize_cluster_master_url,
    parse_ray_status_gpus,
    record_ray_join_success,
    require_ray_gpus_for_tp,
    require_worker_ready_prereqs,
)


@pytest.fixture(autouse=True)
def _clear_joins():
    clear_ray_join_success()
    yield
    clear_ray_join_success()


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


def _store_verified(job_id: str, inference_py: Path) -> None:
    store_compat_chain(
        job_id,
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


# ── master_url / wait_workers ───────────────────────────────────────────────


def test_normalize_master_url_defaults_to_8765():
    out = normalize_cluster_master_url("")
    assert out["ok"] is True
    assert out["master_url"] == "http://127.0.0.1:8765"


def test_normalize_master_url_rejects_ray_port():
    out = normalize_cluster_master_url("http://10.0.21.105:6425")
    assert out["ok"] is False
    assert out["phase"] == "master_url_gate"
    assert "8765" in out["error"]


def test_normalize_master_url_accepts_8765():
    out = normalize_cluster_master_url("http://10.0.21.105:8765")
    assert out["ok"] is True
    assert out["master_url"] == "http://10.0.21.105:8765"


def test_wait_workers_rejects_ray_port(monkeypatch):
    monkeypatch.setenv("GPUCLOUD_INFERENCE_NODE_RANK", "0")
    monkeypatch.setenv("GPUCLOUD_INFERENCE_NNODES", "2")
    monkeypatch.setenv("GPUCLOUD_CLUSTER_SECRET", "secret")
    raw = handle_inference_cluster_wait_workers(
        {
            "job_id": "job-w1",
            "master_url": "http://10.0.21.105:6425",
            "timeout_seconds": 1,
        }
    )
    data = json.loads(raw)
    assert data["success"] is False
    assert data["phase"] == "master_url_gate"


def test_wait_workers_requires_secret(monkeypatch):
    monkeypatch.setenv("GPUCLOUD_INFERENCE_NODE_RANK", "0")
    monkeypatch.setenv("GPUCLOUD_INFERENCE_NNODES", "2")
    monkeypatch.delenv("GPUCLOUD_CLUSTER_SECRET", raising=False)
    raw = handle_inference_cluster_wait_workers(
        {
            "job_id": "job-w2",
            "master_url": "http://10.0.21.105:8765",
            "timeout_seconds": 1,
        }
    )
    data = json.loads(raw)
    assert data["success"] is False
    assert data["phase"] == "auth_gate"


def test_wait_workers_401_fails_fast(monkeypatch):
    monkeypatch.setenv("GPUCLOUD_INFERENCE_NODE_RANK", "0")
    monkeypatch.setenv("GPUCLOUD_INFERENCE_NNODES", "2")
    monkeypatch.setenv("GPUCLOUD_CLUSTER_SECRET", "bad")

    import urllib.error
    from io import BytesIO

    class FakeHTTPError(urllib.error.HTTPError):
        def __init__(self):
            super().__init__(
                url="http://x/api/jobs/j",
                code=401,
                msg="Unauthorized",
                hdrs=None,
                fp=BytesIO(b"unauthorized"),
            )

    with patch("urllib.request.urlopen", side_effect=FakeHTTPError()):
        from plugins.inference_adapters.ray_runtime import wait_workers_ready

        out = wait_workers_ready(
            master_url="http://10.0.21.105:8765",
            job_id="job-w3",
            secret="bad",
            timeout_seconds=5,
            poll_seconds=0.01,
        )
    assert out["success"] is False
    assert out["phase"] == "auth_gate"
    assert "401" in out["error"]


# ── worker_ready gate ───────────────────────────────────────────────────────


def test_worker_ready_refused_without_join():
    raw = handle_inference_report_ready(
        {
            "job_id": "job-wr1",
            "success": True,
            "phase": "worker_ready",
            "summary": "fake ready",
        }
    )
    data = json.loads(raw)
    assert data["success"] is False
    assert data["stored"] is False
    assert data["phase"] == "ray_join_gate"
    assert "ray_join" in data["error"]


def test_worker_ready_refused_without_raylet():
    record_ray_join_success("job-wr2", address="10.0.0.1:6379")
    with patch(
        "plugins.inference_adapters.ray_runtime.local_raylet_alive",
        return_value={"alive": False, "detail": "no raylet"},
    ):
        raw = handle_inference_report_ready(
            {
                "job_id": "job-wr2",
                "success": True,
                "details": {"phase": "worker_ready"},
            }
        )
    data = json.loads(raw)
    assert data["success"] is False
    assert data["phase"] == "raylet_gate"


def test_worker_ready_ok_with_join_and_raylet():
    record_ray_join_success("job-wr3", address="10.0.0.1:6379")
    with patch(
        "plugins.inference_adapters.ray_runtime.local_raylet_alive",
        return_value={"alive": True, "detail": "raylet ok"},
    ):
        raw = handle_inference_report_ready(
            {
                "job_id": "job-wr3",
                "success": True,
                "details": {"phase": "worker_ready", "adapter_id": "hf_vllm"},
            }
        )
    data = json.loads(raw)
    assert data["success"] is True
    assert data["stored"] is True
    assert data["outcome"]["details"]["phase"] == "worker_ready"


def test_rank0_ready_not_gated_by_join():
    raw = handle_inference_report_ready(
        {
            "job_id": "job-r0",
            "success": True,
            "phase": "ready",
            "visit_host": "10.0.0.1",
            "visit_port": 8000,
        }
    )
    data = json.loads(raw)
    assert data["success"] is True
    assert data["stored"] is True


def test_require_worker_ready_prereqs_ok():
    record_ray_join_success("job-wr4", address="a:1")
    with patch(
        "plugins.inference_adapters.ray_runtime.local_raylet_alive",
        return_value={"alive": True, "detail": "ok"},
    ):
        gate = require_worker_ready_prereqs("job-wr4")
    assert gate["ok"] is True


# ── start_vllm GPU gate ─────────────────────────────────────────────────────


def test_parse_ray_status_gpus_total_usage():
    text = """
======== Autoscaler status: 2.x ========
Resources
---------------------------------------------------------------
Total Usage:
 0.0/4.0 GPU
 0.0/32.0 CPU
"""
    assert parse_ray_status_gpus(text) == 4.0


def test_require_ray_gpus_refuses_when_short(inference_py):
    with patch(
        "plugins.inference_adapters.ray_runtime.ray_cluster_gpu_count",
        return_value={"success": True, "gpus": 1.0, "raw": "0.0/1.0 GPU"},
    ):
        gate = require_ray_gpus_for_tp(
            tensor_parallel=4,
            address="10.0.0.1:6379",
            python_executable=str(inference_py),
        )
    assert gate["ok"] is False
    assert gate["phase"] == "ray_gpu_gate"
    assert gate["ray_gpus"] == 1.0


def test_start_vllm_refuses_when_ray_gpus_lt_tp(tmp_path, monkeypatch, inference_py):
    monkeypatch.delenv("GPUCLOUD_INFERENCE_NODE_RANK", raising=False)
    monkeypatch.delenv("NODE_RANK", raising=False)
    _store_verified("job-sv1", inference_py)
    model = tmp_path / "model"
    model.mkdir()
    (model / "config.json").write_text("{}")

    with patch(
        "plugins.inference_adapters.ray_runtime.require_ray_gpus_for_tp",
        return_value={
            "ok": False,
            "error": "only 1 GPU",
            "phase": "ray_gpu_gate",
            "tensor_parallel": 4,
            "ray_gpus": 1.0,
        },
    ):
        raw = handle_inference_start_vllm(
            {
                "job_id": "job-sv1",
                "model_path": str(model),
                "python_executable": str(inference_py),
                "gpus": {"tensor_parallel": 4},
                "ray": {"enabled": True, "address": "10.0.21.105:6425"},
            }
        )
    data = json.loads(raw)
    assert data["success"] is False
    assert data["phase"] == "ray_gpu_gate"


def test_start_vllm_skips_gpu_gate_for_tp1(tmp_path, monkeypatch, inference_py):
    """TP=1 with ray still goes past GPU gate only when tp>1; tp==1 skips."""
    monkeypatch.delenv("GPUCLOUD_INFERENCE_NODE_RANK", raising=False)
    monkeypatch.delenv("NODE_RANK", raising=False)
    _store_verified("job-sv2", inference_py)
    model = tmp_path / "model"
    model.mkdir()
    (model / "config.json").write_text("{}")

    class FakeEndpoint:
        host = "127.0.0.1"
        port = 8000
        protocol = "http://"
        stream_path = "/v1/chat/completions"
        health_path = "/health"
        extra = {"pid": 1, "logs": "/tmp/x"}

        def to_dict(self):
            return {"host": self.host, "port": self.port}

    class FakeAdapter:
        def stop(self):
            return None

        def start(self, spec, artifacts):
            return FakeEndpoint()

    with patch(
        "plugins.inference_adapters.agent_tools._job_adapter",
        return_value=FakeAdapter(),
    ), patch(
        "plugins.inference_adapters.ray_runtime.require_ray_gpus_for_tp"
    ) as gate:
        raw = handle_inference_start_vllm(
            {
                "job_id": "job-sv2",
                "model_path": str(model),
                "python_executable": str(inference_py),
                "gpus": {"tensor_parallel": 1},
                "ray": {"enabled": True, "address": "10.0.21.105:6425"},
            }
        )
    data = json.loads(raw)
    assert data["success"] is True
    gate.assert_not_called()
