"""Shared inference runtime probe helpers (heartbeat + task runner)."""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict

_log = logging.getLogger(__name__)

_PROBE_SCRIPT = (
    "import json,sys\n"
    "info={'python_version':sys.version.split()[0],'torch_version':'',"
    "'torch_cuda':'','torch_available':False,'vllm_version':'',"
    "'vllm_available':False,'cuda_version':''}\n"
    "try:\n"
    " import torch\n"
    " info['torch_version']=str(getattr(torch,'__version__',''))\n"
    " info['torch_cuda']=str(getattr(getattr(torch,'version',None),'cuda','') or '')\n"
    " info['cuda_version']=info['torch_cuda']\n"
    " info['torch_available']=bool(torch.cuda.is_available())\n"
    "except Exception:\n"
    " pass\n"
    "try:\n"
    " import vllm\n"
    " info['vllm_version']=str(getattr(vllm,'__version__',''))\n"
    " info['vllm_available']=True\n"
    "except Exception:\n"
    " pass\n"
    "print(json.dumps(info))\n"
)


def resolve_inference_python() -> str:
    """Prefer inference_venvs / INFERENCE_PYTHON; never prefer swift_venv."""
    from plugins.inference_adapters.inference_venv import (
        is_swift_python,
        list_inference_venv_pythons,
    )

    for key in ("INFERENCE_PYTHON", "VLLM_PYTHON"):
        candidate = str(os.environ.get(key) or "").strip()
        if candidate and Path(candidate).exists() and not is_swift_python(candidate):
            return candidate
    found = list_inference_venv_pythons()
    if found:
        return found[0]
    return sys.executable or "python3"


def probe_python_stack(python_executable: str, *, timeout: float = 20) -> Dict[str, Any]:
    """Probe torch/vllm via a short subprocess against the selected interpreter.

    Best-effort: never raises. Returns a dict with python/torch/vllm fields.
    """
    out: Dict[str, Any] = {
        "python_version": "",
        "torch_version": "",
        "torch_cuda": "",
        "torch_available": False,
        "vllm_version": "",
        "vllm_available": False,
        "cuda_version": "",
    }
    exe = str(python_executable or "").strip() or resolve_inference_python()
    try:
        proc = subprocess.run(
            [exe, "-c", _PROBE_SCRIPT],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            parsed = json.loads(proc.stdout.strip().splitlines()[-1])
            if isinstance(parsed, dict):
                out.update({k: parsed.get(k, out[k]) for k in out})
                return out
    except Exception as exc:
        _log.debug("probe_python_stack subprocess failed: %s", exc)

    # Fallback only when probing the current interpreter.
    if Path(exe).resolve() != Path(sys.executable or exe).resolve():
        return out
    try:
        out["python_version"] = sys.version.split()[0]
    except Exception:
        pass
    try:
        import torch

        out["torch_version"] = str(getattr(torch, "__version__", "") or "")
        out["torch_cuda"] = str(getattr(getattr(torch, "version", None), "cuda", "") or "")
        out["cuda_version"] = out["torch_cuda"]
        out["torch_available"] = bool(torch.cuda.is_available())
    except Exception:
        pass
    try:
        import vllm

        out["vllm_version"] = str(getattr(vllm, "__version__", "") or "")
        out["vllm_available"] = True
    except Exception:
        pass
    return out
