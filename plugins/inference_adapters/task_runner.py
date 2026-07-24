"""Worker-side InstallTask runner for RuntimeScheme.tasks."""

from __future__ import annotations

import logging
import os
import re
import select
import signal
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set

from plugins.cluster.runtime_probe import probe_python_stack, resolve_inference_python
from plugins.inference_adapters.runtime_scheme import (
    get_ensure_runtime_timeout,
    get_mirror_profiles,
    resolve_pin_ref,
)

_log = logging.getLogger(__name__)

# pip progress tokens that reset the idle timer (case-insensitive).
_PIP_PROGRESS_RE = re.compile(
    r"(downloading|download\s+\d|installing|building\s+wheel|writing|saved\s+|successfully\s+installed|"
    r"collecting\s+|obtaining\s+|preparing\s+|using\s+cached|%\s*\||\d+\.\d+\s*(k|m|g)?b/s)",
    re.IGNORECASE,
)


class NeedsReplan(Exception):
    """Raised when the worker cannot proceed safely under the current scheme."""

    def __init__(
        self,
        *,
        failed_task_id: str,
        error: str,
        facts: Dict[str, Any],
        completed_task_ids: Optional[List[str]] = None,
        stderr_tail: str = "",
    ) -> None:
        super().__init__(error)
        self.failed_task_id = failed_task_id
        self.error = error
        self.facts = dict(facts or {})
        self.completed_task_ids = list(completed_task_ids or [])
        self.stderr_tail = stderr_tail or ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": "needs_replan",
            "failed_task_id": self.failed_task_id,
            "error": self.error,
            "facts": self.facts,
            "completed_task_ids": self.completed_task_ids,
            "stderr_tail": self.stderr_tail,
            "replan_generation": self.facts.get("replan_generation"),
        }


@dataclass
class TaskRunnerResult:
    facts: Dict[str, Any] = field(default_factory=dict)
    completed_task_ids: List[str] = field(default_factory=list)
    skipped_task_ids: List[str] = field(default_factory=list)


def _eval_when(when: str, facts: Dict[str, Any]) -> bool:
    expr = str(when or "always").strip()
    if not expr or expr == "always":
        return True
    # Supported shorthand expressions used by built-in schemes.
    torch_ok = bool(facts.get("torch_available"))
    vllm_ok = bool(facts.get("vllm_available"))
    incompatible_torch = bool(facts.get("incompatible_torch"))
    extras_missing = bool(facts.get("extras_missing", True))

    mapping = {
        "not facts.torch_available or incompatible_torch": (not torch_ok) or incompatible_torch,
        "not facts.vllm_available": not vllm_ok,
        "extras_missing": extras_missing,
        "always": True,
    }
    if expr in mapping:
        return mapping[expr]
    # Fallback: unknown when → run (safe; pins still enforced)
    _log.warning("unknown task when=%r; treating as true", expr)
    return True


def _deps_satisfied(task: Dict[str, Any], completed: Set[str], skipped: Set[str]) -> bool:
    after = task.get("after") or []
    if not isinstance(after, list):
        return True
    done = completed | skipped
    return all(str(x) in done for x in after)


def _mirror_env_and_args(profile_name: str) -> tuple[Dict[str, str], List[str]]:
    profiles = get_mirror_profiles()
    profile = profiles.get(profile_name) or profiles.get("default") or {}
    env: Dict[str, str] = {}
    if isinstance(profile.get("env"), dict):
        env.update({str(k): str(v) for k, v in profile["env"].items()})
    args: List[str] = []
    index_url = str(profile.get("pip_index_url") or "").strip()
    if index_url:
        args.extend(["--index-url", index_url])
    extra = profile.get("pip_extra_index_urls")
    if isinstance(extra, dict):
        for url in extra.values():
            if url:
                args.extend(["--extra-index-url", str(url)])
    elif isinstance(extra, list):
        for url in extra:
            if url:
                args.extend(["--extra-index-url", str(url)])
    trusted = profile.get("pip_trusted_host") or []
    if isinstance(trusted, list):
        for host in trusted:
            if host:
                args.extend(["--trusted-host", str(host)])
    return env, args


