"""Tests for the cluster control-plane plugin."""

from __future__ import annotations

import json
import os
import threading
import time
from collections import OrderedDict
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from plugins.cluster.config import ClusterConfig, load_cluster_config, resolve_role
from plugins.cluster.controller import ClusterController
from plugins.cluster.events import ClusterEventBridge
from plugins.cluster.cluster_logging import ClusterLogger
from plugins.cluster.models import GpuInfo, HeartbeatPayload, JobSpec, NodeRecord, RankAssignment
from plugins.cluster.runtime import (
    ClusterRuntime,
    configure_event_delivery,
    start_embedded_master,
    stop_embedded_master,
)
from plugins.cluster.server import ClusterHTTPServer
from plugins.cluster.store import MemoryClusterStore
from plugins.cluster.tools import (
    handle_cluster_status,
    handle_cluster_submit_job,
    handle_cluster_validate_config,
    set_runtime,
)
from plugins.cluster.training import build_torchrun_command, validate_job_spec
from plugins.cluster.node_capabilities import (
    LogicalJobRequirements,
    collect_local_metrics,
    node_matches_job,
    resolve_local_launch,
    select_nodes_for_job,
)
from plugins.cluster.node_agent import NodeAgent, _ACTIVE_PROCS


@pytest.fixture(autouse=True)
def _cluster_env(tmp_path, monkeypatch):
    home = tmp_path / ".gpucloud"
    home.mkdir()
    monkeypatch.setenv("GPUCLOUD_HOME", str(home))
    monkeypatch.setenv("GPUCLOUD_CLUSTER_FORCE", "1")
    monkeypatch.setenv("GPUCLOUD_CLUSTER_NODE_ID", "test-node-a")
    data_dir = tmp_path / "cluster-data"
    monkeypatch.setenv("GPUCLOUD_CLUSTER_DATA_DIR", str(data_dir))
    yield data_dir
    stop_embedded_master()


@pytest.fixture
def runtime_stack(tmp_path):
    cfg = ClusterConfig(
        enabled=True,
        role="master",
        node_id="master-local",
        master_url="http://127.0.0.1:0",
        bind_host="127.0.0.1",
        bind_port=0,
        data_dir=tmp_path / "cluster-data",
        database_url="",
        heartbeat_ttl_sec=2,
    )
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    store = MemoryClusterStore()
    store.ensure_schema()
    logger = ClusterLogger(cfg, store)
    events = ClusterEventBridge(cfg, store)
    controller = ClusterController(cfg, store, logger, events)
    set_runtime(controller=controller, store=store, logger=logger, events=events)
    return cfg, store, logger, events, controller


def test_load_cluster_config_defaults():
    cfg = load_cluster_config({"enabled": True, "role": "worker"})
    assert cfg.enabled is True
    assert cfg.embedded_master is False
    assert cfg.role == "worker"
    assert cfg.heartbeat_interval_sec == 5


def test_load_cluster_config_embedded_master():
    cfg = load_cluster_config({"enabled": True, "embedded_master": True})
    assert cfg.embedded_master is True


def test_resolve_role_auto_master_when_local():
    cfg = ClusterConfig(
        role="auto",
        master_url="http://127.0.0.1:8765",
        bind_port=8765,
    )
    assert resolve_role(cfg) == "master"


def test_resolve_role_auto_worker_when_remote():
    cfg = ClusterConfig(
        role="auto",
        master_url="http://10.0.0.99:8765",
        bind_port=8765,
    )
    assert resolve_role(cfg) == "worker"


def test_validate_job_spec_rejects_missing_script():
    result = validate_job_spec({"nnodes": 2})
    assert result.ok is False
    assert "script is required" in result.errors[0]


def test_validate_job_spec_accepts_minimal():
    result = validate_job_spec({
        "script": "train.py",
        "nnodes": 2,
        "nproc_per_node": 1,
        "framework": "placeholder",
    })
    assert result.ok is True
    assert result.normalized["nnodes"] == 2


