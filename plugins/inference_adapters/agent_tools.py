"""Agent-facing tools wrapping HfVllmAdapter start/health/stop + ready report."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict

from plugins.inference_adapters.agent_driver import store_reported_outcome
from plugins.inference_adapters.base import ArtifactPaths
from plugins.inference_adapters.compat_chain import (
    require_verified_compat,
    run_compat_smoke,
    store_compat_chain,
    validate_compat_chain,
)
from plugins.inference_adapters.inference_venv import (
    InferenceVenvError,
    check_role_tool_allowed,
    resolve_serve_python,
)
from plugins.inference_adapters.registry import create_adapter
from plugins.inference_adapters.runtime import _RUNNING, remember_adapter

_log = logging.getLogger(__name__)

_PYTHON_HINT = (
    "Must be under ~/.cache/gpu_platform/inference_venvs/<tag>/bin/python "
    "(swift_venv is rejected for Ray/vLLM serve)."
)


def _job_adapter(job_id: str, adapter_id: str = "hf_vllm"):
    jid = str(job_id or "").strip()
    ad = _RUNNING.get(jid) if jid else None
    if ad is None:
        ad = create_adapter(adapter_id or "hf_vllm")
        if jid:
            remember_adapter(jid, ad)
    return ad


def _role_gate(tool_name: str) -> str | None:
    ok, err = check_role_tool_allowed(tool_name)
    if ok:
        return None
    return json.dumps({"success": False, "error": err, "phase": "role_gate"})


def _serve_python(args: dict) -> str:
    return resolve_serve_python(str(args.get("python_executable") or "").strip())


def _compat_gate(job_id: str, python_executable: str) -> str | None:
    ok, err = require_verified_compat(job_id, python_executable=python_executable)
    if ok:
        return None
    return json.dumps({"success": False, "error": err, "phase": "compat_gate"})


def handle_inference_ensure_runtime(args: dict, **kwargs: Any) -> str:
    """Validate/store full compat_chain; verified runs CUDA smoke in venv."""
    job_id = str(args.get("job_id") or "").strip()
    if not job_id:
        return json.dumps({"success": False, "error": "job_id required", "phase": "compat_gate"})
    status = str(args.get("status") or "planned").strip().lower() or "planned"
    chain_in = args.get("compat_chain")
    if chain_in is None and isinstance(args.get("chain"), dict):
        chain_in = args.get("chain")

    normalized, errors = validate_compat_chain(chain_in, status=status)
    if errors or not normalized:
        return json.dumps(
            {
                "success": False,
                "error": "; ".join(errors) or "invalid compat_chain",
                "errors": errors,
                "phase": "compat_gate",
            }
        )

    if status == "verified":
        ok, smoke_out = run_compat_smoke(
            venv_python=str(normalized["venv_python"]),
            smoke_cmd=str(normalized.get("smoke_cmd") or ""),
        )
        if not ok:
            normalized["status"] = "planned"
            store_compat_chain(job_id, normalized)
            return json.dumps(
                {
                    "success": False,
                    "error": f"CUDA smoke failed: {smoke_out}",
                    "status": "planned",
                    "stored": True,
                    "fingerprint": normalized.get("fingerprint"),
                    "smoke_output": smoke_out,
                    "phase": "compat_gate",
                    "compat_chain": normalized,
                }
            )
        normalized["status"] = "verified"
        normalized["smoke_output"] = smoke_out
    else:
        normalized["status"] = "planned"

    store_compat_chain(job_id, normalized)
    return json.dumps(
        {
            "success": True,
            "stored": True,
            "status": normalized["status"],
            "fingerprint": normalized.get("fingerprint"),
            "compat_chain": normalized,
            "hint": (
                "Next: pip install exact pins with -i pip_index (torch before vllm), "
                "then call inference_ensure_runtime status=verified after CUDA smoke."
                if normalized["status"] == "planned"
                else "Compat chain verified; Ray / inference_start_vllm unlocked for this job."
            ),
        }
    )


def handle_inference_start_vllm(args: dict, **kwargs: Any) -> str:
    """Start vLLM via HfVllmAdapter and remember the process for this job_id."""
    gated = _role_gate("inference_start_vllm")
    if gated:
        return gated
    job_id = str(args.get("job_id") or "").strip()
    model_path = str(args.get("model_path") or "").strip()
    adapter_id = str(args.get("adapter_id") or "hf_vllm").strip() or "hf_vllm"
    if not job_id:
        return json.dumps({"success": False, "error": "job_id required"})
    if not model_path:
        return json.dumps({"success": False, "error": "model_path required"})
    path = Path(model_path).expanduser()
    if not path.exists():
        return json.dumps({"success": False, "error": f"model_path does not exist: {path}"})

    serve = args.get("serve") if isinstance(args.get("serve"), dict) else {}
    gpus = args.get("gpus") if isinstance(args.get("gpus"), dict) else {}
    secrets_ref = args.get("secrets_ref") if isinstance(args.get("secrets_ref"), dict) else {}
    env = args.get("env") if isinstance(args.get("env"), dict) else {}
    ray = args.get("ray") if isinstance(args.get("ray"), dict) else {}
    adapter_options = (
        args.get("adapter_options") if isinstance(args.get("adapter_options"), dict) else {}
    )

    try:
        python_executable = _serve_python(args)
    except InferenceVenvError as exc:
        return json.dumps({"success": False, "error": str(exc), "phase": "venv_gate"})

    blocked = _compat_gate(job_id, python_executable)
    if blocked:
        return blocked

    spec: Dict[str, Any] = {
        "job_id": job_id,
        "adapter_id": adapter_id,
        "model": {"local_path": str(path)},
        "serve": serve,
        "gpus": gpus,
        "secrets_ref": secrets_ref,
        "env": {str(k): str(v) for k, v in env.items()},
        "adapter_options": adapter_options,
        "ray": ray,
        "runtime": {"python_executable": python_executable},
    }

    try:
        ad = _job_adapter(job_id, adapter_id)
        # Stop previous process if any
        try:
            ad.stop()
        except Exception:
            pass
        endpoint = ad.start(spec, ArtifactPaths(model_path=str(path.resolve())))
        remember_adapter(job_id, ad)
        return json.dumps(
            {
                "success": True,
                "endpoint": endpoint.to_dict(),
                "visit_host": endpoint.host,
                "visit_port": endpoint.port,
                "protocol": endpoint.protocol,
                "stream_path": endpoint.stream_path,
                "health_path": endpoint.health_path,
                "model_path": str(path.resolve()),
                "pid": (endpoint.extra or {}).get("pid"),
                "logs": (endpoint.extra or {}).get("logs"),
                "python_executable": python_executable,
            }
        )
    except Exception as exc:
        _log.exception("inference_start_vllm failed job=%s", job_id)
        return json.dumps({"success": False, "error": str(exc), "phase": "start"})


def handle_inference_ray_start(args: dict, **kwargs: Any) -> str:
    from plugins.inference_adapters.ray_runtime import start_ray_head

    gated = _role_gate("inference_ray_start")
    if gated:
        return gated
    job_id = str(args.get("job_id") or "").strip()
    port = int(args.get("port") or args.get("head_port") or 6379)
    num_gpus = int(args.get("num_gpus") or 1)
    devices = args.get("visible_devices") or args.get("cuda_visible_devices")
    if isinstance(devices, list):
        devices = [int(x) for x in devices]
    else:
        devices = None
    try:
        python_executable = _serve_python(args)
        if job_id:
            blocked = _compat_gate(job_id, python_executable)
            if blocked:
                return blocked
        else:
            # Multi-node rank0 should pass job_id; without it still require any
            # verified chain is insufficient — demand job_id for gate clarity.
            return json.dumps(
                {
                    "success": False,
                    "error": "job_id required for compat_gate (inference_ensure_runtime)",
                    "phase": "compat_gate",
                }
            )
        result = start_ray_head(
            port=port,
            num_gpus=num_gpus,
            node_ip=str(args.get("node_ip") or "").strip(),
            python_executable=python_executable,
            cuda_visible_devices=devices,
        )
        result["python_executable"] = python_executable
        return json.dumps(result)
    except InferenceVenvError as exc:
        return json.dumps({"success": False, "error": str(exc), "phase": "venv_gate"})
    except Exception as exc:
        _log.exception("inference_ray_start failed")
        return json.dumps({"success": False, "error": str(exc)})


def handle_inference_ray_join(args: dict, **kwargs: Any) -> str:
    from plugins.inference_adapters.ray_runtime import join_ray_worker

    gated = _role_gate("inference_ray_join")
    if gated:
        return gated
    job_id = str(args.get("job_id") or "").strip()
    address = str(args.get("address") or "").strip()
    if not address:
        return json.dumps({"success": False, "error": "address required (host:port)"})
    num_gpus = int(args.get("num_gpus") or 1)
    devices = args.get("visible_devices") or args.get("cuda_visible_devices")
    if isinstance(devices, list):
        devices = [int(x) for x in devices]
    else:
        devices = None
    try:
        python_executable = _serve_python(args)
        if not job_id:
            return json.dumps(
                {
                    "success": False,
                    "error": "job_id required for compat_gate (inference_ensure_runtime)",
                    "phase": "compat_gate",
                }
            )
        blocked = _compat_gate(job_id, python_executable)
        if blocked:
            return blocked
        result = join_ray_worker(
            address=address,
            num_gpus=num_gpus,
            node_ip=str(args.get("node_ip") or "").strip(),
            python_executable=python_executable,
            cuda_visible_devices=devices,
        )
        result["python_executable"] = python_executable
        return json.dumps(result)
    except InferenceVenvError as exc:
        return json.dumps({"success": False, "error": str(exc), "phase": "venv_gate"})
    except Exception as exc:
        _log.exception("inference_ray_join failed")
        return json.dumps({"success": False, "error": str(exc)})


def handle_inference_cluster_wait_workers(args: dict, **kwargs: Any) -> str:
    from plugins.inference_adapters.ray_runtime import wait_workers_ready

    gated = _role_gate("inference_cluster_wait_workers")
    if gated:
        return gated
    job_id = str(args.get("job_id") or "").strip()
    master_url = str(args.get("master_url") or os.environ.get("GPUCLOUD_CLUSTER_MASTER_URL") or "").strip()
    if not job_id:
        return json.dumps({"success": False, "error": "job_id required"})
    if not master_url:
        # Common on-node default when this node is the cluster master.
        master_url = "http://127.0.0.1:8765"
    secret = str(
        args.get("cluster_secret")
        or os.environ.get("GPUCLOUD_CLUSTER_SECRET")
        or ""
    ).strip()
    try:
        result = wait_workers_ready(
            master_url=master_url,
            job_id=job_id,
            secret=secret,
            timeout_seconds=float(args.get("timeout_seconds") or 600),
            poll_seconds=float(args.get("poll_seconds") or 3),
        )
        return json.dumps(result)
    except Exception as exc:
        _log.exception("inference_cluster_wait_workers failed")
        return json.dumps({"success": False, "error": str(exc)})


def handle_inference_health(args: dict, **kwargs: Any) -> str:
    job_id = str(args.get("job_id") or "").strip()
    if not job_id:
        return json.dumps({"success": False, "error": "job_id required"})
    ad = _RUNNING.get(job_id)
    if ad is None:
        return json.dumps({"success": False, "error": "no running adapter for job_id", "health": "dead"})
    try:
        state = ad.health()
        return json.dumps({"success": True, "health": state})
    except Exception as exc:
        return json.dumps({"success": False, "error": str(exc), "health": "dead"})


def handle_inference_stop(args: dict, **kwargs: Any) -> str:
    job_id = str(args.get("job_id") or "").strip()
    if not job_id:
        return json.dumps({"success": False, "error": "job_id required"})
    from plugins.inference_adapters.runtime import stop_job_adapter

    stopped = stop_job_adapter(job_id)
    return json.dumps({"success": True, "stopped": stopped})


def handle_inference_report_ready(args: dict, **kwargs: Any) -> str:
    """Record the outcome contract for the host NodeAgent thread."""
    job_id = str(args.get("job_id") or "").strip()
    if not job_id:
        return json.dumps({"success": False, "error": "job_id required"})
    success = bool(args.get("success"))
    summary = str(args.get("summary") or ("inference ready" if success else "inference failed"))
    details = args.get("details") if isinstance(args.get("details"), dict) else {}
    # Allow flat visit_* on the tool args
    for key in (
        "phase",
        "adapter_id",
        "visit_host",
        "visit_port",
        "protocol",
        "stream_path",
        "health_path",
        "deploy_node_id",
        "callback_url",
        "model_path",
    ):
        if key in args and key not in details:
            details[key] = args[key]
    if success and not details.get("phase"):
        details["phase"] = "ready"
    payload = {"success": success, "summary": summary, "details": details}
    store_reported_outcome(job_id, payload)
    return json.dumps({"success": True, "stored": True, "outcome": payload})


INFERENCE_ENSURE_RUNTIME_SCHEMA = {
    "name": "inference_ensure_runtime",
    "description": (
        "Record a full compatibility-chain decision before installing torch/vLLM "
        "or starting Ray/serve. status=planned after deliberation; status=verified "
        "after pip + CUDA smoke. Exact == pins only; pip_index must be a China mirror."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "job_id": {"type": "string"},
            "status": {
                "type": "string",
                "enum": ["planned", "verified"],
                "description": "planned before pip; verified after CUDA smoke",
            },
            "compat_chain": {
                "type": "object",
                "description": (
                    "Full chain: driver, model_family, venv_python, pins "
                    "(torch/vllm exact ==), install_order, pip_index, rationale, "
                    "rejected_alternatives, smoke_cmd"
                ),
                "properties": {
                    "driver": {"type": "object"},
                    "model_family": {"type": "string"},
                    "venv_python": {"type": "string"},
                    "pins": {"type": "object"},
                    "install_order": {"type": "array", "items": {"type": "string"}},
                    "pip_index": {"type": "string"},
                    "pip_extra_index": {"type": "string"},
                    "rationale": {"type": "string"},
                    "rejected_alternatives": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "smoke_cmd": {"type": "string"},
                },
            },
        },
        "required": ["job_id", "compat_chain"],
    },
}

INFERENCE_START_VLLM_SCHEMA = {
    "name": "inference_start_vllm",
    "description": (
        "Start OpenAI-compatible vLLM serve for a job using the managed HfVllmAdapter "
        "(tracks PID/logs for cancel). Prefer this over raw terminal background serves. "
        "Requires inference_ensure_runtime status=verified for job_id first. "
        "For multi-node TP, pass ray={enabled:true,address:host:port} and global tensor_parallel. "
        "Rank>0 must not call this. python_executable must be inference_venvs (not swift_venv). "
        "Honor assignment adapter_options (quantization/load_format/dtype/extra_args) from the "
        "platform precision field; verify serve logs after start."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "job_id": {"type": "string"},
            "model_path": {"type": "string", "description": "HF-loadable local model directory"},
            "adapter_id": {"type": "string", "default": "hf_vllm"},
            "serve": {"type": "object"},
            "gpus": {"type": "object"},
            "ray": {"type": "object"},
            "secrets_ref": {"type": "object"},
            "env": {"type": "object"},
            "adapter_options": {
                "type": "object",
                "description": (
                    "vLLM options forwarded by hf_vllm: trust_remote_code, max_model_len, "
                    "gpu_memory_utilization, cpu_offload_gb, enable_lora, max_lora_rank, "
                    "dtype, quantization, load_format, enforce_eager, lora_modules, "
                    "extra_args (list of raw CLI tokens for anything else). "
                    "For 4-bit BitsAndBytes use quantization=bitsandbytes and "
                    "load_format=bitsandbytes (or the same via extra_args). "
                    "Bit width must be explicit — do not pass a vague bitsandbytes-only note."
                ),
            },
            "python_executable": {"type": "string", "description": _PYTHON_HINT},
        },
        "required": ["job_id", "model_path"],
    },
}

INFERENCE_RAY_START_SCHEMA = {
    "name": "inference_ray_start",
    "description": (
        "Start Ray head on this node (rank0 only) before multi-node vLLM. "
        "Requires inference_ensure_runtime status=verified for job_id. "
        "Rank>0 must use inference_ray_join. python_executable must be inference_venvs."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "job_id": {"type": "string"},
            "port": {"type": "integer"},
            "head_port": {"type": "integer"},
            "num_gpus": {"type": "integer"},
            "visible_devices": {"type": "array", "items": {"type": "integer"}},
            "node_ip": {"type": "string"},
            "python_executable": {"type": "string", "description": _PYTHON_HINT},
        },
        "required": ["job_id"],
    },
}

INFERENCE_RAY_JOIN_SCHEMA = {
    "name": "inference_ray_join",
    "description": (
        "Join Ray worker on this node (rank>0 only) to the head address. "
        "Requires inference_ensure_runtime status=verified for job_id. "
        "Rank0 must use inference_ray_start. python_executable must be inference_venvs."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "job_id": {"type": "string"},
            "address": {"type": "string", "description": "Ray head host:port"},
            "num_gpus": {"type": "integer"},
            "visible_devices": {"type": "array", "items": {"type": "integer"}},
            "node_ip": {"type": "string"},
            "python_executable": {"type": "string", "description": _PYTHON_HINT},
        },
        "required": ["job_id", "address"],
    },
}

INFERENCE_CLUSTER_WAIT_WORKERS_SCHEMA = {
    "name": "inference_cluster_wait_workers",
    "description": (
        "Rank0 only: poll cluster master until all peer assignments report "
        "phase/state worker_ready before starting multi-node vLLM."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "job_id": {"type": "string"},
            "master_url": {"type": "string"},
            "timeout_seconds": {"type": "number"},
            "poll_seconds": {"type": "number"},
        },
        "required": ["job_id"],
    },
}

INFERENCE_HEALTH_SCHEMA = {
    "name": "inference_health",
    "description": "Probe health of the vLLM process started for job_id (ready|degraded|dead).",
    "parameters": {
        "type": "object",
        "properties": {"job_id": {"type": "string"}},
        "required": ["job_id"],
    },
}

INFERENCE_STOP_SCHEMA = {
    "name": "inference_stop",
    "description": "Stop the managed vLLM process for job_id.",
    "parameters": {
        "type": "object",
        "properties": {"job_id": {"type": "string"}},
        "required": ["job_id"],
    },
}

INFERENCE_REPORT_READY_SCHEMA = {
    "name": "inference_report_ready",
    "description": (
        "Report the final inference outcome contract to the cluster worker "
        "(success/failure + visit_host/port). Rank0 uses phase=ready; "
        "workers use phase=worker_ready (no visit_host)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "job_id": {"type": "string"},
            "success": {"type": "boolean"},
            "summary": {"type": "string"},
            "details": {"type": "object"},
            "phase": {"type": "string"},
            "adapter_id": {"type": "string"},
            "visit_host": {"type": "string"},
            "visit_port": {"type": "integer"},
            "protocol": {"type": "string"},
            "stream_path": {"type": "string"},
            "health_path": {"type": "string"},
            "deploy_node_id": {},
            "callback_url": {"type": "string"},
            "model_path": {"type": "string"},
        },
        "required": ["job_id", "success"],
    },
}
