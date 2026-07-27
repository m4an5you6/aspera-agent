"""Agent-facing tools wrapping HfVllmAdapter start/health/stop + ready report."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict

from plugins.inference_adapters.agent_driver import store_reported_outcome
from plugins.inference_adapters.base import ArtifactPaths
from plugins.inference_adapters.registry import create_adapter
from plugins.inference_adapters.runtime import _RUNNING, remember_adapter

_log = logging.getLogger(__name__)


def _job_adapter(job_id: str, adapter_id: str = "hf_vllm"):
    jid = str(job_id or "").strip()
    ad = _RUNNING.get(jid) if jid else None
    if ad is None:
        ad = create_adapter(adapter_id or "hf_vllm")
        if jid:
            remember_adapter(jid, ad)
    return ad


def handle_inference_start_vllm(args: dict, **kwargs: Any) -> str:
    """Start vLLM via HfVllmAdapter and remember the process for this job_id."""
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
    python_executable = str(args.get("python_executable") or "").strip()

    spec: Dict[str, Any] = {
        "job_id": job_id,
        "adapter_id": adapter_id,
        "model": {"local_path": str(path)},
        "serve": serve,
        "gpus": gpus,
        "secrets_ref": secrets_ref,
        "env": {str(k): str(v) for k, v in env.items()},
        "adapter_options": args.get("adapter_options")
        if isinstance(args.get("adapter_options"), dict)
        else {},
        "runtime": {},
    }
    if python_executable:
        spec["runtime"]["python_executable"] = python_executable

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
            }
        )
    except Exception as exc:
        _log.exception("inference_start_vllm failed job=%s", job_id)
        return json.dumps({"success": False, "error": str(exc), "phase": "start"})


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


INFERENCE_START_VLLM_SCHEMA = {
    "name": "inference_start_vllm",
    "description": (
        "Start OpenAI-compatible vLLM serve for a job using the managed HfVllmAdapter "
        "(tracks PID/logs for cancel). Prefer this over raw terminal background serves."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "job_id": {"type": "string"},
            "model_path": {"type": "string", "description": "HF-loadable local model directory"},
            "adapter_id": {"type": "string", "default": "hf_vllm"},
            "serve": {"type": "object"},
            "gpus": {"type": "object"},
            "secrets_ref": {"type": "object"},
            "env": {"type": "object"},
            "adapter_options": {"type": "object"},
            "python_executable": {"type": "string"},
        },
        "required": ["job_id", "model_path"],
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
        "(success/failure + visit_host/port). Call this when ready or when giving up."
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