def test_build_torchrun_command():
    from plugins.cluster.models import JobSpec, RankAssignment

    cfg = ClusterConfig()
    spec = JobSpec(script="train.py", script_args=["--lr", "1e-4"], framework="torchrun")
    assignment = RankAssignment(
        assignment_id="asg-1",
        job_id="job-1",
        node_id="n0",
        node_rank=0,
        nproc_per_node=2,
        nnodes=2,
        world_size=4,
        master_addr="10.0.0.1",
        master_port=29500,
        master_epoch=1,
        job_generation=1,
    )
    cmd, env = build_torchrun_command(spec, assignment, cfg)
    assert "torch.distributed.run" in " ".join(cmd)
    assert env["MASTER_ADDR"] == "10.0.0.1"
    assert env["NODE_RANK"] == "0"


def test_build_torchrun_command_custom_python():
    from plugins.cluster.models import JobSpec, RankAssignment

    cfg = ClusterConfig()
    spec = JobSpec(script="train.py", framework="torchrun")
    assignment = RankAssignment(
        assignment_id="asg-1",
        job_id="job-1",
        node_id="n0",
        node_rank=0,
        nproc_per_node=1,
        nnodes=1,
        world_size=1,
        master_addr="10.0.0.1",
        master_port=29500,
        master_epoch=1,
        job_generation=1,
    )
    cmd, _env = build_torchrun_command(
        spec, assignment, cfg, python_executable="/opt/conda/envs/test/bin/python"
    )
    assert cmd[0] == "/opt/conda/envs/test/bin/python"


def test_logical_job_requirements_from_spec():
    req = LogicalJobRequirements.from_spec_dict({
        "script": "train.py",
        "env_name": "my-env",
        "project": "my-model",
        "release": "abc123",
        "extra": {"dataset": "ds-v1", "min_scratch_gb": 100},
    })
    assert req.env_name == "my-env"
    assert req.project == "my-model"
    assert req.dataset == "ds-v1"
    assert req.min_scratch_gb == 100.0
    assert req.uses_logical_paths is True


def test_node_matches_job_filters_by_capabilities():
    node = NodeRecord(
        node_id="n1",
        advertised_addr="10.0.0.1",
        state="ready",
        gpus=[GpuInfo(index=0), GpuInfo(index=1)],
    )
    req = LogicalJobRequirements(env_name="train-env", project="proj-a", min_scratch_gb=50)
    metrics = {
        "conda_envs": ["train-env"],
        "code_roots": ["proj-a"],
        "scratch_free_gb": {"default": 200.0},
        "gpu_count": 2,
    }
    ok, reasons = node_matches_job(
        node, req, nproc_per_node=2, stale=False, metrics=metrics,
    )
    assert ok is True
    assert reasons == []

    bad_metrics = dict(metrics)
    bad_metrics["conda_envs"] = []
    ok, reasons = node_matches_job(
        node, req, nproc_per_node=2, stale=False, metrics=bad_metrics,
    )
    assert ok is False
    assert any("conda env" in r for r in reasons)


def test_select_nodes_for_job_returns_rejections(runtime_stack):
    _cfg, store, _logger, _events, controller = runtime_stack
    controller.startup()
    store.upsert_node(NodeRecord(node_id="n0", advertised_addr="10.0.0.1", state="ready", gpus=[GpuInfo(index=0)]))
    store.record_heartbeat(HeartbeatPayload(
        node_id="n0",
        config_hash="x",
        metrics={"conda_envs": [], "code_roots": [], "gpu_count": 1},
    ))

    req = LogicalJobRequirements(env_name="missing-env")
    selected, rejections = select_nodes_for_job(
        store.list_nodes(),
        req,
        nnodes=1,
        nproc_per_node=1,
        metrics_by_node={"n0": store.get_node_metrics("n0")},
    )
    assert selected == []
    assert rejections


