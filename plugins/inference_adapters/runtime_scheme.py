"""RuntimeScheme selection and replan (scheme ≈ tasks[])."""

from __future__ import annotations

import copy
import logging
from typing import Any, Dict, List, Optional, Tuple

from plugins.inference_adapters.experience import (
    REPLANABLE_ERROR_CLASSES,
    ExperienceStore,
    classify_error,
)

_log = logging.getLogger(__name__)

SCHEME_VERSION = 1

# Lazy pin dictionary — resolved only when a task with pin_ref runs.
BUILTIN_PIN_MATRIX: Dict[str, Dict[str, Any]] = {
    "cu12-py310": {
        "torch": {"spec": "torch==2.5.1", "extra_index_keys": ["pytorch_cu121"]},
        "vllm": {"spec": "vllm==0.6.6"},
        "vllm_extras": {
            "specs": ["xformers==0.0.28.post3", "triton==3.1.0", "transformers==4.46.3"],
        },
    },
    "cu12-py311": {
        "torch": {"spec": "torch==2.5.1", "extra_index_keys": ["pytorch_cu121"]},
        "vllm": {"spec": "vllm==0.6.6"},
        "vllm_extras": {
            "specs": ["xformers==0.0.28.post3", "triton==3.1.0", "transformers==4.46.3"],
        },
    },
}

BUILTIN_MIRROR_PROFILES: Dict[str, Dict[str, Any]] = {
    "default": {
        "pip_index_url": "",
        "pip_extra_index_urls": {
            "pytorch_cu121": "https://download.pytorch.org/whl/cu121",
        },
        "pip_trusted_host": [],
        "env": {},
    },
}

_HF_VLLM_CU12_TASKS: List[Dict[str, Any]] = [
    {
        "id": "probe_stack",
        "type": "probe",
        "produces": [
            "python_executable",
            "python_version",
            "torch_version",
            "torch_cuda",
            "torch_available",
            "vllm_version",
            "vllm_available",
        ],
    },
    {
        "id": "ensure_torch",
        "type": "ensure_package",
        "package": "torch",
        "pin_ref": "matrix:cu12-py310/torch",
        "when": "not facts.torch_available or incompatible_torch",
        "after": ["probe_stack"],
    },
    {
        "id": "ensure_vllm",
        "type": "ensure_package",
        "package": "vllm",
        "pin_ref": "matrix:cu12-py310/vllm",
        "when": "not facts.vllm_available",
        "after": ["ensure_torch"],
    },
    {
        "id": "verify_stack",
        "type": "verify",
        "imports": ["torch", "vllm"],
        "after": ["ensure_vllm"],
    },
]


def _tasks_for_matrix(matrix_id: str) -> List[Dict[str, Any]]:
    tasks = copy.deepcopy(_HF_VLLM_CU12_TASKS)
    for t in tasks:
        pin_ref = str(t.get("pin_ref") or "")
        if pin_ref.startswith("matrix:"):
            # matrix:cu12-py310/torch -> matrix:{matrix_id}/torch
            rest = pin_ref.split(":", 1)[1]
            pkg = rest.split("/", 1)[-1] if "/" in rest else rest
            t["pin_ref"] = f"matrix:{matrix_id}/{pkg}"
    return tasks


BUILTIN_SCHEME_TEMPLATES: List[Dict[str, Any]] = [
    {
        "scheme_id": "hf_vllm.cu12.py310",
        "adapter_id": "hf_vllm",
        "mirror_profile": "default",
        "matrix_id": "cu12-py310",
        "constraints": {
            "cuda_driver_major": 12,
            "python_minor_ok": [10],
            "forbid_unpinned": True,
            "allow_install": True,
        },
        "tasks": _tasks_for_matrix("cu12-py310"),
    },
    {
        "scheme_id": "hf_vllm.cu12.py311",
        "adapter_id": "hf_vllm",
        "mirror_profile": "default",
        "matrix_id": "cu12-py311",
        "constraints": {
            "cuda_driver_major": 12,
            "python_minor_ok": [11],
            "forbid_unpinned": True,
            "allow_install": True,
        },
        "tasks": _tasks_for_matrix("cu12-py311"),
    },
]


def _load_inference_adapters_config() -> Dict[str, Any]:
    try:
        from gpucloud_cli.config import load_config

        raw = load_config().get("inference_adapters") or {}
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def get_pin_matrix() -> Dict[str, Dict[str, Any]]:
    cfg = _load_inference_adapters_config()
    override = cfg.get("runtime_matrix")
    if isinstance(override, dict) and override:
        return copy.deepcopy(override)
    if isinstance(override, list) and override:
        # list of {matrix_id, packages}
        out: Dict[str, Dict[str, Any]] = {}
        for row in override:
            if not isinstance(row, dict):
                continue
            mid = str(row.get("matrix_id") or "").strip()
            packages = row.get("packages") if isinstance(row.get("packages"), dict) else {}
            if mid and packages:
                out[mid] = copy.deepcopy(packages)
        if out:
            return out
    return copy.deepcopy(BUILTIN_PIN_MATRIX)


