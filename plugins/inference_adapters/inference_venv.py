"""Serve/Ray python must live under inference_venvs (not training swift_venv)."""

from __future__ import annotations

import os
from pathlib import Path
from typing import List, Optional, Tuple


class InferenceVenvError(ValueError):
    """Raised when a serve/Ray interpreter is forbidden or missing."""


def inference_venvs_root() -> Path:
    return Path.home() / ".cache" / "gpu_platform" / "inference_venvs"


def _norm(path: str) -> Path:
    return Path(path).expanduser().resolve()


def is_swift_python(python_executable: str) -> bool:
    raw = str(python_executable or "").strip()
    if not raw:
        return False
    lowered = raw.replace("\\", "/").lower()
    return "swift_venv" in lowered


def is_inference_venv_python(python_executable: str) -> bool:
    raw = str(python_executable or "").strip()
    if not raw or raw in ("python3", "python"):
        return False
    try:
        path = _norm(raw)
    except OSError:
        return False
    root = inference_venvs_root()
    try:
        path.relative_to(root.resolve())
    except (ValueError, OSError):
        return False
    return path.name.startswith("python") and path.parent.name == "bin"


def list_inference_venv_pythons() -> List[str]:
    root = inference_venvs_root()
    if not root.is_dir():
        return []
    found: List[str] = []
    # Prefer common CUDA tags first.
    preferred = ("cu124", "cu128", "cu121", "cu118")
    ordered: List[Path] = []
    for tag in preferred:
        ordered.append(root / tag)
    try:
        for child in sorted(root.iterdir()):
            if child not in ordered:
                ordered.append(child)
    except OSError:
        pass
    for child in ordered:
        py = child / "bin" / "python"
        if py.exists():
            found.append(str(py))
    return found


def allow_swift_serve_from_config() -> bool:
    try:
        from gpucloud_cli.config import load_config

        cfg = load_config()
        raw = cfg.get("inference_adapters") or {}
        return bool(isinstance(raw, dict) and raw.get("allow_swift_serve"))
    except Exception:
        return False


def resolve_serve_python(
    python_executable: str = "",
    *,
    allow_swift: Optional[bool] = None,
) -> str:
    """Resolve interpreter for Ray head/join and vLLM serve.

    Never falls back to ``swift_venv`` unless ``allow_swift`` is true
    (config ``inference_adapters.allow_swift_serve``, default false).
    """
    if allow_swift is None:
        allow_swift = allow_swift_serve_from_config()

    requested = str(python_executable or "").strip()
    if requested:
        if is_swift_python(requested) and not allow_swift:
            raise InferenceVenvError(
                f"swift_venv is not allowed for Ray/vLLM serve: {requested}. "
                "Install torch/vllm/ray into "
                f"{inference_venvs_root()}/<tag>/ and pass that python "
                "(or omit python_executable). Export/megatron may still use "
                "swift_venv via terminal."
            )
        if is_inference_venv_python(requested):
            path = Path(requested).expanduser()
            if not path.exists():
                raise InferenceVenvError(f"python_executable does not exist: {path}")
            return str(path)
        if allow_swift and is_swift_python(requested):
            path = Path(requested).expanduser()
            if path.exists():
                return str(path)
            raise InferenceVenvError(f"python_executable does not exist: {path}")
        # Explicit non-inference path (system python, random venv): reject for serve.
        raise InferenceVenvError(
            f"python_executable must be under {inference_venvs_root()}/<tag>/bin/python; "
            f"got: {requested}"
        )

    for key in ("INFERENCE_PYTHON", "VLLM_PYTHON"):
        env_py = str(os.environ.get(key) or "").strip()
        if not env_py:
            continue
        if is_swift_python(env_py) and not allow_swift:
            continue
        if is_inference_venv_python(env_py) and Path(env_py).expanduser().exists():
            return str(Path(env_py).expanduser())
        if allow_swift and is_swift_python(env_py) and Path(env_py).expanduser().exists():
            return str(Path(env_py).expanduser())

    for candidate in list_inference_venv_pythons():
        return candidate

    raise InferenceVenvError(
        "no inference_venvs python found. Create "
        f"{inference_venvs_root()}/cu124 (or cu128) and install torch/vllm/ray "
        "there before inference_ray_* / inference_start_vllm."
    )


def current_node_rank() -> Optional[int]:
    for key in ("GPUCLOUD_INFERENCE_NODE_RANK", "NODE_RANK"):
        raw = str(os.environ.get(key) or "").strip()
        if raw == "":
            continue
        try:
            return int(raw)
        except ValueError:
            continue
    return None


def current_nnodes() -> Optional[int]:
    for key in ("GPUCLOUD_INFERENCE_NNODES", "NNODES"):
        raw = str(os.environ.get(key) or "").strip()
        if raw == "":
            continue
        try:
            return int(raw)
        except ValueError:
            continue
    return None


def check_role_tool_allowed(tool_name: str) -> Tuple[bool, str]:
    """Return (ok, error). Unknown rank → allow (local/dev without cluster env)."""
    rank = current_node_rank()
    nnodes = current_nnodes()
    if rank is None:
        return True, ""
    multi = nnodes is None or int(nnodes) > 1
    name = str(tool_name or "").strip()
    if name == "inference_ray_start":
        if multi and rank != 0:
            return (
                False,
                f"rank={rank} must not call inference_ray_start; use inference_ray_join",
            )
    elif name == "inference_ray_join":
        if multi and rank == 0:
            return (
                False,
                "rank0 must not call inference_ray_join; use inference_ray_start",
            )
    elif name == "inference_start_vllm":
        if multi and rank != 0:
            return (
                False,
                f"rank={rank} must not start the OpenAI API server; "
                "join Ray then report phase=worker_ready",
            )
    elif name == "inference_cluster_wait_workers":
        if multi and rank != 0:
            return (
                False,
                f"rank={rank} must not call inference_cluster_wait_workers (rank0 only)",
            )
    return True, ""
