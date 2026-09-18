"""On-node Ray helpers for multi-node vLLM tensor parallel (no SSH)."""

from __future__ import annotations

import logging
import os
import re
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

_log = logging.getLogger(__name__)

# Single `ray start --address=...` attempt; outer loop keeps retrying until head is up.
_DEFAULT_JOIN_ATTEMPT_TIMEOUT = 120.0
_DEFAULT_JOIN_POLL_SECONDS = 15.0
# 0 / negative = wait forever (rank0 may still be installing deps for a long time).
_DEFAULT_JOIN_TIMEOUT_SECONDS = 0.0


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


def _parse_host_port(address: str) -> Tuple[str, int]:
    addr = str(address or "").strip()
    if not addr:
        raise ValueError("ray address required")
    if "://" in addr:
        addr = addr.split("://", 1)[1]
    host, sep, port_s = addr.rpartition(":")
    if not sep or not host or not port_s.isdigit():
        raise ValueError(
            f"invalid ray address {address!r}; expected host:port "
            "(e.g. 10.0.21.105:6425)"
        )
    return host.strip(), int(port_s)


def probe_ray_head(address: str, *, timeout: float = 3.0) -> Dict[str, Any]:
    """TCP probe of Ray GCS / head port. Does not require a local ray binary."""
    try:
        host, port = _parse_host_port(address)
    except ValueError as exc:
        return {
            "reachable": False,
            "reason": "bad_address",
            "detail": str(exc),
            "host": "",
            "port": 0,
        }
    try:
        with socket.create_connection((host, port), timeout=max(0.5, float(timeout))):
            return {
                "reachable": True,
                "reason": "ok",
                "detail": f"{host}:{port} accepting TCP",
                "host": host,
                "port": port,
            }
    except OSError as exc:
        return {
            "reachable": False,
            "reason": "head_not_listening",
            "detail": (
                f"Ray head {host}:{port} not accepting TCP yet "
                f"({type(exc).__name__}: {exc}). Rank0 may still be installing "
                "deps / has not called inference_ray_start."
            ),
            "host": host,
            "port": port,
        }


def _classify_join_failure(
    *,
    probe: Dict[str, Any],
    exit_code: Optional[int],
    stdout: str,
    stderr: str,
    timed_out: bool,
) -> str:
    if not probe.get("reachable"):
        return str(probe.get("reason") or "head_not_listening")
    blob = f"{stdout}\n{stderr}".lower()
    if timed_out:
        return "join_attempt_timeout"
    if any(
        x in blob
        for x in (
            "already running",
            "ray is already running",
            "perhaps there is a ray instance",
            "failed to start processes",
            "is already started",
        )
    ):
        return "stale_ray"
    if any(
        x in blob
        for x in (
            "connection refused",
            "failed to connect",
            "unable to connect",
            "timed out",
            "timeout",
            "no route to host",
            "network is unreachable",
            "name or service not known",
        )
    ):
        return "network"
    if exit_code not in (0, None):
        return "ray_cli_error"
    return "unknown"


def _join_failure_message(reason: str, address: str, detail: str = "") -> str:
    base = {
        "head_not_listening": (
            f"Ray head not listening at {address}; keep polling — rank0 may still "
            "be installing deps or has not started the head yet"
        ),
        "bad_address": f"Invalid Ray address {address}",
        "network": (
            f"Network error reaching Ray head {address} (firewall, wrong IP, or "
            "head restarted); will retry"
        ),
        "stale_ray": (
            "Local Ray instance looks stale/already running; forcing stop and retry"
        ),
        "join_attempt_timeout": (
            f"Single ray start --address={address} attempt timed out while head "
            "appeared reachable; will retry"
        ),
        "ray_cli_error": f"ray start --address={address} failed; will retry",
        "unknown": f"Ray join to {address} failed; will retry",
    }.get(reason, f"Ray join to {address} failed; will retry")
    if detail:
        return f"{base}: {detail}"
    return base


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


