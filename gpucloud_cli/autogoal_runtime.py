"""Headless AutoGoal runtime shared by /autogoal policy and cluster inference.

Session slash control stays in ``gpucloud_cli.autogoals.AutoGoalManager``.
This module owns the non-interactive operating contract, profiles, completion
policies, and a single-conversation run loop (stop + inactivity).
"""

from __future__ import annotations

import logging
import os
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional, Protocol, Tuple

_log = logging.getLogger(__name__)

AgentHook = Callable[[str, Any], None]
InterruptHook = Callable[[str, str], bool]
StopFlag = Callable[[], bool]
AgentFactory = Callable[..., Any]

# Shared non-interactive rules (used by /autogoal kickoff and headless hosts).
AUTO_GOAL_OPERATING_CONTRACT = """\
- Do not ask the user questions. Do not call clarify. Do not wait for user
  confirmation. Consume only the initial objective and continue autonomously.
- If information is missing, inspect the host/repo/config, probe available
  infrastructure, or choose conservative defaults and record your rationale.
- Before starting training, inference, deployment, or any high-risk remote
  action, write an internal `decision_record` in your response covering:
  inputs, assumptions, risks, rollback/stop plan, and why proceeding is safe.
- If you cannot safely proceed after self-audit, enter a blocked state by
  explicitly writing `AUTO_GOAL_BLOCKED:` followed by the reason and next safe
  action. Do not ask the user to decide.
- Prefer dry-run, preflight, health checks, reversible steps, and clear logs.\
"""

AUTO_GOAL_KICKOFF_TEMPLATE = """[AutoGoal: non-interactive autonomous ML/service loop]
Objective:
{goal}

Operating contract:
- You are running under /autogoal, not /goal. This is an autonomous training,
  inference, or deployment service loop for multi-GPU, multi-node, and multi-IP
  scenarios.
{operating_contract}

Optional gpucloud.yaml context:
{config_context}

Start by discovering the current repo, runtime, cluster/GPU/SSH state, conda
or venv environments, data/checkpoint/scratch paths, and any existing training
or deployment configuration. Then make the next concrete autonomous step.
"""

AUTO_GOAL_CONTINUATION_TEMPLATE = """[Continuing AutoGoal]
Objective:
{goal}

Last audit/judge reason:
{reason}

Segment context:
{segment_context}

Continue autonomously toward the objective. Do not ask the user questions, do
not call clarify, and do not wait for confirmation. Inspect, infer, choose a
conservative default, run self-audit, proceed if safe, or explicitly block with
`AUTO_GOAL_BLOCKED:` if no safe path remains.
"""

AUTO_GOAL_JUDGE_GOAL_TEMPLATE = """Autonomous /autogoal objective:
{goal}

Completion criteria:
- The training, inference, or deployment objective is complete; OR
- The agent explicitly entered AUTO_GOAL_BLOCKED with a concrete safety reason.

The agent must not ask the user questions or wait for confirmation."""


@dataclass(frozen=True)
class AutoGoalProfile:
    """Toolset / session shape for a headless AutoGoal run."""

    name: str
    enabled_toolsets: Tuple[str, ...]
    disabled_toolsets: Tuple[str, ...]
    platform: str
    skip_memory: bool = True
    skip_context_files: bool = True
    quiet_mode: bool = True
    verbose_logging: bool = False
    default_max_iterations: int = 90
    default_inactivity_seconds: float = 1800.0


PROFILE_CLUSTER_INFERENCE = AutoGoalProfile(
    name="cluster_inference",
    enabled_toolsets=("terminal", "file", "skills", "web", "inference_adapters"),
    disabled_toolsets=("clarify", "messaging", "cronjob", "delegation"),
    platform="inference_worker",
    # Job JSON + skill cover the deploy contract; still load cwd AGENTS.md /
    # .cursorrules / SOUL when present (node-local paths, mirrors, scratch).
    # Keep memory off — do not pull interactive chat USER.md / providers.
    # verbose_logging so agent.log records terminal command + full tool results.
    skip_memory=True,
    skip_context_files=False,
    quiet_mode=True,
    verbose_logging=True,
    default_max_iterations=90,
    default_inactivity_seconds=1800.0,
)

