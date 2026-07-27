"""Master controller state machine — registration, jobs, assignments, sweeps."""

from __future__ import annotations

import socket
import time
from typing import Any, Dict, List, Optional, Tuple

from plugins.cluster.config import ClusterConfig, compute_config_hash
from plugins.cluster.events import ClusterEventBridge
from plugins.cluster.cluster_logging import ClusterLogger
from plugins.cluster.models import (
    ClusterEvent,
    GpuInfo,
    HeartbeatPayload,
    JobRecord,
    JobSpec,
    NodeRecord,
    RankAssignment,
    ValidationResult,
    new_id,
)
from plugins.cluster.store import ClusterStore
from plugins.cluster.training import (
    parse_master_addr,
    pick_rendezvous_port,
    validate_job_spec,
)
from plugins.cluster.node_capabilities import (
    LogicalJobRequirements,
    probe_ready,
    select_nodes_for_job,
)


class ClusterController:
    """Master-side orchestration logic."""

    def __init__(
        self,
        cfg: ClusterConfig,
        store: ClusterStore,
        logger: ClusterLogger,
        events: ClusterEventBridge,
    ) -> None:
        self.cfg = cfg
        self.store = store
        self.logger = logger
        self.events = events
        self._master_epoch = store.get_master_epoch()

    def startup(self) -> int:
        self.cfg.data_dir.mkdir(parents=True, exist_ok=True)
        self._master_epoch = self.store.bump_master_epoch()
        self.events.emit(
            "master_started",
            {"master_epoch": self._master_epoch, "node_id": self.cfg.node_id},
            route_mode="record",
        )
        return self._master_epoch

    def register_node(
        self,
        *,
        node_id: str,
        advertised_addr: str,
        gpus: List[Dict[str, Any]],
        agent_version: str,
        config_hash: str,
    ) -> NodeRecord:
        gpu_objs = [
            GpuInfo(index=int(g.get("index", i)), name=str(g.get("name", "")), memory_mb=int(g.get("memory_mb", 0)))
            for i, g in enumerate(gpus)
        ]
        node = NodeRecord(
            node_id=node_id,
            advertised_addr=advertised_addr,
            state="ready",
            gpus=gpu_objs,
            agent_version=agent_version,
            config_hash=config_hash,
        )
        self.store.upsert_node(node)
        self.events.emit(
            "node_registered",
            {"node_id": node_id, "advertised_addr": advertised_addr},
            node_id=node_id,
        )
        return node

    def heartbeat(self, hb: HeartbeatPayload) -> Dict[str, Any]:
        self.store.record_heartbeat(hb)
        self.events.emit(
            "heartbeat",
            {"state": hb.state, "metrics": hb.metrics},
            node_id=hb.node_id,
            route_mode="record",
        )
        assignment = self.store.get_assignment_for_node(hb.node_id)
        cancel_job_ids: List[str] = []
        if hb.running_job_id:
            running_job = self.store.get_job(str(hb.running_job_id))
            if running_job and running_job.state in ("stopped", "cancelled"):
                cancel_job_ids.append(running_job.job_id)
        return {
            "ok": True,
            "master_epoch": self._master_epoch,
            "assignment": assignment.to_dict() if assignment else None,
            "cancel_job_ids": cancel_job_ids,
        }

    def status(self) -> Dict[str, Any]:
        nodes = self.store.list_nodes()
        stale = set(self.store.stale_node_ids(self.cfg.heartbeat_ttl_sec))
        jobs = self.store.list_jobs(limit=20)
        return {
            "master_epoch": self._master_epoch,
            "master_url": self.cfg.master_url,
            "nodes": [
                {
                    **n.to_dict(),
                    "stale": n.node_id in stale,
                }
                for n in nodes
            ],
            "jobs": [j.to_dict() for j in jobs],
            "stale_nodes": list(stale),
        }

    def validate_config(self, raw: Dict[str, Any]) -> ValidationResult:
        return validate_job_spec(raw)

    def submit_job(self, raw: Dict[str, Any], *, request_id: str = "") -> Dict[str, Any]:
        validation = validate_job_spec(raw)
        if not validation.ok:
            return {"success": False, "errors": validation.errors}

        norm = validation.normalized
        req = LogicalJobRequirements.from_spec_dict(norm)
        stale_ids = set(self.store.stale_node_ids(self.cfg.heartbeat_ttl_sec))
        candidates = [n for n in self.store.list_nodes() if n.state in ("ready", "busy")]
        nnodes = int(norm["nnodes"])
        nproc = int(norm["nproc_per_node"])
        job_kind = str(norm.get("job_kind") or "training")
        rejections: List[str] = []

        preferred_ids: List[str] = []
        if job_kind == "inference":
            inf = (norm.get("extra") or {}).get("inference_spec") or {}
            preferred_ids = [str(x) for x in list((inf.get("gpus") or {}).get("node_ids") or [])]

        if preferred_ids:
            by_id = {n.node_id: n for n in candidates if n.node_id not in stale_ids}
            selected = [by_id[i] for i in preferred_ids if i in by_id]
            if len(selected) < nnodes:
                return {
                    "success": False,
                    "errors": [
                        f"requested node_ids {preferred_ids} but only "
                        f"{len(selected)} eligible/registered",
                    ],
                }
            selected = selected[:nnodes]
        else:
            selected, rejections = select_nodes_for_job(
                candidates,
                req,
                nnodes=nnodes,
                nproc_per_node=nproc,
                stale_ids=stale_ids,
                metrics_by_node={
                    n.node_id: self.store.get_node_metrics(n.node_id) for n in candidates
                },
            )
            if len(selected) < nnodes:
                return {
                    "success": False,
                    "errors": [
                        f"need {nnodes} eligible nodes matching job requirements, "
                        f"have {len(selected)}",
                        *rejections[:10],
                    ],
                }

        master_addr = parse_master_addr(self.cfg.master_url, selected[0].advertised_addr)
        master_port = pick_rendezvous_port(self.cfg)
        world_size = nnodes * nproc
        if job_kind == "inference":
            # Inference does not use torchrun rendezvous; keep fields for schema compatibility.
            serve_port = (
                (norm.get("extra") or {}).get("inference_spec") or {}
            ).get("serve", {}).get("port")
            try:
                master_port = int(serve_port) if serve_port not in (None, "") else master_port
            except (TypeError, ValueError):
                pass

            # RuntimeScheme selection is only required for legacy_scheme driver.
            from plugins.inference_adapters.agent_driver import get_inference_driver
            from plugins.inference_adapters.experience import get_experience_store
            from plugins.inference_adapters.runtime_scheme import (
                embed_scheme_in_job_extra,
                select_initial_scheme,
            )

            driver = get_inference_driver()
            if driver == "legacy_scheme":
                exp = get_experience_store(self.cfg.data_dir)
                schemes: List[Dict[str, Any]] = []
                for node in selected:
                    caps = dict(node.capabilities or {})
                    if not caps:
                        caps = self.store.get_node_metrics(node.node_id) or {}
                    if not probe_ready(caps):
                        return {
                            "success": False,
                            "errors": [f"capabilities_incomplete:{node.node_id}"],
                        }
                    adapter_id = str(
                        ((norm.get("extra") or {}).get("adapter_id"))
                        or ((norm.get("extra") or {}).get("inference_spec") or {}).get(
                            "adapter_id"
                        )
                        or "hf_vllm"
                    )
                    scheme, scheme_errs = select_initial_scheme(
                        caps, adapter_id=adapter_id, experience=exp
                    )
                    if scheme_errs or not scheme:
                        return {
                            "success": False,
                            "errors": scheme_errs or ["no_scheme_match"],
                        }
                    schemes.append(scheme)
                matrix_ids = {str(s.get("matrix_id") or s.get("scheme_id")) for s in schemes}
                if len(matrix_ids) > 1:
                    return {
                        "success": False,
                        "errors": [
                            "heterogeneous_runtime:selected nodes need different schemes"
                        ],
                    }
                extra = dict(norm.get("extra") or {})
                extra = embed_scheme_in_job_extra(extra, schemes[0])
                extra["replan_attempts"] = 0
                extra["attempted_scheme_ids"] = [str(schemes[0].get("scheme_id") or "")]
                extra["inference_driver"] = "legacy_scheme"
                norm["extra"] = extra
            else:
                # Agent driver: still require nodes to have completed capability probe
                # so scheduling knows GPU/python presence; do not pin RuntimeScheme.
                for node in selected:
                    caps = dict(node.capabilities or {})
                    if not caps:
                        caps = self.store.get_node_metrics(node.node_id) or {}
                    if not probe_ready(caps):
                        return {
                            "success": False,
                            "errors": [f"capabilities_incomplete:{node.node_id}"],
                        }
                extra = dict(norm.get("extra") or {})
                extra["inference_driver"] = "agent"
                norm["extra"] = extra

        spec = JobSpec(
            job_id=norm["job_id"],
            script=norm["script"],
            script_args=norm["script_args"],
            nnodes=nnodes,
            nproc_per_node=nproc,
            framework=norm["framework"],
            env=norm["env"],
            working_dir=norm["working_dir"],
            idempotency_key=norm["idempotency_key"],
            job_kind=job_kind,
            extra=norm.get("extra") or {},
        )

        if spec.idempotency_key:
            existing = self.store.get_job_by_idempotency(spec.idempotency_key)
            if existing:
                assignments = self.store.list_assignments_for_job(existing.job_id)
                return {
                    "success": True,
                    "job": existing.to_dict(),
                    "assignments": [a.to_dict() for a in assignments],
                    "idempotent": True,
                }

        job = JobRecord(
            job_id=spec.job_id,
            spec=spec,
            state="assigning",
            master_epoch=self._master_epoch,
            job_generation=1,
            master_addr=master_addr,
            master_port=master_port,
        )

        assignments: List[RankAssignment] = []
        for rank, node in enumerate(selected):
            gpu_ids = [g.index for g in node.gpus[:nproc]] or list(range(nproc))
            partial = RankAssignment(
                assignment_id=new_id("asg-"),
                job_id=job.job_id,
                node_id=node.node_id,
                node_rank=rank,
                nproc_per_node=nproc,
                nnodes=nnodes,
                world_size=world_size,
                master_addr=master_addr,
                master_port=master_port,
                master_epoch=self._master_epoch,
                job_generation=job.job_generation,
                gpus=gpu_ids,
                working_dir=spec.working_dir,
                job_spec=spec.to_dict(),
            )
            # Launch command is built on the worker after local path/env resolution.
            partial.launch_command = []
            partial.env = dict(spec.env)
            assignments.append(partial)

        self.store.create_job(job, assignments)
        self.store.update_job_state(job.job_id, "running")
        self.events.emit(
            "job_submitted",
            {"job_id": job.job_id, "nnodes": nnodes, "world_size": world_size},
            job_id=job.job_id,
            request_id=request_id,
        )

        return {
            "success": True,
            "job": job.to_dict(),
            "assignments": [a.to_dict() for a in assignments],
        }

    def job_status(self, job_id: str) -> Dict[str, Any]:
        job = self.store.get_job(job_id)
        if not job:
            return {"success": False, "error": "job not found"}
        assignments = self.store.list_assignments_for_job(job_id)
        logs = self.store.query_logs(job_id=job_id, limit=20)
        return {
            "success": True,
            "job": job.to_dict(),
            "assignments": [a.to_dict() for a in assignments],
            "recent_logs": logs,
        }

    def stop_job(self, job_id: str) -> Dict[str, Any]:
        job = self.store.get_job(job_id)
        if not job:
            return {"success": False, "error": "job not found"}
        self.store.update_job_state(job_id, "stopped")
        stopped_assignments = []
        for assignment in self.store.list_assignments_for_job(job_id):
            if assignment.state in ("pending", "accepted", "running"):
                if self.store.ack_assignment(
                    assignment.assignment_id,
                    assignment.node_id,
                    assignment.job_generation,
                    "stopping",
                ):
                    stopped_assignments.append(assignment.assignment_id)
        self.events.emit(
            "job_stopped",
            {"job_id": job_id, "assignments": stopped_assignments},
            job_id=job_id,
            route_mode="execute_direct",
        )
        return {
            "success": True,
            "job_id": job_id,
            "state": "stopped",
            "assignments": stopped_assignments,
        }

    def node_action(self, node_id: str, action: str) -> Dict[str, Any]:
        node = self.store.get_node(node_id)
        if not node:
            return {"success": False, "error": "node not found"}

        if action == "quarantine":
            node.state = "quarantined"
        elif action == "restore":
            node.state = "ready"
        elif action == "revalidate":
            node.state = "registering"
        else:
            return {"success": False, "error": f"unknown action: {action}"}

        node.updated_at = time.time()
        self.store.upsert_node(node)
        self.events.emit(
            "node_action",
            {"node_id": node_id, "action": action, "state": node.state},
            node_id=node_id,
        )
        return {"success": True, "node": node.to_dict()}

    def sweep_stale_nodes(self) -> List[str]:
        stale = self.store.stale_node_ids(self.cfg.heartbeat_ttl_sec)
        for node_id in stale:
            node = self.store.get_node(node_id)
            if node and node.state != "lost":
                node.state = "lost"
                self.store.upsert_node(node)
                self.events.emit(
                    "node_lost",
                    {"node_id": node_id},
                    node_id=node_id,
                )
        return stale

    def ack_assignment(
        self, assignment_id: str, node_id: str, job_generation: int, state: str
    ) -> bool:
        return self.store.ack_assignment(assignment_id, node_id, job_generation, state)

    def handle_replan(
        self,
        job_id: str,
        *,
        failed_task_id: str = "",
        error: str = "",
        facts: Optional[Dict[str, Any]] = None,
        completed_task_ids: Optional[List[str]] = None,
        stderr_tail: str = "",
        node_id: str = "",
    ) -> Dict[str, Any]:
        """Amend RuntimeScheme tasks for a running inference job (high-frequency replan)."""
        from plugins.inference_adapters.experience import get_experience_store
        from plugins.inference_adapters.runtime_scheme import (
            amend_scheme_for_replan,
            embed_scheme_in_job_extra,
            get_replan_budget,
        )

        job = self.store.get_job(job_id)
        if not job:
            return {"success": False, "errors": ["job not found"]}
        extra = dict(job.spec.extra or {})
        is_inference = (
            str(getattr(job.spec, "job_kind", "") or "").lower() == "inference"
            or str(extra.get("job_kind") or "").lower() == "inference"
        )
        if not is_inference:
            return {"success": False, "errors": ["not an inference job"]}

        max_attempts, _wall = get_replan_budget()
        attempts = int(extra.get("replan_attempts") or 0)
        if attempts >= max_attempts:
            self._record_experience(
                job,
                outcome="replan_exhausted",
                facts=facts or {},
                failed_task_id=failed_task_id,
                error=error,
            )
            self.store.update_job_state(job_id, "failed", error_summary=f"replan_exhausted:{error}")
            return {"success": False, "errors": [f"replan_exhausted:{error}"]}

        current = extra.get("runtime_scheme") or (extra.get("inference_spec") or {}).get("runtime", {}).get(
            "scheme"
        )
        if not isinstance(current, dict):
            return {"success": False, "errors": ["no runtime_scheme on job"]}

        exp = get_experience_store(self.cfg.data_dir)
        # Record this failure attempt for sharing
        exp.record(
            facts=facts or {},
            scheme_id=str(current.get("scheme_id") or ""),
            tasks=list(current.get("tasks") or []),
            outcome="fail",
            failed_task_id=failed_task_id,
            error=error,
            mirror_profile=str(current.get("mirror_profile") or "default"),
        )

        attempted = list(extra.get("attempted_scheme_ids") or [])
        new_scheme, errs = amend_scheme_for_replan(
            current,
            facts=facts or {},
            failed_task_id=failed_task_id,
            error=error,
            experience=exp,
            attempted_scheme_ids=attempted,
        )
        if errs or not new_scheme:
            self._record_experience(
                job,
                outcome="replan_exhausted",
                facts=facts or {},
                failed_task_id=failed_task_id,
                error="; ".join(errs or ["replan failed"]),
            )
            self.store.update_job_state(
                job_id, "failed", error_summary="; ".join(errs or ["replan failed"])
            )
            return {"success": False, "errors": errs or ["replan failed"]}

        attempts += 1
        sid = str(new_scheme.get("scheme_id") or "")
        if sid and sid not in attempted:
            attempted.append(sid)
        extra["replan_attempts"] = attempts
        extra["attempted_scheme_ids"] = attempted
        extra["last_replan"] = {
            "failed_task_id": failed_task_id,
            "error": error,
            "completed_task_ids": list(completed_task_ids or []),
            "stderr_tail": (stderr_tail or "")[-500:],
            "node_id": node_id,
        }
        extra = embed_scheme_in_job_extra(extra, new_scheme)
        self.store.update_job_extra(job_id, extra)
        self.events.emit(
            "job_replanned",
            {
                "job_id": job_id,
                "replan_generation": new_scheme.get("replan_generation"),
                "scheme_id": new_scheme.get("scheme_id"),
                "failed_task_id": failed_task_id,
            },
            job_id=job_id,
            node_id=node_id,
        )
        return {"success": True, "scheme": new_scheme, "replan_attempts": attempts}

    def _record_experience(
        self,
        job: JobRecord,
        *,
        outcome: str,
        facts: Dict[str, Any],
        failed_task_id: str = "",
        error: str = "",
    ) -> None:
        try:
            from plugins.inference_adapters.experience import get_experience_store

            extra = job.spec.extra or {}
            scheme = extra.get("runtime_scheme") or {}
            if not isinstance(scheme, dict):
                return
            get_experience_store(self.cfg.data_dir).record(
                facts=facts,
                scheme_id=str(scheme.get("scheme_id") or ""),
                tasks=list(scheme.get("tasks") or []),
                outcome=outcome,
                failed_task_id=failed_task_id,
                error=error,
                mirror_profile=str(scheme.get("mirror_profile") or "default"),
            )
        except Exception:
            pass

    def report_job_outcome(
        self,
        job_id: str,
        *,
        success: bool,
        summary: str = "",
        node_id: str = "",
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        state = "succeeded" if success else "failed"
        self.store.update_job_state(job_id, state, error_summary=summary if not success else "")
        event_type = "job_completed" if success else "job_failed"
        payload: Dict[str, Any] = {"summary": summary or state, "job_id": job_id}
        if details:
            payload["details"] = details
        self.events.emit(
            event_type,
            payload,
            job_id=job_id,
            node_id=node_id,
        )
        # Experience: record success with effective tasks
        job = self.store.get_job(job_id)
        if job and str(getattr(job.spec, "job_kind", "") or "").lower() == "inference":
            facts = {}
            if isinstance(details, dict):
                needs = details.get("needs_replan") if isinstance(details.get("needs_replan"), dict) else {}
                facts = dict(needs.get("facts") or details.get("facts") or {})
            self._record_experience(
                job,
                outcome="success" if success else "fail",
                facts=facts,
                failed_task_id=str((details or {}).get("phase") or "") if not success else "",
                error=summary if not success else "",
            )
        # Project inference visit info to thin API / status callback when configured.
        self._maybe_project_inference_status(job_id, success=success, summary=summary, details=details or {})

    def _maybe_project_inference_status(
        self,
        job_id: str,
        *,
        success: bool,
        summary: str,
        details: Dict[str, Any],
    ) -> None:
        job = self.store.get_job(job_id)
        if not job:
            return
        extra = job.spec.extra or {}
        is_inference = (
            str(getattr(job.spec, "job_kind", "") or "").lower() == "inference"
            or str(extra.get("job_kind") or "").lower() == "inference"
        )
        if not is_inference:
            return
        callback = ""
        if details.get("callback_url"):
            callback = str(details["callback_url"])
        if not callback:
            callback = str(self.cfg.status_callback_url or "").strip()
        if not callback:
            try:
                from gpucloud_cli.config import load_config

                ia = load_config().get("inference_adapters") or {}
                callback = str(ia.get("status_callback_url") or "").strip()
            except Exception:
                callback = ""
        if not callback:
            return
        body = {
            "job_id": job_id,
            "success": success,
            "summary": summary,
            "status": "available" if success else "failed",
            "visit_host": details.get("visit_host"),
            "visit_port": details.get("visit_port"),
            "protocol": details.get("protocol"),
            "stream_path": details.get("stream_path"),
            "adapter_id": details.get("adapter_id"),
            "deploy_node_id": details.get("deploy_node_id"),
            "details": details,
        }
        try:
            import httpx

            headers = {"Content-Type": "application/json"}
            secret = self.cfg.secret
            if secret:
                headers["Authorization"] = f"Bearer {secret}"
            with httpx.Client(timeout=15.0) as client:
                client.post(callback, json=body, headers=headers)
        except Exception as exc:
            self.logger.log_error(
                error_type="status_callback",
                message=str(exc),
                job_id=job_id,
            )