def test_resolve_local_launch_with_conda_and_paths(tmp_path):
    code_root = tmp_path / "code" / "my-model"
    release_dir = code_root / "rev1"
    release_dir.mkdir(parents=True)
    (release_dir / "train.py").write_text("print('ok')\n", encoding="utf-8")

    data_dir = tmp_path / "data" / "ds-v1"
    data_dir.mkdir(parents=True)
    ckpt_root = tmp_path / "ckpt" / "my-model"
    ckpt_root.mkdir(parents=True)
    scratch = tmp_path / "scratch"
    scratch.mkdir()

    py_path = tmp_path / "py"
    py_path.write_text("#!/bin/sh\necho py\n", encoding="utf-8")
    py_path.chmod(0o755)

    cfg = ClusterConfig(
        node_paths={
            "code_roots": {"my-model": str(code_root)},
            "data_roots": {"ds-v1": str(data_dir)},
            "checkpoint_roots": {"my-model": str(ckpt_root)},
            "scratch_roots": {"default": str(scratch)},
        },
        conda={"envs": {"train-env": str(py_path)}},
    )

    spec = JobSpec(
        script="train.py",
        framework="placeholder",
        extra={
            "env_name": "train-env",
            "project": "my-model",
            "release": "rev1",
            "dataset": "ds-v1",
            "output_run_id": "run-001",
            "min_scratch_gb": 0,
        },
    )
    assignment = RankAssignment(
        assignment_id="asg-1",
        job_id="job-1",
        node_id="n0",
        node_rank=0,
        nproc_per_node=1,
        nnodes=1,
        world_size=1,
        master_addr="127.0.0.1",
        master_port=29500,
        master_epoch=1,
        job_generation=1,
        job_spec=spec.to_dict(),
    )

    resolved = resolve_local_launch(cfg, spec, assignment)
    assert resolved.ok is True
    assert resolved.working_dir == str(release_dir)
    assert resolved.python_executable == str(py_path)
    assert resolved.env["DATA_DIR"] == str(data_dir)
    assert resolved.env["OUTPUT_DIR"] == str(ckpt_root / "run-001")
    assert resolved.launch_command[0] == str(py_path)


def test_controller_submit_logical_job_with_metrics(runtime_stack, tmp_path):
    cfg, store, _logger, _events, controller = runtime_stack
    controller.startup()

    code_root = tmp_path / "proj"
    (code_root / "rev1").mkdir(parents=True)
    (code_root / "rev1" / "train.py").write_text("x", encoding="utf-8")

    cfg.node_paths = {
        "code_roots": {"my-model": str(code_root)},
        "data_roots": {},
        "checkpoint_roots": {"my-model": str(tmp_path / "ckpt")},
        "scratch_roots": {"default": str(tmp_path / "scratch")},
    }
    (tmp_path / "ckpt").mkdir()
    (tmp_path / "scratch").mkdir()

    for i in range(2):
        nid = f"node-{i}"
        store.upsert_node(NodeRecord(
            node_id=nid,
            advertised_addr=f"10.0.0.{i+1}",
            state="ready",
            gpus=[GpuInfo(index=0)],
        ))
        store.record_heartbeat(HeartbeatPayload(
            node_id=nid,
            config_hash="abc",
            metrics={
                "conda_envs": ["train-env"],
                "code_roots": ["my-model"],
                "checkpoint_roots": ["my-model"],
                "scratch_free_gb": {"default": 1000.0},
                "gpu_count": 1,
            },
        ))

    spec = {
        "script": "train.py",
        "nnodes": 2,
        "nproc_per_node": 1,
        "framework": "placeholder",
        "project": "my-model",
        "release": "rev1",
        "env_name": "train-env",
    }
    result = controller.submit_job(spec)
    assert result["success"] is True
    assert len(result["assignments"]) == 2
    for asg in result["assignments"]:
        assert asg["job_spec"]["extra"]["project"] == "my-model"
        assert asg["launch_command"] == []


def test_controller_submit_job_and_idempotency(runtime_stack):
    cfg, store, _logger, _events, controller = runtime_stack
    controller.startup()

    for i in range(2):
        store.upsert_node(NodeRecord(
            node_id=f"node-{i}",
            advertised_addr=f"10.0.0.{i+1}",
            state="ready",
            gpus=[GpuInfo(index=0)],
        ))

    spec = {
        "script": "train.py",
        "nnodes": 2,
        "nproc_per_node": 1,
        "framework": "placeholder",
        "idempotency_key": "idem-1",
    }
    first = controller.submit_job(spec)
    assert first["success"] is True
    job_id = first["job"]["job_id"]
    assert len(first["assignments"]) == 2

    second = controller.submit_job(spec)
    assert second.get("idempotent") is True
    assert second["job"]["job_id"] == job_id