def _attempt_ray_join(
    *,
    ray: str,
    addr: str,
    num_gpus: int,
    node_ip: str,
    env: Dict[str, str],
    attempt_timeout_seconds: float,
    force_stop: bool,
) -> Dict[str, Any]:
    if force_stop:
        subprocess.run([ray, "stop", "--force"], env=env, capture_output=True, text=True)
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
    timed_out = False
    try:
        proc = subprocess.run(
            cmd,
            env=env,
            capture_output=True,
            text=True,
            timeout=max(30.0, float(attempt_timeout_seconds)),
        )
        stdout = proc.stdout or ""
        stderr = proc.stderr or ""
        exit_code = proc.returncode
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        stdout = (exc.stdout or "") if isinstance(exc.stdout, str) else ""
        stderr = (exc.stderr or "") if isinstance(exc.stderr, str) else ""
        exit_code = None
        # Best-effort cleanup so the next attempt is not blocked by a half-started ray.
        subprocess.run([ray, "stop", "--force"], env=env, capture_output=True, text=True)
    return {
        "success": (not timed_out) and exit_code == 0,
        "timed_out": timed_out,
        "exit_code": exit_code,
        "stdout": stdout[-2000:],
        "stderr": stderr[-2000:],
        "cmd": cmd,
    }