def get_mirror_profiles() -> Dict[str, Dict[str, Any]]:
    cfg = _load_inference_adapters_config()
    override = cfg.get("mirror_profiles")
    if isinstance(override, dict) and override:
        merged = copy.deepcopy(BUILTIN_MIRROR_PROFILES)
        merged.update(copy.deepcopy(override))
        return merged
    return copy.deepcopy(BUILTIN_MIRROR_PROFILES)


def get_scheme_templates() -> List[Dict[str, Any]]:
    cfg = _load_inference_adapters_config()
    override = cfg.get("runtime_schemes")
    if isinstance(override, list) and override:
        return copy.deepcopy(override)
    return copy.deepcopy(BUILTIN_SCHEME_TEMPLATES)


def get_replan_budget() -> Tuple[int, float]:
    cfg = _load_inference_adapters_config()
    try:
        attempts = int(cfg.get("max_replan_attempts") or 16)
    except (TypeError, ValueError):
        attempts = 16
    try:
        wall = float(cfg.get("max_replan_wall_seconds") or 3600)
    except (TypeError, ValueError):
        wall = 3600.0
    return max(1, attempts), max(60.0, wall)


def get_ensure_runtime_timeout() -> float:
    cfg = _load_inference_adapters_config()
    try:
        return float(cfg.get("ensure_runtime_timeout_seconds") or 1800)
    except (TypeError, ValueError):
        return 1800.0


def _python_minor(caps: Dict[str, Any]) -> Optional[int]:
    py = str(caps.get("python_version") or "").strip()
    if not py:
        return None
    parts = py.split(".")
    if len(parts) < 2:
        return None
    try:
        return int(parts[1])
    except (TypeError, ValueError):
        return None


def _cuda_major(caps: Dict[str, Any]) -> int:
    try:
        return int(caps.get("cuda_driver_major") or 0)
    except (TypeError, ValueError):
        return 0


def template_matches(template: Dict[str, Any], caps: Dict[str, Any], adapter_id: str) -> bool:
    if str(template.get("adapter_id") or "") != adapter_id:
        return False
    constraints = template.get("constraints") if isinstance(template.get("constraints"), dict) else {}
    want_cuda = constraints.get("cuda_driver_major")
    if want_cuda is not None:
        try:
            if _cuda_major(caps) != int(want_cuda):
                return False
        except (TypeError, ValueError):
            return False
    py_ok = constraints.get("python_minor_ok")
    if isinstance(py_ok, list) and py_ok:
        minor = _python_minor(caps)
        if minor is None:
            # Unknown python — still allow match; probe task will fill it.
            pass
        elif minor not in {int(x) for x in py_ok}:
            return False
    return True


def _likely_noop(caps: Dict[str, Any]) -> bool:
    return bool(caps.get("vllm_available")) and bool(caps.get("torch_available"))


