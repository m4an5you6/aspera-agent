"""Agent-driven inference prepare/serve/ready (thin host over AutoGoalRuntime)."""

from __future__ import annotations

import json
import logging
import re
import threading
from typing import Any, Callable, Dict, Optional, Tuple

from gpucloud_cli.autogoal_runtime import (
    PROFILE_CLUSTER_INFERENCE,
    AutoGoalRuntime,
    ContractCompletion,
    wrap_objective_with_operating_contract,
)

_log = logging.getLogger(__name__)

OutcomeCallback = Callable[[bool, str, Dict[str, Any]], None]

# job_id -> latest outcome reported via inference_report_ready tool
_OUTCOMES: Dict[str, Dict[str, Any]] = {}
_OUTCOMES_LOCK = threading.RLock()

# job_id -> active AIAgent (for interrupt on stop)
_AGENTS: Dict[str, Any] = {}
_AGENTS_LOCK = threading.RLock()

_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL | re.IGNORECASE)
_READY_PHASES = frozenset(
    {
        "ready",
        "worker_ready",
        "ensure_runtime",
        "ensure_artifacts",
        "start",
        "health_timeout",
        "cancelled",
        "validate",
        "agent_error",
    }
)


def load_inference_adapters_config() -> Dict[str, Any]:
    try:
        from gpucloud_cli.config import load_config

        raw = load_config().get("inference_adapters") or {}
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def get_inference_driver() -> str:
    """Return ``agent`` (default) or ``legacy_scheme``."""
    cfg = load_inference_adapters_config()
    driver = str(cfg.get("driver") or "agent").strip().lower()
    if driver in ("legacy", "legacy_scheme", "scheme"):
        return "legacy_scheme"
    return "agent"


def store_reported_outcome(job_id: str, payload: Dict[str, Any]) -> None:
    jid = str(job_id or "").strip()
    if not jid:
        return
    with _OUTCOMES_LOCK:
        _OUTCOMES[jid] = dict(payload)


def pop_reported_outcome(job_id: str) -> Optional[Dict[str, Any]]:
    jid = str(job_id or "").strip()
    with _OUTCOMES_LOCK:
        return _OUTCOMES.pop(jid, None)


def clear_reported_outcome(job_id: str) -> None:
    jid = str(job_id or "").strip()
    with _OUTCOMES_LOCK:
        _OUTCOMES.pop(jid, None)


def remember_inference_agent(job_id: str, agent: Any) -> None:
    with _AGENTS_LOCK:
        _AGENTS[str(job_id)] = agent


def forget_inference_agent(job_id: str) -> None:
    with _AGENTS_LOCK:
        _AGENTS.pop(str(job_id), None)


def interrupt_inference_agent(job_id: str, reason: str = "inference job stopped") -> bool:
    with _AGENTS_LOCK:
        agent = _AGENTS.get(str(job_id))
    if agent is None:
        return False
    try:
        if hasattr(agent, "interrupt"):
            agent.interrupt(reason)
            return True
    except Exception:
        _log.exception("failed to interrupt inference agent for %s", job_id)
    return False


def _extract_json_object(text: str) -> Optional[Dict[str, Any]]:
    raw = (text or "").strip()
    if not raw:
        return None
    # Prefer fenced JSON
    m = _JSON_FENCE_RE.search(raw)
    if m:
        try:
            obj = json.loads(m.group(1))
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass
    # Whole-string JSON
    if raw.startswith("{"):
        try:
            obj = json.loads(raw)
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass
    # Last {...} blob
    start = raw.rfind("{")
    end = raw.rfind("}")
    if start >= 0 and end > start:
        try:
            obj = json.loads(raw[start : end + 1])
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass
    return None