def join_ray_worker(
    *,
    address: str,
    num_gpus: int = 1,
    node_ip: str = "",
    python_executable: str = "",
    cuda_visible_devices: Optional[List[int]] = None,
    timeout_seconds: float = _DEFAULT_JOIN_TIMEOUT_SECONDS,
    poll_seconds: float = _DEFAULT_JOIN_POLL_SECONDS,
    attempt_timeout_seconds: float = _DEFAULT_JOIN_ATTEMPT_TIMEOUT,
) -> Dict[str, Any]:
    """Join this node to an existing Ray head, polling until the head is up.

    Rank0 may still be installing torch/vLLM for a long time before
    ``inference_ray_start``. Workers must keep calling join (this helper loops
    internally) rather than giving up after a single attempt.

    ``timeout_seconds`` <= 0 means wait forever. Set a positive value only for
    tests or explicit fail-closed budgets.
    """
    addr = str(address or "").strip()
    if not addr:
        raise ValueError("ray address required")
    # Validate address early.
    _parse_host_port(addr)

    ray = _ray_bin(python_executable)
    env = os.environ.copy()
    if cuda_visible_devices is not None:
        env["CUDA_VISIBLE_DEVICES"] = ",".join(str(x) for x in cuda_visible_devices)

    poll = max(1.0, float(poll_seconds))
    attempt_timeout = max(30.0, float(attempt_timeout_seconds))
    budget = float(timeout_seconds)
    deadline = None if budget <= 0 else (time.monotonic() + budget)

    attempts = 0
    last_reason = "head_not_listening"
    last_detail = ""
    last_stdout = ""
    last_stderr = ""
    last_probe: Dict[str, Any] = {}
    force_stop_next = True  # first attempt always clears stale local ray

    while True:
        if deadline is not None and time.monotonic() >= deadline:
            break
        attempts += 1
        probe = probe_ray_head(addr)
        last_probe = probe
        if not probe.get("reachable"):
            last_reason = str(probe.get("reason") or "head_not_listening")
            last_detail = str(probe.get("detail") or "")
            _log.info(
                "ray join waiting for head %s (attempt=%s reason=%s)",
                addr,
                attempts,
                last_reason,
            )
            if deadline is not None and time.monotonic() + poll >= deadline:
                break
            time.sleep(poll)
            continue

        # Head port is open — attempt join. Cap attempt so we can re-probe if
        # rank0 bounced the head mid-call.
        remaining = None if deadline is None else max(1.0, deadline - time.monotonic())
        this_attempt_timeout = attempt_timeout
        if remaining is not None:
            this_attempt_timeout = min(attempt_timeout, remaining)

        attempt = _attempt_ray_join(
            ray=ray,
            addr=addr,
            num_gpus=num_gpus,
            node_ip=node_ip,
            env=env,
            attempt_timeout_seconds=this_attempt_timeout,
            force_stop=force_stop_next,
        )
        last_stdout = attempt.get("stdout") or ""
        last_stderr = attempt.get("stderr") or ""
        if attempt.get("success"):
            return {
                "success": True,
                "role": "worker",
                "address": addr,
                "stdout": last_stdout,
                "stderr": last_stderr,
                "exit_code": attempt.get("exit_code"),
                "attempts": attempts,
                "waited_for_head": attempts > 1,
                "last_probe": last_probe,
            }

        last_reason = _classify_join_failure(
            probe=probe,
            exit_code=attempt.get("exit_code"),  # type: ignore[arg-type]
            stdout=last_stdout,
            stderr=last_stderr,
            timed_out=bool(attempt.get("timed_out")),
        )
        last_detail = (last_stderr or last_stdout or "")[-500:]
        force_stop_next = last_reason in ("stale_ray", "join_attempt_timeout", "ray_cli_error")
        _log.warning(
            "ray join attempt=%s to %s failed reason=%s; retrying",
            attempts,
            addr,
            last_reason,
        )
        if deadline is not None and time.monotonic() + poll >= deadline:
            break
        time.sleep(poll)

    msg = _join_failure_message(last_reason, addr, last_detail)
    return {
        "success": False,
        "role": "worker",
        "address": addr,
        "error": msg,
        "reason": last_reason,
        "detail": last_detail,
        "attempts": attempts,
        "stdout": last_stdout,
        "stderr": last_stderr,
        "exit_code": None,
        "last_probe": last_probe,
        "timeout_seconds": budget,
        "hint": (
            "Workers must keep joining until rank0 finishes deps and "
            "inference_ray_start; do not report worker_ready after a single failure. "
            "Default timeout_seconds=0 waits forever."
        ),
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


# ── Join success ledger + raylet / GPU / master-URL gates ───────────────────

_JOIN_LOCK = threading.Lock()
# job_id -> {address, joined_at, python_executable}
_JOIN_OK: Dict[str, Dict[str, Any]] = {}

_RAY_PORT_HINTS = frozenset({6379, 8265, 10001, 44217})


def record_ray_join_success(
    job_id: str,
    *,
    address: str,
    python_executable: str = "",
) -> None:
    jid = str(job_id or "").strip()
    if not jid:
        return
    with _JOIN_LOCK:
        _JOIN_OK[jid] = {
            "address": str(address or "").strip(),
            "python_executable": str(python_executable or "").strip(),
            "joined_at": time.time(),
        }


def clear_ray_join_success(job_id: str = "") -> None:
    """Test helper / cleanup. Empty job_id clears all."""
    with _JOIN_LOCK:
        if not job_id:
            _JOIN_OK.clear()
            return
        _JOIN_OK.pop(str(job_id).strip(), None)


def get_ray_join_success(job_id: str) -> Optional[Dict[str, Any]]:
    jid = str(job_id or "").strip()
    if not jid:
        return None
    with _JOIN_LOCK:
        raw = _JOIN_OK.get(jid)
        return dict(raw) if isinstance(raw, dict) else None


def local_raylet_alive() -> Dict[str, Any]:
    """Best-effort check that a local raylet process is running."""
    try:
        proc = subprocess.run(
            ["pgrep", "-af", "raylet"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        out = (proc.stdout or "").strip()
        # Prefer real raylet binaries; ignore our own pgrep line.
        lines = [
            ln
            for ln in out.splitlines()
            if "raylet" in ln
            and "pgrep" not in ln
            and "grep" not in ln
        ]
        alive = proc.returncode == 0 and bool(lines)
        return {
            "alive": alive,
            "detail": (lines[0][:200] if lines else "no raylet process"),
        }
    except Exception as exc:
        return {"alive": False, "detail": f"raylet probe failed: {exc}"}


def require_worker_ready_prereqs(job_id: str) -> Dict[str, Any]:
    """Gate worker_ready: successful inference_ray_join for job + local raylet."""
    join = get_ray_join_success(job_id)
    if not join:
        return {
            "ok": False,
            "error": (
                "worker_ready refused: no successful inference_ray_join recorded "
                f"for job_id={job_id}. Call inference_ray_join and wait for "
                "success before inference_report_ready(phase=worker_ready)."
            ),
            "phase": "ray_join_gate",
        }
    raylet = local_raylet_alive()
    if not raylet.get("alive"):
        return {
            "ok": False,
            "error": (
                "worker_ready refused: local raylet is not alive after join "
                f"({raylet.get('detail')}). Re-run inference_ray_join."
            ),
            "phase": "raylet_gate",
            "join": join,
            "raylet": raylet,
        }
    return {"ok": True, "join": join, "raylet": raylet}


def parse_ray_status_gpus(status_text: str) -> float:
    """Extract total cluster GPU count from `ray status` output."""
    text = status_text or ""
    m = re.search(
        r"Total Usage:\s*.*?([\d.]+)\s*/\s*([\d.]+)\s+GPU",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if m:
        return float(m.group(2))
    matches = re.findall(r"([\d.]+)\s*/\s*([\d.]+)\s+GPU", text, flags=re.IGNORECASE)
    if not matches:
        return 0.0
    # Prefer the largest total (cluster aggregate usually max; avoid summing
    # duplicated per-section lines).
    return max(float(tot) for _used, tot in matches)


def ray_cluster_gpu_count(
    *,
    address: str = "",
    python_executable: str = "",
) -> Dict[str, Any]:
    """Run `ray status` and return available GPU count in the cluster."""
    ray = _ray_bin(python_executable)
    env = os.environ.copy()
    addr = str(address or env.get("RAY_ADDRESS") or "").strip()
    if addr:
        env["RAY_ADDRESS"] = addr
    try:
        proc = subprocess.run(
            [ray, "status"],
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except Exception as exc:
        return {
            "success": False,
            "gpus": 0.0,
            "error": f"ray status failed: {exc}",
            "address": addr,
        }
    text = f"{proc.stdout or ''}\n{proc.stderr or ''}"
    gpus = parse_ray_status_gpus(text)
    ok = proc.returncode == 0 and gpus > 0
    return {
        "success": ok,
        "gpus": gpus,
        "exit_code": proc.returncode,
        "address": addr,
        "raw": text[-3000:],
        "error": (
            ""
            if ok
            else (
                f"ray status exit={proc.returncode} parsed_gpus={gpus}; "
                "ensure workers joined with --num-gpus before start_vllm"
            )
        ),
    }


def require_ray_gpus_for_tp(
    *,
    tensor_parallel: int,
    address: str = "",
    python_executable: str = "",
) -> Dict[str, Any]:
    """Fail closed when Ray cluster GPU count < required TP."""
    tp = max(1, int(tensor_parallel))
    status = ray_cluster_gpu_count(address=address, python_executable=python_executable)
    gpus = float(status.get("gpus") or 0)
    if not status.get("success") or gpus + 1e-6 < tp:
        return {
            "ok": False,
            "error": (
                f"start_vllm refused: Ray cluster has {gpus:g} GPU(s) but "
                f"tensor_parallel={tp}. Workers must successfully "
                "inference_ray_join (with num_gpus) before rank0 starts vLLM; "
                "do not start with only the head node."
            ),
            "phase": "ray_gpu_gate",
            "tensor_parallel": tp,
            "ray_gpus": gpus,
            "ray_status": status,
        }
    return {
        "ok": True,
        "tensor_parallel": tp,
        "ray_gpus": gpus,
        "ray_status": status,
    }


def cluster_api_port() -> int:
    try:
        return int(os.environ.get("GPUCLOUD_CLUSTER_API_PORT") or 8765)
    except ValueError:
        return 8765


def normalize_cluster_master_url(raw: str = "") -> Dict[str, Any]:
    """Force http(s)://<host>:8765 — reject Ray GCS / dashboard ports."""
    from urllib.parse import urlparse, urlunparse

    api_port = cluster_api_port()
    s = str(raw or "").strip()
    if not s:
        s = (
            os.environ.get("GPUCLOUD_CLUSTER_MASTER_URL") or ""
        ).strip() or f"http://127.0.0.1:{api_port}"
    if "://" not in s:
        s = "http://" + s
    parsed = urlparse(s)
    if parsed.scheme not in ("http", "https"):
        return {
            "ok": False,
            "error": (
                f"master_url must be http(s)://{parsed.hostname or '<host>'}:{api_port} "
                f"(got scheme={parsed.scheme!r}). Do not pass a Ray address."
            ),
            "phase": "master_url_gate",
        }
    host = parsed.hostname or ""
    if not host:
        return {
            "ok": False,
            "error": "master_url missing host",
            "phase": "master_url_gate",
        }
    port = parsed.port
    if port is None:
        port = api_port
    # Explicit Ray-ish ports always rejected.
    if port in _RAY_PORT_HINTS or port != api_port:
        return {
            "ok": False,
            "error": (
                f"master_url port must be cluster API {api_port} "
                f"(got {port}). Ray GCS/dashboard ports "
                f"(e.g. 6379/8265/6425) are forbidden — use "
                f"http://{host}:{api_port} with GPUCLOUD_CLUSTER_SECRET."
            ),
            "phase": "master_url_gate",
            "got_port": port,
            "expected_port": api_port,
        }
    normalized = urlunparse(
        (parsed.scheme, f"{host}:{api_port}", "", "", "", "")
    ).rstrip("/")
    return {"ok": True, "master_url": normalized, "port": api_port}


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

    url_info = normalize_cluster_master_url(master_url)
    if not url_info.get("ok"):
        return {
            "success": False,
            "ready": False,
            "error": url_info.get("error"),
            "phase": url_info.get("phase") or "master_url_gate",
        }
    master = str(url_info["master_url"])
    tok = str(secret or os.environ.get("GPUCLOUD_CLUSTER_SECRET") or "").strip()
    if not tok:
        return {
            "success": False,
            "ready": False,
            "error": (
                "cluster_secret required: set GPUCLOUD_CLUSTER_SECRET or pass "
                "cluster_secret (Bearer for GET /api/jobs/{id}). Without it "
                "wait_workers gets HTTP 401."
            ),
            "phase": "auth_gate",
        }

    deadline = time.monotonic() + max(1.0, float(timeout_seconds))
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {tok}",
    }
    url = f"{master}/api/jobs/{job_id}"
    last: Dict[str, Any] = {}
    while time.monotonic() < deadline:
        try:
            req = urllib.request.Request(url, headers=headers, method="GET")
            with urllib.request.urlopen(req, timeout=10) as resp:
                last = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = ""
            try:
                body = exc.read().decode("utf-8", errors="replace")[:300]
            except Exception:
                pass
            last = {
                "success": False,
                "error": f"HTTP Error {exc.code}: {exc.reason}",
                "body": body,
            }
            if exc.code == 401:
                return {
                    "success": False,
                    "ready": False,
                    "error": (
                        "HTTP 401 Unauthorized from cluster master — check "
                        "GPUCLOUD_CLUSTER_SECRET matches master cluster.secret"
                    ),
                    "phase": "auth_gate",
                    "last_status": last,
                    "master_url": master,
                }
            time.sleep(poll_seconds)
            continue
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, Exception) as exc:
            last = {"success": False, "error": str(exc)}
            time.sleep(poll_seconds)
            continue
        assignments = last.get("assignments") or []
        if not isinstance(assignments, list):
            time.sleep(poll_seconds)
            continue
        peers = [a for a in assignments if int(a.get("node_rank") or 0) != 0]
        if not peers:
            return {
                "success": True,
                "ready": True,
                "assignments": assignments,
                "master_url": master,
            }
        pending = [
            a.get("node_id")
            for a in peers
            if str(a.get("state") or "") not in ("worker_ready", "succeeded")
        ]
        if not pending:
            return {
                "success": True,
                "ready": True,
                "assignments": assignments,
                "master_url": master,
            }
        last = {**last, "pending_nodes": pending, "ready": False}
        time.sleep(poll_seconds)
    return {
        "success": False,
        "ready": False,
        "error": "timeout waiting for workers",
        "pending_nodes": last.get("pending_nodes") or [],
        "last_status": last,
        "master_url": master,
    }
