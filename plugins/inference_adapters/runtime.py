"""Fixed inference lifecycle runner: validate → ensure_runtime → ensure → start → health → outcome."""

from __future__ import annotations

import logging
import time
from typing import Any, Callable, Dict, Optional

from plugins.inference_adapters.base import EndpointInfo, HealthState, ModelAdapter
from plugins.inference_adapters.registry import create_adapter
from plugins.inference_adapters.spec import extract_inference_spec
from plugins.inference_adapters.task_runner import NeedsReplan

_log = logging.getLogger(__name__)

OutcomeCallback = Callable[[bool, str, Dict[str, Any]], None]
ReplanCallback = Callable[[NeedsReplan], Dict[str, Any]]


def _load_runtime_config() -> Dict[str, Any]:
    try:
        from gpucloud_cli.config import load_config

        cfg = load_config()
        raw = cfg.get("inference_adapters") or {}
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _merge_inference_spec(job_spec: Dict[str, Any]) -> Dict[str, Any]:
    inference_spec = extract_inference_spec(job_spec)
    extra = job_spec.get("extra") if isinstance(job_spec.get("extra"), dict) else {}
    if isinstance(extra.get("inference_spec"), dict):
        inference_spec = extract_inference_spec({**extra["inference_spec"], **job_spec})
        # Preserve role/placement fields even if a nested extract path drops them.
        for key in ("node_rank", "nnodes", "local_visible_devices"):
            if inference_spec.get(key) is None and extra["inference_spec"].get(key) is not None:
                inference_spec[key] = extra["inference_spec"][key]
    # Attach runtime.scheme from extra.runtime_scheme when missing
    runtime = inference_spec.get("runtime") if isinstance(inference_spec.get("runtime"), dict) else {}
    if not runtime.get("scheme") and isinstance(extra.get("runtime_scheme"), dict):
        runtime = dict(runtime)
        runtime["scheme"] = dict(extra["runtime_scheme"])
        inference_spec["runtime"] = runtime
    return inference_spec


def run_inference_lifecycle(
    *,
    job_spec: Dict[str, Any],
    on_outcome: OutcomeCallback,
    stop_flag: Optional[Callable[[], bool]] = None,
    adapter: Optional[ModelAdapter] = None,
    replan_callback: Optional[ReplanCallback] = None,
) -> Dict[str, Any]:
    """Execute the fixed adapter lifecycle and invoke on_outcome.

    Phase order: validate → ensure_runtime → ensure_artifacts → start → health → outcome.
    ``on_outcome(success, summary, details)`` — details may include endpoint visit fields.
    """
    rt = _load_runtime_config()
    poll_s = float(rt.get("health_poll_seconds") or 2)
    timeout_s = float(rt.get("health_timeout_seconds") or 300)

    inference_spec = _merge_inference_spec(job_spec)
    extra = job_spec.get("extra") if isinstance(job_spec.get("extra"), dict) else {}

    adapter_id = str(
        inference_spec.get("adapter_id")
        or extra.get("adapter_id")
        or rt.get("default_adapter_id")
        or ""
    ).strip()
    if not adapter_id:
        on_outcome(False, "adapter_id missing", {"phase": "validate"})
        return {"success": False, "error": "adapter_id missing"}

    try:
        ad = adapter or create_adapter(adapter_id)
    except KeyError as exc:
        on_outcome(False, str(exc), {"phase": "validate", "adapter_id": adapter_id})
        return {"success": False, "error": str(exc)}

    errors = ad.validate(inference_spec)
    if errors:
        msg = "; ".join(errors)
        on_outcome(False, msg, {"phase": "validate", "adapter_id": adapter_id})
        return {"success": False, "error": msg}

    # Stash replan callback for adapters that support it (hf_vllm).
    if replan_callback is not None:
        inference_spec = dict(inference_spec)
        inference_spec["_replan_callback"] = replan_callback
        inference_spec["_stop_flag"] = stop_flag

    try:
        ad.ensure_runtime(inference_spec)
    except NeedsReplan as needs:
        on_outcome(
            False,
            needs.error,
            {
                "phase": "ensure_runtime",
                "adapter_id": adapter_id,
                "needs_replan": needs.to_dict(),
            },
        )
        return {"success": False, "error": needs.error, "needs_replan": needs.to_dict()}
    except Exception as exc:
        _log.exception("ensure_runtime failed for %s", adapter_id)
        on_outcome(False, str(exc), {"phase": "ensure_runtime", "adapter_id": adapter_id})
        return {"success": False, "error": str(exc)}

    try:
        artifacts = ad.ensure_artifacts(inference_spec)
    except Exception as exc:
        _log.exception("ensure_artifacts failed for %s", adapter_id)
        on_outcome(False, str(exc), {"phase": "ensure_artifacts", "adapter_id": adapter_id})
        return {"success": False, "error": str(exc)}

    if stop_flag and stop_flag():
        ad.stop()
        on_outcome(False, "cancelled before start", {"phase": "cancelled", "adapter_id": adapter_id})
        return {"success": False, "error": "cancelled"}

    try:
        endpoint = ad.start(inference_spec, artifacts)
    except Exception as exc:
        _log.exception("start failed for %s", adapter_id)
        try:
            ad.stop()
        except Exception:
            pass
        on_outcome(False, str(exc), {"phase": "start", "adapter_id": adapter_id})
        return {"success": False, "error": str(exc)}

    deadline = time.monotonic() + timeout_s
    last: HealthState = "dead"
    while time.monotonic() < deadline:
        if stop_flag and stop_flag():
            ad.stop()
            on_outcome(False, "cancelled during health wait", {"phase": "cancelled", "adapter_id": adapter_id})
            return {"success": False, "error": "cancelled"}
        try:
            last = ad.health()
        except Exception as exc:
            last = "dead"
            _log.warning("health probe error: %s", exc)
        if last == "ready":
            details = {
                "phase": "ready",
                "adapter_id": adapter_id,
                "visit_host": endpoint.host,
                "visit_port": endpoint.port,
                "protocol": endpoint.protocol,
                "stream_path": endpoint.stream_path,
                "health_path": endpoint.health_path,
                "endpoint": endpoint.to_dict(),
                "model_path": artifacts.model_path,
                "deploy_node_id": inference_spec.get("deploy_node_id"),
                "callback_url": inference_spec.get("callback_url") or "",
            }
            on_outcome(True, "inference ready", details)
            return {"success": True, "endpoint": endpoint.to_dict(), "details": details}
        if last == "dead":
            pass
        time.sleep(max(0.2, poll_s))

    try:
        ad.stop()
    except Exception:
        pass
    msg = f"health timeout after {timeout_s}s (last={last})"
    on_outcome(False, msg, {"phase": "health_timeout", "adapter_id": adapter_id, "last_health": last})
    return {"success": False, "error": msg}


# Track running adapters by job_id for cancel/stop
_RUNNING: Dict[str, ModelAdapter] = {}


def remember_adapter(job_id: str, adapter: ModelAdapter) -> None:
    _RUNNING[job_id] = adapter


def stop_job_adapter(job_id: str) -> bool:
    ad = _RUNNING.pop(job_id, None)
    if ad is None:
        return False
    try:
        ad.stop()
    except Exception:
        _log.exception("stop failed for job %s", job_id)
    return True