def parse_outcome_contract(
    payload: Optional[Dict[str, Any]],
    *,
    defaults: Optional[Dict[str, Any]] = None,
) -> Tuple[bool, str, Dict[str, Any]]:
    """Normalize agent/tool outcome into (success, summary, details)."""
    defaults = dict(defaults or {})
    if not isinstance(payload, dict):
        return (
            False,
            "agent did not return a valid outcome contract",
            {"phase": "agent_error", **defaults},
        )
    success = bool(payload.get("success"))
    summary = str(payload.get("summary") or ("inference ready" if success else "inference failed"))
    details = payload.get("details") if isinstance(payload.get("details"), dict) else {}
    details = {**defaults, **details}
    phase = str(details.get("phase") or ("ready" if success else "agent_error")).strip()
    if phase not in _READY_PHASES:
        phase = "ready" if success else "agent_error"
    details["phase"] = phase
    if success:
        # Ensure visit fields exist when ready
        for key in ("visit_host", "visit_port", "protocol", "stream_path", "health_path"):
            if key not in details and key in defaults:
                details[key] = defaults[key]
    return success, summary, details


def build_inference_agent_prompt(job_spec: Dict[str, Any], inference_spec: Dict[str, Any]) -> str:
    """User prompt: job context + mandatory outcome contract."""
    node_rank = int(inference_spec.get("node_rank") or 0)
    nnodes = int(inference_spec.get("nnodes") or job_spec.get("nnodes") or 1)
    local_devices = (
        inference_spec.get("local_visible_devices")
        or (inference_spec.get("gpus") or {}).get("local_visible_devices")
        or (inference_spec.get("gpus") or {}).get("visible_devices")
        or []
    )
    compact = {
        "job_id": inference_spec.get("job_id"),
        "adapter_id": inference_spec.get("adapter_id") or "hf_vllm",
        "model": inference_spec.get("model") or {},
        "model_hint": inference_spec.get("model_hint")
        or (inference_spec.get("model") or {}).get("hint")
        or "",
        "training_artifact_kind": inference_spec.get("training_artifact_kind") or "",
        "gpus": inference_spec.get("gpus") or {},
        "serve": inference_spec.get("serve") or {},
        "sources": inference_spec.get("sources") or [],
        "secrets_ref": inference_spec.get("secrets_ref") or {},
        "adapter_options": inference_spec.get("adapter_options") or {},
        "deploy_node_id": inference_spec.get("deploy_node_id"),
        "callback_url": inference_spec.get("callback_url") or "",
        "env": inference_spec.get("env") or {},
        "working_dir": inference_spec.get("working_dir") or ".",
        "node_rank": node_rank,
        "nnodes": nnodes,
        "local_visible_devices": local_devices,
        "ray": inference_spec.get("ray") or {},
        "tensor_parallel": (inference_spec.get("gpus") or {}).get("tensor_parallel"),
    }
    role_block = (
        "You are rank0 (serve head) on a multi-node inference job.\n"
        "After runtime/artifacts are ready:\n"
        "1) `inference_ray_start` with ray.head_port and local_visible_devices\n"
        "2) `inference_cluster_wait_workers` until peers are worker_ready\n"
        "3) `inference_start_vllm` with global tensor_parallel, local visible_devices, "
        "and ray={enabled:true, address/head_port}\n"
        "4) health then `inference_report_ready` phase=ready with reachable visit_host\n"
        if nnodes > 1 and node_rank == 0
        else (
            "You are a worker rank (rank>0) on a multi-node inference job.\n"
            "Do NOT start the OpenAI API server and do NOT report visit_host.\n"
            "After runtime/artifacts are ready:\n"
            "1) `inference_ray_join` to ray head address (head advertised_addr:head_port)\n"
            "2) `inference_report_ready` with success=true and details.phase=worker_ready\n"
            if nnodes > 1
            else ""
        )
    )
    return (
        "You are deploying inference on THIS GPU node until the service is ready.\n"
        "Follow the skill `gpucloud-inference-deployment`.\n"
        "For megatron_checkpoints / .distcp trees, follow "
        "`gpucloud-megatron-weight-export` (ModelOpt/SWIFT recipes first; "
        "hand-rolled load_distcp only as last resort).\n\n"
        f"{role_block}\n"
        "Job assignment JSON:\n"
        f"```json\n{json.dumps(compact, ensure_ascii=False, indent=2)}\n```\n\n"
        "Required work (in order):\n"
        "1. Inspect CUDA/Python and the model directory (config.json / names) to infer model family.\n"
        "2. Install a compatible torch + vLLM (+ ray when nnodes>1) stack for that model "
        "into the inference venv (trial-and-error OK; fix conflicts).\n"
        "3. Ensure artifacts: if local_path missing or not HF-loadable, sync/convert using sources[]; else fail clearly.\n"
        "4. Follow the role steps above for Ray/serve (single-node: "
        "`inference_start_vllm` then `inference_health`).\n"
        "5. Call `inference_report_ready` with the success contract (preferred), "
        "or end with a single JSON object matching the contract.\n\n"
        "Success contract shape (rank0 ready):\n"
        "```json\n"
        "{\n"
        '  "success": true,\n'
        '  "summary": "inference ready",\n'
        '  "details": {\n'
        '    "phase": "ready",\n'
        '    "adapter_id": "hf_vllm",\n'
        '    "visit_host": "<host>",\n'
        '    "visit_port": 8000,\n'
        '    "protocol": "http://",\n'
        '    "stream_path": "/v1/chat/completions",\n'
        '    "health_path": "/health",\n'
        '    "deploy_node_id": null,\n'
        '    "callback_url": "",\n'
        '    "model_path": "/path/to/model"\n'
        "  }\n"
        "}\n"
        "```\n"
        "Worker contract: success=true, details.phase=worker_ready (no visit_host).\n"
        "On failure set success=false and details.phase to one of "
        "ensure_runtime|ensure_artifacts|start|health_timeout|cancelled|validate.\n"
        "Never put API keys into the contract JSON.\n"
    )