PROFILE_SESSION = AutoGoalProfile(
    name="session",
    enabled_toolsets=(),
    disabled_toolsets=("clarify",),
    platform="cli",
    skip_memory=False,
    skip_context_files=False,
    quiet_mode=False,
    verbose_logging=False,
    default_max_iterations=90,
    default_inactivity_seconds=0.0,
)


@dataclass
class AutoGoalRunResult:
    success: bool
    summary: str
    details: Dict[str, Any] = field(default_factory=dict)
    status: str = "failed"  # done|failed|cancelled|blocked|timeout
    error: Optional[str] = None
    conversation_result: Optional[Dict[str, Any]] = None

    def as_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "success": self.success,
            "summary": self.summary,
            "details": dict(self.details),
            "status": self.status,
        }
        if self.error is not None:
            out["error"] = self.error
        return out


class CompletionPolicy(Protocol):
    def finalize(
        self,
        *,
        conversation_result: Dict[str, Any],
        inactivity_hit: bool,
        inactivity_seconds: float,
        defaults: Dict[str, Any],
    ) -> AutoGoalRunResult:
        ...


@dataclass
class ContractCompletion:
    """Prefer an explicit reported payload; else parse final response JSON."""

    pop_reported: Callable[[], Optional[Dict[str, Any]]]
    parse_contract: Callable[
        [Optional[Dict[str, Any]]], Tuple[bool, str, Dict[str, Any]]
    ]
    extract_json: Callable[[str], Optional[Dict[str, Any]]]

    def finalize(
        self,
        *,
        conversation_result: Dict[str, Any],
        inactivity_hit: bool,
        inactivity_seconds: float,
        defaults: Dict[str, Any],
    ) -> AutoGoalRunResult:
        reported = self.pop_reported()
        if reported is None:
            final_text = ""
            if isinstance(conversation_result, dict):
                final_text = str(conversation_result.get("final_response") or "")
                if not final_text and conversation_result.get("error"):
                    final_text = str(conversation_result.get("error"))
            reported = self.extract_json(final_text)

        if inactivity_hit and not (isinstance(reported, dict) and reported.get("success")):
            summary = f"inference agent inactivity timeout after {int(inactivity_seconds)}s"
            details = {"phase": "agent_error", **defaults}
            return AutoGoalRunResult(
                success=False,
                summary=summary,
                details=details,
                status="timeout",
                error=summary,
                conversation_result=conversation_result,
            )

        success, summary, details = self.parse_contract(reported)
        status = "done" if success else "failed"
        if isinstance(details, dict) and str(details.get("phase") or "") == "cancelled":
            status = "cancelled"
        return AutoGoalRunResult(
            success=success,
            summary=summary,
            details=details,
            status=status,
            error=None if success else summary,
            conversation_result=conversation_result,
        )


@dataclass
class JudgeCompletion:
    """Judge-based completion (for future headless multi-turn hosts)."""

    judge_goal_text: str
    looks_blocked: Callable[[str], bool]
    judge_fn: Callable[[str, str], Tuple[str, str, bool]]

    def finalize(
        self,
        *,
        conversation_result: Dict[str, Any],
        inactivity_hit: bool,
        inactivity_seconds: float,
        defaults: Dict[str, Any],
    ) -> AutoGoalRunResult:
        final_text = ""
        if isinstance(conversation_result, dict):
            final_text = str(conversation_result.get("final_response") or "")
        if inactivity_hit:
            summary = f"autogoal inactivity timeout after {int(inactivity_seconds)}s"
            return AutoGoalRunResult(
                success=False,
                summary=summary,
                details={**defaults, "phase": "agent_error"},
                status="timeout",
                error=summary,
                conversation_result=conversation_result,
            )
        if self.looks_blocked(final_text):
            summary = "agent entered AUTO_GOAL_BLOCKED"
            return AutoGoalRunResult(
                success=False,
                summary=summary,
                details={**defaults, "phase": "blocked"},
                status="blocked",
                error=summary,
                conversation_result=conversation_result,
            )
        verdict, reason, _parse_failed = self.judge_fn(self.judge_goal_text, final_text)
        if verdict == "done":
            return AutoGoalRunResult(
                success=True,
                summary=reason or "autogoal done",
                details={**defaults, "phase": "ready", "verdict": verdict},
                status="done",
                conversation_result=conversation_result,
            )
        return AutoGoalRunResult(
            success=False,
            summary=reason or "autogoal incomplete",
            details={**defaults, "phase": "agent_error", "verdict": verdict},
            status="failed",
            error=reason or "autogoal incomplete",
            conversation_result=conversation_result,
        )


