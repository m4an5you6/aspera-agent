"""Apply master-selected job nudges on a worker node."""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable, Dict, Optional

_log = logging.getLogger(__name__)

# Per-job pending queue for route_mode=queue when agent is busy / idle.
_JOB_QUEUES: Dict[str, list] = {}
_JOB_QUEUES_LOCK = threading.Lock()
_BUSY_JOBS: set[str] = set()
_BUSY_LOCK = threading.Lock()


def _nudge_text(payload: Dict[str, Any], nudge_type: str) -> str:
    text = str(payload.get("text") or payload.get("summary") or payload.get("message") or "").strip()
    if text:
        return text
    return f"[cluster:nudge] type={nudge_type} {payload}".strip()


def _mark_busy(job_id: str, busy: bool) -> None:
    with _BUSY_LOCK:
        if busy:
            _BUSY_JOBS.add(job_id)
        else:
            _BUSY_JOBS.discard(job_id)


def _is_busy(job_id: str) -> bool:
    with _BUSY_LOCK:
        return job_id in _BUSY_JOBS


def _enqueue_queue_text(job_id: str, text: str) -> None:
    with _JOB_QUEUES_LOCK:
        _JOB_QUEUES.setdefault(job_id, []).append(text)


def _pop_queue_text(job_id: str) -> Optional[str]:
    with _JOB_QUEUES_LOCK:
        q = _JOB_QUEUES.get(job_id) or []
        if not q:
            return None
        return q.pop(0)


def _ensure_agent(job_id: str) -> Any:
    """Return a remembered agent, or build a minimal steerable stub and remember it."""
    from plugins.inference_adapters.agent_driver import (
        get_inference_agent,
        remember_inference_agent,
    )

    agent = get_inference_agent(job_id)
    if agent is not None:
        return agent

    class _NudgeAgent:
        """Minimal agent that accepts steer/interrupt and can run chat follow-ups."""

        def __init__(self) -> None:
            self._pending: list[str] = []
            self._lock = threading.Lock()

        def steer(self, text: str) -> bool:
            t = str(text or "").strip()
            if not t:
                return False
            with self._lock:
                self._pending.append(t)
            return True

        def interrupt(self, reason: str = "") -> None:
            with self._lock:
                self._pending.clear()

        def drain_pending(self) -> list[str]:
            with self._lock:
                out = list(self._pending)
                self._pending.clear()
                return out

        def chat(self, message: str) -> str:
            # Best-effort follow-up; real AIAgent may replace this stub after relaunch.
            return f"nudge_ack:{message[:200]}"

        def run_conversation(self, user_message: str, **kwargs: Any) -> dict:
            return {
                "final_response": self.chat(user_message),
                "messages": [],
            }

    agent = _NudgeAgent()
    remember_inference_agent(job_id, agent)
    _log.info("relaunch stub inference agent for nudge job_id=%s", job_id)
    return agent


def _start_followup(job_id: str, agent: Any, text: str) -> None:
    """Run a one-shot follow-up turn in a daemon thread when agent is idle."""

    def _run() -> None:
        _mark_busy(job_id, True)
        try:
            if hasattr(agent, "run_conversation"):
                agent.run_conversation(user_message=text)
            elif hasattr(agent, "chat"):
                agent.chat(text)
            # Drain any queued items
            while True:
                nxt = _pop_queue_text(job_id)
                if not nxt:
                    break
                if hasattr(agent, "run_conversation"):
                    agent.run_conversation(user_message=nxt)
                elif hasattr(agent, "chat"):
                    agent.chat(nxt)
        except Exception:
            _log.exception("nudge follow-up failed job_id=%s", job_id)
        finally:
            _mark_busy(job_id, False)

    threading.Thread(target=_run, daemon=True, name=f"nudge-followup-{job_id}").start()


def dispatch_nudge(
    nudge: Dict[str, Any],
    *,
    node_id: str,
    ack_fn: Callable[..., Dict[str, Any]],
) -> Dict[str, Any]:
    """Apply one nudge dict from heartbeat; ack via ack_fn(job_id, nudge_id, ...)."""
    job_id = str(nudge.get("job_id") or "")
    nudge_id = str(nudge.get("nudge_id") or "")
    route_mode = str(nudge.get("route_mode") or "guide").strip().lower()
    nudge_type = str(nudge.get("type") or "steer_text")
    payload = nudge.get("payload") if isinstance(nudge.get("payload"), dict) else {}
    text = _nudge_text(payload, nudge_type)

    detail: Dict[str, Any] = {"route_mode": route_mode, "type": nudge_type}

    try:
        if route_mode == "record":
            detail["action"] = "recorded"
            return ack_fn(job_id, nudge_id, node_id=node_id, success=True, detail=detail)

        if route_mode == "execute_direct":
            # Deterministic hooks by type; default is no-op success.
            detail["action"] = "execute_direct"
            detail["handled"] = False
            if nudge_type == "cleanup_non_serve":
                detail["handled"] = True
                detail["note"] = "cleanup_non_serve placeholder (deterministic cleanup deferred)"
            return ack_fn(job_id, nudge_id, node_id=node_id, success=True, detail=detail)

        if route_mode == "interrupt":
            from plugins.inference_adapters.agent_driver import (
                get_inference_agent,
                interrupt_inference_agent,
            )

            if get_inference_agent(job_id) is None:
                detail["action"] = "already_idle"
                return ack_fn(job_id, nudge_id, node_id=node_id, success=True, detail=detail)
            ok = interrupt_inference_agent(job_id, text or "nudge interrupt")
            detail["action"] = "interrupt"
            detail["interrupted"] = ok
            return ack_fn(job_id, nudge_id, node_id=node_id, success=True, detail=detail)

        # guide / queue need a live agent
        needs_agent = route_mode in ("guide", "queue")
        agent = None
        if needs_agent:
            agent = _ensure_agent(job_id)

        if route_mode == "guide":
            from plugins.inference_adapters.agent_driver import steer_inference_agent

            if _is_busy(job_id):
                ok = steer_inference_agent(job_id, text)
                detail["action"] = "steer"
                detail["steered"] = ok
            else:
                _start_followup(job_id, agent, text)
                detail["action"] = "followup_turn"
            return ack_fn(job_id, nudge_id, node_id=node_id, success=True, detail=detail)

        if route_mode == "queue":
            from plugins.inference_adapters.agent_driver import steer_inference_agent

            _enqueue_queue_text(job_id, text)
            if _is_busy(job_id):
                # Also park on steer buffer if supported
                steer_inference_agent(job_id, text)
                detail["action"] = "queued_busy"
            else:
                nxt = _pop_queue_text(job_id) or text
                _start_followup(job_id, agent, nxt)
                detail["action"] = "queued_started"
            return ack_fn(job_id, nudge_id, node_id=node_id, success=True, detail=detail)

        detail["action"] = "unknown_mode"
        return ack_fn(
            job_id,
            nudge_id,
            node_id=node_id,
            success=False,
            detail=detail,
        )
    except Exception as exc:
        _log.exception("dispatch_nudge failed nudge_id=%s", nudge_id)
        return ack_fn(
            job_id,
            nudge_id,
            node_id=node_id,
            success=False,
            detail={"error": str(exc), "route_mode": route_mode},
        )