def instantiate_scheme(
    template: Dict[str, Any],
    *,
    reason: str = "",
    replan_generation: int = 0,
    tasks_override: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    tasks = copy.deepcopy(tasks_override if tasks_override is not None else (template.get("tasks") or []))
    return {
        "scheme_version": SCHEME_VERSION,
        "scheme_id": str(template.get("scheme_id") or ""),
        "adapter_id": str(template.get("adapter_id") or ""),
        "mirror_profile": str(template.get("mirror_profile") or "default"),
        "matrix_id": str(template.get("matrix_id") or ""),
        "constraints": copy.deepcopy(template.get("constraints") or {}),
        "tasks": tasks,
        "replan_generation": int(replan_generation),
        "reason": reason or str(template.get("reason") or "selected"),
    }


def select_initial_scheme(
    capabilities: Dict[str, Any],
    *,
    adapter_id: str = "hf_vllm",
    experience: Optional[ExperienceStore] = None,
) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    """Pick an initial RuntimeScheme from templates + experience. Returns (scheme, errors)."""
    adapter = (adapter_id or "hf_vllm").strip() or "hf_vllm"
    templates = get_scheme_templates()
    candidates = [t for t in templates if template_matches(t, capabilities, adapter)]
    if not candidates:
        return None, [
            f"no_scheme_match:cuda_major={_cuda_major(capabilities)};"
            f"python={capabilities.get('python_version')!s};adapter={adapter}"
        ]

    # Experience: prefer prior success for this fingerprint.
    if experience is not None:
        prior = experience.best_success(capabilities)
        if prior and prior.effective_tasks:
            for t in candidates:
                if str(t.get("scheme_id") or "") == prior.scheme_id:
                    scheme = instantiate_scheme(
                        t,
                        reason="experience_success_hit",
                        tasks_override=prior.effective_tasks,
                    )
                    if prior.mirror_profile:
                        scheme["mirror_profile"] = prior.mirror_profile
                    return scheme, []

    # Prefer likely no-op (already has vllm/torch)
    if _likely_noop(capabilities):
        candidates = sorted(
            candidates,
            key=lambda t: 0 if _likely_noop(capabilities) else 1,
        )

    failures = experience.known_failures(capabilities) if experience is not None else []
    failed_ids = {f.scheme_id for f in failures if f.outcome == "replan_exhausted"}

    for t in candidates:
        sid = str(t.get("scheme_id") or "")
        if sid in failed_ids:
            continue
        reason = "caps_match"
        if _likely_noop(capabilities):
            reason = "already_satisfied_preferred"
        return instantiate_scheme(t, reason=reason), []

    # All candidates previously exhausted — still try first candidate
    return instantiate_scheme(candidates[0], reason="fallback_after_known_failures"), []


def resolve_pin_ref(
    pin_ref: str,
    *,
    matrix: Optional[Dict[str, Dict[str, Any]]] = None,
) -> Tuple[List[str], List[str], Optional[str]]:
    """Resolve pin_ref to (pip_specs, extra_index_urls, error)."""
    ref = str(pin_ref or "").strip()
    if not ref:
        return [], [], "empty pin_ref"
    if ref.startswith("pin:"):
        return [ref[4:].strip()], [], None
    if not ref.startswith("matrix:"):
        return [], [], f"unresolved_pin_ref:{ref}"

    body = ref.split(":", 1)[1]
    if "/" not in body:
        return [], [], f"unresolved_pin_ref:{ref}"
    matrix_id, pkg_key = body.split("/", 1)
    matrix = matrix if matrix is not None else get_pin_matrix()
    row = matrix.get(matrix_id) or {}
    entry = row.get(pkg_key)
    if not entry:
        return [], [], f"unresolved_pin_ref:missing {matrix_id}/{pkg_key}"

    specs: List[str] = []
    extra_keys: List[str] = []
    if isinstance(entry, dict):
        if entry.get("spec"):
            specs.append(str(entry["spec"]))
        if isinstance(entry.get("specs"), list):
            specs.extend(str(x) for x in entry["specs"])
        if isinstance(entry.get("extra_index_keys"), list):
            extra_keys.extend(str(x) for x in entry["extra_index_keys"])
    elif isinstance(entry, str):
        specs.append(entry)
    else:
        return [], [], f"unresolved_pin_ref:bad entry {matrix_id}/{pkg_key}"

    profiles = get_mirror_profiles()
    # Default profile supplies named extra indexes
    urls: List[str] = []
    default = profiles.get("default") or {}
    url_map = default.get("pip_extra_index_urls") if isinstance(default.get("pip_extra_index_urls"), dict) else {}
    for key in extra_keys:
        url = url_map.get(key)
        if url:
            urls.append(str(url))

    if not specs:
        return [], [], f"unresolved_pin_ref:empty specs {matrix_id}/{pkg_key}"
    # Safety: forbid unpinned names without ==
    for s in specs:
        if "==" not in s and "@" not in s:
            return [], [], f"forbid_unpinned:{s}"
    return specs, urls, None


def amend_scheme_for_replan(
    current: Dict[str, Any],
    *,
    facts: Dict[str, Any],
    failed_task_id: str,
    error: str,
    experience: Optional[ExperienceStore] = None,
    attempted_scheme_ids: Optional[List[str]] = None,
) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    """Produce next scheme (tasks amended or alternate template)."""
    attempted = list(attempted_scheme_ids or [])
    cur_id = str(current.get("scheme_id") or "")
    if cur_id and cur_id not in attempted:
        attempted.append(cur_id)

    gen = int(current.get("replan_generation") or 0) + 1
    err_class = classify_error(error, failed_task_id)

    # 1) Experience success patch (allowed for any failure class — reuse known-good scheme)
    if experience is not None:
        prior = experience.best_success(facts)
        if prior and prior.effective_tasks and prior.scheme_id not in attempted:
            for t in get_scheme_templates():
                if str(t.get("scheme_id") or "") == prior.scheme_id:
                    if not template_matches(t, facts, str(current.get("adapter_id") or "hf_vllm")):
                        continue
                    scheme = instantiate_scheme(
                        t,
                        reason=f"replan_experience:{err_class}",
                        replan_generation=gen,
                        tasks_override=prior.effective_tasks,
                    )
                    if prior.mirror_profile:
                        scheme["mirror_profile"] = prior.mirror_profile
                    return scheme, []

    # Only classifiable install/import failures may switch template / matrix / extras.
    if err_class not in REPLANABLE_ERROR_CLASSES:
        return None, [f"replan_refused:{err_class}"]

    adapter = str(current.get("adapter_id") or "hf_vllm")
    templates = [
        t
        for t in get_scheme_templates()
        if template_matches(t, facts, adapter) and str(t.get("scheme_id") or "") not in attempted
    ]

    # Skip known failure combos
    if experience is not None:
        filtered = []
        for t in templates:
            sid = str(t.get("scheme_id") or "")
            if experience.is_known_failure(
                facts, scheme_id=sid, failed_task_id=failed_task_id, error=error
            ):
                continue
            filtered.append(t)
        templates = filtered or templates

    if templates:
        # Prefer alternate matrix / template
        scheme = instantiate_scheme(
            templates[0],
            reason=f"replan_alternate:{failed_task_id}:{err_class}",
            replan_generation=gen,
        )
        return scheme, []

    # 2) Same scheme: patch tasks — swap pin_ref matrix row or insert extras
    patched = copy.deepcopy(current)
    patched["replan_generation"] = gen
    patched["reason"] = f"replan_patch:{failed_task_id}:{err_class}"
    tasks = list(patched.get("tasks") or [])

    # Switch pin to alternate matrix when available (replanable classes only).
    alt_matrix = None
    cur_matrix = str(patched.get("matrix_id") or "")
    for mid in get_pin_matrix():
        if mid != cur_matrix:
            alt_matrix = mid
            break
    if (
        err_class in REPLANABLE_ERROR_CLASSES
        and alt_matrix
        and failed_task_id in ("ensure_vllm", "ensure_torch", "verify_stack")
    ):
        patched["matrix_id"] = alt_matrix
        for t in tasks:
            pin_ref = str(t.get("pin_ref") or "")
            if pin_ref.startswith("matrix:") and "/" in pin_ref:
                pkg = pin_ref.split("/", 1)[1]
                t["pin_ref"] = f"matrix:{alt_matrix}/{pkg}"
        patched["tasks"] = tasks
        patched["reason"] = f"replan_switch_matrix:{alt_matrix}"
        return patched, []

    # Insert ensure_extras if missing and verify/import/conflict failed
    if err_class in ("import_failed", "conflict") and failed_task_id in (
        "verify_stack",
        "ensure_vllm",
    ):
        has_extras = any(str(t.get("id")) == "ensure_extras" for t in tasks)
        if not has_extras:
            matrix_id = str(patched.get("matrix_id") or "cu12-py310")
            tasks.insert(
                -1 if tasks else 0,
                {
                    "id": "ensure_extras",
                    "type": "ensure_package_set",
                    "set": "vllm_extras",
                    "pin_ref": f"matrix:{matrix_id}/vllm_extras",
                    "when": "always",
                    "after": ["ensure_vllm"],
                },
            )
            patched["tasks"] = tasks
            return patched, []

    # Force re-run of failed ensure by clearing a synthetic when=always
    for t in tasks:
        if str(t.get("id")) == failed_task_id and t.get("type") in (
            "ensure_package",
            "ensure_package_set",
        ):
            t["when"] = "always"
            # Literal pin fallback if pin_ref unresolved — still forbid unpinned
            if "pin_ref" in t and err_class == "unresolved_pin":
                return None, [f"replan_exhausted:cannot resolve pin for {failed_task_id}"]
    patched["tasks"] = tasks
    # If we only toggled when=always on same scheme, still return it once
    if gen <= 2:
        return patched, []

    return None, [f"replan_exhausted:no alternate for {failed_task_id}:{err_class}"]


def embed_scheme_in_job_extra(extra: Dict[str, Any], scheme: Dict[str, Any]) -> Dict[str, Any]:
    """Write runtime_scheme into job extra + nested inference_spec.runtime."""
    out = dict(extra or {})
    out["runtime_scheme"] = copy.deepcopy(scheme)
    inf = dict(out.get("inference_spec") or {})
    runtime = dict(inf.get("runtime") or {})
    runtime["scheme"] = copy.deepcopy(scheme)
    # Convenience: surface python hint from constraints/tasks later filled by worker facts
    inf["runtime"] = runtime
    if scheme.get("adapter_id"):
        inf.setdefault("adapter_id", scheme["adapter_id"])
        out.setdefault("adapter_id", scheme["adapter_id"])
    out["inference_spec"] = inf
    return out