def test_stop_job_returns_cancel_instruction(runtime_stack):
    _cfg, store, _logger, _events, controller = runtime_stack
    controller.startup()
    store.upsert_node(NodeRecord(
        node_id="node-0",
        advertised_addr="10.0.0.1",
        state="ready",
        gpus=[GpuInfo(index=0)],
    ))
    result = controller.submit_job({
        "script": "train.py",
        "nnodes": 1,
        "nproc_per_node": 1,
        "framework": "placeholder",
    })
    assert result["success"] is True
    job_id = result["job"]["job_id"]
    assignment_id = result["assignments"][0]["assignment_id"]
    assert store.ack_assignment(assignment_id, "node-0", 1, "running")

    before = controller.heartbeat(HeartbeatPayload(
        node_id="node-0",
        state="busy",
        running_job_id=job_id,
    ))
    assert before["cancel_job_ids"] == []

    stopped = controller.stop_job(job_id)
    assert stopped["success"] is True
    assert stopped["assignments"] == [assignment_id]

    after = controller.heartbeat(HeartbeatPayload(
        node_id="node-0",
        state="busy",
        running_job_id=job_id,
    ))
    assert after["cancel_job_ids"] == [job_id]
    assert after["assignment"] is None


def test_failed_assignment_is_not_reissued_on_heartbeat(runtime_stack):
    _cfg, store, _logger, _events, controller = runtime_stack
    controller.startup()
    store.upsert_node(NodeRecord(
        node_id="node-0",
        advertised_addr="10.0.0.1",
        state="ready",
        gpus=[GpuInfo(index=0)],
    ))
    result = controller.submit_job({
        "script": "train.py",
        "nnodes": 1,
        "nproc_per_node": 1,
        "framework": "placeholder",
    })
    assert result["success"] is True
    job_id = result["job"]["job_id"]
    assignment_id = result["assignments"][0]["assignment_id"]
    assert store.ack_assignment(assignment_id, "node-0", 1, "running")

    controller.report_job_outcome(job_id, success=False, summary="exit_code=1", node_id="node-0")
    after_failed_job = controller.heartbeat(HeartbeatPayload(node_id="node-0", state="ready"))
    assert after_failed_job["assignment"] is None

    store.update_job_state(job_id, "running")
    assert store.ack_assignment(assignment_id, "node-0", 1, "failed")
    after_failed_assignment = controller.heartbeat(HeartbeatPayload(node_id="node-0", state="ready"))
    assert after_failed_assignment["assignment"] is None


def test_report_job_outcome_persists_outcome_details(runtime_stack):
    _cfg, store, _logger, _events, controller = runtime_stack
    controller.startup()
    store.upsert_node(NodeRecord(
        node_id="node-0",
        advertised_addr="10.0.0.1",
        state="ready",
        gpus=[GpuInfo(index=0)],
    ))
    result = controller.submit_job({
        "script": "train.py",
        "nnodes": 1,
        "nproc_per_node": 1,
        "framework": "placeholder",
    })
    assert result["success"] is True, result
    job_id = result["job"]["job_id"]
    details = {
        "visit_host": "10.0.20.188",
        "visit_port": 8000,
        "deploy_node_id": 99,
        "adapter_id": "hf_vllm",
    }
    controller.report_job_outcome(
        job_id,
        success=True,
        summary="ready",
        node_id="node-0",
        details=details,
    )
    job = store.get_job(job_id)
    assert job is not None
    assert job.state == "succeeded"
    assert job.outcome_details.get("visit_host") == "10.0.20.188"
    assert job.outcome_details.get("visit_port") == 8000
    status = controller.job_status(job_id)
    assert status["job"]["outcome_details"]["visit_port"] == 8000