def format_kickoff_prompt(goal: str, config_context: str = "(none)") -> str:
    return AUTO_GOAL_KICKOFF_TEMPLATE.format(
        goal=goal,
        operating_contract=AUTO_GOAL_OPERATING_CONTRACT,
        config_context=config_context or "(none)",
    )


def wrap_objective_with_operating_contract(objective: str, *, host_label: str = "autogoal") -> str:
    """Prefix a host-specific objective with the shared non-interactive contract."""
    return (
        f"[AutoGoal host: {host_label}]\n"
        f"Operating contract:\n{AUTO_GOAL_OPERATING_CONTRACT}\n\n"
        f"{objective}"
    )


def _resolve_model_name(runtime: Dict[str, Any], agent_model_hint: str = "") -> str:
    model = str(runtime.get("model") or agent_model_hint or "").strip()
    if model:
        return model
    try:
        from gpucloud_cli.config import load_config

        return str((load_config().get("model") or {}).get("default") or "")
    except Exception:
        return ""


def resolve_headless_runtime_provider() -> Dict[str, Any]:
    """Resolve LLM credentials for headless hosts (config.yaml model.* preferred)."""
    from gpucloud_cli.runtime_provider import (
        format_runtime_provider_error,
        resolve_runtime_provider,
    )

    explicit_api_key = ""
    explicit_base_url = ""
    try:
        from gpucloud_cli.config import load_config

        model_cfg = load_config().get("model") or {}
        if isinstance(model_cfg, dict):
            explicit_api_key = str(model_cfg.get("api_key") or "").strip()
            explicit_base_url = str(model_cfg.get("base_url") or "").strip()
    except Exception:
        pass

    try:
        runtime = resolve_runtime_provider(
            explicit_api_key=explicit_api_key or None,
            explicit_base_url=explicit_base_url or None,
        )
    except Exception as exc:
        raise RuntimeError(format_runtime_provider_error(exc)) from exc

    if not str(runtime.get("api_key") or "").strip():
        raise RuntimeError(
            "No LLM API key resolved for autogoal runtime "
            f"(provider={runtime.get('provider')!r}). "
            "Set model.api_key in config.yaml or the provider env var "
            "(e.g. XIAOMI_API_KEY)."
        )
    return runtime


