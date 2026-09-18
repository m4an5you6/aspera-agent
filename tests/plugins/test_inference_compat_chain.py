"""Compat-chain validation + Ray/serve compat_gate."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from plugins.inference_adapters.agent_tools import (
    handle_inference_ensure_runtime,
    handle_inference_ray_start,
    handle_inference_start_vllm,
)
from plugins.inference_adapters.compat_chain import (
    reset_compat_chains_for_tests,
    validate_compat_chain,
)


@pytest.fixture
def inference_py(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    py = tmp_path / ".cache/gpu_platform/inference_venvs/cu124/bin/python"
    py.parent.mkdir(parents=True)
    py.write_text("#!/bin/sh\n")
    py.chmod(0o755)
    return py


@pytest.fixture(autouse=True)
def _clear_chains():
    reset_compat_chains_for_tests()
    yield
    reset_compat_chains_for_tests()


def _valid_chain(inference_py: Path, **overrides):
    chain = {
        "driver": {"nvidia_smi_cuda": "12.4", "driver_version": "550.54.15"},
        "model_family": "qwen3.6_moe",
        "venv_python": str(inference_py),
        "pins": {
            "torch": "torch==2.5.1+cu124",
            "vllm": "vllm==0.6.6",
        },
        "install_order": ["torch==2.5.1+cu124", "vllm==0.6.6"],
        "pip_index": "https://mirrors.aliyun.com/pypi/simple/",
        "pip_extra_index": "https://download.pytorch.org/whl/cu124",
        "rationale": (
            "Arch allows older vLLM; prefer CUDA 12.4 → torch cu124 pin; "
            "vllm 0.6.6 matches that torch; reject unpinned ranges that "
            "accidentally float torch; Aliyun as pip_index."
        ),
        "rejected_alternatives": [
            "vllm>=0.8.0 unpinned — accidental torch cu-tag drift / NCCL replace"
        ],
        "smoke_cmd": (
            f"{inference_py} -c \"import torch; t=torch.zeros(1).cuda(); "
            f"print('CUDA_OK', torch.__version__)\""
        ),
    }
    chain.update(overrides)
    return chain


def test_validate_rejects_vllm_range(inference_py):
    chain = _valid_chain(inference_py)
    chain["pins"]["vllm"] = "vllm>=0.8.0"
    normalized, errors = validate_compat_chain(chain, status="planned")
    assert normalized is None
    assert any("vllm" in e and "==" in e for e in errors)


def test_validate_rejects_missing_rationale(inference_py):
    chain = _valid_chain(inference_py, rationale="too short")
    normalized, errors = validate_compat_chain(chain, status="planned")
    assert normalized is None
    assert any("rationale" in e for e in errors)


def test_validate_rejects_missing_rejected_alternatives(inference_py):
    chain = _valid_chain(inference_py, rejected_alternatives=[])
    normalized, errors = validate_compat_chain(chain, status="planned")
    assert normalized is None
    assert any("rejected_alternatives" in e for e in errors)


def test_validate_rejects_official_pypi(inference_py):
    chain = _valid_chain(inference_py, pip_index="https://pypi.org/simple/")
    normalized, errors = validate_compat_chain(chain, status="planned")
    assert normalized is None
    assert any("PyPI" in e or "pip_index" in e for e in errors)


def test_validate_accepts_planned(inference_py):
    chain = _valid_chain(inference_py)
    normalized, errors = validate_compat_chain(chain, status="planned")
    assert errors == []
    assert normalized is not None
    assert normalized["status"] == "planned"
    assert normalized["fingerprint"]


def test_ensure_runtime_planned_then_gates(monkeypatch, inference_py, tmp_path):
    monkeypatch.delenv("GPUCLOUD_INFERENCE_NODE_RANK", raising=False)
    monkeypatch.delenv("NODE_RANK", raising=False)
    job_id = "job-compat-1"
    chain = _valid_chain(inference_py)

    planned = json.loads(
        handle_inference_ensure_runtime(
            {"job_id": job_id, "status": "planned", "compat_chain": chain}
        )
    )
    assert planned["success"] is True
    assert planned["status"] == "planned"

    # Not verified yet → Ray blocked
    ray_raw = handle_inference_ray_start(
        {"job_id": job_id, "python_executable": str(inference_py), "port": 6379}
    )
    ray_data = json.loads(ray_raw)
    assert ray_data["success"] is False
    assert ray_data["phase"] == "compat_gate"

    model = tmp_path / "model"
    model.mkdir()
    (model / "config.json").write_text("{}")
    vllm_raw = handle_inference_start_vllm(
        {
            "job_id": job_id,
            "model_path": str(model),
            "python_executable": str(inference_py),
        }
    )
    vllm_data = json.loads(vllm_raw)
    assert vllm_data["success"] is False
    assert vllm_data["phase"] == "compat_gate"


def test_start_vllm_compat_gate_without_chain(monkeypatch, inference_py, tmp_path):
    monkeypatch.delenv("GPUCLOUD_INFERENCE_NODE_RANK", raising=False)
    monkeypatch.delenv("NODE_RANK", raising=False)
    model = tmp_path / "model"
    model.mkdir()
    (model / "config.json").write_text("{}")
    raw = handle_inference_start_vllm(
        {
            "job_id": "job-no-chain",
            "model_path": str(model),
            "python_executable": str(inference_py),
        }
    )
    data = json.loads(raw)
    assert data["success"] is False
    assert data["phase"] == "compat_gate"


def test_ray_start_compat_gate_without_job_id(monkeypatch, inference_py):
    monkeypatch.delenv("GPUCLOUD_INFERENCE_NODE_RANK", raising=False)
    monkeypatch.delenv("NODE_RANK", raising=False)
    raw = handle_inference_ray_start(
        {"python_executable": str(inference_py), "port": 6379}
    )
    data = json.loads(raw)
    assert data["success"] is False
    assert data["phase"] == "compat_gate"
    assert "job_id" in data["error"]


def test_planned_verified_unlocks_ray(monkeypatch, inference_py):
    monkeypatch.delenv("GPUCLOUD_INFERENCE_NODE_RANK", raising=False)
    monkeypatch.delenv("NODE_RANK", raising=False)
    job_id = "job-compat-ok"
    chain = _valid_chain(inference_py)

    planned = json.loads(
        handle_inference_ensure_runtime(
            {"job_id": job_id, "status": "planned", "compat_chain": chain}
        )
    )
    assert planned["success"] is True

    with patch(
        "plugins.inference_adapters.agent_tools.run_compat_smoke",
        return_value=(True, "CUDA_OK mock"),
    ):
        verified = json.loads(
            handle_inference_ensure_runtime(
                {"job_id": job_id, "status": "verified", "compat_chain": chain}
            )
        )
    assert verified["success"] is True
    assert verified["status"] == "verified"

    with patch(
        "plugins.inference_adapters.ray_runtime.start_ray_head",
        return_value={"success": True, "address": "127.0.0.1:6379"},
    ):
        ray_raw = handle_inference_ray_start(
            {
                "job_id": job_id,
                "python_executable": str(inference_py),
                "port": 6379,
            }
        )
    ray_data = json.loads(ray_raw)
    assert ray_data["success"] is True
    assert ray_data.get("address") == "127.0.0.1:6379"