def test_stale_node_detection(runtime_stack):
    _cfg, store, _logger, events, controller = runtime_stack
    controller.startup()
    store.upsert_node(NodeRecord(node_id="n1", advertised_addr="10.0.0.1"))
    store.record_heartbeat(HeartbeatPayload(node_id="n1", config_hash="abc"))
    stale = controller.sweep_stale_nodes()
    assert stale == []

    # Backdate heartbeat
    store._heartbeats["n1"]["last_seen_at"] = time.time() - 999
    stale = controller.sweep_stale_nodes()
    assert "n1" in stale
    lost_events = [e for e in store.list_events() if e.event_type == "node_lost"]
    assert lost_events


def test_event_routing_record_vs_queue(runtime_stack):
    cfg, store, _logger, events, _controller = runtime_stack
    cfg.event_routing = {"default": "record", "job_failed": "queue"}
    queued = []

    def on_queue(text, _ev):
        queued.append(text)

    events.callbacks.on_queue = on_queue
    events.emit("heartbeat", {"x": 1})
    assert queued == []
    events.emit("job_failed", {"summary": "boom"}, job_id="job-1")
    assert len(queued) == 1


def test_event_delivery_routes_to_agent(runtime_stack):
    cfg, store, logger, events, controller = runtime_stack
    cfg.event_routing = {
        "default": "record",
        "job_failed": "queue",
        "node_lost": "guide",
        "config_mismatch": "interrupt",
    }
    runtime = ClusterRuntime(cfg, store, logger, events, controller)
    queued = []

    class FakeAgent:
        def __init__(self):
            self.steered = []
            self.interrupted = []

        def steer(self, text):
            self.steered.append(text)
            return True

        def interrupt(self, text):
            self.interrupted.append(text)

    agent = FakeAgent()
    configure_event_delivery(
        runtime,
        agent=agent,
        session_key="sess-1",
        queue_delivery=lambda text, event: queued.append((text, event.event_type)),
    )

    events.emit("job_failed", {"summary": "boom"}, job_id="job-1")
    events.emit("node_lost", {"summary": "lost"}, node_id="node-1")
    events.emit("config_mismatch", {"summary": "bad config"}, node_id="node-1")

    assert queued and queued[0][1] == "job_failed"
    assert agent.steered and "node_lost" in agent.steered[0]
    assert agent.interrupted and "config_mismatch" in agent.interrupted[0]


def test_tool_handlers_local_controller(runtime_stack):
    _cfg, _store, _logger, _events, controller = runtime_stack
    controller.startup()
    store = _store = runtime_stack[1]
    for i in range(2):
        store.upsert_node(NodeRecord(
            node_id=f"n{i}",
            advertised_addr=f"10.0.0.{i}",
            state="ready",
            gpus=[GpuInfo(index=0)],
        ))

    status_raw = handle_cluster_status({})
    status = json.loads(status_raw)
    assert status["success"] is True
    assert len(status["data"]["nodes"]) == 2

    val_raw = handle_cluster_validate_config({"spec": {"script": "t.py", "nnodes": 1}})
    val = json.loads(val_raw)
    assert val["ok"] is True

    submit_raw = handle_cluster_submit_job({
        "spec": {
            "script": "train.py",
            "nnodes": 2,
            "nproc_per_node": 1,
            "framework": "placeholder",
        },
    })
    submit = json.loads(submit_raw)
    assert submit["success"] is True


def test_http_server_health(runtime_stack, tmp_path):
    cfg, store, logger, events, controller = runtime_stack
    # Pick ephemeral port
    import socket as _socket
    sock = _socket.socket()
    sock.bind(("127.0.0.1", 0))
    cfg.bind_port = sock.getsockname()[1]
    sock.close()

    server = ClusterHTTPServer(cfg, controller, logger)
    thread = threading.Thread(target=lambda: server.start(block=True), daemon=True)
    thread.start()
    time.sleep(0.3)

    import httpx
    resp = httpx.get(f"http://127.0.0.1:{cfg.bind_port}/health", timeout=2.0)
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
    server.stop()


