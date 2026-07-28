"""On-node Ray helpers for multi-node vLLM tensor parallel (no SSH)."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

_log = logging.getLogger(__name__)


def _resolve_python(python_executable: str = "") -> str:
    from plugins.inference_adapters.inference_venv import resolve_serve_python

    return resolve_serve_python(python_executable)


def _ray_bin(python_executable: str = "") -> str:
    py = Path(_resolve_python(python_executable)).expanduser()
    sibling = py.parent / "ray"
    if sibling.exists() and os.access(sibling, os.X_OK):
        return str(sibling)
    which = shutil.which("ray")
    if which:
        return which
    raise FileNotFoundError(
        f"ray executable not found next to {py} or on PATH; "
        "install ray into the inference venv"
    )


def start_ray_head(
    *,
    port: int,
    num_gpus: int = 1,
    node_ip: str = "",
    python_executable: str = "",
    cuda_visible_devices: Optional[List[int]] = None,
) -> Dict[str, Any]:
    """Start a Ray head on this node. Idempotent-ish: stops existing first."""
    ray = _ray_bin(python_executable)
    env = os.environ.copy()
    if cuda_visible_devices is not None:
        env["CUDA_VISIBLE_DEVICES"] = ",".join(str(x) for x in cuda_visible_devices)
    # Best-effort stop before start.
    subprocess.run([ray, "stop", "--force"], env=env, capture_output=True, text=True)
    cmd = [
        ray,
        "start",
        "--head",
        f"--port={int(port)}",
        f"--num-gpus={max(0, int(num_gpus))}",
        "--disable-usage-stats",
    ]
    ip = (node_ip or os.environ.get("GPUCLOUD_CLUSTER_ADVERTISED_ADDR", "") or "").strip()
    if ip:
        cmd.append(f"--node-ip-address={ip}")
    _log.info("ray start head: %s", " ".join(cmd))
    proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=180)
    address = f"{ip or '127.0.0.1'}:{int(port)}"
    return {
        "success": proc.returncode == 0,
        "role": "head",
        "address": address,
        "stdout": (proc.stdout or "")[-2000:],
        "stderr": (proc.stderr or "")[-2000:],
        "exit_code": proc.returncode,
    }


def join_ray_worker(
    *,
    address: str,
    num_gpus: int = 1,
    node_ip: str = "",
    python_executable: str = "",
    cuda_visible_devices: Optional[List[int]] = None,
) -> Dict[str, Any]:
    """Join this node to an existing Ray head."""
    ray = _ray_bin(python_executable)
    env = os.environ.copy()
    if cuda_visible_devices is not None:
        env["CUDA_VISIBLE_DEVICES"] = ",".join(str(x) for x in cuda_visible_devices)
    subprocess.run([ray, "stop", "--force"], env=env, capture_output=True, text=True)
    addr = str(address or "").strip()
    if not addr:
        raise ValueError("ray address required")
    cmd = [
        ray,
        "start",
        f"--address={addr}",
        f"--num-gpus={max(0, int(num_gpus))}",
        "--disable-usage-stats",
    ]
    ip = (node_ip or os.environ.get("GPUCLOUD_CLUSTER_ADVERTISED_ADDR", "") or "").strip()
    if ip:
        cmd.append(f"--node-ip-address={ip}")
    _log.info("ray start worker: %s", " ".join(cmd))
    proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=180)
    return {
        "success": proc.returncode == 0,
        "role": "worker",
        "address": addr,
        "stdout": (proc.stdout or "")[-2000:],
        "stderr": (proc.stderr or "")[-2000:],
        "exit_code": proc.returncode,
    }


def stop_ray(*, python_executable: str = "") -> Dict[str, Any]:
    ray = _ray_bin(python_executable)
    proc = subprocess.run(
        [ray, "stop", "--force"], capture_output=True, text=True, timeout=120
    )
    return {
        "success": proc.returncode == 0,
        "stdout": (proc.stdout or "")[-1000:],
        "stderr": (proc.stderr or "")[-1000:],
        "exit_code": proc.returncode,
    }


def wait_workers_ready(
    *,
    master_url: str,
    job_id: str,
    secret: str = "",
    timeout_seconds: float = 600.0,
    poll_seconds: float = 3.0,
) -> Dict[str, Any]:
    """Poll cluster master until all non-rank0 assignments are worker_ready."""
    import json
    import urllib.error
    import urllib.request

    deadline = time.monotonic() + max(1.0, float(timeout_seconds))
    headers = {"Accept": "application/json"}
    if secret:
        headers["Authorization"] = f"Bearer {secret}"
    url = f"{master_url.rstrip('/')}/api/jobs/{job_id}"
    last: Dict[str, Any] = {}
    while time.monotonic() < deadline:
        try:
            req = urllib.request.Request(url, headers=headers, method="GET")
            with urllib.request.urlopen(req, timeout=10) as resp:
                last = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last = {"success": False, "error": str(exc)}
            time.sleep(poll_seconds)
            continue
        assignments = last.get("assignments") or []
        if not isinstance(assignments, list):
            time.sleep(poll_seconds)
            continue
        peers = [a for a in assignments if int(a.get("node_rank") or 0) != 0]
        if not peers:
            return {"success": True, "ready": True, "assignments": assignments}
        pending = [
            a.get("node_id")
            for a in peers
            if str(a.get("state") or "") not in ("worker_ready", "succeeded")
        ]
        if not pending:
            return {"success": True, "ready": True, "assignments": assignments}
        last = {**last, "pending_nodes": pending, "ready": False}
        time.sleep(poll_seconds)
    return {
        "success": False,
        "ready": False,
        "error": "timeout waiting for workers",
        "pending_nodes": last.get("pending_nodes") or [],
        "last_status": last,
    }
