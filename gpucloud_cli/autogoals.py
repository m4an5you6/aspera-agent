"""Non-interactive AutoGoal loop for training, inference, and deployment.

``/autogoal`` is intentionally separate from the plain ``/goal`` Ralph loop.
It owns long-running ML/service automation where the agent should continue
autonomously after the first user sentence. Missing information is handled by
inspection, conservative defaults, internal self-audit, or a blocked state,
never by asking the user follow-up questions.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from gpucloud_cli.autogoal_runtime import (
    AUTO_GOAL_CONTINUATION_TEMPLATE,
    AUTO_GOAL_JUDGE_GOAL_TEMPLATE,
    AUTO_GOAL_KICKOFF_TEMPLATE,
    AUTO_GOAL_OPERATING_CONTRACT,
    format_kickoff_prompt,
)
from gpucloud_cli.goals import DEFAULT_MAX_TURNS, judge_goal

logger = logging.getLogger(__name__)

DEFAULT_AUTOGOAL_SEGMENT_MAX_TURNS = 100
DEFAULT_AUTOGOAL_MAX_SEGMENTS = 20
DEFAULT_AUTOGOAL_MAX_TURNS = DEFAULT_AUTOGOAL_SEGMENT_MAX_TURNS * DEFAULT_AUTOGOAL_MAX_SEGMENTS


@dataclass
class AutoGoalState:
    """Serializable AutoGoal state stored independently from /goal."""

    goal: str
    status: str = "active"  # active | paused | done | cleared | blocked
    turns_used: int = 0
    max_turns: int = DEFAULT_AUTOGOAL_MAX_TURNS
    segment_index: int = 1
    segment_turns_used: int = 0
    segment_max_turns: int = DEFAULT_AUTOGOAL_SEGMENT_MAX_TURNS
    max_segments: int = DEFAULT_AUTOGOAL_MAX_SEGMENTS
    segment_summaries: List[Dict[str, Any]] = field(default_factory=list)
    created_at: float = 0.0
    last_turn_at: float = 0.0
    last_verdict: Optional[str] = None
    last_reason: Optional[str] = None
    paused_reason: Optional[str] = None
    config_path: str = ""
    config_warnings: List[str] = field(default_factory=list)
    decision_records: List[Dict[str, Any]] = field(default_factory=list)

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)

    @classmethod
    def from_json(cls, raw: str) -> "AutoGoalState":
        data = json.loads(raw)
        return cls(
            goal=str(data.get("goal") or ""),
            status=str(data.get("status") or "active"),
            turns_used=int(data.get("turns_used", 0) or 0),
            max_turns=int(data.get("max_turns", DEFAULT_AUTOGOAL_MAX_TURNS) or DEFAULT_AUTOGOAL_MAX_TURNS),
            segment_index=int(data.get("segment_index", 1) or 1),
            segment_turns_used=int(data.get("segment_turns_used", 0) or 0),
            segment_max_turns=int(
                data.get("segment_max_turns", data.get("max_turns", DEFAULT_AUTOGOAL_SEGMENT_MAX_TURNS))
                or DEFAULT_AUTOGOAL_SEGMENT_MAX_TURNS
            ),
            max_segments=int(data.get("max_segments", 1) or 1),
            segment_summaries=[
                item for item in (data.get("segment_summaries") or []) if isinstance(item, dict)
            ],
            created_at=float(data.get("created_at", 0.0) or 0.0),
            last_turn_at=float(data.get("last_turn_at", 0.0) or 0.0),
            last_verdict=data.get("last_verdict"),
            last_reason=data.get("last_reason"),
            paused_reason=data.get("paused_reason"),
            config_path=str(data.get("config_path") or ""),
            config_warnings=[
                str(item) for item in (data.get("config_warnings") or []) if str(item).strip()
            ],
            decision_records=[
                item for item in (data.get("decision_records") or []) if isinstance(item, dict)
            ],
        )


def _meta_key(session_id: str) -> str:
    return f"autogoal:{session_id}"


def _get_session_db() -> Optional[Any]:
    try:
        from gpucloud_cli import goals

        return goals._get_session_db()  # Reuse the profile-aware DB cache.
    except Exception as exc:  # pragma: no cover
        logger.debug("AutoGoalManager: SessionDB bootstrap failed (%s)", exc)
        return None


def load_autogoal(session_id: str) -> Optional[AutoGoalState]:
    if not session_id:
        return None
    db = _get_session_db()
    if db is None:
        return None
    try:
        raw = db.get_meta(_meta_key(session_id))
    except Exception as exc:
        logger.debug("AutoGoalManager: get_meta failed: %s", exc)
        return None
    if not raw:
        return None
    try:
        return AutoGoalState.from_json(raw)
    except Exception as exc:
        logger.warning("AutoGoalManager: could not parse stored autogoal for %s: %s", session_id, exc)
        return None


def save_autogoal(session_id: str, state: AutoGoalState) -> None:
    if not session_id:
        return
    db = _get_session_db()
    if db is None:
        return
    try:
        db.set_meta(_meta_key(session_id), state.to_json())
    except Exception as exc:
        logger.debug("AutoGoalManager: set_meta failed: %s", exc)


def _discover_gpucloud_yaml() -> Optional[Path]:
    explicit = os.environ.get("GPUCLOUD_CONFIG", "").strip()
    if explicit:
        path = Path(explicit).expanduser()
        return path if path.is_file() else None
    for path in (Path.cwd() / "gpucloud.yaml", Path.cwd() / ".gpucloud" / "config.yaml"):
        if path.is_file():
            return path
    return None


def _load_optional_gpucloud_context() -> tuple[str, str, List[str]]:
    """Return ``(path, context, warnings)`` for optional gpucloud.yaml."""
    path = _discover_gpucloud_yaml()
    if path is None:
        return "", "No gpucloud.yaml found. Continue with automatic discovery and conservative defaults.", [
            "gpucloud.yaml not found; autogoal will auto-discover configuration"
        ]

    warnings: List[str] = []
    try:
        import yaml
    except Exception:
        return str(path), f"Found {path}, but PyYAML is unavailable; treat it as unreadable.", [
            "PyYAML unavailable; gpucloud.yaml could not be parsed"
        ]

    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception as exc:
        return str(path), f"Found {path}, but parsing failed: {type(exc).__name__}: {exc}", [
            f"gpucloud.yaml parse failed: {type(exc).__name__}"
        ]

    if not isinstance(data, dict):
        return str(path), f"Found {path}, but the root is not a mapping.", [
            "gpucloud.yaml root is not a mapping"
        ]

    missing: List[str] = []
    clusters = data.get("clusters")
    if not isinstance(clusters, list) or not clusters:
        missing.append("clusters")
    for field_name in ("dataset_name", "model_name"):
        value = data.get(field_name)
        if value is None or (isinstance(value, str) and not value.strip()):
            missing.append(field_name)
    if missing:
        warnings.append(f"gpucloud.yaml missing recommended fields: {', '.join(missing)}")

    summary = {
        "clusters": len(clusters) if isinstance(clusters, list) else 0,
        "dataset_name": data.get("dataset_name") or "",
        "model_name": data.get("model_name") or "",
        "has_training": isinstance(data.get("training"), dict),
        "has_inference": isinstance(data.get("inference"), dict),
        "warnings": warnings,
    }
    return str(path), json.dumps(summary, ensure_ascii=False, indent=2), warnings


def _looks_blocked(text: str) -> bool:
    lowered = (text or "").lower()
    return "auto_goal_blocked:" in lowered or "autogoal_blocked:" in lowered


def resolve_autogoal_budget(config: Optional[Dict[str, Any]] = None) -> Tuple[int, int, int]:
    """Resolve ``(total_turns, segment_turns, max_segments)`` from config.

    Back-compat: an existing config that only sets ``autogoals.max_turns`` keeps
    the old single-budget behavior. Segment mode turns on when either
    ``segment_max_turns`` or ``max_segments`` is present.
    """
    if config is None:
        try:
            from gpucloud_cli.config import load_config

            config = load_config() or {}
        except Exception:
            config = {}

    autogoals_cfg = (config or {}).get("autogoals") or {}
    if not isinstance(autogoals_cfg, dict):
        autogoals_cfg = {}

    has_segment_cfg = (
        "segment_max_turns" in autogoals_cfg
        or "max_segments" in autogoals_cfg
    )
    if has_segment_cfg:
        try:
            segment_turns = int(
                autogoals_cfg.get("segment_max_turns", DEFAULT_AUTOGOAL_SEGMENT_MAX_TURNS)
                or DEFAULT_AUTOGOAL_SEGMENT_MAX_TURNS
            )
        except (TypeError, ValueError):
            segment_turns = DEFAULT_AUTOGOAL_SEGMENT_MAX_TURNS
        try:
            max_segments = int(
                autogoals_cfg.get("max_segments", DEFAULT_AUTOGOAL_MAX_SEGMENTS)
                or DEFAULT_AUTOGOAL_MAX_SEGMENTS
            )
        except (TypeError, ValueError):
            max_segments = DEFAULT_AUTOGOAL_MAX_SEGMENTS
        segment_turns = max(1, segment_turns)
        max_segments = max(1, max_segments)
        try:
            total_turns = int(autogoals_cfg.get("max_turns") or (segment_turns * max_segments))
        except (TypeError, ValueError):
            total_turns = segment_turns * max_segments
        return max(1, total_turns), segment_turns, max_segments

    if "max_turns" in autogoals_cfg:
        try:
            total_turns = int(autogoals_cfg.get("max_turns") or DEFAULT_AUTOGOAL_MAX_TURNS)
        except (TypeError, ValueError):
            total_turns = DEFAULT_AUTOGOAL_MAX_TURNS
        total_turns = max(1, total_turns)
        return total_turns, total_turns, 1

    return (
        DEFAULT_AUTOGOAL_MAX_TURNS,
        DEFAULT_AUTOGOAL_SEGMENT_MAX_TURNS,
        DEFAULT_AUTOGOAL_MAX_SEGMENTS,
    )


def _summarize_segment(
    *,
    segment_index: int,
    turns_used: int,
    reason: str,
    last_response: str,
) -> Dict[str, Any]:
    text = (last_response or "").strip()
    if len(text) > 1800:
        text = text[-1800:]
    return {
        "segment": segment_index,
        "turns_used": turns_used,
        "reason": reason or "continue",
        "summary": text or "(no response text captured)",
        "created_at": time.time(),
    }


class AutoGoalManager:
    """Per-session non-interactive autogoal state and continuation logic."""

    def __init__(
        self,
        session_id: str,
        *,
        default_max_turns: Optional[int] = None,
        default_segment_max_turns: Optional[int] = None,
        default_max_segments: Optional[int] = None,
    ):
        self.session_id = session_id
        if default_segment_max_turns is None and default_max_segments is None:
            if default_max_turns is None:
                self.default_segment_max_turns = DEFAULT_AUTOGOAL_SEGMENT_MAX_TURNS
                self.default_max_segments = DEFAULT_AUTOGOAL_MAX_SEGMENTS
                self.default_max_turns = DEFAULT_AUTOGOAL_MAX_TURNS
            else:
                self.default_max_turns = int(default_max_turns or DEFAULT_AUTOGOAL_MAX_TURNS)
                self.default_segment_max_turns = self.default_max_turns
                self.default_max_segments = 1
        else:
            self.default_segment_max_turns = int(
                default_segment_max_turns or DEFAULT_AUTOGOAL_SEGMENT_MAX_TURNS
            )
            self.default_max_segments = int(default_max_segments or DEFAULT_AUTOGOAL_MAX_SEGMENTS)
            self.default_max_turns = int(
                default_max_turns or (self.default_segment_max_turns * self.default_max_segments)
            )
        self._state: Optional[AutoGoalState] = load_autogoal(session_id)

    @property
    def state(self) -> Optional[AutoGoalState]:
        return self._state

    def is_active(self) -> bool:
        return self._state is not None and self._state.status == "active"

    def has_autogoal(self) -> bool:
        return self._state is not None and self._state.status in {"active", "paused", "blocked"}

    def status_line(self) -> str:
        s = self._state
        if s is None or s.status == "cleared":
            return "No active autogoal. Set one with /autogoal <objective>."
        turns = (
            f"{s.turns_used}/{s.max_turns} turns, "
            f"segment {s.segment_index}/{s.max_segments} "
            f"({s.segment_turns_used}/{s.segment_max_turns})"
        )
        warn = f", {len(s.config_warnings)} warning(s)" if s.config_warnings else ""
        if s.status == "active":
            return f"⊙ AutoGoal (active, {turns}{warn}): {s.goal}"
        if s.status == "paused":
            extra = f" — {s.paused_reason}" if s.paused_reason else ""
            return f"⏸ AutoGoal (paused, {turns}{warn}{extra}): {s.goal}"
        if s.status == "blocked":
            reason = f" — {s.last_reason}" if s.last_reason else ""
            return f"■ AutoGoal blocked ({turns}{warn}{reason}): {s.goal}"
        if s.status == "done":
            return f"✓ AutoGoal done ({turns}{warn}): {s.goal}"
        return f"AutoGoal ({s.status}, {turns}{warn}): {s.goal}"

    def set(self, goal: str, *, max_turns: Optional[int] = None) -> AutoGoalState:
        goal = (goal or "").strip()
        if not goal:
            raise ValueError("autogoal text is empty")
        config_path, _context, warnings = _load_optional_gpucloud_context()
        state = AutoGoalState(
            goal=goal,
            status="active",
            turns_used=0,
            max_turns=int(max_turns) if max_turns else self.default_max_turns,
            segment_index=1,
            segment_turns_used=0,
            segment_max_turns=self.default_segment_max_turns,
            max_segments=self.default_max_segments,
            segment_summaries=[],
            created_at=time.time(),
            last_turn_at=0.0,
            config_path=config_path,
            config_warnings=warnings,
        )
        self._state = state
        save_autogoal(self.session_id, state)
        return state

    def pause(self, reason: str = "user-paused") -> Optional[AutoGoalState]:
        if not self._state:
            return None
        self._state.status = "paused"
        self._state.paused_reason = reason
        save_autogoal(self.session_id, self._state)
        return self._state

    def resume(self, *, reset_budget: bool = True) -> Optional[AutoGoalState]:
        if not self._state:
            return None
        self._state.status = "active"
        self._state.paused_reason = None
        if reset_budget:
            self._state.turns_used = 0
            self._state.segment_index = 1
            self._state.segment_turns_used = 0
            self._state.segment_summaries = []
        save_autogoal(self.session_id, self._state)
        return self._state

    def clear(self) -> None:
        if self._state is None:
            return
        self._state.status = "cleared"
        save_autogoal(self.session_id, self._state)
        self._state = None

    def kickoff_prompt(self) -> str:
        config_path, config_context, warnings = _load_optional_gpucloud_context()
        if self._state:
            self._state.config_path = config_path
            self._state.config_warnings = warnings
            save_autogoal(self.session_id, self._state)
        return format_kickoff_prompt(
            self._state.goal if self._state else "",
            config_context=config_context,
        )

    def next_continuation_prompt(self, reason: str = "") -> Optional[str]:
        if not self._state or self._state.status != "active":
            return None
        if self._state.segment_summaries:
            recent = self._state.segment_summaries[-3:]
            segment_context = json.dumps(recent, ensure_ascii=False, indent=2)
        else:
            segment_context = "No prior segment summaries."
        return AUTO_GOAL_CONTINUATION_TEMPLATE.format(
            goal=self._state.goal,
            reason=reason or self._state.last_reason or "continue",
            segment_context=segment_context,
        )

    def evaluate_after_turn(self, last_response: str, *, user_initiated: bool = True) -> Dict[str, Any]:
        state = self._state
        if state is None or state.status != "active":
            return {
                "status": state.status if state else None,
                "should_continue": False,
                "continuation_prompt": None,
                "verdict": "inactive",
                "reason": "no active autogoal",
                "message": "",
            }

        state.turns_used += 1
        state.segment_turns_used += 1
        state.last_turn_at = time.time()

        if _looks_blocked(last_response):
            state.status = "blocked"
            state.last_verdict = "blocked"
            state.last_reason = "agent entered AUTO_GOAL_BLOCKED"
            save_autogoal(self.session_id, state)
            return {
                "status": "blocked",
                "should_continue": False,
                "continuation_prompt": None,
                "verdict": "blocked",
                "reason": state.last_reason,
                "message": f"■ AutoGoal blocked: {state.last_reason}",
            }

        judge_goal_text = AUTO_GOAL_JUDGE_GOAL_TEMPLATE.format(goal=state.goal)
        verdict, reason, _parse_failed = judge_goal(judge_goal_text, last_response)
        state.last_verdict = verdict
        state.last_reason = reason

        if verdict == "done":
            state.status = "done"
            save_autogoal(self.session_id, state)
            return {
                "status": "done",
                "should_continue": False,
                "continuation_prompt": None,
                "verdict": "done",
                "reason": reason,
                "message": f"✓ AutoGoal achieved: {reason}",
            }

        if state.segment_turns_used >= state.segment_max_turns:
            summary = _summarize_segment(
                segment_index=state.segment_index,
                turns_used=state.segment_turns_used,
                reason=reason,
                last_response=last_response,
            )
            state.segment_summaries.append(summary)
            state.segment_summaries = state.segment_summaries[-state.max_segments:]

            if state.segment_index >= state.max_segments:
                state.status = "paused"
                state.paused_reason = (
                    f"segment budget exhausted ({state.segment_index}/{state.max_segments} segments, "
                    f"{state.turns_used}/{state.max_turns} turns)"
                )
                save_autogoal(self.session_id, state)
                return {
                    "status": "paused",
                    "should_continue": False,
                    "continuation_prompt": None,
                    "verdict": "continue",
                    "reason": reason,
                    "message": (
                        f"⏸ AutoGoal paused — segment budget exhausted "
                        f"({state.segment_index}/{state.max_segments} segments)."
                    ),
                }

            completed_segment = state.segment_index
            state.segment_index += 1
            state.segment_turns_used = 0
            state.last_reason = f"segment {completed_segment} completed; continue from summary"
            save_autogoal(self.session_id, state)
            return {
                "status": "active",
                "should_continue": True,
                "continuation_prompt": self.next_continuation_prompt(state.last_reason),
                "verdict": "continue",
                "reason": state.last_reason,
                "message": (
                    f"↻ AutoGoal segment {completed_segment}/{state.max_segments} summarized; "
                    f"continuing segment {state.segment_index}/{state.max_segments}."
                ),
            }

        if state.turns_used >= state.max_turns:
            state.status = "paused"
            state.paused_reason = f"turn budget exhausted ({state.turns_used}/{state.max_turns})"
            save_autogoal(self.session_id, state)
            return {
                "status": "paused",
                "should_continue": False,
                "continuation_prompt": None,
                "verdict": "continue",
                "reason": reason,
                "message": (
                    f"⏸ AutoGoal paused — {state.turns_used}/{state.max_turns} turns used. "
                    "Use /autogoal resume to continue, or /autogoal clear to stop."
                ),
            }

        save_autogoal(self.session_id, state)
        return {
            "status": "active",
            "should_continue": True,
            "continuation_prompt": self.next_continuation_prompt(reason),
            "verdict": "continue",
            "reason": reason,
            "message": (
                f"↻ Continuing autogoal "
                f"({state.turns_used}/{state.max_turns}, "
                f"segment {state.segment_index}/{state.max_segments} "
                f"{state.segment_turns_used}/{state.segment_max_turns}): {reason}"
            ),
        }