def test_embedded_master_starts_once(tmp_path):
    raw_cfg = {
        "cluster": {
            "enabled": True,
            "embedded_master": True,
            "role": "master",
            "node_id": "embedded-master",
            "master_url": "http://127.0.0.1:0",
            "bind_host": "127.0.0.1",
            "bind_port": 0,
            "data_dir": str(tmp_path / "embedded-cluster"),
            "heartbeat_interval_sec": 1,
        }
    }
    with patch("gpucloud_cli.config.load_config", return_value=raw_cfg):
        runtime = start_embedded_master(session_key="sess-embed")
        assert runtime is not None
        assert runtime.running is True
        again = start_embedded_master(session_key="sess-embed")
        assert again is runtime

        import httpx
        resp = httpx.get(f"http://127.0.0.1:{runtime.cfg.bind_port}/health", timeout=2.0)
        assert resp.status_code == 200
        assert resp.json()["ok"] is True


def test_assignment_validation_rejects_wrong_node():
    from plugins.cluster.models import RankAssignment
    from plugins.cluster.training import validate_local_assignment

    assignment = RankAssignment(
        assignment_id="a1",
        job_id="j1",
        node_id="other-node",
        node_rank=0,
        nproc_per_node=1,
        nnodes=1,
        world_size=1,
        master_addr="127.0.0.1",
        master_port=29500,
        master_epoch=1,
        job_generation=1,
    )
    result = validate_local_assignment(
        assignment,
        node_id="local-node",
        config_hash="hash",
        local_addrs=["127.0.0.1"],
    )
    assert result.ok is False


def test_node_agent_stop_job_terminates_active_process(runtime_stack):
    cfg, store, logger, _events, _controller = runtime_stack

    class FakeProc:
        def __init__(self):
            self.terminated = False

        def terminate(self):
            self.terminated = True

    proc = FakeProc()
    _ACTIVE_PROCS["job-stop"] = proc  # type: ignore[assignment]
    try:
        agent = NodeAgent(cfg, store, logger)
        agent._running_job_id = "job-stop"
        agent._stop_job("job-stop")
        assert proc.terminated is True
        assert agent._running_job_id is None
        assert "job-stop" not in agent._stopping_jobs
    finally:
        _ACTIVE_PROCS.pop("job-stop", None)


def test_stop_cancel_without_running_job_id(runtime_stack):
    """Stop must cancel via assignment state even when worker cleared running_job_id."""
    _cfg, store, _logger, _events, controller = runtime_stack
    controller.startup()
    store.upsert_node(NodeRecord(
        node_id="node-0",
        advertised_addr="10.0.0.1",
        state="ready",
        gpus=[GpuInfo(index=0)],
    ))
    result = controller.submit_job({
        "script": "train.py",
        "nnodes": 1,
        "nproc_per_node": 1,
        "framework": "placeholder",
    })
    assert result["success"] is True
    job_id = result["job"]["job_id"]
    assignment_id = result["assignments"][0]["assignment_id"]
    assert store.ack_assignment(assignment_id, "node-0", 1, "running")

    stopped = controller.stop_job(job_id)
    assert stopped["success"] is True

    after = controller.heartbeat(HeartbeatPayload(
        node_id="node-0",
        state="ready",
        running_job_id="",  # cleared after AutoGoal finally
    ))
    assert after["cancel_job_ids"] == [job_id]


def test_nudge_enqueue_and_heartbeat_delivery(runtime_stack):
    _cfg, store, _logger, _events, controller = runtime_stack
    controller.startup()
    store.upsert_node(NodeRecord(
        node_id="node-0",
        advertised_addr="10.0.0.1",
        state="ready",
        gpus=[GpuInfo(index=0)],
    ))
    result = controller.submit_job({
        "script": "train.py",
        "nnodes": 1,
        "nproc_per_node": 1,
        "framework": "placeholder",
    })
    job_id = result["job"]["job_id"]

    bad = controller.enqueue_nudge(
        job_id,
        type="steer_text",
        payload={"text": "hi"},
        route_mode="steer",  # invalid — must use guide
    )
    assert bad["success"] is False

    enq = controller.enqueue_nudge(
        job_id,
        type="steer_text",
        payload={"text": "please sync lora"},
        route_mode="guide",
    )
    assert enq["success"] is True
    assert len(enq["nudges"]) == 1
    nudge_id = enq["nudges"][0]["nudge_id"]

    hb = controller.heartbeat(HeartbeatPayload(node_id="node-0", state="ready"))
    assert len(hb["nudges"]) == 1
    assert hb["nudges"][0]["nudge_id"] == nudge_id
    assert hb["nudges"][0]["route_mode"] == "guide"

    status = controller.job_status(job_id)
    assert len(status["nudges"]) == 1

    acked = controller.ack_nudge(
        job_id,
        nudge_id,
        node_id="node-0",
        success=True,
        detail={"action": "steer"},
    )
    assert acked["success"] is True
    hb2 = controller.heartbeat(HeartbeatPayload(node_id="node-0", state="ready"))
    assert hb2["nudges"] == []