def _kill_pip_process(proc: subprocess.Popen) -> None:
    try:
        if proc.poll() is not None:
            return
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                proc.kill()
            proc.wait(timeout=5)
    except Exception:
        pass


def _path_mtime(path: Optional[Path]) -> float:
    if path is None:
        return 0.0
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _run_pip_install(
    python_executable: str,
    specs: List[str],
    *,
    extra_index_urls: Optional[List[str]] = None,
    mirror_profile: str = "default",
    timeout: float = 1800,
    log_path: Optional[Path] = None,
    on_progress: Optional[Callable[[], None]] = None,
) -> tuple[bool, str]:
    """Run pip install with idle (no-progress) timeout.

    ``timeout`` is the max seconds without download/write/progress output —
    not an absolute wall for the whole install. Any progress renews the idle timer.
    """
    env = os.environ.copy()
    mirror_env, mirror_args = _mirror_env_and_args(mirror_profile)
    env.update(mirror_env)
    # Encourage line-buffered progress from pip.
    env.setdefault("PYTHONUNBUFFERED", "1")
    cmd = [
        python_executable,
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--progress-bar",
        "on",
        *mirror_args,
    ]
    for url in extra_index_urls or []:
        if url and url not in cmd:
            cmd.extend(["--extra-index-url", url])
    cmd.extend(specs)
    _log.info("pip install: %s", " ".join(cmd))

    idle_limit = float(timeout or 1800)
    log_fh = None
    if log_path is not None:
        try:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            log_fh = open(log_path, "ab")
        except Exception:
            log_fh = None

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=env,
            start_new_session=True,
        )
    except Exception as exc:
        if log_fh is not None:
            log_fh.close()
        return False, str(exc)

    chunks: List[str] = []
    last_progress = time.monotonic()
    last_log_mtime = _path_mtime(log_path)
    timed_out = False

    def _note_progress(reason: str = "") -> None:
        nonlocal last_progress
        last_progress = time.monotonic()
        if on_progress is not None:
            try:
                on_progress()
            except Exception:
                pass
        if reason:
            _log.debug("pip progress: %s", reason)

    def _consume(data: str) -> None:
        if not data:
            return
        chunks.append(data)
        if log_fh is not None:
            try:
                log_fh.write(data.encode("utf-8", errors="replace"))
                log_fh.flush()
            except Exception:
                pass
        # Any new bytes count as activity; stronger tokens also renew.
        _note_progress("stdout/stderr bytes")
        if _PIP_PROGRESS_RE.search(data):
            _note_progress("pip progress token")

    try:
        fds = [fd for fd in (proc.stdout, proc.stderr) if fd is not None]
        while True:
            if proc.poll() is not None:
                # Drain remaining output.
                for stream in fds:
                    try:
                        rest = stream.read()
                    except Exception:
                        rest = ""
                    if rest:
                        _consume(rest)
                break

            idle_for = time.monotonic() - last_progress
            if idle_for > idle_limit:
                timed_out = True
                _kill_pip_process(proc)
                break

            ready, _, _ = select.select(fds, [], [], 1.0)
            for stream in ready:
                try:
                    data = stream.readline()
                except Exception:
                    data = ""
                if data:
                    _consume(data)

            # Optional: log file growth also counts as progress.
            new_mtime = _path_mtime(log_path)
            if new_mtime > last_log_mtime:
                last_log_mtime = new_mtime
                _note_progress("log mtime")
    finally:
        if log_fh is not None:
            try:
                log_fh.close()
            except Exception:
                pass

    combined = "".join(chunks)
    if timed_out:
        tail = combined[-2000:] if combined else ""
        msg = f"pip timeout after {int(idle_limit)}s (no progress)"
        if tail:
            msg = f"{msg}: {tail}"
        return False, msg

    if proc.returncode != 0:
        tail = combined[-2000:] if combined else ""
        return False, tail or f"pip exit {proc.returncode}"
    return True, ""


def _probe_into_facts(python_executable: str, facts: Dict[str, Any]) -> None:
    facts["python_executable"] = python_executable
    facts.update(probe_python_stack(python_executable, timeout=30))