class AutoGoalRuntime:
    """Run one non-interactive agent conversation under an AutoGoal profile."""

    def run(
        self,
        *,
        objective: str,
        profile: AutoGoalProfile,
        session_id: str,
        completion: CompletionPolicy,
        stop_flag: Optional[StopFlag] = None,
        inactivity_seconds: Optional[float] = None,
        max_iterations: Optional[int] = None,
        agent_factory: Optional[AgentFactory] = None,
        remember_agent: Optional[AgentHook] = None,
        forget_agent: Optional[Callable[[str], None]] = None,
        interrupt_agent: Optional[InterruptHook] = None,
        defaults: Optional[Dict[str, Any]] = None,
        agent_model_hint: str = "",
        task_id: Optional[str] = None,
        runtime_provider: Optional[Dict[str, Any]] = None,
    ) -> AutoGoalRunResult:
        defaults = dict(defaults or {})
        inactivity_s = (
            float(inactivity_seconds)
            if inactivity_seconds is not None
            else float(profile.default_inactivity_seconds)
        )
        try:
            iters = int(max_iterations) if max_iterations is not None else int(profile.default_max_iterations)
        except (TypeError, ValueError):
            iters = int(profile.default_max_iterations)

        prev_yolo = os.environ.get("GPUCLOUD_YOLO_MODE")
        os.environ["GPUCLOUD_YOLO_MODE"] = "1"
        os.environ.setdefault("GPUCLOUD_CRON_SESSION", "1")

        agent = None
        try:
            if stop_flag and stop_flag():
                summary = "cancelled before agent start"
                details = {"phase": "cancelled", **defaults}
                return AutoGoalRunResult(
                    success=False,
                    summary=summary,
                    details=details,
                    status="cancelled",
                    error=summary,
                )

            runtime = runtime_provider if runtime_provider is not None else resolve_headless_runtime_provider()
            model = _resolve_model_name(runtime, agent_model_hint)
            enabled = list(profile.enabled_toolsets)
            disabled = list(profile.disabled_toolsets)

            factory_kwargs = dict(
                model=model or runtime.get("model"),
                api_key=runtime.get("api_key"),
                base_url=runtime.get("base_url"),
                provider=runtime.get("provider"),
                api_mode=runtime.get("api_mode"),
                max_iterations=iters,
                enabled_toolsets=enabled,
                disabled_toolsets=disabled,
                quiet_mode=profile.quiet_mode,
                verbose_logging=bool(profile.verbose_logging),
                skip_context_files=profile.skip_context_files,
                skip_memory=profile.skip_memory,
                platform=profile.platform,
                session_id=session_id,
            )

            if agent_factory is not None:
                agent = agent_factory(**factory_kwargs)
            else:
                from run_agent import AIAgent

                agent = AIAgent(**factory_kwargs)

            if remember_agent is not None:
                remember_agent(session_id, agent)

            prompt = objective
            conv_task_id = task_id or session_id

            def _run_conv() -> Dict[str, Any]:
                return agent.run_conversation(user_message=prompt, task_id=conv_task_id)

            result: Dict[str, Any] = {}
            inactivity_hit = False
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(_run_conv)
                while True:
                    if stop_flag and stop_flag():
                        if interrupt_agent is not None:
                            interrupt_agent(session_id, "cancelled by stop flag")
                        try:
                            result = future.result(timeout=30)
                        except Exception:
                            result = {"final_response": "", "error": "cancelled"}
                        summary = "cancelled during agent run"
                        details = {"phase": "cancelled", **defaults}
                        return AutoGoalRunResult(
                            success=False,
                            summary=summary,
                            details=details,
                            status="cancelled",
                            error=summary,
                            conversation_result=result,
                        )
                    try:
                        result = future.result(timeout=2.0)
                        break
                    except FuturesTimeout:
                        if inactivity_s <= 0:
                            continue
                        idle = 0.0
                        if hasattr(agent, "get_activity_summary"):
                            try:
                                act = agent.get_activity_summary() or {}
                                idle = float(act.get("seconds_since_activity") or 0.0)
                            except Exception:
                                idle = 0.0
                        if idle >= inactivity_s:
                            inactivity_hit = True
                            if interrupt_agent is not None:
                                interrupt_agent(session_id, "autogoal inactivity timeout")
                            try:
                                result = future.result(timeout=30)
                            except Exception as exc:
                                result = {"final_response": "", "error": str(exc)}
                            break
                        continue

            return completion.finalize(
                conversation_result=result if isinstance(result, dict) else {},
                inactivity_hit=inactivity_hit,
                inactivity_seconds=inactivity_s,
                defaults=defaults,
            )
        except Exception as exc:
            _log.exception("autogoal runtime failed for %s", session_id)
            summary = str(exc)
            return AutoGoalRunResult(
                success=False,
                summary=summary,
                details={"phase": "agent_error", **defaults},
                status="failed",
                error=summary,
            )
        finally:
            if forget_agent is not None:
                forget_agent(session_id)
            if prev_yolo is None:
                os.environ.pop("GPUCLOUD_YOLO_MODE", None)
            else:
                os.environ["GPUCLOUD_YOLO_MODE"] = prev_yolo
