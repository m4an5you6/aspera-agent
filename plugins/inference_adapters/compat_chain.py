"""Compatibility-chain store + validation for inference agent runtime."""

from __future__ import annotations

import hashlib
import json
import logging
import re
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from plugins.inference_adapters.inference_venv import (
    InferenceVenvError,
    resolve_serve_python,
)

_log = logging.getLogger(__name__)

_LOCK = threading.Lock()
_CHAINS: Dict[str, Dict[str, Any]] = {}

_RANGE_BAD = re.compile(r"(>=|<=|~=|>|<|\*)")
_OFFICIAL_PIP = re.compile(r"pypi\.org|files\.pythonhosted\.org", re.I)
_PREFERRED_MIRROR = re.compile(
    r"mirrors\.aliyun\.com|tuna\.tsinghua\.edu\.cn|pypi\.tuna\.tsinghua",
    re.I,
)


def clear_compat_chain(job_id: str) -> None:
    jid = str(job_id or "").strip()
    if not jid:
        return
    with _LOCK:
        _CHAINS.pop(jid, None)


def get_compat_chain(job_id: str) -> Optional[Dict[str, Any]]:
    jid = str(job_id or "").strip()
    if not jid:
        return None
    with _LOCK:
        raw = _CHAINS.get(jid)
        return dict(raw) if isinstance(raw, dict) else None


def store_compat_chain(job_id: str, record: Dict[str, Any]) -> None:
    jid = str(job_id or "").strip()
    if not jid:
        return
    with _LOCK:
        _CHAINS[jid] = dict(record)


def reset_compat_chains_for_tests() -> None:
    with _LOCK:
        _CHAINS.clear()


def _norm_pin(raw: Any) -> str:
    return str(raw or "").strip()


def _pin_errors(label: str, pin: str, *, required: bool) -> List[str]:
    errs: List[str] = []
    if not pin:
        if required:
            errs.append(f"pins.{label} is required (exact pkg==version)")
        return errs
    if _RANGE_BAD.search(pin) or ">=" in pin:
        errs.append(
            f"pins.{label}={pin!r} must be an exact == pin "
            "(reject >= / unpinned ranges; they can pull incompatible torch CUDA)"
        )
        return errs
    # Allow torch==2.5.1+cu124 style
    if "==" not in pin:
        errs.append(f"pins.{label}={pin!r} must contain '=='")
        return errs
    pkg, _, ver = pin.partition("==")
    if not pkg.strip() or not ver.strip():
        errs.append(f"pins.{label}={pin!r} is not a valid pkg==version pin")
    return errs


def validate_compat_chain(
    chain: Any,
    *,
    status: str = "planned",
) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    """Return (normalized_chain, errors)."""
    errors: List[str] = []
    if not isinstance(chain, dict):
        return None, ["compat_chain must be an object"]

    status_n = str(status or chain.get("status") or "planned").strip().lower()
    if status_n not in ("planned", "verified"):
        errors.append("status must be planned or verified")
        status_n = "planned"

    driver = chain.get("driver")
    if not isinstance(driver, dict):
        errors.append("driver must be an object with nvidia_smi_cuda / driver_version")
        driver_n: Dict[str, Any] = {}
    else:
        driver_n = {
            "nvidia_smi_cuda": str(
                driver.get("nvidia_smi_cuda") or driver.get("cuda") or ""
            ).strip(),
            "driver_version": str(
                driver.get("driver_version") or driver.get("version") or ""
            ).strip(),
        }
        if not driver_n["nvidia_smi_cuda"] and not driver_n["driver_version"]:
            errors.append("driver.nvidia_smi_cuda or driver.driver_version required")

    model_family = str(chain.get("model_family") or "").strip()
    if not model_family:
        errors.append("model_family required")

    venv_raw = str(chain.get("venv_python") or "").strip()
    venv_python = ""
    if not venv_raw:
        errors.append("venv_python required")
    else:
        try:
            venv_python = resolve_serve_python(venv_raw)
        except InferenceVenvError as exc:
            errors.append(f"venv_python: {exc}")

    pins_in = chain.get("pins") if isinstance(chain.get("pins"), dict) else {}
    pins = {
        "torch": _norm_pin(pins_in.get("torch")),
        "vllm": _norm_pin(pins_in.get("vllm")),
        "transformers": _norm_pin(pins_in.get("transformers")),
        "ray": _norm_pin(pins_in.get("ray")),
    }
    errors.extend(_pin_errors("torch", pins["torch"], required=True))
    errors.extend(_pin_errors("vllm", pins["vllm"], required=True))
    if pins["transformers"]:
        errors.extend(_pin_errors("transformers", pins["transformers"], required=False))
    if pins["ray"]:
        errors.extend(_pin_errors("ray", pins["ray"], required=False))

    order = chain.get("install_order")
    if not isinstance(order, list) or not order:
        errors.append("install_order must be a non-empty list")
        order_n: List[str] = []
    else:
        order_n = [str(x).strip() for x in order if str(x).strip()]
        joined = " | ".join(order_n).lower()
        torch_pos = next(
            (i for i, x in enumerate(order_n) if "torch" in x.lower()),
            None,
        )
        vllm_pos = next(
            (i for i, x in enumerate(order_n) if "vllm" in x.lower()),
            None,
        )
        if torch_pos is None or vllm_pos is None:
            errors.append("install_order must mention torch before vllm")
        elif torch_pos >= vllm_pos:
            errors.append("install_order must install/confirm torch before vllm")
        if "torch" not in joined or "vllm" not in joined:
            pass  # already covered

    pip_index = str(chain.get("pip_index") or "").strip()
    if not pip_index:
        errors.append(
            "pip_index required (use a China mirror, e.g. "
            "https://mirrors.aliyun.com/pypi/simple/)"
        )
    elif _OFFICIAL_PIP.search(pip_index):
        rationale_l = str(chain.get("rationale") or "").lower()
        if "mirror failed" not in rationale_l and "mirrors failed" not in rationale_l:
            errors.append(
                "pip_index must not default to official PyPI; use Aliyun/Tsinghua "
                "(official only if rationale documents mirror failed)"
            )
    elif not _PREFERRED_MIRROR.search(pip_index):
        # warn-level as soft error? Plan recommends aliyun/tsinghua — accept other
        # mirrors but prefer documenting. Keep as non-fatal info via no error.
        pass

    pip_extra = str(chain.get("pip_extra_index") or "").strip()

    rationale = str(chain.get("rationale") or "").strip()
    if len(rationale) < 40:
        errors.append(
            "rationale required (>=40 chars): driver CUDA → torch cu tag → "
            "vllm pin → why not latest; include mirror choice"
        )

    rejected = chain.get("rejected_alternatives")
    if isinstance(rejected, str):
        rejected_n = [rejected.strip()] if rejected.strip() else []
    elif isinstance(rejected, list):
        rejected_n = [str(x).strip() for x in rejected if str(x).strip()]
    else:
        rejected_n = []
    if not rejected_n:
        errors.append(
            "rejected_alternatives required (at least one concrete rejected option, "
            "e.g. vllm>=0.8.0 pulls torch cu130)"
        )

    smoke_cmd = str(chain.get("smoke_cmd") or "").strip()
    if not smoke_cmd:
        errors.append("smoke_cmd required (one-liner CUDA smoke after install)")

    if errors:
        return None, errors

    normalized = {
        "status": status_n,
        "driver": driver_n,
        "model_family": model_family,
        "venv_python": venv_python,
        "pins": {k: v for k, v in pins.items() if v},
        "install_order": order_n,
        "pip_index": pip_index,
        "pip_extra_index": pip_extra,
        "rationale": rationale,
        "rejected_alternatives": rejected_n,
        "smoke_cmd": smoke_cmd,
    }
    normalized["fingerprint"] = fingerprint_compat(normalized)
    return normalized, []


