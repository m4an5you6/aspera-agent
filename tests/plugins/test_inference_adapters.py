"""Tests for inference_adapters plugin and cluster inference job_kind."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from plugins.cluster.config import ClusterConfig, load_cluster_config
from plugins.cluster.controller import ClusterController
from plugins.cluster.events import ClusterEventBridge
from plugins.cluster.cluster_logging import ClusterLogger
from plugins.cluster.models import GpuInfo, JobSpec, NodeRecord
from plugins.cluster.runtime import start_embedded_worker, stop_embedded_worker
from plugins.cluster.store import MemoryClusterStore
from plugins.cluster.tools import set_runtime
from plugins.cluster.training import validate_job_spec
from plugins.inference_adapters.bootstrap import (
    plan_deploy_bootstrap,
    render_dotenv,
    render_master_config,
    render_worker_config,
    write_node_files,
)
from plugins.inference_adapters.hf_vllm import HfVllmAdapter
from plugins.inference_adapters.registry import create_adapter, list_adapters, register_adapter
from plugins.inference_adapters.runtime import run_inference_lifecycle
from plugins.inference_adapters.spec import extract_job_kind, validate_inference_spec
from plugins.inference_adapters.base import ArtifactPaths, EndpointInfo, ModelAdapter


@pytest.fixture(autouse=True)
def _env(tmp_path, monkeypatch):
    home = tmp_path / ".gpucloud"
    home.mkdir()
    monkeypatch.setenv("GPUCLOUD_HOME", str(home))
    monkeypatch.setenv("GPUCLOUD_CLUSTER_FORCE", "1")
    monkeypatch.setenv("GPUCLOUD_CLUSTER_DATA_DIR", str(tmp_path / "cluster-data"))
    # Ensure hf_vllm registered
    import plugins.inference_adapters.hf_vllm  # noqa: F401
    yield
    stop_embedded_worker()


def test_extract_job_kind_defaults_training():
    assert extract_job_kind({}) == "training"
    assert extract_job_kind({"job_kind": "inference"}) == "inference"
    assert extract_job_kind({"extra": {"job_kind": "inference"}}) == "inference"


def test_validate_inference_spec_requires_adapter():
    errors, norm = validate_inference_spec({"job_kind": "inference"})
    assert errors
    assert "adapter_id" in errors[0]


def test_validate_job_spec_inference_branch():
    result = validate_job_spec(
        {
            "job_kind": "inference",
            "adapter_id": "hf_vllm",
            "model": {"local_path": "/tmp/model"},
            "nnodes": 1,
            "nproc_per_node": 1,
        }
    )
    assert result.ok
    assert result.normalized["job_kind"] == "inference"
    assert result.normalized["framework"] == "inference"
    assert result.normalized["extra"]["adapter_id"] == "hf_vllm"


def test_hf_vllm_registered():
    assert "hf_vllm" in list_adapters()
    ad = create_adapter("hf_vllm")
    assert isinstance(ad, HfVllmAdapter)


def test_hf_vllm_validate_and_ensure(tmp_path):
    model_dir = tmp_path / "hf-model"
    model_dir.mkdir()
    (model_dir / "config.json").write_text("{}", encoding="utf-8")
    ad = HfVllmAdapter()
    spec = {
        "model": {"local_path": str(model_dir)},
        "serve": {"port": 8000},
        "gpus": {"tensor_parallel": 1},
    }
    assert ad.validate(spec) == []
    arts = ad.ensure_artifacts(spec)
    assert Path(arts.model_path).exists()


def test_bootstrap_requires_llm_key():
    with pytest.raises(ValueError, match="llm_api_key"):
        plan_deploy_bootstrap(
            master_node_id="m1",
            worker_node_ids=[],
            master_url="http://127.0.0.1:8765",
            llm_api_key="",
            cluster_secret="sec",
        )


def test_bootstrap_templates_and_write(tmp_path):
    master = render_master_config(
        llm_api_key="sk-test",
        cluster_secret="sec",
        inference_api_key="inf",
        model_provider="openrouter",
        model_default="test-model",
        node_id="master-a",
        master_url="http://10.0.0.1:8765",
    )
    assert "embedded_master: true" in master
    assert "embedded_worker: true" in master
    assert "node_id: master-a" in master
    assert "http://10.0.0.1:8765" in master
    assert "master_url:" in master
    assert "api_key:" in master
    assert "sk-test" in master
    assert "secret:" in master
    assert "serve_api_key:" in master
    worker = render_worker_config(
        master_url="http://10.0.0.1:8765",
        node_id="gpu-1",
        llm_api_key="sk-test",
        cluster_secret="sec",
    )
    assert "embedded_worker: true" in worker
    assert "api_key:" in worker
    paths = write_node_files(tmp_path / "home", config_yaml=master)
    assert Path(paths["config"]).exists()
    assert "env" not in paths

    plan = plan_deploy_bootstrap(
        master_node_id="m1",
        worker_node_ids=["w1"],
        master_url="http://10.0.0.1:8765",
        llm_api_key="sk-test",
        cluster_secret="sec",
    )
    assert plan["master"]["role"] == "master"
    assert plan["workers"][0]["node_id"] == "w1"
    assert "api_key:" in plan["master"]["config_yaml"]
    assert "embedded_worker: true" in plan["master"]["config_yaml"]
    assert "node_id: m1" in plan["master"]["config_yaml"]
    assert "master_url:" in plan["master"]["config_yaml"]
    assert "sk-test" in plan["master"]["script"]
    assert plan["master"]["dotenv"] == ""
    assert any("embedded_worker" in n for n in plan["notes"])


def test_bootstrap_optional_dotenv():
    dotenv = render_dotenv(llm_api_key="sk-test", cluster_secret="sec", inference_api_key="inf")
    assert "OPENROUTER_API_KEY=sk-test" in dotenv
    assert "GPUCLOUD_CLUSTER_SECRET=sec" in dotenv


def test_load_cluster_config_inline_secret(tmp_path, monkeypatch):
    monkeypatch.setenv("GPUCLOUD_HOME", str(tmp_path / ".gpucloud"))
    monkeypatch.delenv("GPUCLOUD_CLUSTER_SECRET", raising=False)
    cfg = load_cluster_config(
        {
            "enabled": True,
            "secret": "from-config",
            "role": "master",
        }
    )
    assert cfg.secret == "from-config"
    monkeypatch.setenv("GPUCLOUD_CLUSTER_SECRET", "from-env")
    cfg2 = load_cluster_config({"enabled": True, "secret": "from-config"})
    assert cfg2.secret == "from-env"


def test_load_cluster_config_embedded_worker(tmp_path, monkeypatch):
    monkeypatch.setenv("GPUCLOUD_HOME", str(tmp_path / ".gpucloud"))
    cfg = load_cluster_config(
        {
            "enabled": True,
            "embedded_worker": True,
            "role": "worker",
            "master_url": "http://127.0.0.1:8765",
        }
    )
    assert cfg.embedded_worker is True


def test_controller_submit_inference(tmp_path):
    from plugins.inference_adapters.experience import reset_experience_store_for_tests

    reset_experience_store_for_tests()
    cfg = ClusterConfig(
        enabled=True,
        role="master",
        node_id="master",
        master_url="http://127.0.0.1:8765",
        data_dir=tmp_path / "data",
        heartbeat_ttl_sec=30,
    )
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    store = MemoryClusterStore()
    store.ensure_schema()
    logger = ClusterLogger(cfg, store)
    events = ClusterEventBridge(cfg, store)
    controller = ClusterController(cfg, store, logger, events)
    set_runtime(controller=controller, store=store, logger=logger, events=events)

    caps = {
        "probe_version": 1,
        "probe_ok": True,
        "python_executable": "/usr/bin/python3",
        "python_version": "3.10.12",
        "nvidia_driver": "535.0",
        "cuda_driver_major": 12,
        "cuda_driver_minor": 2,
        "torch_available": False,
        "vllm_available": False,
        "gpu_count": 1,
    }
    store.upsert_node(
        NodeRecord(
            node_id="gpu-node-03",
            advertised_addr="10.0.0.3",
            state="ready",
            gpus=[GpuInfo(index=0, name="GPU", memory_mb=24000)],
            capabilities=dict(caps),
        )
    )
    from plugins.cluster.models import HeartbeatPayload

    store.record_heartbeat(
        HeartbeatPayload(
            node_id="gpu-node-03",
            state="ready",
            gpus=[GpuInfo(index=0)],
            metrics=dict(caps),
        )
    )

    result = controller.submit_job(
        {
            "job_kind": "inference",
            "adapter_id": "hf_vllm",
            "model": {"local_path": "/data/model"},
            "gpus": {"node_ids": ["gpu-node-03"], "visible_devices": [0], "tensor_parallel": 1},
            "serve": {"port": 8000},
            "nnodes": 1,
            "nproc_per_node": 1,
        }
    )
    assert result["success"] is True
    assert result["job"]["spec"]["job_kind"] == "inference"
    assert result["assignments"][0]["node_id"] == "gpu-node-03"
    extra = result["job"]["spec"]["extra"]
    # Default driver=agent: no forced RuntimeScheme embed
    assert extra.get("inference_driver") == "agent"
    assert "runtime_scheme" not in extra
    assert extra["inference_spec"]["model"]["local_path"] == "/data/model"


def test_controller_submit_inference_legacy_scheme_embeds_runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("GPUCLOUD_HOME", str(tmp_path / ".gpucloud"))
    monkeypatch.setattr(
        "plugins.inference_adapters.agent_driver.get_inference_driver",
        lambda: "legacy_scheme",
    )
    cfg = ClusterConfig(
        enabled=True,
        role="master",
        node_id="master",
        master_url="http://127.0.0.1:8765",
        data_dir=tmp_path / "data",
        heartbeat_ttl_sec=30,
    )
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    store = MemoryClusterStore()
    store.ensure_schema()
    logger = ClusterLogger(cfg, store)
    events = ClusterEventBridge(cfg, store)
    controller = ClusterController(cfg, store, logger, events)
    set_runtime(controller=controller, store=store, logger=logger, events=events)

    caps = {
        "probe_version": 1,
        "probe_ok": True,
        "python_executable": "/usr/bin/python3",
        "python_version": "3.10.12",
        "nvidia_driver": "535.0",
        "cuda_driver_major": 12,
        "cuda_driver_minor": 2,
        "torch_available": False,
        "vllm_available": False,
        "gpu_count": 1,
    }
    store.upsert_node(
        NodeRecord(
            node_id="gpu-node-03",
            advertised_addr="10.0.0.3",
            state="ready",
            gpus=[GpuInfo(index=0, name="GPU", memory_mb=24000)],
            capabilities=dict(caps),
        )
    )
    from plugins.cluster.models import HeartbeatPayload

    store.record_heartbeat(
        HeartbeatPayload(
            node_id="gpu-node-03",
            state="ready",
            gpus=[GpuInfo(index=0)],
            metrics=dict(caps),
        )
    )

    result = controller.submit_job(
        {
            "job_kind": "inference",
            "adapter_id": "hf_vllm",
            "model": {"local_path": "/data/model"},
            "gpus": {"node_ids": ["gpu-node-03"], "visible_devices": [0], "tensor_parallel": 1},
            "serve": {"port": 8000},
            "nnodes": 1,
            "nproc_per_node": 1,
        }
    )
    assert result["success"] is True
    extra = result["job"]["spec"]["extra"]
    assert extra.get("inference_driver") == "legacy_scheme"
    assert "runtime_scheme" in extra
    scheme = extra["runtime_scheme"]
    assert isinstance(scheme.get("tasks"), list) and scheme["tasks"]
    assert extra["inference_spec"]["runtime"]["scheme"]["scheme_id"] == scheme["scheme_id"]


def test_run_lifecycle_with_fake_adapter():
    class FakeAdapter(ModelAdapter):
        adapter_id = "fake_test"

        def validate(self, spec):
            return []

        def ensure_artifacts(self, spec):
            return ArtifactPaths(model_path="/tmp/m")

        def start(self, spec, artifacts):
            return EndpointInfo(host="127.0.0.1", port=9)

        def health(self):
            return "ready"

        def stop(self):
            return None

    register_adapter(FakeAdapter)
    outcomes = []

    def on_outcome(ok, summary, details):
        outcomes.append((ok, summary, details))

    result = run_inference_lifecycle(
        job_spec={"job_kind": "inference", "adapter_id": "fake_test", "extra": {"adapter_id": "fake_test", "inference_spec": {"adapter_id": "fake_test"}}},
        on_outcome=on_outcome,
        adapter=FakeAdapter(),
    )
    assert result["success"] is True
    assert outcomes and outcomes[0][0] is True


def test_start_embedded_worker_respects_flag(tmp_path, monkeypatch):
    monkeypatch.setenv("GPUCLOUD_HOME", str(tmp_path / ".gpucloud"))
    monkeypatch.setenv("GPUCLOUD_CLUSTER_DATA_DIR", str(tmp_path / "cdata"))

    with patch("plugins.cluster.runtime.load_cluster_config") as load_cfg:
        load_cfg.return_value = ClusterConfig(
            enabled=True,
            embedded_worker=False,
            role="worker",
            node_id="w1",
            master_url="http://127.0.0.1:8765",
            data_dir=tmp_path / "cdata",
        )
        assert start_embedded_worker() is None

    with patch("plugins.cluster.runtime.load_cluster_config") as load_cfg, patch(
        "plugins.cluster.runtime.build_runtime"
    ) as build:
        cfg = ClusterConfig(
            enabled=True,
            embedded_worker=True,
            role="worker",
            node_id="w1",
            master_url="http://127.0.0.1:8765",
            data_dir=tmp_path / "cdata",
        )
        load_cfg.return_value = cfg
        store = MemoryClusterStore()
        store.ensure_schema()
        logger = ClusterLogger(cfg, store)
        events = ClusterEventBridge(cfg, store)
        controller = ClusterController(cfg, store, logger, events)
        from plugins.cluster.runtime import ClusterRuntime

        build.return_value = ClusterRuntime(
            cfg=cfg, store=store, logger=logger, events=events, controller=controller
        )
        with patch.object(
            __import__("plugins.cluster.node_agent", fromlist=["NodeAgent"]).NodeAgent,
            "run_loop",
            lambda self: None,
        ):
            agent = start_embedded_worker()
            assert agent is not None
            stop_embedded_worker()


def test_start_embedded_worker_on_master_role(tmp_path, monkeypatch):
    """GPU master configs dual-enable: role=master + embedded_worker starts NodeAgent."""
    monkeypatch.setenv("GPUCLOUD_HOME", str(tmp_path / ".gpucloud"))
    monkeypatch.setenv("GPUCLOUD_CLUSTER_DATA_DIR", str(tmp_path / "cdata"))

    with patch("plugins.cluster.runtime.load_cluster_config") as load_cfg, patch(
        "plugins.cluster.runtime.build_runtime"
    ) as build:
        cfg = ClusterConfig(
            enabled=True,
            embedded_master=True,
            embedded_worker=True,
            role="master",
            node_id="master-a",
            master_url="http://127.0.0.1:8765",
            data_dir=tmp_path / "cdata",
        )
        load_cfg.return_value = cfg
        store = MemoryClusterStore()
        store.ensure_schema()
        logger = ClusterLogger(cfg, store)
        events = ClusterEventBridge(cfg, store)
        controller = ClusterController(cfg, store, logger, events)
        from plugins.cluster.runtime import ClusterRuntime

        build.return_value = ClusterRuntime(
            cfg=cfg, store=store, logger=logger, events=events, controller=controller
        )
        with patch.object(
            __import__("plugins.cluster.node_agent", fromlist=["NodeAgent"]).NodeAgent,
            "run_loop",
            lambda self: None,
        ):
            agent = start_embedded_worker()
            assert agent is not None
            assert agent.cfg.role == "master"
            assert agent.cfg.node_id == "master-a"
            stop_embedded_worker()


def _caps(**overrides):
    base = {
        "probe_version": 1,
        "probe_ok": True,
        "python_executable": "/usr/bin/python3",
        "python_version": "3.10.12",
        "nvidia_driver": "535.0",
        "cuda_driver_major": 12,
        "cuda_driver_minor": 2,
        "torch_available": False,
        "torch_version": "",
        "vllm_available": False,
        "vllm_version": "",
        "gpu_count": 1,
    }
    base.update(overrides)
    return base


def test_probe_ready_and_select_scheme():
    from plugins.cluster.node_capabilities import probe_ready
    from plugins.inference_adapters.experience import ExperienceStore, reset_experience_store_for_tests
    from plugins.inference_adapters.runtime_scheme import select_initial_scheme

    reset_experience_store_for_tests()
    assert probe_ready(_caps()) is True
    assert probe_ready({"probe_version": 1, "python_executable": "", "gpu_count": 1}) is False

    scheme, errs = select_initial_scheme(_caps(), adapter_id="hf_vllm")
    assert not errs
    assert scheme and scheme["scheme_id"].startswith("hf_vllm.cu12")
    assert isinstance(scheme["tasks"], list)

    # already satisfied preferred
    scheme2, errs2 = select_initial_scheme(
        _caps(torch_available=True, vllm_available=True, vllm_version="0.6.6", torch_version="2.5.1"),
        adapter_id="hf_vllm",
    )
    assert not errs2
    assert "satisfied" in scheme2["reason"] or scheme2["scheme_id"]

    bad, errs_bad = select_initial_scheme(_caps(cuda_driver_major=11), adapter_id="hf_vllm")
    assert bad is None
    assert any("no_scheme_match" in e for e in errs_bad)


def test_task_runner_skips_ensure_when_available(monkeypatch):
    from plugins.inference_adapters.runtime_scheme import instantiate_scheme, get_scheme_templates
    from plugins.inference_adapters.task_runner import run_scheme_tasks

    template = get_scheme_templates()[0]
    scheme = instantiate_scheme(template, reason="test")
    facts = {
        "python_executable": "python3",
        "torch_available": True,
        "vllm_available": True,
        "extras_missing": False,
    }

    # probe should refresh facts; stub probe to keep satisfied flags
    import plugins.inference_adapters.task_runner as tr

    def fake_probe(py, facts_dict):
        facts_dict.update(
            {
                "torch_available": True,
                "vllm_available": True,
                "python_version": "3.10.12",
                "extras_missing": False,
            }
        )

    monkeypatch.setattr(tr, "_probe_into_facts", fake_probe)
    pip_calls = []

    def fake_pip(*a, **k):
        pip_calls.append((a, k))
        return True, ""

    monkeypatch.setattr(tr, "_run_pip_install", fake_pip)
    monkeypatch.setattr(tr, "_verify_imports", lambda *a, **k: (True, ""))

    result = run_scheme_tasks(scheme, initial_facts=facts, max_replan_attempts=3)
    assert "probe_stack" in result.completed_task_ids or "probe_stack" in result.skipped_task_ids
    # ensure_* should be skipped because when=false
    assert "ensure_torch" in result.skipped_task_ids
    assert "ensure_vllm" in result.skipped_task_ids
    assert pip_calls == []


def test_task_runner_replan_callback(monkeypatch):
    from plugins.inference_adapters.task_runner import NeedsReplan, run_scheme_tasks

    scheme = {
        "scheme_id": "s1",
        "mirror_profile": "default",
        "constraints": {"allow_install": True, "forbid_unpinned": True},
        "replan_generation": 0,
        "tasks": [
            {"id": "ensure_vllm", "type": "ensure_package", "pin_ref": "matrix:missing/vllm", "when": "always"},
            {"id": "verify_stack", "type": "verify", "imports": ["vllm"]},
        ],
    }

    import plugins.inference_adapters.task_runner as tr

    monkeypatch.setattr(tr, "_probe_into_facts", lambda *a, **k: None)

    calls = {"n": 0}

    def replan(needs: NeedsReplan):
        calls["n"] += 1
        assert needs.failed_task_id == "ensure_vllm"
        return {
            "scheme_id": "s2",
            "mirror_profile": "default",
            "constraints": {"allow_install": True},
            "replan_generation": 1,
            "tasks": [
                {"id": "verify_stack", "type": "verify", "imports": ["vllm"]},
            ],
        }

    monkeypatch.setattr(tr, "_verify_imports", lambda *a, **k: (True, ""))
    result = run_scheme_tasks(
        scheme,
        initial_facts={"python_executable": "python3"},
        replan_callback=replan,
        max_replan_attempts=5,
    )
    assert calls["n"] == 1
    assert "verify_stack" in result.completed_task_ids


def test_experience_shared_across_lookups(tmp_path):
    from plugins.inference_adapters.experience import ExperienceStore, facts_fingerprint

    store = ExperienceStore(tmp_path / "exp.sqlite")
    caps = _caps(torch_available=True, vllm_available=True, vllm_version="0.6.6")
    tasks = [{"id": "verify_stack", "type": "verify", "imports": ["vllm"]}]
    store.record(
        facts=caps,
        scheme_id="hf_vllm.cu12.py310",
        tasks=tasks,
        outcome="success",
        mirror_profile="default",
    )
    hit = store.best_success(caps)
    assert hit is not None
    assert hit.scheme_id == "hf_vllm.cu12.py310"
    assert hit.effective_tasks == tasks
    assert facts_fingerprint(caps) == hit.facts_fingerprint

    store.record(
        facts=caps,
        scheme_id="hf_vllm.cu12.py310",
        tasks=tasks,
        outcome="fail",
        failed_task_id="ensure_vllm",
        error="no matching distribution",
    )
    assert store.is_known_failure(
        caps, scheme_id="hf_vllm.cu12.py310", failed_task_id="ensure_vllm", error="no matching distribution"
    )


def test_controller_capabilities_incomplete(tmp_path):
    from plugins.inference_adapters.experience import reset_experience_store_for_tests

    reset_experience_store_for_tests()
    cfg = ClusterConfig(
        enabled=True,
        role="master",
        node_id="master",
        master_url="http://127.0.0.1:8765",
        data_dir=tmp_path / "data",
        heartbeat_ttl_sec=30,
    )
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    store = MemoryClusterStore()
    store.ensure_schema()
    logger = ClusterLogger(cfg, store)
    events = ClusterEventBridge(cfg, store)
    controller = ClusterController(cfg, store, logger, events)

    store.upsert_node(
        NodeRecord(
            node_id="gpu-node-03",
            advertised_addr="10.0.0.3",
            state="ready",
            gpus=[GpuInfo(index=0)],
            capabilities={},
        )
    )
    from plugins.cluster.models import HeartbeatPayload

    store.record_heartbeat(HeartbeatPayload(node_id="gpu-node-03", state="ready", gpus=[GpuInfo(index=0)]))

    result = controller.submit_job(
        {
            "job_kind": "inference",
            "adapter_id": "hf_vllm",
            "model": {"local_path": "/data/model"},
            "gpus": {"node_ids": ["gpu-node-03"]},
            "nnodes": 1,
            "nproc_per_node": 1,
        }
    )
    assert result["success"] is False
    assert any("capabilities_incomplete" in e for e in result["errors"])


def test_controller_replan_and_experience(tmp_path, monkeypatch):
    from plugins.inference_adapters.experience import reset_experience_store_for_tests

    reset_experience_store_for_tests()
    monkeypatch.setattr(
        "plugins.inference_adapters.agent_driver.get_inference_driver",
        lambda: "legacy_scheme",
    )
    cfg = ClusterConfig(
        enabled=True,
        role="master",
        node_id="master",
        master_url="http://127.0.0.1:8765",
        data_dir=tmp_path / "data",
        heartbeat_ttl_sec=30,
    )
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    store = MemoryClusterStore()
    store.ensure_schema()
    logger = ClusterLogger(cfg, store)
    events = ClusterEventBridge(cfg, store)
    controller = ClusterController(cfg, store, logger, events)

    caps = _caps()
    store.upsert_node(
        NodeRecord(
            node_id="gpu-node-03",
            advertised_addr="10.0.0.3",
            state="ready",
            gpus=[GpuInfo(index=0)],
            capabilities=dict(caps),
        )
    )
    from plugins.cluster.models import HeartbeatPayload

    store.record_heartbeat(
        HeartbeatPayload(node_id="gpu-node-03", state="ready", gpus=[GpuInfo(index=0)], metrics=dict(caps))
    )

    submitted = controller.submit_job(
        {
            "job_kind": "inference",
            "adapter_id": "hf_vllm",
            "model": {"local_path": "/data/model"},
            "gpus": {"node_ids": ["gpu-node-03"]},
            "nnodes": 1,
            "nproc_per_node": 1,
        }
    )
    assert submitted["success"]
    job_id = submitted["job"]["job_id"]
    gen0 = submitted["job"]["spec"]["extra"]["runtime_scheme"]["replan_generation"]

    replanned = controller.handle_replan(
        job_id,
        failed_task_id="ensure_vllm",
        error="no matching distribution found for vllm",
        facts=caps,
        completed_task_ids=["probe_stack"],
        node_id="gpu-node-03",
    )
    assert replanned["success"] is True
    assert replanned["scheme"]["replan_generation"] == gen0 + 1
    assert store.get_job(job_id).spec.extra["replan_attempts"] == 1


def test_lifecycle_ensure_runtime_fail_phase():
    from plugins.inference_adapters.task_runner import NeedsReplan

    class BoomAdapter(ModelAdapter):
        adapter_id = "boom_rt"

        def validate(self, spec):
            return []

        def ensure_runtime(self, spec):
            raise NeedsReplan(failed_task_id="ensure_vllm", error="boom", facts={})

        def ensure_artifacts(self, spec):
            return ArtifactPaths(model_path="/tmp/m")

        def start(self, spec, artifacts):
            return EndpointInfo(host="127.0.0.1", port=9)

        def health(self):
            return "ready"

        def stop(self):
            return None

    register_adapter(BoomAdapter)
    outcomes = []

    def on_outcome(ok, summary, details):
        outcomes.append((ok, summary, details))

    result = run_inference_lifecycle(
        job_spec={
            "job_kind": "inference",
            "adapter_id": "boom_rt",
            "extra": {"adapter_id": "boom_rt", "inference_spec": {"adapter_id": "boom_rt"}},
        },
        on_outcome=on_outcome,
        adapter=BoomAdapter(),
    )
    assert result["success"] is False
    assert outcomes[0][2]["phase"] == "ensure_runtime"


def test_classify_error_timeout_and_import_failed():
    from plugins.inference_adapters.experience import classify_error

    assert classify_error("pip timeout after 1800s (no progress)") == "timeout"
    assert classify_error("pip timeout after 30s: ...") == "timeout"
    assert classify_error("import_failed:vllm:No module named 'vllm'") == "import_failed"
    assert classify_error("ModuleNotFoundError: No module named 'torch'") == "import_failed"
    assert classify_error("no matching distribution found for vllm") == "no_wheel"
    assert classify_error("ResolutionImpossible") == "conflict"


def test_amend_scheme_refuses_timeout_keeps_matrix():
    from plugins.inference_adapters.runtime_scheme import amend_scheme_for_replan

    current = {
        "scheme_id": "hf_vllm.cu12.py310",
        "matrix_id": "cu12-py310",
        "adapter_id": "hf_vllm",
        "replan_generation": 0,
        "mirror_profile": "default",
        "tasks": [
            {
                "id": "ensure_vllm",
                "type": "ensure_package",
                "pin_ref": "matrix:cu12-py310/vllm",
                "when": "always",
            }
        ],
    }
    facts = {
        "cuda_major": 12,
        "python_version": "3.10.12",
        "torch_available": False,
        "vllm_available": False,
    }
    scheme, errs = amend_scheme_for_replan(
        current,
        facts=facts,
        failed_task_id="ensure_vllm",
        error="pip timeout after 1800s (no progress)",
        attempted_scheme_ids=["hf_vllm.cu12.py310", "hf_vllm.cu12.py311"],
    )
    assert scheme is None
    assert errs and errs[0].startswith("replan_refused:timeout")
    assert current["matrix_id"] == "cu12-py310"


def test_amend_scheme_no_wheel_can_switch_matrix():
    from plugins.inference_adapters.runtime_scheme import (
        amend_scheme_for_replan,
        get_scheme_templates,
    )

    attempted = [str(t.get("scheme_id") or "") for t in get_scheme_templates()]
    current = {
        "scheme_id": attempted[0] if attempted else "hf_vllm.cu12.py310",
        "matrix_id": "cu12-py310",
        "adapter_id": "hf_vllm",
        "replan_generation": 1,
        "mirror_profile": "default",
        "tasks": [
            {
                "id": "ensure_vllm",
                "type": "ensure_package",
                "pin_ref": "matrix:cu12-py310/vllm",
                "when": "always",
            }
        ],
    }
    facts = {
        "cuda_major": 12,
        "python_version": "3.10.12",
        "torch_available": True,
        "vllm_available": False,
    }
    scheme, errs = amend_scheme_for_replan(
        current,
        facts=facts,
        failed_task_id="ensure_vllm",
        error="no matching distribution found for vllm==0.6.6",
        attempted_scheme_ids=attempted,
    )
    assert not errs
    assert scheme is not None
    assert scheme["matrix_id"] != "cu12-py310"
    assert "replan_switch_matrix" in str(scheme.get("reason") or "")


def test_run_pip_install_idle_timeout_renewed_by_output(monkeypatch):
    """Intermittent pip output renews idle timer; total elapsed may exceed idle."""
    import plugins.inference_adapters.task_runner as tr

    class FakeStream:
        def __init__(self, lines):
            self._lines = list(lines)
            self._i = 0

        def readline(self):
            if self._i < len(self._lines):
                line = self._lines[self._i]
                self._i += 1
                return line
            return ""

        def read(self):
            rest = "".join(self._lines[self._i :])
            self._i = len(self._lines)
            return rest

    class FakeProc:
        def __init__(self):
            self.pid = 12345
            self.stdout = FakeStream(
                [
                    "Collecting torch\n",
                    "Downloading torch-2.5.1.whl (100 MB)\n",
                    "Installing collected packages: torch\n",
                    "Successfully installed torch-2.5.1\n",
                ]
            )
            self.stderr = FakeStream([])
            self.returncode = 0
            self._polls = 0

        def poll(self):
            self._polls += 1
            # Stay alive until a few select loops have consumed lines.
            if self._polls < 6:
                return None
            return 0

        def wait(self, timeout=None):
            return 0

        def terminate(self):
            self.returncode = -15

        def kill(self):
            self.returncode = -9

    clock = {"t": 0.0}

    def fake_monotonic():
        return clock["t"]

    def fake_select(r, w, x, timeout=0):
        # Advance clock a bit each select, but less than idle if output arrives.
        clock["t"] += 0.4
        ready = []
        for stream in r:
            if isinstance(stream, FakeStream) and stream._i < len(stream._lines):
                ready.append(stream)
        return ready, [], []

    monkeypatch.setattr(tr.time, "monotonic", fake_monotonic)
    monkeypatch.setattr(tr.select, "select", fake_select)
    monkeypatch.setattr(
        tr.subprocess,
        "Popen",
        lambda *a, **k: FakeProc(),
    )
    monkeypatch.setattr(tr, "_kill_pip_process", lambda proc: None)
    monkeypatch.setattr(tr, "_mirror_env_and_args", lambda *_a, **_k: ({}, []))

    bumps = {"n": 0}

    def on_progress():
        bumps["n"] += 1

    # Idle limit 1s; total simulated time will exceed 1s but progress renews.
    ok, err = tr._run_pip_install(
        "python3",
        ["torch==2.5.1"],
        timeout=1.0,
        on_progress=on_progress,
    )
    assert ok is True
    assert err == ""
    assert bumps["n"] >= 1
    assert clock["t"] > 1.0  # total elapsed exceeded idle, yet succeeded


def test_run_scheme_tasks_no_progress_wall_renewed(monkeypatch):
    """Wall is idle-based: progress bumps prevent no_progress_wall during slow work."""
    from plugins.inference_adapters.task_runner import run_scheme_tasks
    import plugins.inference_adapters.task_runner as tr

    scheme = {
        "scheme_id": "s1",
        "mirror_profile": "default",
        "constraints": {"allow_install": True},
        "replan_generation": 0,
        "tasks": [
            {"id": "ensure_torch", "type": "ensure_package", "pin": "torch==2.5.1", "when": "always"},
            {"id": "verify_stack", "type": "verify", "imports": ["torch"]},
        ],
    }

    clock = {"t": 0.0}
    monkeypatch.setattr(tr.time, "monotonic", lambda: clock["t"])
    monkeypatch.setattr(tr, "_probe_into_facts", lambda *a, **k: None)
    monkeypatch.setattr(tr, "_verify_imports", lambda *a, **k: (True, ""))

    def slow_pip(*a, **k):
        on_progress = k.get("on_progress")
        # Simulate long install with intermittent progress beyond wall if absolute.
        for _ in range(5):
            clock["t"] += 0.5
            if on_progress:
                on_progress()
        clock["t"] += 0.1
        return True, ""

    monkeypatch.setattr(tr, "_run_pip_install", slow_pip)

    # Wall of 1.0s would fail if absolute from start (total ~2.6s), but renews.
    result = run_scheme_tasks(
        scheme,
        initial_facts={"python_executable": "python3"},
        max_replan_attempts=2,
        max_replan_wall_seconds=1.0,
    )
    assert "ensure_torch" in result.completed_task_ids
    assert "verify_stack" in result.completed_task_ids


def test_run_scheme_tasks_idle_wall_fires_on_next_loop(monkeypatch):
    """Idle wall trips at loop top after progress stops renewing."""
    from plugins.inference_adapters.task_runner import NeedsReplan, run_scheme_tasks
    import plugins.inference_adapters.task_runner as tr

    scheme = {
        "scheme_id": "s1",
        "tasks": [
            # Skipped when vllm already available → counts as progress once.
            {
                "id": "ensure_vllm",
                "type": "ensure_package",
                "pin": "vllm==0.6.6",
                "when": "not facts.vllm_available",
            },
            # Never runnable → keeps the outer while alive after the skip.
            {
                "id": "blocked",
                "type": "probe",
                "when": "always",
                "after": ["never_done"],
            },
        ],
    }

    # monotonic() call order:
    # 1) init last_progress_at
    # 2) wall check (iter 1)
    # 3) bump on skip
    # 4) wall check (iter 2) → idle exceeded
    times = [0.0, 0.0, 0.0, 100.0, 100.0, 100.0]

    def mono():
        return times.pop(0) if times else 100.0

    monkeypatch.setattr(tr.time, "monotonic", mono)
    monkeypatch.setattr(tr, "_probe_into_facts", lambda *a, **k: None)

    with pytest.raises(NeedsReplan) as ei:
        run_scheme_tasks(
            scheme,
            initial_facts={
                "python_executable": "python3",
                "vllm_available": True,
            },
            max_replan_wall_seconds=1.0,
        )
    assert ei.value.error == "replan_exhausted:no_progress_wall"


def test_controller_multinode_placements_and_outcome_gating(tmp_path, monkeypatch):
    monkeypatch.setenv("GPUCLOUD_HOME", str(tmp_path / ".gpucloud"))
    cfg = ClusterConfig(
        enabled=True,
        role="master",
        node_id="master",
        master_url="http://127.0.0.1:8765",
        data_dir=tmp_path / "data",
        heartbeat_ttl_sec=30,
    )
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    store = MemoryClusterStore()
    store.ensure_schema()
    logger = ClusterLogger(cfg, store)
    events = ClusterEventBridge(cfg, store)
    controller = ClusterController(cfg, store, logger, events)
    set_runtime(controller=controller, store=store, logger=logger, events=events)

    caps = {
        "probe_version": 1,
        "probe_ok": True,
        "python_executable": "/usr/bin/python3",
        "python_version": "3.10.12",
        "nvidia_driver": "535.0",
        "cuda_driver_major": 12,
        "cuda_driver_minor": 2,
        "torch_available": True,
        "vllm_available": True,
        "gpu_count": 1,
    }
    for nid, addr in (("node5", "10.0.21.105"), ("node1", "10.0.20.185")):
        store.upsert_node(
            NodeRecord(
                node_id=nid,
                advertised_addr=addr,
                state="ready",
                gpus=[GpuInfo(index=0, name="GPU", memory_mb=24000)],
                capabilities=dict(caps),
            )
        )
        from plugins.cluster.models import HeartbeatPayload

        store.record_heartbeat(
            HeartbeatPayload(
                node_id=nid,
                state="ready",
                gpus=[GpuInfo(index=0)],
                metrics=dict(caps),
            )
        )

    result = controller.submit_job(
        {
            "job_kind": "inference",
            "adapter_id": "hf_vllm",
            "model": {"local_path": "/data/model"},
            "nnodes": 2,
            "nproc_per_node": 1,
            "gpus": {
                "node_ids": ["node5", "node1"],
                "tensor_parallel": 2,
                "visible_devices": [0],
                "placements": [
                    {"node_id": "node5", "visible_devices": [0]},
                    {"node_id": "node1", "visible_devices": [0]},
                ],
            },
            "ray": {"enabled": True, "head_node_id": "node5", "head_port": 6413},
            "serve": {"port": 8000},
        }
    )
    assert result["success"] is True
    asgs = sorted(result["assignments"], key=lambda a: a["node_rank"])
    assert len(asgs) == 2
    assert asgs[0]["node_id"] == "node5"
    assert asgs[0]["gpus"] == [0]
    assert asgs[1]["node_id"] == "node1"
    assert asgs[0]["job_spec"]["extra"]["inference_spec"]["node_rank"] == 0
    assert asgs[1]["job_spec"]["extra"]["inference_spec"]["local_visible_devices"] == [0]
    assert asgs[0]["job_spec"]["extra"]["inference_spec"]["ray"]["enabled"] is True

    job_id = result["job"]["job_id"]
    # Rank0 ready before workers → rejected
    early = controller.report_job_outcome(
        job_id,
        success=True,
        summary="too early",
        node_id="node5",
        details={"phase": "ready", "visit_host": "10.0.21.105", "visit_port": 8000},
    )
    assert early.get("accepted") is False
    assert early.get("error") == "workers_not_ready"
    assert store.get_job(job_id).state == "running"

    worker = controller.report_job_outcome(
        job_id,
        success=True,
        summary="worker ok",
        node_id="node1",
        details={"phase": "worker_ready"},
    )
    assert worker.get("accepted") is True
    assert worker.get("phase") == "worker_ready"
    assert store.get_job(job_id).state == "running"
    w_asg = [a for a in store.list_assignments_for_job(job_id) if a.node_id == "node1"][0]
    assert w_asg.state == "worker_ready"

    ready = controller.report_job_outcome(
        job_id,
        success=True,
        summary="ready",
        node_id="node5",
        details={"phase": "ready", "visit_host": "10.0.21.105", "visit_port": 8000},
    )
    assert ready.get("accepted") is True
    assert store.get_job(job_id).state == "succeeded"


def test_hf_vllm_start_ray_and_adapter_options(tmp_path, monkeypatch):
    monkeypatch.setenv("GPUCLOUD_HOME", str(tmp_path / ".gpucloud"))
    monkeypatch.setenv("GPUCLOUD_CLUSTER_ADVERTISED_ADDR", "10.0.21.105")
    model = tmp_path / "model"
    model.mkdir()
    (model / "config.json").write_text('{"model_type":"gpt2"}')
    (model / "pytorch_model.bin").write_bytes(b"x")

    ad = HfVllmAdapter()
    captured = {}

    class _Proc:
        pid = 4242

        def poll(self):
            return None

    def fake_popen(cmd, env=None, **kwargs):
        captured["cmd"] = list(cmd)
        captured["env"] = dict(env or {})
        return _Proc()

    monkeypatch.setattr("plugins.inference_adapters.hf_vllm.subprocess.Popen", fake_popen)
    monkeypatch.setattr(
        "plugins.inference_adapters.hf_vllm.resolve_inference_python",
        lambda: "python3",
    )

    endpoint = ad.start(
        {
            "job_id": "job-ray",
            "serve": {"host": "0.0.0.0", "port": 8000},
            "gpus": {"tensor_parallel": 2, "visible_devices": [0]},
            "ray": {"enabled": True, "head_port": 6413},
            "adapter_options": {
                "trust_remote_code": True,
                "max_model_len": 4096,
                "gpu_memory_utilization": 0.9,
            },
        },
        ArtifactPaths(model_path=str(model)),
    )
    cmd = " ".join(captured["cmd"])
    assert "--tensor-parallel-size 2" in cmd
    assert "--distributed-executor-backend ray" in cmd
    assert "--trust-remote-code" in cmd
    assert "--max-model-len 4096" in cmd
    assert captured["env"].get("CUDA_VISIBLE_DEVICES") == "0"
    assert captured["env"].get("RAY_ADDRESS") == "10.0.21.105:6413"
    assert endpoint.port == 8000