def test_dispatch_nudge_route_modes(runtime_stack):
    from plugins.cluster.nudge_dispatch import dispatch_nudge
    from plugins.inference_adapters.agent_driver import (
        forget_inference_agent,
        get_inference_agent,
        remember_inference_agent,
    )

    job_id = "job-nudge-modes"
    forget_inference_agent(job_id)
    acks: list = []

    def _ack(jid, nid, **kwargs):
        row = {"job_id": jid, "nudge_id": nid, **kwargs}
        acks.append(row)
        return {"success": True, **row}

    # record — no agent needed
    dispatch_nudge(
        {
            "job_id": job_id,
            "nudge_id": "n1",
            "type": "note",
            "route_mode": "record",
            "payload": {"text": "log only"},
        },
        node_id="node-0",
        ack_fn=_ack,
    )
    assert acks[-1]["detail"]["action"] == "recorded"

    # interrupt with no agent → already_idle
    dispatch_nudge(
        {
            "job_id": job_id,
            "nudge_id": "n2",
            "type": "stop_agent",
            "route_mode": "interrupt",
            "payload": {"text": "bye"},
        },
        node_id="node-0",
        ack_fn=_ack,
    )
    assert acks[-1]["detail"]["action"] == "already_idle"

    # guide — relaunches stub agent then follow-up
    dispatch_nudge(
        {
            "job_id": job_id,
            "nudge_id": "n3",
            "type": "steer_text",
            "route_mode": "guide",
            "payload": {"text": "install foo"},
        },
        node_id="node-0",
        ack_fn=_ack,
    )
    assert acks[-1]["detail"]["action"] in ("followup_turn", "steer")
    assert get_inference_agent(job_id) is not None

    # queue — with agent present
    dispatch_nudge(
        {
            "job_id": job_id,
            "nudge_id": "n4",
            "type": "steer_text",
            "route_mode": "queue",
            "payload": {"text": "next turn please"},
        },
        node_id="node-0",
        ack_fn=_ack,
    )
    assert acks[-1]["detail"]["action"] in ("queued_started", "queued_busy")

    # interrupt with live agent
    class FakeAgent:
        def __init__(self):
            self.interrupted = None

        def interrupt(self, reason=""):
            self.interrupted = reason

        def steer(self, text):
            return True

    live = FakeAgent()
    remember_inference_agent(job_id, live)
    dispatch_nudge(
        {
            "job_id": job_id,
            "nudge_id": "n5",
            "type": "hard_stop",
            "route_mode": "interrupt",
            "payload": {"text": "cluster nudge interrupt"},
        },
        node_id="node-0",
        ack_fn=_ack,
    )
    assert acks[-1]["detail"]["action"] == "interrupt"
    assert live.interrupted == "cluster nudge interrupt"
    forget_inference_agent(job_id)


def test_stop_job_interrupts_and_forgets_agent(runtime_stack):
    cfg, store, logger, _events, _controller = runtime_stack
    from plugins.inference_adapters.agent_driver import (
        forget_inference_agent,
        get_inference_agent,
        remember_inference_agent,
    )

    job_id = "job-stop-agent"

    class FakeAgent:
        def __init__(self):
            self.interrupted = None

        def interrupt(self, reason=""):
            self.interrupted = reason

    fake = FakeAgent()
    remember_inference_agent(job_id, fake)
    try:
        agent = NodeAgent(cfg, store, logger)
        with patch(
            "plugins.inference_adapters.runtime.stop_job_adapter",
            return_value=None,
        ):
            agent._stop_job(job_id)
        assert fake.interrupted == "cluster stop requested"
        assert get_inference_agent(job_id) is None
    finally:
        forget_inference_agent(job_id)


