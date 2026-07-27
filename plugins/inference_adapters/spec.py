"""Inference job JSON spec helpers (versioned, no secrets inline)."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from plugins.cluster.models import new_id


SPEC_VERSION = 1


def extract_job_kind(raw: Dict[str, Any]) -> str:
    """Return training|inference from top-level or extra."""
    kind = raw.get("job_kind")
    if kind in (None, ""):
        extra = raw.get("extra") if isinstance(raw.get("extra"), dict) else {}
        kind = extra.get("job_kind")
    kind_s = str(kind or "training").strip().lower()
    if kind_s not in ("training", "inference"):
        return "training"
    return kind_s


def extract_adapter_id(raw: Dict[str, Any]) -> str:
    adapter_id = raw.get("adapter_id")
    if adapter_id in (None, ""):
        extra = raw.get("extra") if isinstance(raw.get("extra"), dict) else {}
        adapter_id = extra.get("adapter_id")
    if adapter_id in (None, ""):
        inference = raw.get("inference") if isinstance(raw.get("inference"), dict) else {}
        adapter_id = inference.get("adapter_id")
    return str(adapter_id or "").strip()


def extract_inference_spec(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize an inference submit body into a flat adapter spec dict."""
    if isinstance(raw.get("inference_spec"), dict):
        base = dict(raw["inference_spec"])
    elif isinstance(raw.get("spec"), dict) and extract_job_kind(raw) == "inference":
        base = dict(raw["spec"])
    else:
        base = dict(raw)

    adapter_id = extract_adapter_id(raw) or extract_adapter_id(base)
    out: Dict[str, Any] = {
        "spec_version": int(base.get("spec_version") or raw.get("spec_version") or SPEC_VERSION),
        "adapter_id": adapter_id,
        "model": dict(base.get("model") or {}),
        "gpus": dict(base.get("gpus") or {}),
        "serve": dict(base.get("serve") or {}),
        "runtime": dict(base.get("runtime") or {}),
        "sources": list(base.get("sources") or []),
        "secrets_ref": dict(base.get("secrets_ref") or {}),
        "adapter_options": dict(base.get("adapter_options") or {}),
        "env": {str(k): str(v) for k, v in dict(base.get("env") or {}).items()},
        "working_dir": str(base.get("working_dir") or raw.get("working_dir") or "."),
        "job_id": str(raw.get("job_id") or base.get("job_id") or new_id("job-")),
        "idempotency_key": str(
            raw.get("idempotency_key") or raw.get("request_id") or base.get("idempotency_key") or ""
        ),
        "deploy_node_id": base.get("deploy_node_id") or raw.get("deploy_node_id"),
        "callback_url": str(base.get("callback_url") or raw.get("callback_url") or ""),
        "model_hint": str(
            base.get("model_hint")
            or raw.get("model_hint")
            or (base.get("model") or {}).get("hint")
            or ""
        ),
        "training_artifact_kind": str(
            base.get("training_artifact_kind") or raw.get("training_artifact_kind") or ""
        ),
    }
    # Convenience: top-level model.local_path aliases
    if not out["model"].get("local_path"):
        for key in ("model_path", "local_path"):
            if raw.get(key):
                out["model"]["local_path"] = str(raw[key])
                break
    if not out["serve"].get("port") and raw.get("port") is not None:
        out["serve"]["port"] = int(raw["port"])
    if not out["serve"].get("host") and raw.get("host"):
        out["serve"]["host"] = str(raw["host"])
    return out


def validate_inference_spec(raw: Dict[str, Any]) -> tuple[List[str], Dict[str, Any]]:
    """Validate inference job body. Returns (errors, normalized cluster JobSpec-shaped dict)."""
    errors: List[str] = []
    spec = extract_inference_spec(raw)
    adapter_id = str(spec.get("adapter_id") or "").strip()
    if not adapter_id:
        errors.append("adapter_id is required for job_kind=inference")

    nnodes = int(raw.get("nnodes") or spec.get("gpus", {}).get("nnodes") or 1)
    nproc = int(
        raw.get("nproc_per_node")
        or len(spec.get("gpus", {}).get("visible_devices") or [])
        or spec.get("gpus", {}).get("tensor_parallel")
        or 1
    )
    if nnodes < 1:
        errors.append("nnodes must be >= 1")
    if nproc < 1:
        errors.append("nproc_per_node must be >= 1")

    node_ids = spec.get("gpus", {}).get("node_ids") or raw.get("node_ids") or []
    if node_ids is not None and not isinstance(node_ids, list):
        errors.append("gpus.node_ids must be a list when provided")
        node_ids = []
    if isinstance(node_ids, list):
        spec.setdefault("gpus", {})["node_ids"] = [str(x) for x in node_ids]

    extra = {
        "job_kind": "inference",
        "adapter_id": adapter_id,
        "inference_spec": spec,
        "min_gpu_count": int(spec.get("gpus", {}).get("tensor_parallel") or nproc or 1),
    }
    if raw.get("extra") and isinstance(raw["extra"], dict):
        # Preserve caller extras that don't collide
        for k, v in raw["extra"].items():
            if k not in extra:
                extra[k] = v

    normalized = {
        "script": str(raw.get("script") or f"inference:{adapter_id or 'unknown'}"),
        "script_args": [],
        "nnodes": nnodes,
        "nproc_per_node": nproc,
        "framework": "inference",
        "env": dict(spec.get("env") or {}),
        "working_dir": str(spec.get("working_dir") or "."),
        "job_id": str(spec.get("job_id") or new_id("job-")),
        "idempotency_key": str(spec.get("idempotency_key") or ""),
        "job_kind": "inference",
        "extra": extra,
    }
    return errors, normalized


def resolve_secret_env(name: Optional[str]) -> Optional[str]:
    """Read a secret from env, then inference_adapters config (internal deployments).

    Assignment / job spec must never carry plaintext keys — only env names via
    ``secrets_ref``. Config.yaml may hold keys for private internal fleets.
    """
    import os

    if name:
        from_env = os.environ.get(str(name).strip(), "").strip()
        if from_env:
            return from_env
    try:
        from gpucloud_cli.config import load_config_readonly

        ia = load_config_readonly().get("inference_adapters") or {}
        if not isinstance(ia, dict):
            return None
        # Prefer the named env's conventional config twin for serve key.
        if not name or str(name).strip() in ("INFERENCE_API_KEY", ia.get("serve_api_key_env")):
            inline = str(ia.get("serve_api_key") or "").strip()
            if inline:
                return inline
        if name and str(name).strip() == "HF_TOKEN":
            inline = str(ia.get("hf_token") or "").strip()
            if inline:
                return inline
    except Exception:
        return None
    return None