def run_inference_agent(
    *,
    job_spec: Dict[str, Any],
    on_outcome: OutcomeCallback,
    stop_flag: Optional[Callable[[], bool]] = None,
    adapter: Any = None,
    agent_factory: Any = None,
) -> Dict[str, Any]:
    """Spawn an on-node AIAgent to prepare deps/artifacts and serve until ready.

    Thin host over ``AutoGoalRuntime`` + ``ContractCompletion``. ``agent_factory``
    is optional (tests); when set it must return an object with
    ``run_conversation`` / optional ``interrupt`` / ``get_activity_summary``.
    """
    from plugins.inference_adapters.runtime import _merge_inference_spec, remember_adapter
    from plugins.inference_adapters.registry import create_adapter

    rt = load_inference_adapters_config()
    inference_spec = _merge_inference_spec(job_spec)
    extra = job_spec.get("extra") if isinstance(job_spec.get("extra"), dict) else {}
    # Pass through optional hints from extra/inference_spec
    for key in ("model_hint", "training_artifact_kind"):
        if not inference_spec.get(key):
            if extra.get(key):
                inference_spec[key] = extra[key]
            elif isinstance(extra.get("inference_spec"), dict) and extra["inference_spec"].get(key):
                inference_spec[key] = extra["inference_spec"][key]

    adapter_id = str(
        inference_spec.get("adapter_id")
        or extra.get("adapter_id")
        or rt.get("default_adapter_id")
        or "hf_vllm"
    ).strip()
    job_id = str(inference_spec.get("job_id") or job_spec.get("job_id") or "inference")
    inference_spec["adapter_id"] = adapter_id
    inference_spec["job_id"] = job_id

    defaults = {
        "adapter_id": adapter_id,
        "deploy_node_id": inference_spec.get("deploy_node_id"),
        "callback_url": inference_spec.get("callback_url") or "",
        "protocol": str((inference_spec.get("serve") or {}).get("protocol") or "http://"),
        "stream_path": str(
            (inference_spec.get("serve") or {}).get("stream_path") or "/v1/chat/completions"
        ),
        "health_path": str((inference_spec.get("serve") or {}).get("health_path") or "/health"),
    }

    try:
        ad = adapter or create_adapter(adapter_id)
    except KeyError as exc:
        on_outcome(False, str(exc), {"phase": "validate", "adapter_id": adapter_id})
        return {"success": False, "error": str(exc)}

    remember_adapter(job_id, ad)
    clear_reported_outcome(job_id)

    # Match CLI AutoGoal: segment_max_turns × max_segments (default 100 × 20).
    # ``max_iterations`` remains a back-compat alias for per-segment tool budget.
    try:
        segment_max_turns = int(
            rt.get("segment_max_turns")
            or rt.get("max_iterations")
            or PROFILE_CLUSTER_INFERENCE.default_segment_max_turns
        )
    except (TypeError, ValueError):
        segment_max_turns = PROFILE_CLUSTER_INFERENCE.default_segment_max_turns
    try:
        max_segments = int(
            rt.get("max_segments") or PROFILE_CLUSTER_INFERENCE.default_max_segments
        )
    except (TypeError, ValueError):
        max_segments = PROFILE_CLUSTER_INFERENCE.default_max_segments
    try:
        inactivity_s = float(
            rt.get("agent_timeout_seconds") or PROFILE_CLUSTER_INFERENCE.default_inactivity_seconds
        )
    except (TypeError, ValueError):
        inactivity_s = PROFILE_CLUSTER_INFERENCE.default_inactivity_seconds

    objective = wrap_objective_with_operating_contract(
        build_inference_agent_prompt(job_spec, inference_spec),
        host_label="cluster_inference",
    )
    completion = ContractCompletion(
        pop_reported=lambda: pop_reported_outcome(job_id),
        parse_contract=lambda payload: parse_outcome_contract(payload, defaults=defaults),
        extract_json=_extract_json_object,
    )

    run_result = AutoGoalRuntime().run(
        objective=objective,
        profile=PROFILE_CLUSTER_INFERENCE,
        session_id=f"inference-{job_id}",
        completion=completion,
        stop_flag=stop_flag,
        inactivity_seconds=inactivity_s,
        segment_max_turns=segment_max_turns,
        max_segments=max_segments,
        agent_factory=agent_factory,
        remember_agent=lambda _sid, agent: remember_inference_agent(job_id, agent),
        forget_agent=lambda _sid: forget_inference_agent(job_id),
        interrupt_agent=lambda _sid, reason: interrupt_inference_agent(job_id, reason),
        defaults=defaults,
        agent_model_hint=str(rt.get("agent_model") or ""),
        task_id=f"inference-{job_id}",
    )

    success = bool(run_result.success)
    summary = str(run_result.summary or "")
    details = dict(run_result.details or {})

    # Enrich visit fields from adapter endpoint when ready
    if success and hasattr(ad, "_endpoint") and getattr(ad, "_endpoint", None) is not None:
        ep = ad._endpoint  # noqa: SLF001 — adapter owns endpoint after start tool
        details.setdefault("visit_host", ep.host)
        details.setdefault("visit_port", ep.port)
        details.setdefault("protocol", ep.protocol)
        details.setdefault("stream_path", ep.stream_path)
        details.setdefault("health_path", ep.health_path)
        details.setdefault("endpoint", ep.to_dict())

    # Validate-phase provider errors should keep phase=validate when possible
    if not success and details.get("phase") == "agent_error":
        err = str(run_result.error or summary)
        if "API key" in err or "runtime provider" in err.lower() or "No LLM" in err:
            details["phase"] = "validate"

    on_outcome(success, summary, details)
    out: Dict[str, Any] = {"success": success, "summary": summary, "details": details}
    if not success:
        out["error"] = str(run_result.error or summary)
    return out