def _verify_imports(python_executable: str, imports: List[str]) -> tuple[bool, str]:
    mods = ",".join(repr(m) for m in imports)
    script = (
        f"mods=[{mods}]\n"
        "failed=[]\n"
        "for m in mods:\n"
        "  try:\n"
        "    __import__(m)\n"
        "  except Exception as e:\n"
        "    failed.append(f'{m}:{e}')\n"
        "if failed:\n"
        "  raise SystemExit(';'.join(failed))\n"
    )
    try:
        proc = subprocess.run(
            [python_executable, "-c", script],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except Exception as exc:
        return False, str(exc)
    if proc.returncode != 0:
        return False, (proc.stderr or proc.stdout or "import failed")[-2000:]
    return True, ""


ReplanCallback = Callable[[NeedsReplan], Dict[str, Any]]


def run_scheme_tasks(
    scheme: Dict[str, Any],
    *,
    initial_facts: Optional[Dict[str, Any]] = None,
    replan_callback: Optional[ReplanCallback] = None,
    stop_flag: Optional[Callable[[], bool]] = None,
    log_dir: Optional[Path] = None,
    max_replan_attempts: int = 16,
    max_replan_wall_seconds: float = 3600.0,
) -> TaskRunnerResult:
    """Execute scheme.tasks with optional synchronous replan callback.

    ``replan_callback(needs)`` must return a new scheme dict (or raise).
    ``max_replan_wall_seconds`` is an idle / no-progress budget: task completion,
    skips, successful replan, and pip download/write progress all renew it.
    """
    current = dict(scheme or {})
    facts: Dict[str, Any] = dict(initial_facts or {})
    facts.setdefault(
        "python_executable",
        str(facts.get("python_executable") or resolve_inference_python()),
    )
    completed: Set[str] = set()
    skipped: Set[str] = set()
    replan_count = 0
    last_progress_at = time.monotonic()
    timeout = get_ensure_runtime_timeout()
    attempted_scheme_ids: List[str] = []

    def _bump_progress() -> None:
        nonlocal last_progress_at
        last_progress_at = time.monotonic()

    while True:
        if stop_flag and stop_flag():
            raise NeedsReplan(
                failed_task_id="",
                error="cancelled",
                facts=facts,
                completed_task_ids=sorted(completed),
            )
        if time.monotonic() - last_progress_at > max_replan_wall_seconds:
            raise NeedsReplan(
                failed_task_id="",
                error="replan_exhausted:no_progress_wall",
                facts=facts,
                completed_task_ids=sorted(completed),
            )

        tasks = list(current.get("tasks") or [])
        if not tasks:
            return TaskRunnerResult(
                facts=facts,
                completed_task_ids=sorted(completed),
                skipped_task_ids=sorted(skipped),
            )

        progress = False
        pending = [t for t in tasks if str(t.get("id") or "") not in completed | skipped]
        if not pending:
            return TaskRunnerResult(
                facts=facts,
                completed_task_ids=sorted(completed),
                skipped_task_ids=sorted(skipped),
            )

        for task in tasks:
            tid = str(task.get("id") or "")
            if not tid or tid in completed or tid in skipped:
                continue
            if not _deps_satisfied(task, completed, skipped):
                continue

            when = str(task.get("when") or "always")
            if not _eval_when(when, facts):
                skipped.add(tid)
                progress = True
                _bump_progress()
                continue

            ttype = str(task.get("type") or "")
            py = str(facts.get("python_executable") or "python3")
            try:
                if ttype == "probe":
                    _probe_into_facts(py, facts)
                    completed.add(tid)
                    progress = True
                    _bump_progress()
                elif ttype == "ensure_package":
                    pin_ref = str(task.get("pin") or task.get("pin_ref") or "")
                    if task.get("pin") and not str(task.get("pin")).startswith("matrix:"):
                        # literal pin field
                        specs = [str(task["pin"])]
                        urls: List[str] = []
                        err = (
                            None
                            if "==" in specs[0] or "@" in specs[0]
                            else f"forbid_unpinned:{specs[0]}"
                        )
                    else:
                        specs, urls, err = resolve_pin_ref(pin_ref)
                    if err:
                        raise NeedsReplan(
                            failed_task_id=tid,
                            error=err,
                            facts=facts,
                            completed_task_ids=sorted(completed),
                        )
                    constraints = (
                        current.get("constraints")
                        if isinstance(current.get("constraints"), dict)
                        else {}
                    )
                    if not constraints.get("allow_install", True):
                        raise NeedsReplan(
                            failed_task_id=tid,
                            error="constraint:allow_install=false",
                            facts=facts,
                            completed_task_ids=sorted(completed),
                        )
                    log_path = None
                    if log_dir is not None:
                        log_path = Path(log_dir) / "ensure_runtime.log"
                    ok, err_text = _run_pip_install(
                        py,
                        specs,
                        extra_index_urls=urls,
                        mirror_profile=str(current.get("mirror_profile") or "default"),
                        timeout=timeout,
                        log_path=log_path,
                        on_progress=_bump_progress,
                    )
                    if not ok:
                        raise NeedsReplan(
                            failed_task_id=tid,
                            error=err_text or "pip failed",
                            facts=facts,
                            completed_task_ids=sorted(completed),
                            stderr_tail=err_text[-2000:],
                        )
                    _probe_into_facts(py, facts)
                    completed.add(tid)
                    progress = True
                    _bump_progress()
                elif ttype == "ensure_package_set":
                    pin_ref = str(task.get("pin_ref") or "")
                    specs, urls, err = resolve_pin_ref(pin_ref)
                    if err:
                        raise NeedsReplan(
                            failed_task_id=tid,
                            error=err,
                            facts=facts,
                            completed_task_ids=sorted(completed),
                        )
                    log_path = None
                    if log_dir is not None:
                        log_path = Path(log_dir) / "ensure_runtime.log"
                    ok, err_text = _run_pip_install(
                        py,
                        specs,
                        extra_index_urls=urls,
                        mirror_profile=str(current.get("mirror_profile") or "default"),
                        timeout=timeout,
                        log_path=log_path,
                        on_progress=_bump_progress,
                    )
                    if not ok:
                        raise NeedsReplan(
                            failed_task_id=tid,
                            error=err_text or "pip failed",
                            facts=facts,
                            completed_task_ids=sorted(completed),
                            stderr_tail=err_text[-2000:],
                        )
                    facts["extras_missing"] = False
                    completed.add(tid)
                    progress = True
                    _bump_progress()
                elif ttype == "verify":
                    imports = [str(x) for x in (task.get("imports") or [])]
                    ok, err_text = _verify_imports(py, imports)
                    if not ok:
                        raise NeedsReplan(
                            failed_task_id=tid,
                            error=f"import_failed:{err_text}",
                            facts=facts,
                            completed_task_ids=sorted(completed),
                            stderr_tail=err_text,
                        )
                    completed.add(tid)
                    progress = True
                    _bump_progress()
                else:
                    raise NeedsReplan(
                        failed_task_id=tid,
                        error=f"unknown_task_type:{ttype}",
                        facts=facts,
                        completed_task_ids=sorted(completed),
                    )
            except NeedsReplan as needs:
                needs.facts["replan_generation"] = current.get("replan_generation")
                if replan_callback is None:
                    raise
                if replan_count >= max_replan_attempts:
                    needs.error = f"replan_exhausted:{needs.error}"
                    raise needs
                replan_count += 1
                sid = str(current.get("scheme_id") or "")
                if sid and sid not in attempted_scheme_ids:
                    attempted_scheme_ids.append(sid)
                new_scheme = replan_callback(needs)
                if not isinstance(new_scheme, dict) or not new_scheme.get("tasks"):
                    needs.error = f"replan_exhausted:empty scheme ({needs.error})"
                    raise needs
                current = dict(new_scheme)
                # Keep facts; clear incomplete ensure/verify completions so they can re-run
                # but keep successful probe/ensure completions that are still valid.
                # Drop only the failed task and later tasks from completed.
                failed = needs.failed_task_id
                if failed in completed:
                    completed.discard(failed)
                # Allow re-evaluation of when conditions
                skipped = {x for x in skipped if x != failed}
                progress = True
                _bump_progress()
                break

        if not progress:
            # Deadlock: deps never satisfied
            raise NeedsReplan(
                failed_task_id="",
                error="replan_exhausted:no_progress",
                facts=facts,
                completed_task_ids=sorted(completed),
            )