def test_launch_inference_finally_keeps_agent_reference():
    """Source contract: AutoGoal finally must not interrupt by default."""
    import inspect
    from plugins.cluster import node_agent as na

    src = inspect.getsource(na.NodeAgent._launch_inference)
    assert "interrupt_inference_agent" not in src
    assert "Keep serve" in src or "Do NOT interrupt" in src


def test_node_agent_marks_failed_assignment_terminal(runtime_stack, tmp_path):
    cfg, _store, logger, _events, _controller = runtime_stack

    class FakeProc:
        def wait(self):
            return 1

    class FakeClient:
        def __init__(self):
            self.acks = []
            self.outcomes = []

        def ack_assignment(self, assignment_id, node_id, job_generation, state):
            self.acks.append((assignment_id, node_id, job_generation, state))
            return {"success": True}

        def report_outcome(self, job_id, *, success, summary="", node_id=""):
            self.outcomes.append((job_id, success, summary, node_id))
            return {"success": True}

    client = FakeClient()
    agent = NodeAgent(cfg, _store, logger, client=client)
    agent.cfg.node_id = "node-0"
    agent._running_job_id = "job-fail"

    stdout_path = tmp_path / "stdout.log"
    stderr_path = tmp_path / "stderr.log"
    stdout_path.write_text("", encoding="utf-8")
    stderr_path.write_text("boom", encoding="utf-8")
    run_id = logger.start_process(
        job_id="job-fail",
        node_id="node-0",
        command=["python", "train.py"],
        cwd=str(tmp_path),
        env={},
    )
    assignment = RankAssignment(
        assignment_id="asg-fail",
        job_id="job-fail",
        node_id="node-0",
        node_rank=0,
        nproc_per_node=1,
        nnodes=1,
        world_size=1,
        master_addr="127.0.0.1",
        master_port=29500,
        master_epoch=1,
        job_generation=1,
    )
    _ACTIVE_PROCS["job-fail"] = FakeProc()  # type: ignore[assignment]
    try:
        agent._watch_process(FakeProc(), assignment, run_id, stdout_path, stderr_path)
    finally:
        _ACTIVE_PROCS.pop("job-fail", None)

    assert agent._running_job_id is None
    assert client.acks == [("asg-fail", "node-0", 1, "failed")]
    assert client.outcomes == [("job-fail", False, "exit_code=1", "node-0")]


def test_gateway_dispatch_cluster_event_routes_modes():
    from gateway.run import GatewayRunner

    runner = object.__new__(GatewayRunner)
    source = SimpleNamespace(platform="test-platform")
    runner._session_sources = OrderedDict({"sess-gw": source})
    runner._running_agents = {}
    runner.adapters = {
        "test-platform": SimpleNamespace(_pending_messages={}),
    }
    runner._queued_events = {}

    class FakeAgent:
        def __init__(self):
            self.steered = []
            self.interrupted = []

        def steer(self, text):
            self.steered.append(text)
            return True

        def interrupt(self, text):
            self.interrupted.append(text)

    agent = FakeAgent()
    runner._running_agents["sess-gw"] = agent

    assert runner.dispatch_cluster_event(
        session_key="sess-gw",
        text="[cluster:node_lost] node lost",
        route_mode="guide",
    ) is True
    assert agent.steered == ["[cluster:node_lost] node lost"]

    assert runner.dispatch_cluster_event(
        session_key="sess-gw",
        text="[cluster:config_mismatch] bad config",
        route_mode="interrupt",
    ) is True
    assert agent.interrupted == ["[cluster:config_mismatch] bad config"]

    assert runner.dispatch_cluster_event(
        session_key="sess-gw",
        text="[cluster:job_failed] boom",
        route_mode="queue",
    ) is True
    pending = runner.adapters["test-platform"]._pending_messages
    assert pending["sess-gw"].text == "[cluster:job_failed] boom"
