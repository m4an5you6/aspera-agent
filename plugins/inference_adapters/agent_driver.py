"""Agent-driven inference prepare/serve/ready (replaces fixed RuntimeScheme lifecycle)."""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout
from typing import Any, Callable, Dict, List, Optional, Tuple

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
    }
    return (
        "You are deploying inference on THIS GPU node until the service is ready.\n"
        "Follow the skill `gpucloud-inference-deployment`.\n\n"
        "Job assignment JSON:\n"
        f"```json\n{json.dumps(compact, ensure_ascii=False, indent=2)}\n```\n\n"
        "Required work (in order):\n"
        "1. Inspect CUDA/Python and the model directory (config.json / names) to infer model family.\n"
        "2. Install a compatible torch + vLLM stack for that model (trial-and-error OK; fix conflicts).\n"
        "3. Ensure artifacts: if local_path missing or not HF-loadable, sync/convert using sources[]; else fail clearly.\n"
        "4. Start serving with tools `inference_start_vllm` then poll `inference_health` until ready "
        "(do not invent your own long-lived serve process unless the tool fails).\n"
        "5. Call `inference_report_ready` with the success contract (preferred), "
        "or end with a single JSON object matching the contract.\n\n"
        "Success contract shape:\n"
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

    ``agent_factory`` is optional (tests); when set it must return an object with
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

    # Non-interactive approvals for pip/shell
    prev_yolo = os.environ.get("GPUCLOUD_YOLO_MODE")
    os.environ["GPUCLOUD_YOLO_MODE"] = "1"
    # Hint cron-like approval path if present
    os.environ.setdefault("GPUCLOUD_CRON_SESSION", "1")

    agent = None
    try:
        if stop_flag and stop_flag():
            success, summary, details = (
                False,
                "cancelled before agent start",
                {"phase": "cancelled", **defaults},
            )
            on_outcome(success, summary, details)
            return {"success": False, "error": summary}

        from gpucloud_cli.runtime_provider import (
            resolve_runtime_provider,
            format_runtime_provider_error,
        )

        # Internal deploys write model.api_key into config.yaml (not always
        # the provider env var). Pass them as explicit so AIAgent gets both
        # api_key and base_url even if named-provider env vars are unset.
        explicit_api_key = ""
        explicit_base_url = ""
        try:
            from gpucloud_cli.config import load_config

            model_cfg = load_config().get("model") or {}
            if isinstance(model_cfg, dict):
                explicit_api_key = str(model_cfg.get("api_key") or "").strip()
                explicit_base_url = str(model_cfg.get("base_url") or "").strip()
        except Exception:
            pass

        try:
            runtime = resolve_runtime_provider(
                explicit_api_key=explicit_api_key or None,
                explicit_base_url=explicit_base_url or None,
            )
        except Exception as exc:
            msg = format_runtime_provider_error(exc)
            on_outcome(False, msg, {"phase": "validate", **defaults})
            return {"success": False, "error": msg}

        if not str(runtime.get("api_key") or "").strip():
            msg = (
                "No LLM API key resolved for inference agent "
                f"(provider={runtime.get('provider')!r}). "
                "Set model.api_key in config.yaml or the provider env var "
                "(e.g. XIAOMI_API_KEY)."
            )
            on_outcome(False, msg, {"phase": "validate", **defaults})
            return {"success": False, "error": msg}

        try:
            max_iterations = int(rt.get("max_iterations") or 90)
        except (TypeError, ValueError):
            max_iterations = 90
        try:
            inactivity_s = float(rt.get("agent_timeout_seconds") or 1800)
        except (TypeError, ValueError):
            inactivity_s = 1800.0

        enabled_toolsets = [
            "terminal",
            "file",
            "skills",
            "web",
            "inference_adapters",
        ]
        disabled_toolsets = [
            "clarify",
            "messaging",
            "cronjob",
            "delegation",
        ]

        model = str(
            runtime.get("model")
            or (load_inference_adapters_config().get("agent_model") or "")
            or ""
        )
        # Prefer config model.default when runtime did not pin
        if not model:
            try:
                from gpucloud_cli.config import load_config

                model = str((load_config().get("model") or {}).get("default") or "")
            except Exception:
                model = ""

        if agent_factory is not None:
            agent = agent_factory(
                model=model or runtime.get("model"),
                api_key=runtime.get("api_key"),
                base_url=runtime.get("base_url"),
                provider=runtime.get("provider"),
                api_mode=runtime.get("api_mode"),
                max_iterations=max_iterations,
                enabled_toolsets=enabled_toolsets,
                disabled_toolsets=disabled_toolsets,
            )
        else:
            from run_agent import AIAgent

            agent = AIAgent(
                model=model or runtime.get("model"),
                api_key=runtime.get("api_key"),
                base_url=runtime.get("base_url"),
                provider=runtime.get("provider"),
                api_mode=runtime.get("api_mode"),
                max_iterations=max_iterations,
                quiet_mode=True,
                verbose_logging=False,
                enabled_toolsets=enabled_toolsets,
                disabled_toolsets=disabled_toolsets,
                skip_context_files=True,
                skip_memory=True,
                platform="inference_worker",
                session_id=f"inference-{job_id}",
            )
        remember_inference_agent(job_id, agent)

        prompt = build_inference_agent_prompt(job_spec, inference_spec)

        def _run_conv() -> Dict[str, Any]:
            return agent.run_conversation(user_message=prompt, task_id=f"inference-{job_id}")

        result: Dict[str, Any] = {}
        inactivity_hit = False
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(_run_conv)
            while True:
                if stop_flag and stop_flag():
                    interrupt_inference_agent(job_id, "cancelled by cluster stop")
                    try:
                        result = future.result(timeout=30)
                    except Exception:
                        result = {"final_response": "", "error": "cancelled"}
                    success, summary, details = (
                        False,
                        "cancelled during agent run",
                        {"phase": "cancelled", **defaults},
                    )
                    on_outcome(success, summary, details)
                    return {"success": False, "error": summary}
                try:
                    result = future.result(timeout=2.0)
                    break
                except FuturesTimeout:
                    if inactivity_s <= 0:
                        continue
                    idle = 0.0
                    if hasattr(agent, "get_activity_summary"):
                        try:
                            act = agent.get_activity_summary() or {}
                            idle = float(act.get("seconds_since_activity") or 0.0)
                        except Exception:
                            idle = 0.0
                    if idle >= inactivity_s:
                        inactivity_hit = True
                        interrupt_inference_agent(job_id, "inference agent inactivity timeout")
                        try:
                            result = future.result(timeout=30)
                        except Exception as exc:
                            result = {"final_response": "", "error": str(exc)}
                        break
                    continue

        if inactivity_hit and not pop_reported_outcome(job_id):
            # Will re-pop below; store a synthetic if needed
            pass

        reported = pop_reported_outcome(job_id)
        if reported is None:
            final_text = ""
            if isinstance(result, dict):
                final_text = str(result.get("final_response") or "")
                if not final_text and result.get("error"):
                    final_text = str(result.get("error"))
            reported = _extract_json_object(final_text)

        if inactivity_hit and not (isinstance(reported, dict) and reported.get("success")):
            success, summary, details = (
                False,
                f"inference agent inactivity timeout after {int(inactivity_s)}s",
                {"phase": "agent_error", **defaults},
            )
        else:
            success, summary, details = parse_outcome_contract(reported, defaults=defaults)
            # Enrich visit fields from adapter endpoint when ready
            if success and hasattr(ad, "_endpoint") and getattr(ad, "_endpoint", None) is not None:
                ep = ad._endpoint  # noqa: SLF001 — adapter owns endpoint after start tool
                details.setdefault("visit_host", ep.host)
                details.setdefault("visit_port", ep.port)
                details.setdefault("protocol", ep.protocol)
                details.setdefault("stream_path", ep.stream_path)
                details.setdefault("health_path", ep.health_path)
                details.setdefault("endpoint", ep.to_dict())

        on_outcome(success, summary, details)
        return {"success": success, "summary": summary, "details": details}
    except Exception as exc:
        _log.exception("inference agent failed for %s", job_id)
        on_outcome(False, str(exc), {"phase": "agent_error", **defaults})
        return {"success": False, "error": str(exc)}
    finally:
        forget_inference_agent(job_id)
        if prev_yolo is None:
            os.environ.pop("GPUCLOUD_YOLO_MODE", None)
        else:
            os.environ["GPUCLOUD_YOLO_MODE"] = prev_yolo
