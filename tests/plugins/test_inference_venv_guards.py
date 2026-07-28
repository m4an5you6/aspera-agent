"""Hard guards: inference_venvs only + multi-node role gating."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from plugins.inference_adapters.agent_tools import (
    handle_inference_ray_join,
    handle_inference_ray_start,
    handle_inference_start_vllm,
)
from plugins.inference_adapters.inference_venv import (
    InferenceVenvError,
    check_role_tool_allowed,
    is_swift_python,
    resolve_serve_python,
)
from plugins.inference_adapters.runtime import _merge_inference_spec
from plugins.inference_adapters.spec import extract_inference_spec


@pytest.fixture
def inference_py(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    py = tmp_path / ".cache/gpu_platform/inference_venvs/cu124/bin/python"
    py.parent.mkdir(parents=True)
    py.write_text("#!/bin/sh\n")
    py.chmod(0o755)
    return py


def test_is_swift_python():
    assert is_swift_python("/home/u/.cache/gpu_platform/swift_venv/bin/python")
    assert not is_swift_python("/home/u/.cache/gpu_platform/inference_venvs/cu124/bin/python")


def test_resolve_serve_python_rejects_swift(tmp_path, monkeypatch, inference_py):
    swift = tmp_path / ".cache/gpu_platform/swift_venv/bin/python"
    swift.parent.mkdir(parents=True)
    swift.write_text("#!/bin/sh\n")
    with pytest.raises(InferenceVenvError, match="swift_venv"):
        resolve_serve_python(str(swift), allow_swift=False)


def test_resolve_serve_python_rejects_system(tmp_path, monkeypatch, inference_py):
    with pytest.raises(InferenceVenvError, match="inference_venvs"):
        resolve_serve_python("python3", allow_swift=False)


def test_resolve_serve_python_auto_picks_cu124(tmp_path, monkeypatch, inference_py):
    assert resolve_serve_python("", allow_swift=False) == str(inference_py)


def test_resolve_serve_python_accepts_explicit(tmp_path, monkeypatch, inference_py):
    assert resolve_serve_python(str(inference_py), allow_swift=False) == str(inference_py)


def test_role_gate_worker_cannot_ray_start(monkeypatch):
    monkeypatch.setenv("GPUCLOUD_INFERENCE_NODE_RANK", "1")
    monkeypatch.setenv("GPUCLOUD_INFERENCE_NNODES", "2")
    ok, err = check_role_tool_allowed("inference_ray_start")
    assert ok is False
    assert "ray_join" in err


def test_role_gate_rank0_cannot_ray_join(monkeypatch):
    monkeypatch.setenv("GPUCLOUD_INFERENCE_NODE_RANK", "0")
    monkeypatch.setenv("GPUCLOUD_INFERENCE_NNODES", "2")
    ok, err = check_role_tool_allowed("inference_ray_join")
    assert ok is False
    assert "ray_start" in err


def test_role_gate_worker_cannot_start_vllm(monkeypatch):
    monkeypatch.setenv("GPUCLOUD_INFERENCE_NODE_RANK", "1")
    monkeypatch.setenv("GPUCLOUD_INFERENCE_NNODES", "2")
    ok, err = check_role_tool_allowed("inference_start_vllm")
    assert ok is False
    assert "worker_ready" in err


def test_role_gate_unknown_rank_allows(monkeypatch):
    monkeypatch.delenv("GPUCLOUD_INFERENCE_NODE_RANK", raising=False)
    monkeypatch.delenv("NODE_RANK", raising=False)
    ok, err = check_role_tool_allowed("inference_ray_start")
    assert ok is True
    assert err == ""


def test_agent_tool_ray_start_rejects_swift(tmp_path, monkeypatch, inference_py):
    monkeypatch.delenv("GPUCLOUD_INFERENCE_NODE_RANK", raising=False)
    monkeypatch.delenv("NODE_RANK", raising=False)
    swift = tmp_path / ".cache/gpu_platform/swift_venv/bin/python"
    swift.parent.mkdir(parents=True)
    swift.write_text("#!/bin/sh\n")
    raw = handle_inference_ray_start({"python_executable": str(swift), "port": 6379})
    data = json.loads(raw)
    assert data["success"] is False
    assert data["phase"] == "venv_gate"
    assert "swift_venv" in data["error"]


def test_agent_tool_ray_start_role_gate(monkeypatch, inference_py):
    monkeypatch.setenv("GPUCLOUD_INFERENCE_NODE_RANK", "1")
    monkeypatch.setenv("GPUCLOUD_INFERENCE_NNODES", "2")
    raw = handle_inference_ray_start({"python_executable": str(inference_py)})
    data = json.loads(raw)
    assert data["success"] is False
    assert data["phase"] == "role_gate"


def test_agent_tool_ray_join_role_gate(monkeypatch, inference_py):
    monkeypatch.setenv("GPUCLOUD_INFERENCE_NODE_RANK", "0")
    monkeypatch.setenv("GPUCLOUD_INFERENCE_NNODES", "2")
    raw = handle_inference_ray_join(
        {"address": "10.0.0.1:6379", "python_executable": str(inference_py)}
    )
    data = json.loads(raw)
    assert data["success"] is False
    assert data["phase"] == "role_gate"


def test_agent_tool_start_vllm_role_gate(tmp_path, monkeypatch, inference_py):
    monkeypatch.setenv("GPUCLOUD_INFERENCE_NODE_RANK", "1")
    monkeypatch.setenv("GPUCLOUD_INFERENCE_NNODES", "2")
    model = tmp_path / "model"
    model.mkdir()
    (model / "config.json").write_text("{}")
    raw = handle_inference_start_vllm(
        {
            "job_id": "job-1",
            "model_path": str(model),
            "python_executable": str(inference_py),
        }
    )
    data = json.loads(raw)
    assert data["success"] is False
    assert data["phase"] == "role_gate"


def test_extract_preserves_node_rank():
    spec = extract_inference_spec(
        {
            "adapter_id": "hf_vllm",
            "model": {"local_path": "/m"},
            "node_rank": 1,
            "nnodes": 2,
            "local_visible_devices": [0],
        }
    )
    assert spec["node_rank"] == 1
    assert spec["nnodes"] == 2
    assert spec["local_visible_devices"] == [0]


def test_merge_preserves_rank_from_extra_inference_spec():
    merged = _merge_inference_spec(
        {
            "job_id": "job-1",
            "nnodes": 2,
            "extra": {
                "inference_spec": {
                    "adapter_id": "hf_vllm",
                    "model": {"local_path": "/m"},
                    "node_rank": 1,
                    "nnodes": 2,
                    "local_visible_devices": [3],
                }
            },
        }
    )
    assert merged["node_rank"] == 1
    assert merged["nnodes"] == 2
    assert merged["local_visible_devices"] == [3]