def fingerprint_compat(chain: Dict[str, Any]) -> str:
    payload = {
        "venv_python": chain.get("venv_python"),
        "pins": chain.get("pins"),
        "driver": chain.get("driver"),
        "model_family": chain.get("model_family"),
        "pip_index": chain.get("pip_index"),
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def run_compat_smoke(
    *,
    venv_python: str,
    smoke_cmd: str = "",
    timeout: float = 60.0,
) -> Tuple[bool, str]:
    """Run CUDA smoke in the target venv. Returns (ok, output_or_error)."""
    py = str(venv_python or "").strip()
    if not py or not Path(py).expanduser().exists():
        return False, f"venv_python missing: {py}"

    # Prefer structured default smoke so agents cannot skip cuda with a no-op cmd.
    default = (
        f"{py} -c \"import torch; "
        f"t=torch.zeros(1).cuda(); "
        f"print('CUDA_OK', torch.__version__, torch.version.cuda, t.device)\""
    )
    cmd = smoke_cmd.strip() if smoke_cmd.strip() else default
    # If agent passed a relative python -c, still force interpreter prefix when missing.
    if not cmd.startswith(py) and "python" not in cmd.split()[0]:
        cmd = f"{py} -c {json.dumps(cmd)}" if cmd.startswith("import ") else cmd

    try:
        proc = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except Exception as exc:
        return False, str(exc)

    out = ((proc.stdout or "") + (proc.stderr or "")).strip()
    if proc.returncode != 0:
        return False, out[-2000:] or f"smoke exit {proc.returncode}"
    # Require torch import success signal
    if "CUDA_OK" not in out and "cuda" not in out.lower():
        # still accept if exit 0 and no obvious error — but prefer CUDA_OK
        try:
            probe = subprocess.run(
                [
                    py,
                    "-c",
                    "import torch; t=torch.zeros(1).cuda(); "
                    "print('CUDA_OK', torch.__version__, torch.version.cuda)",
                ],
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
            pout = ((probe.stdout or "") + (probe.stderr or "")).strip()
            if probe.returncode != 0 or "CUDA_OK" not in pout:
                return False, pout[-2000:] or out[-2000:]
            return True, pout[-2000:]
        except Exception as exc:
            return False, str(exc)
    return True, out[-2000:]


def require_verified_compat(
    job_id: str,
    *,
    python_executable: str = "",
) -> Tuple[bool, str]:
    """Gate Ray/serve: need verified chain matching venv python."""
    rec = get_compat_chain(job_id)
    if not rec:
        return (
            False,
            "compat_gate: call inference_ensure_runtime with a full compat_chain "
            "and reach status=verified before Ray/serve",
        )
    if str(rec.get("status") or "") != "verified":
        return (
            False,
            "compat_gate: compat_chain status must be verified "
            "(planned → pip/smoke → ensure_runtime verified)",
        )
    want = str(rec.get("venv_python") or "").strip()
    got = str(python_executable or "").strip()
    if got and want:
        try:
            if Path(got).expanduser().resolve() != Path(want).expanduser().resolve():
                return (
                    False,
                    f"compat_gate: python_executable {got} != verified venv_python {want}",
                )
        except OSError:
            if got != want:
                return (
                    False,
                    f"compat_gate: python_executable {got} != verified venv_python {want}",
                )
    return True, ""
