"""Storage policy regressions use synthetic small materials and explicit provider/process observations."""
import ast
import base64
import contextlib
import copy
import csv
import email
import hashlib
import io
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import types
import unittest
import uuid
import zipfile
from unittest.mock import patch


scripts = pathlib.Path(__file__).parents[1] / "scripts"
namespace = {name: value for name, value in globals().copy().items() if not name.startswith("__")}
tree = ast.parse((scripts / "managed-environment.py").read_text())
helpers = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in ("load", "save", "digest", "relative", "reject_links", "file_hash", "allocated", "now", "main", "release_references", "environment_repair", "wheel_metadata", "storage_governance", "sync_directory")]
exec(compile(ast.Module(body=helpers, type_ignores=[]), "managed-environment-helpers", "exec"), namespace)
if os.name == "nt":
    # Windows exercises the service decisions; Linux-only fsync/flock semantics are tested on Linux.
    def save_windows(path, value):
        path = pathlib.Path(path); namespace["reject_links"](path)
        path.parent.mkdir(parents=True, exist_ok=True)
        incoming = path.with_name(".incoming-" + str(uuid.uuid4()))
        try:
            incoming.write_text(json.dumps(value, sort_keys=True) + "\n")
            os.replace(incoming, path)
        finally:
            incoming.unlink(missing_ok=True)
    namespace["save"] = save_windows
    namespace["sync_directory"] = lambda _path: None
    namespace["fcntl"] = types.SimpleNamespace(LOCK_EX=1, LOCK_NB=2, LOCK_UN=8, flock=lambda *_: None)
else:
    import fcntl
    namespace["fcntl"] = fcntl
exec(compile((scripts / "storage-placement.py").read_text(), "storage-placement.py", "exec"), namespace)
exec(compile((scripts / "storage-governance.py").read_text(), "storage-governance.py", "exec"), namespace)
exec(compile((scripts / "storage-reuse.py").read_text(), "storage-reuse.py", "exec"), namespace)
exec(compile((scripts / "environment-repair.py").read_text(), "environment-repair.py", "exec"), namespace)
exec(compile((scripts / "wheel-metadata.py").read_text(), "wheel-metadata.py", "exec"), namespace)
exec(compile((scripts / "storage-preflight.py").read_text(), "storage-preflight.py", "exec"), namespace)
StorageGovernance = namespace["StorageGovernance"]
save, load, digest = namespace["save"], namespace["load"], namespace["digest"]


class Owner:
    def __init__(self, root):
        self.server, self.id = str(uuid.uuid4()), str(uuid.uuid4())
        self.control = root / "system/control"
        self.namespace = root / "data/.aspera" / self.server
        self.run = self.namespace / "runs" / self.id
        self.workspace = self.run / "workspace"
        self.operations = self.run / "environment-operations-v1"
        self.store = self.namespace / "packages-v1"
        self.placement = {"namespaceRoot": str(self.namespace), "workspaceRoot": str(self.workspace), "minimumFreeBytes": 1024}
        self.policy = {"minimumFreeBytes": 1024, "readTimeoutMs": 1000, "operationPollIntervalMs": 1, "legacyScanDepth": 16, "uvVersion": "0.13.0"}
        self.config = {"deploymentId": "a" * 64, "uvPath": "/tools/uv", "governancePolicy": {"scanTimeoutMs": 10000, "scanEntryLimit": 10000,
            "verificationTimeoutMs": 1000, "snapshotFileLimit": 1000, "materialHosts": ["huggingface.co", "hf-mirror.com", "modelscope.cn"],
            "metadataBytes": 100000, "materialFileLimit": 100, "transferChunkBytes": 65536, "networkReadTimeoutMs": 1000,
            "metadataProbeTimeoutMs": 100, "metadataWaitTimeoutMs": 10000, "materialTimeoutMs": 10000, "maxConcurrentTransfers": 1}}
        self.config["governancePolicy"]["inventoryMountPrefixes"] = ['/']
        self.config["governancePolicy"]["materialLockShards"] = 64
        for path in (self.control, self.workspace, self.operations):
            path.mkdir(parents=True)
        save(self.control / ".aspera-owner.json", {"version": 1, "serverId": self.server, "kind": "control"})
        save(self.namespace / ".aspera-owner.json", {"version": 1, "serverId": self.server, "kind": "storage"})
        save(self.run / ".aspera-owner.json", {"version": 1, "serverId": self.server, "experimentId": self.id})
    def environment(self, _):
        return None
    def free_for_path(self, path, needed=0):
        return shutil.disk_usage(path).free
    def assert_exited(self, command, launch_failure=False):
        self.checked_command = command


class Response(io.BytesIO):
    def __init__(self, data, status=200, headers=None):
        super().__init__(data); self.status = status; self.headers = headers or {}


class GovernanceCase(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.base = pathlib.Path(temp.name)
        self.owner = Owner(self.base)
        self.service = StorageGovernance(self.owner)
        save(self.service.root / "scan.v1.json", {"version": 1, "todo": [], "materialFiles": [], "materialFilesComplete": True})
        process = patch.object(StorageGovernance, "process_identity", return_value={"version": 1, "pid": 1, "hostBootId": "fixture", "startTime": "1"})
        process.start(); self.addCleanup(process.stop)
        self.service.mount = lambda path: {"mountId": 2 if str(path).startswith(str(self.base / "data")) else 1,
            "directory": str(self.base / "data") if str(path).startswith(str(self.base / "data")) else str(self.base / "system"),
            "filesystem": "ext4", "source": "fixture-data" if str(path).startswith(str(self.base / "data")) else "fixture-system", "readonly": False}
        identity = patch.dict(namespace, {"capacity_identity": lambda governance, path: {key: governance.mount(path)[key] for key in ("directory", "filesystem", "source")} | {"device": governance.mount(path)["source"]},
            "is_system_storage": lambda governance, path: governance.mount(path)["source"] == "fixture-system"})
        identity.start(); self.addCleanup(identity.stop)
    def request(self, **changes):
        return {"operationId": str(uuid.uuid4()), "materialIds": [], "environmentId": "training", "requirements": [],
            "outputBytes": 0, "checkpointBytes": 0, **changes}

    def test_borrowing_checks_unsupported_constraints_before_source_work(self):
        candidate = {"directory": str(self.base / "historical"), "runRoot": str(self.base / "source-run"),
            "sourceExperimentId": str(uuid.uuid4())}
        for requirement in ("fixture @ file:///owned/fixture.whl", "fixture @ https://example.invalid/fixture.whl", "fixture==1\nother==2"):
            with self.subTest(requirement=requirement), patch.object(self.service, "source_released",
                    side_effect=AssertionError("Historical source work began before rejecting the request")):
                with self.assertRaisesRegex(RuntimeError, "single-line dependency constraints|Only authenticated|outside"):
                    self.service.verify_borrowed(candidate, self.request(requirements=[requirement]))

    def test_borrowing_rejects_missing_pinned_distributions_before_hashing_or_executing_the_source(self):
        directory = self.base / "historical"
        (directory / "bin").mkdir(parents=True)
        (directory / "bin/python").write_text("untrusted interpreter fixture")
        (directory / "pyvenv.cfg").write_text("include-system-site-packages = false\n")
        metadata = directory / "lib/python3.10/site-packages/installed-1.dist-info/METADATA"
        metadata.parent.mkdir(parents=True)
        metadata.write_text("Metadata-Version: 2.1\nName: installed\nVersion: 1\n")
        candidate = {"directory": str(directory), "python": str(directory / "bin/python"),
            "runRoot": str(self.base / "source-run"), "sourceExperimentId": str(uuid.uuid4())}
        with patch.object(self.service, "source_released", return_value="released"), \
                patch.dict(namespace, {"file_hash": lambda _: self.fail("Ineligible source reached full content hashing")}), \
                patch.object(namespace["subprocess"], "run", side_effect=AssertionError("Ineligible source was executed")):
            with self.assertRaisesRegex(RuntimeError, "missing requested distributions: av==16.1.0, qwen_vl_utils==0.0.14"):
                self.service.verify_borrowed(candidate, self.request(requirements=["qwen_vl_utils==0.0.14", "av==16.1.0"]))

    def test_borrowing_metadata_screen_defers_unconfirmed_requirements_to_full_verification(self):
        def require_full_verification(_):
            raise RuntimeError("full verification required")
        for kind in ("matching-name", "conditional", "incomplete-metadata", "path-extension", "legacy-metadata"):
            with self.subTest(kind=kind):
                directory = self.base / kind
                (directory / "bin").mkdir(parents=True)
                (directory / "bin/python").write_text("untrusted interpreter fixture")
                (directory / "pyvenv.cfg").write_text("include-system-site-packages = false\n")
                site = directory / "lib/python3.10/site-packages"
                metadata = site / "tiny_fixture-1.dist-info/METADATA"
                metadata.parent.mkdir(parents=True)
                metadata.write_text("Metadata-Version: 2.1\nName: tiny-fixture\nVersion: 1\n")
                if kind == "incomplete-metadata":
                    metadata.write_text("Metadata-Version: 2.1\n")
                if kind == "path-extension":
                    (site / "extra.pth").write_text("nested-packages\n")
                if kind == "legacy-metadata":
                    (site / "legacy.egg-info").mkdir()
                requirement = "Tiny_Fixture==1" if kind == "matching-name" else "missing==1"
                if kind == "conditional":
                    requirement += "; python_version < '3.0'"
                candidate = {"directory": str(directory), "python": str(directory / "bin/python"),
                    "runRoot": str(self.base / "source-run"), "sourceExperimentId": str(uuid.uuid4())}
                with patch.object(self.service, "source_released", return_value="released"), \
                        patch.dict(namespace, {"file_hash": require_full_verification}):
                    with self.assertRaisesRegex(RuntimeError, "full verification required"):
                        self.service.verify_borrowed(candidate, self.request(requirements=[requirement]))
    def material(self, data=b"synthetic weights", **changes):
        request = {"kind": "model", "provider": "huggingface", "repository": "fixture/tiny", "revision": "a" * 40, **changes}
        document = {"id": request["repository"], "sha": request["revision"], "siblings": [{"rfilename": "model.safetensors", "size": len(data),
            "lfs": {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}}]}
        return self.service.inspect_material(request, document)
    def ready_budget(self, material):
        result = self.service.assess(self.request(materialIds=[material["id"]]))
        self.assertEqual(result["state"], "ready")
        return result["operationId"]

    def test_shipped_inline_helper_loads_without_test_namespace_imports(self):
        program = "\n".join((scripts / filename).read_text() for filename in ("storage-placement.py", "storage-governance.py", "storage-reuse.py", "managed-environment.py"))
        program = program.split('if __name__ == "__main__":')[0]
        isolated = {"__name__": "inline_helper", "__file__": str(scripts / "managed-environment.py")}
        with patch.dict(sys.modules, {"fcntl": namespace["fcntl"]}):
            exec(compile(program, "inline_helper", "exec"), isolated)
        self.assertIn("StorageGovernance", isolated)
        self.assertIn("main", isolated)

    def test_eighteen_gib_model_does_not_fit_a_one_point_six_gib_volume(self):
        material = self.material()
        material["missingBytes"] = 19329394438
        material["files"][0]["bytes"] = material["missingBytes"]
        save(self.service.root / "materials-0.1.2" / (material["id"] + ".json"), material)
        with patch.object(namespace["shutil"], "disk_usage", return_value=shutil._ntuple_diskusage(31526391808, 29858443264, 1667948544)):
            plan = self.service.assess(self.request(materialIds=[material["id"]]))
        self.assertEqual(plan["state"], "insufficient")
        self.assertGreater(plan["volumes"][0]["requiredBytes"], plan["volumes"][0]["availableBytes"])

    def test_unknown_environment_peak_is_pending_and_not_zero(self):
        result = self.service.assess(self.request(requirements=["torch==2.14.1"]))
        self.assertEqual(result["state"], "requirements-pending")
        self.assertIsNone(result["volumes"][0]["environmentBytes"])
        self.assertIsNone(result["volumes"][0]["requiredBytes"])

    def test_capacity_assessment_does_not_start_historical_environment_verification(self):
        self.owner.config["reuseVerificationVersion"] = 1
        with patch.object(self.service, "borrowing", side_effect=AssertionError("assessment must not scan or publish a loan")):
            result = self.service.assess(self.request(requirements=["torch==2.14.1"], allowEnvironmentFallback=True))
        self.assertEqual(result["state"], "requirements-pending")
        self.assertIsNone(result["volumes"][0]["environmentBytes"])

    def test_automatic_material_verification_discovers_a_historical_source_when_default_is_empty(self):
        self.owner.config["reuseVerificationVersion"] = 1
        _, directory, _ = self.targeted_material()
        before = (directory / "model.safetensors").read_bytes()
        material = self.material(b"owned historical model")
        result = self.service.prepare_material({"operationId": str(uuid.uuid4()), "materialId": material["id"], "action": "verify"})
        self.assertEqual(result["state"], "completed")
        self.assertEqual(result["material"]["directory"], str(directory))
        self.assertEqual(result["downloadedBytes"], 0)
        self.assertEqual(before, (directory / "model.safetensors").read_bytes())

    def test_inventory_entry_budget_preserves_every_unvisited_child(self):
        self.owner.config["reuseVerificationVersion"] = 1
        self.owner.config["governancePolicy"]["scanEntryLimit"] = 2
        directory = self.owner.workspace / "models"
        directory.mkdir()
        for index in range(9):
            (directory / (str(index) + ".safetensors")).write_bytes(b"tiny")
        roots, _ = self.service.roots()
        root = next(row for row in roots if row["directory"] == str(self.owner.namespace))
        scope = {"kind": "directory", "rootId": root["id"], "relativePath": directory.relative_to(self.owner.namespace).as_posix()}
        result = self.service.catalog(refresh=True, scope=scope)
        for _ in range(32):
            if not result.get("cursor"):
                break
            result = self.service.catalog(cursor=result["cursor"], scope=scope)
        self.assertTrue(result["complete"], result["diagnostics"])
        self.assertEqual(result["entriesScanned"], 10)

    def test_automatic_reuse_flows_into_capacity_without_a_second_source_selection(self):
        self.owner.config["reuseVerificationVersion"] = 1
        _, directory, _ = self.targeted_material()
        original = (directory / "model.safetensors").read_bytes()
        material = self.material(original)
        request = {"operationId": str(uuid.uuid4()), "materialId": material["id"], "action": "verify"}
        verified = self.service.prepare_material(request)
        self.assertEqual(verified["state"], "completed")
        if os.name != "nt":
            self.owner.config["action"] = "history-material-verify"
            self.service.assert_material_exited(request["operationId"], verified)
            self.owner.config.pop("action")
        self.service.settle_material(request["operationId"])
        plan = self.service.assess(self.request(materialIds=[material["id"]]))
        self.assertEqual(plan["state"], "ready", plan["detail"])
        self.assertEqual(plan["materialSources"][0]["verificationOperationId"], request["operationId"])
        self.assertEqual(plan["materialEstimates"][0]["newPeakBytes"], 0)
        self.assertEqual(plan["volumes"][0]["missingBytes"], 0)
        with patch.object(namespace["urllib"].request, "urlopen", side_effect=AssertionError("verified weights must not download")):
            acquired = self.service.prepare_material({"operationId": str(uuid.uuid4()), "materialId": material["id"], "action": "acquire", "budgetId": plan["operationId"]})
        self.assertEqual(acquired["state"], "completed", acquired.get("detail"))
        self.assertEqual(acquired["downloadedBytes"], 0)
        self.assertEqual((directory / "model.safetensors").read_bytes(), original)

    def test_material_budget_waits_for_reuse_and_cannot_forget_registered_requirements(self):
        self.owner.config["reuseVerificationVersion"] = 1
        material = self.material()
        first = self.service.assess(self.request(requirements=["torch==2.14.1"], materialIds=[material["id"]]))
        self.assertEqual(first["state"], "requirements-pending")
        second = self.service.assess(self.request())
        self.assertEqual(second["state"], "requirements-pending")
        self.assertTrue(any("omitted" in row for row in second["coverage"]["unresolved"]))

    def test_installation_cannot_use_a_later_partial_budget_to_forget_registered_materials(self):
        self.owner.config["reuseVerificationVersion"] = 1
        material = self.material()
        self.service.assess(self.request(materialIds=[material["id"]]))
        self.service.assess(self.request())
        with self.assertRaisesRegex(RuntimeError, "omits previously registered fixed materials"):
            self.service.reserve_environment(5)

    def test_output_reserves_cannot_disappear_during_reuse_reassessment(self):
        self.owner.config["reuseVerificationVersion"] = 1
        self.service.assess(self.request(outputBytes=2000, checkpointBytes=3000))
        reduced = self.service.assess(self.request(outputBytes=0, checkpointBytes=0))
        self.assertEqual(reduced["state"], "requirements-pending")
        self.assertTrue(any("reserves" in row for row in reduced["coverage"]["unresolved"]))

    def test_preexisting_default_verification_does_not_adopt_new_automatic_source_semantics(self):
        _, directory, _ = self.targeted_material()
        material = self.material(b"owned historical model")
        request = {"operationId": str(uuid.uuid4()), "materialId": material["id"], "action": "verify"}
        self.service.register_material(request)
        self.owner.config["reuseVerificationVersion"] = 1
        result = self.service.prepare_material(request)
        self.assertEqual(result["state"], "blocked")
        self.assertNotEqual(result["material"]["directory"], str(directory))

    def test_new_verification_after_confirmed_expiry_retains_the_original_receipt(self):
        self.owner.config["reuseVerificationVersion"] = 1
        material = self.material()
        request = {"operationId": str(uuid.uuid4()), "materialId": material["id"], "action": "verify"}
        original = self.service.register_material(request)
        original.update(state="blocked", exitConfirmed=True, admissionReleased=True, deadline=namespace["now"]() - 1)
        path = self.owner.run / "material-operations-v1" / request["operationId"] / "receipt.v1.json"
        save(path, original)
        retained = path.read_bytes()
        second = self.service.register_material({**request, "operationId": str(uuid.uuid4())})
        self.assertEqual(second["state"], "requested")
        self.assertEqual(path.read_bytes(), retained)

    def test_explicit_failed_source_never_switches_to_another_automatic_candidate(self):
        self.owner.config["reuseVerificationVersion"] = 1
        candidate, directory, _ = self.targeted_material()
        material = self.material(b"different fixed weights")
        result = self.service.prepare_material({"operationId": str(uuid.uuid4()), "materialId": material["id"],
            "action": "verify", "reuseCandidateId": candidate["id"]})
        self.assertEqual(result["state"], "blocked")
        self.assertEqual(result["material"]["directory"], str(directory))
        self.assertNotIn("reuse", result)

    def test_completed_material_hashes_survive_a_new_verification_operation(self):
        self.owner.config["reuseVerificationVersion"] = 1
        candidate, directory, _ = self.targeted_material()
        material = self.service.candidate_material(self.material(b"owned historical model"), candidate["id"])
        folder = self.owner.run / "proof-test"
        value = {"operationId": str(uuid.uuid4())}
        self.service.verify_material_files(copy.deepcopy(material), folder, value, namespace["now"]() + 10000)
        real_open = open
        def observe_open(path, mode="r", *args, **kwargs):
            if pathlib.Path(path) == directory / "model.safetensors" and mode == "rb":
                raise AssertionError("unchanged verified weight was rehashed")
            return real_open(path, mode, *args, **kwargs)
        with patch.dict(namespace, {"open": observe_open}):
            second = self.service.verify_material_files(copy.deepcopy(material), self.owner.run / "proof-test-2", {}, namespace["now"]() + 10000)
        self.assertEqual(second["verifiedBytes"], material["totalBytes"])

    @unittest.skipIf(os.name == "nt", "Linux cache symlinks and native material links")
    def test_huggingface_snapshot_blobs_publish_without_a_second_weight_download(self):
        self.owner.config["reuseVerificationVersion"] = 1
        _, directory, _ = self.targeted_material()
        cache = directory.parent / "cache/huggingface/hub/models--fixture--tiny"
        snapshot = cache / "snapshots" / ("a" * 40)
        snapshot.mkdir(parents=True)
        (cache / "blobs").mkdir()
        data = b"cached fixed weights"
        blob = cache / "blobs" / hashlib.sha256(data).hexdigest()
        blob.write_bytes(data)
        (snapshot / "model.safetensors").symlink_to(os.path.relpath(blob, snapshot))
        roots, _ = self.service.roots()
        root = next(row for row in roots if row["directory"] == str(self.owner.namespace))
        candidate = self.service.material_candidate(snapshot, root)
        material = self.material(data)
        request = {"operationId": str(uuid.uuid4()), "materialId": material["id"], "action": "verify", "reuseCandidateId": candidate["id"]}
        verified = self.service.prepare_material(request)
        self.assertEqual(verified["state"], "completed", verified.get("detail"))
        self.service.settle_material(request["operationId"])
        plan = self.service.assess(self.request(materialIds=[material["id"]]))
        self.assertEqual(plan["materialSources"][0]["mode"], "copy")
        self.assertEqual(plan["materialEstimates"][0]["newPeakBytes"], 0)
        with patch.object(namespace["urllib"].request, "urlopen", side_effect=AssertionError("cached weight must not download")):
            acquired = self.service.prepare_material({"operationId": str(uuid.uuid4()), "materialId": material["id"], "action": "acquire", "budgetId": plan["operationId"]})
        self.assertEqual(acquired["state"], "completed", acquired.get("detail"))
        target = pathlib.Path(acquired["material"]["directory"]) / "model.safetensors"
        self.assertFalse(target.is_symlink())
        self.assertEqual(target.stat().st_ino, blob.stat().st_ino)
        self.assertEqual(acquired["downloadedBytes"], 0)
        self.assertEqual(blob.read_bytes(), data)

    def test_automatic_environment_borrowing_does_not_wait_for_account_inventory(self):
        self.owner.config["reuseVerificationVersion"] = 1
        self.owner.config["governancePolicy"]["verificationTimeoutMs"] = 10000
        source_id = str(uuid.uuid4())
        run = self.owner.namespace / "runs" / source_id
        directory = run / "workspace/pyenv"
        (directory / "bin").mkdir(parents=True)
        save(run / ".aspera-owner.json", {"version": 1, "experimentId": source_id, "serverId": self.owner.server})
        (directory / "pyvenv.cfg").write_text("include-system-site-packages = false\n")
        (directory / "bin/python").write_bytes(b"fixture interpreter")
        metadata = directory / "lib/python3.10/site-packages/tiny_fixture-1.dist-info/METADATA"
        metadata.parent.mkdir(parents=True)
        metadata.write_text("Metadata-Version: 2.1\nName: tiny-fixture\nVersion: 1\n")
        self.service.source_released = lambda *_: "confirmed-original-release"
        self.owner.sandbox = lambda command, **_kwargs: ["bwrap", "--", *command]
        response = subprocess.CompletedProcess([], 0, json.dumps({"prefix": str(directory), "userSite": False,
            "pythonVersion": "3.10.12", "pythonAbi": "cp310", "cuda": False}), "")
        request = {"operationId": str(uuid.uuid4()), "environmentId": "training", "action": "create", "requirements": ["tiny-fixture==1"], "modules": [], "requireCuda": False}
        def probe(argv, **_kwargs):
            return subprocess.CompletedProcess(argv, 0, "uv 0.13.0\n", "") if "--version" in argv else response
        with patch.object(self.service, "catalog", side_effect=AssertionError("no complete account scan")), patch.object(namespace["subprocess"], "run", side_effect=probe):
            result = self.service.borrowing(request)
        self.assertEqual(result["directory"], str(directory))
        self.assertEqual(result["mode"], "borrowed-readonly")
        self.assertEqual((directory / "bin/python").read_bytes(), b"fixture interpreter")

    def test_registered_ready_environment_is_discovered_before_cached_legacy_sources(self):
        self.owner.config["reuseVerificationVersion"] = 1
        sources = []
        for name in ("pyenv", "env/python"):
            run = self.owner.namespace / "runs" / str(uuid.uuid4())
            directory = run / "workspace" / name
            (directory / "bin").mkdir(parents=True)
            save(run / ".aspera-owner.json", {"version": 1, "serverId": self.owner.server, "experimentId": run.name})
            (directory / "bin/python").write_bytes(b"fixture interpreter")
            (directory / "pyvenv.cfg").write_text("include-system-site-packages = false\n")
            sources.append(self.service.candidate(run, directory, self.owner.namespace))
        legacy, registered = sources
        save(self.service.root / "catalog.v1.json", {"historicalEnvironments": [legacy]})
        run = pathlib.Path(registered["runRoot"])
        save(run / "environments-v1/training.json", {"version": 1, "environmentId": "training", "serverId": self.owner.server,
            "experimentId": run.name, "directory": registered["directory"], "python": registered["python"],
            "state": "ready", "verification": {"verified": True}})
        discovery = namespace["storage_reuse"](self.service).discover("environment", str(uuid.uuid4()), namespace["now"]() + 10000)
        self.assertEqual([row["id"] for row in discovery["candidates"]], [registered["id"]])
        self.assertFalse(discovery["complete"], "Unrelated historical trees remain resumable")
        original_mount = self.service.mount
        def nested_mount(path):
            observed = original_mount(path)
            return {**observed, "mountId": 99} if pathlib.Path(path) == pathlib.Path(registered["directory"]) else observed
        with patch.object(self.service, "mount", side_effect=nested_mount):
            excluded = namespace["storage_reuse"](self.service).discover("environment", str(uuid.uuid4()), namespace["now"]() + 10000)
        self.assertNotIn(registered["id"], [row["id"] for row in excluded["candidates"]])
        self.assertTrue(any("Nested mount excluded" in error for error in excluded["diagnostics"]))
        for name in ("a", "b", "c", "d"):
            save(run / "environments-v1" / (name + ".json"), {"version": 1, "environmentId": name,
                "serverId": self.owner.server, "experimentId": run.name, "state": "blocked"})
        self.owner.config["governancePolicy"]["scanEntryLimit"] = 3
        operation = str(uuid.uuid4())
        deadline = namespace["now"]() + 10000
        previous = 0
        for _page in range(10):
            discovery = namespace["storage_reuse"](self.service).discover("environment", operation, deadline)
            self.assertLessEqual(discovery["entriesScanned"] - previous, 3)
            previous = discovery["entriesScanned"]
            if discovery["candidates"]:
                break
        self.assertEqual([row["id"] for row in discovery["candidates"]], [registered["id"]])

    def test_full_environment_verification_observes_registration_once_per_batch(self):
        self.owner.config["reuseVerificationVersion"] = 1
        run = self.owner.namespace / "runs" / str(uuid.uuid4())
        directory = run / "workspace/pyenv"
        (directory / "bin").mkdir(parents=True)
        (directory / "bin/python").write_bytes(b"fixture interpreter")
        (directory / "pyvenv.cfg").write_text("include-system-site-packages = false\n")
        for index in range(32):
            (directory / ("package_" + str(index) + ".py")).write_text("value=" + str(index) + "\n")
        candidate = {"id": "a" * 64, "directory": str(directory), "python": str(directory / "bin/python"),
            "runRoot": str(run), "sourceExperimentId": run.name}
        self.service.source_released = lambda *_: "confirmed-release"
        self.service._reuse_deadline = namespace["now"]() + 10000
        self.owner.sandbox = lambda command, **_kwargs: ["bwrap", "--", *command]
        response = subprocess.CompletedProcess([], 0, json.dumps({"prefix": str(directory), "userSite": False,
            "pythonVersion": "3.10.12", "pythonAbi": "cp310", "cuda": False}), "")
        request = {"operationId": str(uuid.uuid4()), "environmentId": "training", "action": "verify-reuse",
            "requirements": [], "modules": [], "requireCuda": False}
        def probe(argv, **_kwargs):
            return subprocess.CompletedProcess(argv, 0, "uv 0.13.0\n", "") if "--version" in argv else response
        with patch.object(self.service, "roots", wraps=self.service.roots) as observations, \
                patch.object(namespace["subprocess"], "run", side_effect=probe):
            verified = self.service.verify_borrowed(candidate, request)
        self.assertTrue(verified["verified"])
        self.assertEqual(len(verified["files"]), 34)
        self.assertLessEqual(observations.call_count, 4, "Each package file must not reread every storage registration")
        self.assertFalse(hasattr(self.service, "_reuse_registration_roots"))
        roots = self.service.roots()
        changed = copy.deepcopy(roots)
        changed[0][0]["registrationId"] = "changed-during-import"
        with patch.object(self.service, "roots", side_effect=[roots, changed]), \
                patch.object(namespace["subprocess"], "run", side_effect=probe):
            with self.assertRaisesRegex(RuntimeError, "registration changed during"):
                self.service.verify_borrowed(candidate, request)
        self.assertFalse(hasattr(self.service, "_reuse_registration_roots"))

    def test_registered_discovery_rejects_a_manifest_pointing_outside_its_source_workspace(self):
        self.owner.config["reuseVerificationVersion"] = 1
        run = self.owner.namespace / "runs" / str(uuid.uuid4())
        save(run / ".aspera-owner.json", {"version": 1, "serverId": self.owner.server, "experimentId": run.name})
        directory = self.base / "unowned/python"
        save(run / "environments-v1/training.json", {"version": 1, "environmentId": "training", "serverId": self.owner.server,
            "experimentId": run.name, "directory": str(directory), "python": str(directory / "bin/python"),
            "state": "ready", "verification": {"verified": True}})
        discovery = namespace["storage_reuse"](self.service).discover("environment", str(uuid.uuid4()), namespace["now"]() + 10000)
        self.assertEqual(discovery["candidates"], [])
        self.assertTrue(any("differs from its owned training workspace" in error for error in discovery["diagnostics"]))

    def test_cleanup_checks_reuse_only_unchanged_lease_metadata_and_detect_a_new_protection(self):
        source = self.base / "retained-environment"
        lease = self.service.root / "environment-leases/source.json"
        value = {"version": 1, "serverId": self.owner.server, "sourceExperimentId": str(uuid.uuid4()),
            "directory": str(source), "files": [{"path": "fixture.py", "hash": "a" * 64}]}
        save(lease, value)
        original = namespace["governance_row"]
        reads = []
        def read(path):
            if pathlib.Path(path) == lease:
                reads.append(str(path))
            return original(path)
        with patch.dict(namespace, {"governance_row": read}):
            for index in range(32):
                self.service.protect_path(self.base / "releases" / str(index))
        self.assertEqual(len(reads), 1, "Each release asset must not reparse the full historical environment file list")
        target = self.base / "releases/newly-retained"
        save(lease, {**value, "directory": str(target)})
        with self.assertRaisesRegex(RuntimeError, "retained"):
            self.service.protect_path(target / "payload.bin")
        lease.unlink()
        self.service.protect_path(target)
        save(lease, {**value, "serverId": str(uuid.uuid4())})
        with self.assertRaisesRegex(RuntimeError, "another server"):
            self.service.protect_path(target)

    def test_metadata_request_is_durable_before_an_outer_transport_interruption(self):
        request = {"kind": "model", "provider": "huggingface", "repository": "fixture/tiny", "revision": "a" * 40}
        with patch.object(self.service, "metadata", side_effect=KeyboardInterrupt("outer command timeout")):
            with self.assertRaises(KeyboardInterrupt):
                self.service.inspect_material(request)
        self.assertTrue((self.owner.run / "material-metadata-v1" / (digest(request) + ".json")).exists())
        clock = namespace["now"]()
        with patch.dict(namespace, {"now": lambda: clock + 200}):
            pending = self.service.pending_metadata()
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["request"], request)

    def test_modelscope_dataset_waits_for_official_git_proof_and_rejects_an_unattested_revision(self):
        request = {"kind": "dataset", "provider": "modelscope", "repository": "fixture/data", "revision": "a" * 40}
        with patch.object(self.service, "metadata", side_effect=AssertionError("Dataset must not use a Hugging Face model URL")):
            pending = self.service.inspect_material(request)
        self.assertEqual(pending["state"], "metadata-pending")
        self.assertEqual(self.service.pending_metadata()[0]["request"], request)
        data = b'{"text":"sample"}'
        document = {"id": request["repository"], "sha": request["revision"], "siblings": [{"rfilename": "data.json", "size": len(data),
            "blobId": hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()}]}
        with self.assertRaisesRegex(RuntimeError, "Git commit and tree attestation"):
            self.service.inspect_material(request, document)
        document["source"] = {"provider": "modelscope", "method": "git-commit-tree-v1"}
        material = self.service.inspect_material(request, document)
        self.assertEqual(material["revision"], request["revision"])
        self.assertIn("/api/v1/datasets/fixture/data/repo?Revision=" + request["revision"], material["files"][0]["url"])
        self.assertEqual(material["files"][0]["algorithm"], "git-sha1")

    def test_empty_material_budget_reports_only_declared_scope(self):
        result = self.service.assess(self.request())
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["coverage"]["scope"], "declared")
        self.assertFalse(result["coverage"]["complete"])
        with self.assertRaisesRegex(RuntimeError, "Training command capacity is not verified"):
            self.service.reserve_command("train")
        self.assertFalse((self.service.root / "reservations" / (self.owner.id + "-command-train.json")).exists())

    def targeted_material(self, data=b"owned historical model"):
        source = self.owner.namespace / "runs" / str(uuid.uuid4())
        directory = source / "workspace/models/tiny"
        directory.mkdir(parents=True)
        save(source / ".aspera-owner.json", {"version": 1, "serverId": self.owner.server, "experimentId": source.name})
        (directory / "model.safetensors").write_bytes(data)
        roots, _ = self.service.roots()
        root = next(row for row in roots if row["directory"] == str(self.owner.namespace))
        scope = {"kind": "directory", "rootId": root["id"], "relativePath": directory.relative_to(self.owner.namespace).as_posix()}
        catalog = self.service.catalog(refresh=True, scope=scope)
        candidate = catalog["materialCandidates"][0]
        self.service.source_released = lambda *_: "fixture-confirmed-release"
        return candidate, directory, scope

    def test_targeted_reuse_is_verified_without_global_discovery_or_a_download_budget(self):
        candidate, directory, _ = self.targeted_material()
        save(self.service.root / "scan.v1.json", {"version": 1, "todo": [["unrelated", "root"]], "materialFilesComplete": False})
        material = self.material(b"owned historical model", reuseCandidateId=candidate["id"])
        self.assertEqual(material["verifiedBytes"], 0)
        before = (directory / "model.safetensors").read_bytes()
        result = self.service.prepare_material({"operationId": str(uuid.uuid4()), "materialId": material["id"],
            "action": "verify", "reuseCandidateId": candidate["id"]})
        self.assertEqual(result["state"], "completed")
        self.assertEqual(result["material"]["missingBytes"], 0)
        self.assertFalse(self.service.material_bindings.exists(), 'Read-only verification does not publish a binding')
        self.assertEqual(before, (directory / "model.safetensors").read_bytes())
        budget = self.service.assess(self.request(materialIds=[material["id"]], materialSources=[{"materialId": material["id"], "verificationOperationId": result["operationId"], "mode": "readonly"}], assessmentScope="experiment", materialRequirements={
            "planRevision": 1, "complete": True, "materials": [{"kind": "model", "repository": "fixture/tiny", "revision": "a" * 40, "materialId": material["id"]}]}))
        self.assertEqual(budget["state"], "ready")
        self.assertTrue(budget["coverage"]["complete"])
        with patch.object(namespace["urllib"].request, "urlopen", side_effect=AssertionError("no duplicate payload")):
            acquired = self.service.prepare_material({"operationId": str(uuid.uuid4()), "materialId": material["id"], "action": "acquire", "budgetId": budget["operationId"]})
        self.assertEqual(acquired["state"], "completed")
        self.assertEqual(acquired["downloadedBytes"], 0)
        self.assertEqual(acquired["material"]["directory"], str(directory))

    def test_metadata_before_candidate_discovery_verifies_the_explicit_source(self):
        material = self.material(b"owned historical model")
        candidate, directory, _ = self.targeted_material()
        operation = str(uuid.uuid4())
        result = self.service.prepare_material({"operationId": operation, "materialId": material["id"],
            "action": "verify", "reuseCandidateId": candidate["id"]})
        self.assertEqual(result["state"], "completed")
        self.assertEqual(result["material"]["directory"], str(directory))
        self.assertEqual(result["verifiedBytes"], len(b"owned historical model"))
        self.assertFalse(self.service.material_bindings.exists())

    def verified_source(self, data=b"owned historical model"):
        material = self.material(data)
        candidate, directory, _ = self.targeted_material(data)
        request = {"operationId": str(uuid.uuid4()), "materialId": material["id"], "action": "verify", "reuseCandidateId": candidate["id"]}
        result = self.service.prepare_material(request)
        return material, candidate, directory, request, result

    def test_inspection_does_not_choose_a_candidate_for_a_later_implicit_verify(self):
        candidate, directory, _ = self.targeted_material()
        material = self.material(b"owned historical model", reuseCandidateId=candidate["id"])
        result = self.service.prepare_material({"operationId": str(uuid.uuid4()), "materialId": material["id"], "action": "verify"})
        self.assertEqual(result["state"], "blocked")
        self.assertNotEqual(result["material"]["directory"], str(directory))
        self.assertEqual(result["fileResults"][0]["state"], "missing")

    def test_same_verification_with_new_id_cannot_restart_its_deadline(self):
        _, _, _, request, result = self.verified_source()
        with self.assertRaisesRegex(RuntimeError, request["operationId"]):
            self.service.register_material({**request, "operationId": str(uuid.uuid4())})
        self.assertEqual(self.service.material_operation(request["operationId"])["deadline"], result["deadline"])

    def test_new_candidate_waits_for_unconfirmed_original_exit(self):
        material, _, _, request, result = self.verified_source()
        path = self.owner.run / "material-operations-v1" / request["operationId"] / "receipt.v1.json"
        save(path, {**result, "state": "running", "exitConfirmed": False})
        other, _, _ = self.targeted_material()
        with patch.object(self.owner, "assert_exited", side_effect=RuntimeError("process remains alive")):
            with self.assertRaisesRegex(RuntimeError, "process remains alive"):
                self.service.register_material({"operationId": str(uuid.uuid4()), "materialId": material["id"], "action": "verify", "reuseCandidateId": other["id"]})

    def test_two_experiments_publish_the_same_content_from_independent_sources(self):
        material, candidate, directory, request, result = self.verified_source()
        first_receipt = (self.owner.run / "material-operations-v1" / request["operationId"] / "receipt.v1.json").read_bytes()
        first_budget = self.service.assess(self.request(materialIds=[material["id"]], materialSources=[{
            "materialId": material["id"], "verificationOperationId": request["operationId"], "mode": "readonly"}]))
        self.service.prepare_material({"operationId": str(uuid.uuid4()), "materialId": material["id"], "action": "acquire", "budgetId": first_budget["operationId"]})
        publication = self.owner.run / "material-publications-0.1.2" / (material["id"] + ".json")
        first_publication = publication.read_bytes()
        second_candidate, second_directory, _ = self.targeted_material()
        second_owner = copy.copy(self.owner); second_owner.id = str(uuid.uuid4())
        second_owner.run = self.owner.namespace / "runs" / second_owner.id
        second_owner.workspace = second_owner.run / "workspace"; second_owner.workspace.mkdir(parents=True)
        save(second_owner.run / ".aspera-owner.json", {"version": 1, "serverId": self.owner.server, "experimentId": second_owner.id})
        second = StorageGovernance(second_owner); second.mount = self.service.mount; second.source_released = self.service.source_released
        second_result = second.prepare_material({"operationId": str(uuid.uuid4()), "materialId": material["id"], "action": "verify", "reuseCandidateId": second_candidate["id"]})
        budget = second.assess(self.request(materialIds=[material["id"]], materialSources=[{
            "materialId": material["id"], "verificationOperationId": second_result["operationId"], "mode": "readonly"}]))
        acquired = second.prepare_material({"operationId": str(uuid.uuid4()), "materialId": material["id"], "action": "acquire", "budgetId": budget["operationId"]})
        self.assertEqual(acquired["material"]["directory"], str(second_directory))
        self.assertEqual(self.service.material(material["id"])["directory"], str(directory))
        self.assertEqual(first_publication, publication.read_bytes())
        self.assertEqual(first_receipt, (self.owner.run / "material-operations-v1" / request["operationId"] / "receipt.v1.json").read_bytes())
        self.assertEqual(self.service.material_operation(request["operationId"])["state"], "completed")
        with self.assertRaisesRegex(RuntimeError, "retained"):
            second.protect_source(candidate["sourceExperimentId"])

    def test_rejected_republication_cannot_replace_an_existing_source_lease(self):
        material, candidate, _, first, _ = self.verified_source()
        source = {'materialId': material['id'], 'verificationOperationId': first['operationId'], 'mode': 'readonly'}
        budget = self.service.assess(self.request(materialIds=[material['id']], materialSources=[source]))
        self.service.prepare_material({'operationId': str(uuid.uuid4()), 'materialId': material['id'], 'budgetId': budget['operationId'], 'action': 'acquire'})
        lease = self.service.root / 'material-source-leases' / (self.owner.id + '-' + material['id'] + '.json')
        saved = lease.read_bytes()
        other, _, _ = self.targeted_material()
        second = self.service.prepare_material({'operationId': str(uuid.uuid4()), 'materialId': material['id'], 'reuseCandidateId': other['id'], 'action': 'verify'})
        budget = self.service.assess(self.request(materialIds=[material['id']], materialSources=[{**source, 'verificationOperationId': second['operationId']}]))
        with self.assertRaisesRegex(RuntimeError, 'already published'):
            self.service.prepare_material({'operationId': str(uuid.uuid4()), 'materialId': material['id'], 'budgetId': budget['operationId'], 'action': 'acquire'})
        self.assertEqual(lease.read_bytes(), saved)
        with self.assertRaisesRegex(RuntimeError, 'retained'):
            self.service.protect_source(candidate['sourceExperimentId'])

    def test_partial_candidate_repairs_only_missing_files_in_a_new_target(self):
        weights, metadata = b"historical model weights", b"canonical attributes"
        candidate, directory, _ = self.targeted_material(weights)
        fixed = {"kind": "model", "provider": "huggingface", "repository": "fixture/tiny", "revision": "a" * 40}
        document = {"id": "fixture/tiny", "sha": "a" * 40, "siblings": [{"rfilename": name, "size": len(data),
            "lfs": {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}} for name, data in [(".gitattributes", metadata), ("model.safetensors", weights)]]}
        material = self.service.inspect_material(fixed, document)
        verified = self.service.prepare_material({"operationId": str(uuid.uuid4()), "materialId": material["id"], "action": "verify", "reuseCandidateId": candidate["id"]})
        self.assertEqual([row["state"] for row in verified["fileResults"]], ["missing", "verified"])
        self.assertTrue(verified["verificationComplete"])
        source = {"materialId": material["id"], "verificationOperationId": verified["operationId"], "mode": "readonly"}
        readonly = self.service.assess(self.request(materialIds=[material["id"]], materialSources=[source]))
        self.assertEqual(readonly["state"], "requirements-pending")
        budget = self.service.assess(self.request(materialIds=[material["id"]], materialSources=[{**source, "mode": "copy"}]))
        self.assertEqual(budget["state"], "ready")
        self.assertEqual(budget["materialEstimates"][0]["newPeakBytes"], len(metadata))
        def transfer(request, **_):
            self.assertTrue(request.full_url.endswith('/.gitattributes'))
            return Response(metadata)
        with patch.object(namespace["urllib"].request, "urlopen", side_effect=transfer):
            acquired = self.service.prepare_material({"operationId": str(uuid.uuid4()), "materialId": material["id"], "action": "acquire", "budgetId": budget["operationId"]})
        self.assertEqual(acquired["state"], "completed", acquired.get("detail"))
        self.assertEqual(acquired["downloadedBytes"], len(metadata))
        self.assertEqual(acquired["reusedBytes"], len(weights))
        self.assertFalse((directory / '.gitattributes').exists())
        self.assertEqual((directory / 'model.safetensors').read_bytes(), weights)
        self.assertNotEqual(acquired["material"]["directory"], str(directory))

    def test_source_selection_rejects_a_foreign_plan_and_candidate_conflict(self):
        self.service.config['evidenceContext'] = {'sessionId': 'execution-1', 'planRevision': 1}
        material, candidate, _, request, _ = self.verified_source()
        source = {"materialId": material["id"], "verificationOperationId": request["operationId"], "mode": "readonly"}
        self.service.config['evidenceContext'] = {'sessionId': 'execution-2', 'planRevision': 2}
        with self.assertRaisesRegex(RuntimeError, "another plan"):
            self.service.assess(self.request(materialIds=[material["id"]], materialSources=[source]))
        self.service.config['evidenceContext'] = {'sessionId': 'execution-1', 'planRevision': 1}
        budget = self.service.assess(self.request(materialIds=[material["id"]], materialSources=[source]))
        other, _, _ = self.targeted_material()
        with self.assertRaisesRegex(RuntimeError, 'capacity plan'):
            self.service.register_material({"operationId": str(uuid.uuid4()), "materialId": material["id"], "budgetId": budget["operationId"],
                "action": "acquire", "reuseCandidateId": other["id"]})

    def test_damaged_file_does_not_hide_later_verified_files(self):
        material, candidate, directory, request, result = self.verified_source()
        (directory / 'model.safetensors').write_bytes(b'broken file')
        current = self.service.assess(self.request(materialIds=[material["id"]], materialSources=[{
            "materialId": material["id"], "verificationOperationId": request["operationId"], "mode": "readonly"}]))
        self.assertEqual(current['state'], 'requirements-pending')
        self.assertGreater(current['materialEstimates'][0]['unknownBytes'], 0)

    def test_removed_verified_file_is_unknown_and_does_not_keep_a_reuse_budget_ready(self):
        material, _, directory, request, _ = self.verified_source()
        (directory / 'model.safetensors').unlink()
        result = self.service.assess(self.request(materialIds=[material['id']], materialSources=[{
            'materialId': material['id'], 'verificationOperationId': request['operationId'], 'mode': 'copy'}]))
        self.assertEqual(result['state'], 'requirements-pending')
        self.assertEqual(result['materialEstimates'][0]['unknownBytes'], material['totalBytes'])

    def test_default_asset_verification_is_invalidated_without_rewriting_the_receipt(self):
        material = self.material()
        directory = pathlib.Path(material['directory']); directory.mkdir(parents=True)
        path = directory / 'model.safetensors'; path.write_bytes(b'synthetic weights')
        request = {'operationId': str(uuid.uuid4()), 'materialId': material['id'], 'action': 'verify'}
        self.assertEqual(self.service.prepare_material(request)['state'], 'completed')
        receipt = self.owner.run / 'material-operations-v1' / request['operationId'] / 'receipt.v1.json'
        saved = receipt.read_bytes(); path.write_bytes(b'changed bytes')
        self.assertEqual(self.service.material_operation(request['operationId'])['state'], 'blocked')
        self.assertEqual(receipt.read_bytes(), saved)

    def test_installation_recheck_uses_the_selected_readonly_material_budget(self):
        material, _, _, request, _ = self.verified_source()
        self.service.assess(self.request(materialIds=[material['id']], materialSources=[{
            'materialId': material['id'], 'verificationOperationId': request['operationId'], 'mode': 'readonly'}]))
        with patch.object(namespace['shutil'], 'disk_usage', return_value=types.SimpleNamespace(total=10000, free=1024 + 5)):
            self.service.reserve_environment(5)

    def test_cross_filesystem_copy_reserves_verified_source_bytes(self):
        original_capacity = namespace['capacity_identity']
        owner_id = self.owner.id
        def observed(governance, path):
            path = pathlib.Path(path)
            value = original_capacity(governance, path)
            if 'runs' not in path.parts or owner_id in path.parts:
                return value
            return {**value, 'device': 'independent-source-volume'}
        with patch.dict(namespace, {'capacity_identity': observed}):
            material, _, _, request, _ = self.verified_source()
            result = self.service.assess(self.request(materialIds=[material['id']], materialSources=[{
                'materialId': material['id'], 'verificationOperationId': request['operationId'], 'mode': 'copy'}]))
        self.assertEqual(result['materialEstimates'][0]['newPeakBytes'], material['totalBytes'])

    def test_legacy_acquisition_keeps_its_original_source_and_lease_filename(self):
        material, _, _, _, verified = self.verified_source()
        legacy = copy.deepcopy(verified['material']); legacy.pop('formatVersion', None); legacy.pop('unknownBytes', None)
        save(self.service.root / 'materials' / (material['id'] + '.json'), legacy)
        budget = self.service.assess(self.request(materialIds=[material['id']]))
        request = {'operationId': str(uuid.uuid4()), 'materialId': material['id'], 'action': 'acquire', 'budgetId': budget['operationId']}
        registered = self.service.register_material(request)
        registered.pop('formatVersion'); registered.pop('sourceHash')
        registered['material'] = legacy
        folder = self.owner.run / 'material-operations-v1' / request['operationId']
        save(folder / 'receipt.v1.json', registered); (folder / 'source-0.1.2.json').unlink()
        result = self.service.prepare_material(request)
        self.assertEqual(result['state'], 'completed')
        self.assertEqual(result['material']['directory'], legacy['directory'])
        self.assertTrue((self.service.root / 'material-source-leases' / (material['id'] + '.json')).exists())
        self.assertNotIn('formatVersion', load(self.service.material_bindings / (material['id'] + '.json')))

    def test_legacy_verification_without_a_source_does_not_adopt_the_current_catalog(self):
        material, _, _, request, verified = self.verified_source()
        verified.pop('formatVersion'); verified.pop('material'); verified.pop('sourceHash')
        save(self.owner.run / 'material-operations-v1' / request['operationId'] / 'receipt.v1.json', verified)
        result = self.service.material_operation(request['operationId'])
        self.assertEqual(result['state'], 'blocked')
        self.assertIn('no recorded source', result['detail'])

    def test_new_implicit_verification_does_not_adopt_a_legacy_historical_directory(self):
        material, _, directory, _, verified = self.verified_source()
        save(self.service.root / 'materials' / (material['id'] + '.json'), verified['material'])
        (self.service.root / 'materials-0.1.2' / (material['id'] + '.json')).unlink()
        result = self.service.prepare_material({'operationId': str(uuid.uuid4()), 'materialId': material['id'], 'action': 'verify'})
        self.assertEqual(result['state'], 'blocked')
        self.assertNotEqual(result['material']['directory'], str(directory))
        self.assertEqual(result['fileResults'][0]['state'], 'missing')

    def test_later_inspection_does_not_change_an_acquisition_transport(self):
        data = b'fixed transport'
        material = self.material(data)
        request = {'operationId': str(uuid.uuid4()), 'materialId': material['id'], 'budgetId': self.ready_budget(material), 'action': 'acquire'}
        self.service.register_material(request)
        self.material(data, mirror='https://hf-mirror.com')
        def transfer(request, **_):
            self.assertTrue(request.full_url.startswith('https://huggingface.co/'))
            return Response(data)
        with patch.object(namespace['urllib'].request, 'urlopen', side_effect=transfer):
            result = self.service.prepare_material(request)
        self.assertEqual(result['state'], 'completed', result.get('detail'))

    def test_recovery_keeps_the_source_and_expired_original_deadline(self):
        material = self.material(b"owned historical model")
        candidate, _, _ = self.targeted_material()
        request = {"operationId": str(uuid.uuid4()), "materialId": material["id"], "action": "verify", "reuseCandidateId": candidate["id"]}
        registered = self.service.register_material(request)
        self.service.material = lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Recovery must use the operation source"))
        with patch.dict(namespace, {"now": lambda: registered["deadline"] + 1}):
            first = self.service.prepare_material(request)
            recovered = self.service.prepare_material({**request, "action": "recover"})
        self.assertEqual(recovered["deadline"], registered["deadline"])
        self.assertEqual(recovered["sourceHash"], registered["sourceHash"])
        self.assertEqual(recovered["fileResults"][0]["state"], "unverified")
        self.assertIn("budget expired", first["detail"])

    def test_selected_source_mount_change_revokes_verification(self):
        material, _, directory, request, result = self.verified_source()
        mount = self.service.mount
        self.service.mount = lambda path: {**mount(path), **({"source": "replacement-device"} if str(path) == str(directory) else {})}
        with self.assertRaisesRegex(RuntimeError, "(filesystem|mount) identity changed"):
            self.service.assess(self.request(materialIds=[material["id"]], materialSources=[{
                "materialId": material["id"], "verificationOperationId": request["operationId"], "mode": "readonly"}]))

    def test_history_verify_uses_the_real_preparation_dispatch_entry(self):
        material = self.material(b"owned historical model")
        candidate, directory, _ = self.targeted_material()
        config = {"action": "history-material-verify", "request": {"operationId": str(uuid.uuid4()),
            "materialId": material["id"], "action": "verify", "reuseCandidateId": candidate["id"]}}
        def service(owner):
            value = StorageGovernance(owner); value.mount = self.service.mount; value.source_released = self.service.source_released
            return value
        with patch.dict(namespace, {"Environments": lambda _: self.owner, "storage_governance": service}):
            result = namespace['main'](config)
        self.assertEqual(result['state'], 'completed')
        self.assertEqual(result['material']['directory'], str(directory))
        self.assertTrue((self.owner.control / 'state/preparation-storage-v1' / self.owner.id / 'material-operations-v1' / result['operationId'] / 'receipt.v1.json').exists())

    def test_copy_fallback_checks_space_before_independent_bytes_are_written(self):
        material, _, directory, request, _ = self.verified_source()
        budget = self.service.assess(self.request(materialIds=[material['id']], materialSources=[{
            'materialId': material['id'], 'verificationOperationId': request['operationId'], 'mode': 'copy'}]))
        self.assertEqual(budget['materialEstimates'][0]['newPeakBytes'], 0)
        with patch.object(namespace['os'], 'link', side_effect=OSError('cross-device link')):
            with patch.object(namespace['fcntl'], 'ioctl', side_effect=OSError('clone unavailable'), create=True):
                with patch.object(self.service, 'download_capacity', side_effect=RuntimeError('copy peak exceeds capacity')):
                    result = self.service.prepare_material({'operationId': str(uuid.uuid4()), 'materialId': material['id'], 'action': 'acquire', 'budgetId': budget['operationId']})
        self.assertEqual(result['state'], 'blocked')
        self.assertIn('copy peak exceeds capacity', result['detail'])
        self.assertEqual((directory / 'model.safetensors').read_bytes(), b'owned historical model')
        self.assertFalse(pathlib.Path(material['directory']).exists())

    def test_known_candidate_still_requires_matching_owner_mount_and_canonical_digest(self):
        candidate, directory, _ = self.targeted_material()
        material = self.material(b"owned historical model", reuseCandidateId=candidate["id"])
        (directory / "model.safetensors").write_bytes(b"wrong historical model")
        result = self.service.prepare_material({"operationId": str(uuid.uuid4()), "materialId": material["id"], "action": "verify", "reuseCandidateId": candidate["id"]})
        self.assertEqual(result["state"], "blocked")
        self.assertEqual(result['fileResults'][0]['state'], 'mismatch')
        self.assertFalse(self.service.material_bindings.exists())
        save(pathlib.Path(candidate["runRoot"]) / ".aspera-owner.json", {"version": 1, "serverId": str(uuid.uuid4()), "experimentId": candidate["sourceExperimentId"]})
        with self.assertRaisesRegex(RuntimeError, "owner"):
            self.service.find_material_candidate(candidate["id"])

    def test_metadata_digest_mismatch_does_not_skip_later_weight_verification(self):
        weights, metadata = b'owned historical model', b'fixed metadata'
        candidate, directory, _ = self.targeted_material(weights)
        (directory / '.gitattributes').write_bytes(b'wrong metadata')
        request = {'kind': 'model', 'provider': 'huggingface', 'repository': 'fixture/tiny', 'revision': 'a' * 40}
        canonical = {'id': request['repository'], 'sha': request['revision'], 'siblings': [
            {'rfilename': name, 'size': len(data), 'lfs': {'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}}
            for name, data in [('.gitattributes', metadata), ('model.safetensors', weights)]]}
        material = self.service.inspect_material(request, canonical)
        result = self.service.prepare_material({'operationId': str(uuid.uuid4()), 'materialId': material['id'], 'action': 'verify', 'reuseCandidateId': candidate['id']})
        self.assertEqual([row['state'] for row in result['fileResults']], ['mismatch', 'verified'])
        self.assertEqual(result['material']['verifiedBytes'], len(weights))
        self.assertIn('digest', result['fileResults'][0]['detail'])

    def test_completed_readonly_verification_is_invalidated_when_the_source_changes(self):
        candidate, directory, _ = self.targeted_material()
        material = self.material(b"owned historical model", reuseCandidateId=candidate["id"])
        request = {"operationId": str(uuid.uuid4()), "materialId": material["id"], "action": "verify", "reuseCandidateId": candidate["id"]}
        self.assertEqual(self.service.prepare_material(request)["state"], "completed")
        original_receipt = (self.owner.run / "material-operations-v1" / request["operationId"] / "receipt.v1.json").read_bytes()
        (directory / "model.safetensors").write_bytes(b"changed model contents")
        self.assertEqual(self.service.material_operation(request["operationId"])["state"], "blocked")
        self.assertEqual(self.service.material(material["id"])["verifiedBytes"], 0)
        self.assertEqual(original_receipt, (self.owner.run / "material-operations-v1" / request["operationId"] / "receipt.v1.json").read_bytes())

    def test_whole_experiment_capacity_remains_pending_without_bound_fixed_materials(self):
        result = self.service.assess(self.request(assessmentScope="experiment", materialRequirements={"planRevision": 1, "complete": True,
            "materials": [{"kind": "model", "repository": "fixture/tiny", "revision": "a" * 40}]}))
        self.assertEqual(result["state"], "requirements-pending")
        self.assertFalse(result["coverage"]["complete"])
        self.assertIn("no bound canonical", result["detail"])

    def test_an_unselected_failed_source_attempt_does_not_block_registered_material_coverage(self):
        material = self.material()
        request = {"kind": "model", "provider": "huggingface", "repository": "fixture/unselected", "revision": "b" * 40, "metadataSource": "host"}
        self.service.inspect_material(request)
        budget = self.service.assess(self.request(assessmentScope="experiment", materialIds=[material["id"]], materialRequirements={
            "planRevision": 1, "complete": True, "materials": [{"kind": "model", "repository": "fixture/tiny", "revision": "a" * 40, "materialId": material["id"]}]}))
        self.assertEqual(budget["state"], "ready")
        self.assertTrue(budget["coverage"]["complete"])

    def test_material_request_does_not_reset_its_deadline_on_retry_or_restart(self):
        request = {"kind": "model", "provider": "huggingface", "repository": "fixture/tiny", "revision": "a" * 40, "metadataSource": "host"}
        result = self.service.inspect_material(request)
        path = self.owner.run / "material-metadata-v1" / (result["requestId"] + ".json")
        original = load(path)
        with patch.dict(namespace, {"now": lambda: original["deadline"] + 1}):
            restarted = StorageGovernance(self.owner)
            result = restarted.inspect_material(request)
            self.assertEqual(result["state"], "metadata-blocked")
            self.assertEqual(restarted.pending_metadata(), [])
        self.assertEqual(load(path)["deadline"], original["deadline"])

    def test_agent_switching_metadata_location_keeps_one_request_and_deadline(self):
        request = {"kind": "model", "provider": "huggingface", "repository": "fixture/tiny", "revision": "a" * 40, "metadataSource": "node"}
        with patch.object(self.service, "metadata", side_effect=TimeoutError("node timeout")):
            first = self.service.inspect_material(request)
        path = self.owner.run / "material-metadata-v1" / (first["requestId"] + ".json")
        deadline = load(path)["deadline"]
        changed = self.service.inspect_material({**request, "metadataSource": "host", "mirror": "https://hf-mirror.com"})
        self.assertEqual(changed["requestId"], first["requestId"])
        self.assertEqual(load(path)["deadline"], deadline)
        self.assertEqual(len(self.service.pending_metadata()), 1)
        self.assertEqual(self.service.pending_metadata()[0]["request"]["metadataSource"], "host")
        self.service.metadata_error(first["requestId"], "Host request unavailable")
        self.assertEqual(load(path)["deadline"], deadline)

    def test_requirement_evidence_is_bound_to_the_plan_session_and_precise_observation(self):
        self.service.config["evidenceContext"] = {"sessionId": "execution-a", "planRevision": 1}
        with patch.object(namespace["shutil"], "disk_usage", return_value=shutil._ntuple_diskusage(1000, 999, 1)):
            budget = self.service.assess(self.request(outputBytes=100))
        reference = {"serverId": self.owner.server, "kind": "storage-plan", "id": budget["operationId"]}
        observed = self.service.requirement_evidence(reference)
        self.assertIn("declared scope", observed["detail"])
        self.service.config["evidenceContext"] = {"sessionId": "execution-b", "planRevision": 1}
        with self.assertRaisesRegex(RuntimeError, "different experiment, plan or Session"):
            self.service.requirement_evidence(reference)

    def placement_fixture(self, system_free=10000, data_free=4200):
        self.owner.placement["workspaceRoot"] = str(self.owner.workspace)
        self.owner.placement["minimumFreeBytes"] = 10
        self.owner.policy["minimumFreeBytes"] = 10
        self.owner.config["action"] = "storage-assess"
        self.owner.manifests = self.owner.run / "environments-v1"
        self.owner.manifests.mkdir(exist_ok=True)
        self.service.policy.update(systemReserveBytes=1000, systemReserveRatio=.1, dataReserveBytes=500, dataReserveRatio=.05, peakSafetyFactor=1.2)
        disk = patch.object(namespace["shutil"], "disk_usage", side_effect=lambda path: shutil._ntuple_diskusage(20000 if self.service.mount(path)["source"] == "fixture-system" else 10000,
            0, system_free if self.service.mount(path)["source"] == "fixture-system" else data_free))
        disk.start(); self.addCleanup(disk.stop)
        provider = patch.dict(namespace, {"storage_governance": lambda _: self.service})
        provider.start(); self.addCleanup(provider.stop)
        borrowing = patch.object(self.service, "borrowing", return_value=None)
        attempted = borrowing.start(); self.addCleanup(borrowing.stop)
        return attempted

    def test_fallback_reuses_first_then_applies_only_the_environment_and_keeps_one_event(self):
        reuse = self.placement_fixture()
        original_workspace = str(self.owner.workspace)
        request = self.request(requirements=["fixture==1"], outputBytes=1000, environmentEstimate={"peakBytes": 6000, "basis": "fixed wheels plus unpack/build temporary files"}, allowEnvironmentFallback=True)
        result = self.service.assess(request)
        self.assertEqual(result["state"], "ready")
        reuse.assert_called_once()
        event = load(self.owner.run / "storage-arrangement.v1.json")
        self.assertEqual(event["dataWorkspace"], original_workspace)
        self.assertEqual(str(self.owner.workspace), event["environmentWorkspace"])
        self.assertEqual(event["estimatedPeakBytes"], 7200)
        self.assertEqual(self.owner.placement["workspaceRoot"], original_workspace)
        second = self.service.assess(request)
        self.assertEqual(second["state"], "ready")
        self.assertEqual(event, load(self.owner.run / "storage-arrangement.v1.json"))
        output = pathlib.Path(original_workspace) / "artifacts/result.json"
        output.parent.mkdir(exist_ok=True)
        output.write_bytes(b'x' * 4096)
        third = self.service.assess(request)
        data = next(row for row in third["volumes"] if row["source"] == 'fixture-data')
        self.assertEqual(data["outputBytes"], 0, 'Outputs remain measured on the original data workspace after environment fallback')

    def test_both_volumes_insufficient_do_not_publish_a_fallback(self):
        self.placement_fixture(system_free=5000)
        result = self.service.assess(self.request(requirements=["fixture==1"], outputBytes=1000, environmentEstimate={"peakBytes": 6000, "basis": "fixture wheel sizes"}, allowEnvironmentFallback=True))
        self.assertEqual(result["state"], "insufficient")
        self.assertFalse((self.owner.run / "storage-arrangement.v1.json").exists())
        self.assertTrue(any(row["shortfallBytes"] > 0 for row in result["volumes"]))

    def test_historical_reuse_avoids_system_fallback_and_unknown_sizes_remain_pending(self):
        self.placement_fixture()
        self.service.borrowing = lambda _: {"requirements": ["fixture==1"]}
        result = self.service.assess(self.request(requirements=["fixture==1"], outputBytes=1000, environmentEstimate={"peakBytes": 6000, "basis": "fixture"}, allowEnvironmentFallback=True))
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["volumes"][0]["environmentBytes"], 0)
        self.assertFalse((self.owner.run / "storage-arrangement.v1.json").exists())
        self.service.borrowing = lambda _: None
        result = self.service.assess(self.request(requirements=["unknown==1"], outputBytes=1000, allowEnvironmentFallback=True))
        self.assertEqual(result["state"], "requirements-pending")
        self.assertIsNone(result["volumes"][0]["newPeakBytes"])

    def test_fallback_owner_or_mount_changes_are_rejected_on_read(self):
        self.placement_fixture()
        self.service.assess(self.request(requirements=["fixture==1"], outputBytes=1000, environmentEstimate={"peakBytes": 6000, "basis": "fixture"}, allowEnvironmentFallback=True))
        record = self.owner.run / "storage-arrangement.v1.json"
        saved = load(record)
        save(record, {**saved, "experimentId": str(uuid.uuid4())})
        with self.assertRaisesRegex(RuntimeError, 'differs'):
            namespace["environment_arrangement"](self.owner)
        save(record, saved)
        original = self.service.mount
        self.service.mount = lambda path: {**original(path), "source": 'replacement-disk'}
        with self.assertRaisesRegex(RuntimeError, 'filesystem changed'):
            namespace["environment_arrangement"](self.owner)

    def test_existing_environment_operations_prevent_relocation(self):
        self.placement_fixture()
        save(self.owner.operations / str(uuid.uuid4()) / "receipt.v1.json", {"state": "blocked", "exitConfirmed": True})
        with self.assertRaisesRegex(RuntimeError, 'fixed location'):
            self.service.assess(self.request(requirements=["fixture==1"], outputBytes=1000, environmentEstimate={"peakBytes": 6000, "basis": "fixture"}, allowEnvironmentFallback=True))
        self.assertFalse((self.owner.run / "storage-arrangement.v1.json").exists())

    def test_a_readonly_control_filesystem_never_authorizes_fallback(self):
        self.placement_fixture()
        original = self.service.mount
        self.service.mount = lambda path: {**original(path), "readonly": original(path)["source"] == "fixture-system"}
        with self.assertRaisesRegex(RuntimeError, 'read-only'):
            self.service.assess(self.request(requirements=["fixture==1"], outputBytes=1000, environmentEstimate={"peakBytes": 6000, "basis": "fixture"}, allowEnvironmentFallback=True))

    def test_same_filesystem_directories_share_one_budget_and_one_reserve(self):
        self.placement_fixture(data_free=10000)
        material = self.material()
        mount = self.service.mount(self.owner.workspace)
        self.service.mount = lambda _: mount
        result = self.service.assess(self.request(materialIds=[material["id"]], outputBytes=1000))
        self.assertEqual(len(result["volumes"]), 1)
        self.assertEqual(result["volumes"][0]["safetyBytes"], 500)
        self.assertEqual(result["volumes"][0]["newPeakBytes"], namespace["math"].ceil((1000 + len(b'synthetic weights')) * 1.2))

    def test_existing_ready_environment_has_no_second_installation_budget(self):
        self.owner.environment = lambda _: {"state": "ready", "requirements": ["torch==2.14.1"]}
        result = self.service.assess(self.request(requirements=["torch==2.14.1"]))
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["volumes"][0]["environmentBytes"], 0)

    def test_same_operation_cannot_change_output_or_dependency_requirements(self):
        request = self.request()
        self.service.assess(request)
        with self.assertRaisesRegex(RuntimeError, "different requirements"):
            self.service.assess({**request, "outputBytes": 123})

    def test_source_without_terminal_and_allocation_proof_cannot_be_borrowed(self):
        with self.assertRaisesRegex(RuntimeError, "allocation release is unconfirmed"):
            self.service.source_released(str(uuid.uuid4()), self.owner.run)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Live command identities require Linux /proc")
    def test_current_readonly_command_does_not_reoccupy_a_released_source(self):
        original_id = str(uuid.uuid4())
        original_run = self.owner.namespace / "runs" / original_id
        (original_run / "workspace").mkdir(parents=True)
        server = {"id": self.owner.server, "storagePlacement": {"serverId": self.owner.server, "runRoot": str(original_run)}}
        table = self.owner.control / "state/node-home/storages/aspera_node"
        save(table / "allocations" / (original_id + ".json"), {"experimentId": original_id, "deploymentId": "a" * 64, "node": {"server": server}, "released": True})
        save(self.owner.control / "state/coordinator-home/storages/aspera_queue/experiments" / (original_id + ".json"),
            {"state": "completed", "resourcesReleased": True, "submission": {"experimentId": original_id, "deploymentId": "a" * 64, "nodes": [{"server": server}]}})
        self.owner.placement["workspaceRoot"] = str(self.owner.workspace)
        current_server = {"id": self.owner.server, "storagePlacement": {"serverId": self.owner.server, "runRoot": str(self.owner.run), "workspaceRoot": str(self.owner.workspace)}}
        save(table / "allocations" / (self.owner.id + ".json"), {"experimentId": self.owner.id, "deploymentId": "a" * 64, "node": {"server": current_server}, "released": False})
        command = "readonly-consumer"
        save(table / "commands" / (self.owner.id + "_" + command + ".json"), {"experimentId": self.owner.id, "commandId": command, "state": "running", "released": False})
        identity = self.owner.run / "process-identities" / (command + ".v1.json")
        binding = {"experimentId": self.owner.id, "serverId": self.owner.server, "commandId": command,
            "controlRoot": str(self.owner.control), "deploymentId": "a" * 64}
        child_file = self.owner.workspace / "readonly-consumer-child.pid"
        launcher = "\n".join([
            "import pathlib,signal,subprocess,sys",
            "child=subprocess.Popen([sys.executable,'-c','import sys; sys.stdin.read()',sys.argv[2]],start_new_session=True)",
            "pathlib.Path(sys.argv[1]).write_text(str(child.pid))",
            "signal.signal(signal.SIGTERM,lambda *_:sys.exit(143))",
            "try: child.wait()",
            "finally:",
            " if child.poll() is None: child.terminate(); child.wait(timeout=5)",
        ])
        process = subprocess.Popen([sys.executable, str(scripts / "owned-command.py"), str(identity), json.dumps(binding),
            sys.executable, "-c", launcher, str(child_file), str(original_run / "workspace")],
            cwd=self.owner.workspace, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        def close_process():
            process.stdin.close()
            if process.poll() is None:
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.terminate(); process.wait(timeout=5)
            for stream in (process.stdin, process.stdout, process.stderr):
                if not stream.closed:
                    stream.close()
        self.addCleanup(close_process)
        deadline = time.monotonic() + 5
        while not (identity.exists() and child_file.exists()) and process.poll() is None and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue(identity.exists(), "Owned wrapper must publish its identity before execution")
        self.assertTrue(child_file.exists(), "The owned command must start its private-session child")
        child_pid = int(child_file.read_text())
        self.assertNotEqual(os.getpgid(child_pid), os.getpgid(process.pid))
        saved_identity = load(identity)
        observed_pids = [process.pid, child_pid]
        original_iterdir = pathlib.Path.iterdir
        def scoped_processes(path):
            return iter([path / str(pid) for pid in observed_pids]) if path == pathlib.Path("/proc") else original_iterdir(path)
        with patch.object(pathlib.Path, "iterdir", scoped_processes):
            self.assertEqual(len(self.service.source_released(original_id, original_run)), 64)
            unrelated = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()", str(original_run)],
                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            try:
                observed_pids.append(unrelated.pid)
                with self.assertRaisesRegex(RuntimeError, "A process still uses the original experiment"):
                    self.service.source_released(original_id, original_run)
            finally:
                observed_pids.remove(unrelated.pid)
                unrelated.stdin.close()
                try:
                    unrelated.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    unrelated.terminate(); unrelated.wait(timeout=5)
            for change in ({"start": "0"}, {"hostBootId": "previous-boot"}, {"serverId": str(uuid.uuid4())}, {"group": process.pid + 1}, {"environmentOperation": "mutation"}, {"cacheCleanup": True}):
                with self.subTest(change=change):
                    save(identity, {**saved_identity, **change})
                    with self.assertRaisesRegex(RuntimeError, "A process still uses the original experiment"):
                        self.service.source_released(original_id, original_run)
            save(identity, saved_identity)
            command_file = table / "commands" / (self.owner.id + "_" + command + ".json")
            saved_command = load(command_file)
            save(command_file, {**saved_command, "released": True})
            with self.assertRaisesRegex(RuntimeError, "A process still uses the original experiment"):
                self.service.source_released(original_id, original_run)
            save(command_file, saved_command)
            current_allocation = table / "allocations" / (self.owner.id + ".json")
            saved_allocation = load(current_allocation)
            save(current_allocation, {**saved_allocation, "releasing": True})
            with self.assertRaisesRegex(RuntimeError, "A process still uses the original experiment"):
                self.service.source_released(original_id, original_run)
            save(current_allocation, saved_allocation)
            identity.unlink()
            with self.assertRaisesRegex(RuntimeError, "A process still uses the original experiment"):
                self.service.source_released(original_id, original_run)

    def test_terminal_proof_from_a_different_experiment_cannot_authorize_a_historical_source(self):
        identifier = str(uuid.uuid4())
        source = self.owner.namespace / 'runs' / identifier
        node = {'experimentId': identifier, 'released': True, 'deploymentId': 'a' * 64, 'node': {'server': {'id': self.owner.server,
            'storagePlacement': {'serverId': self.owner.server, 'runRoot': str(source)}}}}
        save(self.owner.control / 'state/node-home/storages/aspera_node/allocations' / (identifier + '.json'), node)
        save(self.owner.control / 'state/coordinator-home/storages/aspera_queue/experiments' / (identifier + '.json'),
            {'state': 'completed', 'resourcesReleased': True, 'submission': {'experimentId': str(uuid.uuid4()), 'nodes': [], 'deploymentId': 'a' * 64}})
        with self.assertRaisesRegex(RuntimeError, 'does not confirm'):
            self.service.source_released(identifier, source)

    def test_account_side_candidate_exposes_existing_versions_without_claiming_verified_reuse(self):
        identifier = str(uuid.uuid4()); run = self.owner.namespace / 'runs' / identifier
        directory = run / 'workspace/pyenv'; (directory / 'bin').mkdir(parents=True)
        (directory / 'bin/python').write_text('interpreter fixture'); (directory / 'pyvenv.cfg').write_text('home=/usr/bin\n')
        save(run / '.aspera-owner.json', {'version': 1, 'serverId': self.owner.server, 'experimentId': identifier})
        metadata = directory / 'lib/python3.10/site-packages/torch-2.14.1.dist-info/METADATA'; metadata.parent.mkdir(parents=True)
        metadata.write_text('Metadata-Version: 2.1\nName: torch\nVersion: 2.14.1\n')
        candidate = self.service.candidate(run, directory, self.owner.namespace)
        self.assertEqual(candidate['distributions'], [{'name': 'torch', 'version': '2.14.1'}])
        self.assertIsNone(candidate['reusable'])
        self.assertTrue(candidate['metadataComplete'])

    def test_preparation_inspection_runs_before_a_new_experiment_directory_exists(self):
        config = {"action": "history-inspect"}
        self.service.catalog = lambda *_: {"state": "account-inspected"}
        shutil.rmtree(self.owner.run)
        with patch.dict(namespace, {"Environments": lambda _: self.owner, "storage_governance": lambda _: self.service}):
            self.assertEqual(namespace["main"](config), {"state": "account-inspected"})

    def test_capacity_is_separate_for_system_and_data_and_does_not_double_reserve_shared_content(self):
        material = self.material()
        peer = str(uuid.uuid4())
        volume = self.service.mount(self.owner.workspace)["directory"]
        held = {"directory": volume, "experimentId": peer, "remainingBytes": 12345, "baseBytes": 4000,
            "materials": [{"id": digest([material["files"][0]["algorithm"], material["files"][0]["hash"], material["files"][0]["bytes"]]), "remainingBytes": 8345}]}
        save(self.service.root / "reservations/peer.json", {"serverId": self.owner.server, "volumes": [held]})
        save(self.service.root / "reservations/peer-repeat.json", {"serverId": self.owner.server, "volumes": [held]})
        self.assertEqual(self.service.peer_held(volume, [material["id"]]), 4000)
        self.assertEqual(self.service.peer_held(volume), 12345)
        material["missingBytes"] = 18000000000
        material["files"][0]["bytes"] = material["missingBytes"]
        save(self.service.root / "materials-0.1.2" / (material["id"] + ".json"), material)
        self.owner.workspace = self.base / "system/current-workspace"; self.owner.workspace.mkdir()
        def usage(path):
            free = 40000000000 if str(path).startswith(str(self.base / "system")) else 1600000000
            return shutil._ntuple_diskusage(52500000000, 52500000000 - free, free)
        with patch.object(namespace["shutil"], "disk_usage", side_effect=usage):
            plan = self.service.assess(self.request(materialIds=[material["id"]]))
        self.assertEqual(len(plan["volumes"]), 2)
        self.assertEqual(plan["state"], "insufficient")

    def test_borrowing_publishes_readonly_references_without_installing_or_modifying_the_source(self):
        source_id = str(uuid.uuid4()); source_run = self.owner.namespace / "runs" / source_id
        directory = source_run / "workspace/pyenv"; (directory / "bin").mkdir(parents=True)
        (directory / "bin/python").write_bytes(b"interpreter fixture")
        (directory / "pyvenv.cfg").write_text("include-system-site-packages = false\n")
        (directory / "package.py").write_text("value=1\n")
        metadata = directory / "lib/python3.10/site-packages/tiny_fixture-1.dist-info/METADATA"
        metadata.parent.mkdir(parents=True)
        metadata.write_text("Metadata-Version: 2.1\nName: tiny-fixture\nVersion: 1\n")
        candidate = {"id": "b" * 64, "directory": str(directory), "python": str(directory / "bin/python"),
            "runRoot": str(source_run), "sourceExperimentId": source_id}
        request = {"environmentId": "training", "operationId": str(uuid.uuid4()), "action": "create", "requirements": ["tiny-fixture==1"],
            "modules": ["tiny_fixture"], "requireCuda": False, "reuseCandidateId": candidate["id"]}
        self.owner.sandbox = lambda command, **_kwargs: ["bwrap", "--", *command]
        self.service.find_candidate = lambda _: candidate
        self.service.source_released = lambda *_: "confirmed-original-release"
        before = {str(path): path.read_bytes() for path in directory.rglob('*') if path.is_file()}
        result = subprocess.CompletedProcess([], 0, json.dumps({"prefix": str(directory), "userSite": False, "pythonVersion": "3.10.12", "pythonAbi": "cp310", "cuda": False}), '')
        def probe(argv, **_kwargs):
            return subprocess.CompletedProcess(argv, 0, "uv 0.13.0\n", "") if "--version" in argv else result
        with patch.object(namespace["subprocess"], "run", side_effect=probe) as commands:
            binding = self.service.borrowing(request)
        self.assertTrue(all("install" not in call.args[0] and "venv" not in call.args[0] for call in commands.call_args_list))
        self.assertEqual(binding["mode"], "borrowed-readonly")
        self.assertEqual(load(pathlib.Path(binding["lease"])), binding)
        self.assertEqual(before, {str(path): path.read_bytes() for path in directory.rglob('*') if path.is_file()})
        self.service.validate_borrowings()
        (directory / 'package.py').write_text('value=2\n')
        with self.assertRaisesRegex(RuntimeError, 'changed'):
            self.service.validate_borrowings()

    def test_verified_partial_shards_are_not_budgeted_or_downloaded_twice(self):
        data = b"retained complete shard"
        material = self.material(data)
        partial = pathlib.Path(material["directory"]).parent / (".partial-" + material["id"]) / "model.safetensors"
        partial.parent.mkdir(parents=True); partial.write_bytes(data)
        inspected = self.material(data)
        self.assertEqual(inspected["missingBytes"], 0)
        self.assertEqual(inspected["unknownBytes"], len(data), 'Existing unverified shards are unknown rather than missing')
        verified = self.service.prepare_material({"operationId": str(uuid.uuid4()), "materialId": material["id"], "action": "verify"})
        self.assertEqual(verified["state"], "completed")
        inspected = self.material(data)
        self.assertEqual(inspected["missingBytes"], 0)
        with patch.object(namespace["urllib"].request, "urlopen", side_effect=AssertionError("duplicate download")):
            outcome = self.service.prepare_material({"operationId": str(uuid.uuid4()), "materialId": material["id"], "budgetId": self.ready_budget(inspected), "action": "acquire"})
        self.assertEqual(outcome["state"], "completed")
        self.assertEqual(outcome["downloadedBytes"], 0)

    def test_identical_files_across_revisions_share_an_inode_and_preserve_the_original_publication(self):
        data = b"same fixed file in distinct revisions"
        first = self.material(data)
        with patch.object(namespace["urllib"].request, "urlopen", return_value=Response(data)):
            self.service.prepare_material({"operationId": str(uuid.uuid4()), "materialId": first["id"], "budgetId": self.ready_budget(first), "action": "acquire"})
        publication = self.owner.run / "material-publications-0.1.2" / (first["id"] + '.json')
        original_publication = publication.read_bytes()
        second = self.material(data, revision='b' * 40)
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(second["missingBytes"], 0)
        with patch.object(namespace["urllib"].request, "urlopen", side_effect=AssertionError("duplicate revision download")):
            result = self.service.prepare_material({"operationId": str(uuid.uuid4()), "materialId": second["id"], "budgetId": self.ready_budget(second), "action": "acquire"})
        self.assertEqual(result["state"], "completed")
        self.assertEqual(result["downloadedBytes"], 0)
        left, right = [pathlib.Path(row["directory"]) / 'model.safetensors' for row in (first, second)]
        self.assertEqual((left.stat().st_dev, left.stat().st_ino), (right.stat().st_dev, right.stat().st_ino))
        self.assertEqual(publication.read_bytes(), original_publication)

    def test_written_outputs_reduce_remaining_reserve_without_changing_the_original_requirement(self):
        request = self.request(outputBytes=65536)
        initial = self.service.assess(request)
        output = self.owner.workspace / 'output'; output.mkdir()
        (output / 'adapter.bin').write_bytes(b'x' * 16384)
        current = self.service.assess(request)
        self.assertEqual(current['declaredOutputBytes'], 65536)
        self.assertLess(current['volumes'][0]['outputBytes'], initial['volumes'][0]['outputBytes'])
        self.assertEqual(current['requestHash'], initial['requestHash'])

    def test_material_recovery_preserves_verification_mode_and_cannot_create_a_missing_operation(self):
        material = self.material()
        request = {"operationId": str(uuid.uuid4()), "materialId": material["id"], "budgetId": self.ready_budget(material), "action": "verify"}
        with patch.object(namespace["urllib"].request, "urlopen", side_effect=AssertionError('verification must not download')):
            first = self.service.prepare_material(request)
            self.assertEqual(first['state'], 'blocked')
            self.service.config['materialCommandId'] = 'material-' + request['operationId'] + '-retry-1'
            recovery = {**request, 'action': 'recover'}
            self.service.register_material(recovery)
            second = self.service.prepare_material(recovery)
        self.assertEqual(second['state'], 'blocked')
        self.assertEqual(second['fileResults'][0]['state'], 'missing')
        with self.assertRaisesRegex(RuntimeError, 'different content'):
            self.service.register_material({**request, 'action': 'acquire'})
        with self.assertRaisesRegex(RuntimeError, 'Original material request is missing'):
            self.service.register_material({**request, 'operationId': str(uuid.uuid4()), 'action': 'recover'})

    def test_mirror_claim_does_not_replace_canonical_commit(self):
        request = {"kind": "model", "provider": "huggingface", "repository": "fixture/tiny", "revision": "a" * 40}
        for document in ({"id": "fixture/tiny", "sha": "b" * 40, "siblings": []}, {"id": "foreign/tiny", "sha": "a" * 40, "siblings": []}):
            with self.assertRaisesRegex(RuntimeError, "did not attest"):
                self.service.inspect_material(request, document)
        with self.assertRaisesRegex(RuntimeError, "immutable commit attestation"):
            self.service.inspect_material({**request, "provider": "modelscope"})

    def test_historical_payload_record_cannot_substitute_different_content_for_its_wheel(self):
        directory = self.base / "package-object"; directory.mkdir()
        wheel = directory / "fixture-1-py3-none-any.whl"
        with zipfile.ZipFile(wheel, "w") as archive:
            archive.writestr("fixture.py", b"VALUE = 1\n")
            archive.writestr("fixture-1.dist-info/METADATA", "Name: fixture\nVersion: 1\n")
        info = {"hash": hashlib.sha256(wheel.read_bytes()).hexdigest(), "name": "fixture", "version": "1",
            "tags": ["py3-none-any"], "distInfo": "fixture-1.dist-info"}
        hashes = {"fixture.py": hashlib.sha256(b"VALUE = 1\n").hexdigest()}
        content = digest(sorted(hashes.items()))
        record = {"wheel": wheel.name, "wheelHash": info["hash"], "name": "fixture", "versionString": "1", "tags": info["tags"],
            "source": "https://fixture.invalid/fixture.whl", "pythonAbi": "fixture-abi", "hashes": hashes, "files": list(hashes), "contentHash": content,
            "id": digest([info["hash"], "https://fixture.invalid/fixture.whl", "fixture-abi", info["tags"], content])}
        self.owner.wheel = lambda _: info
        self.service.verify_package_record(record, directory)
        record["hashes"] = {"fixture.py": hashlib.sha256(b"VALUE = 2\n").hexdigest()}
        with self.assertRaisesRegex(RuntimeError, "canonical wheel content"):
            self.service.verify_package_record(record, directory)

    def test_unsafe_paths_unknown_digests_and_unconfigured_mirrors_are_rejected(self):
        request = {"kind": "model", "provider": "huggingface", "repository": "fixture/tiny", "revision": "a" * 40}
        for entry in ({"rfilename": "../outside", "size": 1, "blobId": "a" * 40}, {"rfilename": "model", "size": 1, "blobId": ""}):
            with self.assertRaises((RuntimeError, ValueError)):
                self.service.inspect_material(request, {"id": "fixture/tiny", "sha": "a" * 40, "siblings": [entry]})
        with self.assertRaisesRegex(RuntimeError, "outside configured"):
            self.material(mirror="https://localhost")

    def test_second_experiment_uses_verified_weights_without_network_or_copy(self):
        data = b"small immutable weight content"
        material = self.material(data)
        budget = self.ready_budget(material)
        request = {"operationId": str(uuid.uuid4()), "materialId": material["id"], "budgetId": budget, "action": "acquire"}
        with patch.object(namespace["urllib"].request, "urlopen", return_value=Response(data)) as network:
            result = self.service.prepare_material(request)
        self.assertEqual(result["state"], "completed")
        self.assertEqual(network.call_count, 1)
        weights = pathlib.Path(material["directory"]) / "model.safetensors"
        identity = weights.stat().st_ino
        another = Owner(self.base / "second")
        another.server = self.owner.server; another.namespace = self.owner.namespace; another.control = self.owner.control
        another.run = self.owner.namespace / "runs" / another.id; another.workspace = another.run / "workspace"; another.workspace.mkdir(parents=True)
        another.placement = self.owner.placement
        service = StorageGovernance(another); service.mount = self.service.mount
        second_budget = service.assess({**self.request(), "materialIds": [material["id"]]})
        with patch.object(namespace["urllib"].request, "urlopen", side_effect=AssertionError("second download")):
            second = service.prepare_material({**request, "operationId": str(uuid.uuid4()), "budgetId": second_budget["operationId"]})
        self.assertEqual(second["state"], "completed")
        self.assertEqual(second["downloadedBytes"], 0)
        self.assertEqual(weights.stat().st_ino, identity)
        self.assertEqual(weights.read_bytes(), data)

    def test_bad_download_keeps_partial_and_never_publishes(self):
        data = b"canonical weights"
        material = self.material(data)
        request = {"operationId": str(uuid.uuid4()), "materialId": material["id"], "budgetId": self.ready_budget(material), "action": "acquire"}
        with patch.object(namespace["urllib"].request, "urlopen", return_value=Response(b"x" * len(data))):
            result = self.service.prepare_material(request)
        self.assertEqual(result["state"], "blocked")
        self.assertFalse(pathlib.Path(material["directory"]).exists())
        partial = pathlib.Path(material["directory"]).parent / (".partial-" + material["id"]) / "model.safetensors.part"
        self.assertTrue(partial.exists())

    def test_partial_resume_verifies_whole_file_and_keeps_original_deadline(self):
        data = b"canonical weights"
        material = self.material(data)
        request = {"operationId": str(uuid.uuid4()), "materialId": material["id"], "budgetId": self.ready_budget(material), "action": "acquire"}
        partial = pathlib.Path(material["directory"]).parent / (".partial-" + material["id"])
        partial.mkdir(parents=True); (partial / "model.safetensors.part").write_bytes(data[:4])
        with patch.object(namespace["urllib"].request, "urlopen", return_value=Response(data[4:], 206, {"Content-Range": "bytes 4-16/17"})) as network:
            result = self.service.prepare_material(request)
        self.assertEqual(result["state"], "completed")
        self.assertEqual(network.call_args.args[0].headers["Range"], "bytes=4-")
        self.assertEqual(result["downloadedBytes"], len(data) - 4)
        original = self.service.material_operation(request["operationId"])
        self.assertEqual(original["deadline"], result["deadline"])

    def test_file_digest_uses_git_blob_header_for_non_lfs_metadata(self):
        path = self.base / "config.json"; path.write_bytes(b"{}")
        row = {"bytes": 2, "algorithm": "git-sha1", "hash": hashlib.sha1(b"blob 2\0{}").hexdigest()}
        self.assertTrue(self.service.file_valid(path, row))
        path.write_bytes(b"[]")
        self.assertFalse(self.service.file_valid(path, row))

    def test_unconfirmed_source_lease_blocks_deletion_without_changing_source(self):
        source = str(uuid.uuid4())
        save(self.service.root / "environment-leases" / "loan.json", {"serverId": self.owner.server, "sourceExperimentId": source, "experimentId": self.owner.id})
        with self.assertRaisesRegex(RuntimeError, "borrowed read-only"):
            self.service.protect_source(source)
        self.assertTrue(self.owner.workspace.exists())

    @unittest.skipUnless(os.name == "posix", "Linux mount and allocated-block semantics require a Linux filesystem")
    def test_hardlink_inventory_counts_one_physical_payload(self):
        roots, _ = self.service.roots()
        root = next(row for row in roots if row["directory"] == str(self.owner.namespace))
        scope = {"kind": "directory", "rootId": root["id"], "relativePath": self.owner.workspace.relative_to(self.owner.namespace).as_posix()}
        baseline = self.service.catalog(refresh=True, scope=scope)
        before = sum(row["allocatedBytes"] for volume in baseline["volumes"] for row in volume["categories"] if row["kind"] == "other")
        path = self.owner.workspace / "one"; path.write_bytes(b"x" * 8192)
        os.link(path, self.owner.workspace / "two")
        result = self.service.catalog(refresh=True, scope=scope)
        measured = sum(row["allocatedBytes"] for volume in result["volumes"] for row in volume["categories"] if row["kind"] == "other") - before
        self.assertGreaterEqual(measured, path.stat().st_blocks * 512)
        self.assertLess(measured, path.stat().st_blocks * 512 * 2 + 4096)


    def observed(self):
        roots, _ = self.service.roots()
        row = next(value for value in roots if value["directory"] == str(self.owner.namespace))
        return {"operationId": str(uuid.uuid4()), "rootId": row["id"], "observationId": row["observationId"]}

    def test_clone_registration_preserves_old_identity_and_rejects_old_proofs(self):
        self.service.catalog(refresh=True)
        path = self.service.root / "root-identities" / (digest(str(self.owner.namespace)) + ".json")
        old = path.read_bytes()
        original = self.service.mount
        self.service.mount = lambda path: {**original(path), "source": "copied-volume"}
        self.assertFalse(next(row for row in self.service.roots()[0] if row["directory"] == str(self.owner.namespace))["confirmed"])
        request = self.observed()
        result = self.service.verify_root(request)
        self.assertEqual(result["state"], "verified")
        self.assertEqual(path.read_bytes(), old)
        self.assertEqual(self.service.verify_root(request)["registrationId"], result["registrationId"])
        with self.assertRaisesRegex(RuntimeError, "previous storage registration"):
            self.service.check_registration({}, self.owner.workspace)
        self.assertEqual(self.service.registration_id(self.owner.workspace), result["registrationId"])

    def test_stale_observation_and_changed_fixed_placement_cannot_register(self):
        request = self.observed()
        original = self.service.mount
        self.service.mount = lambda path: {**original(path), "mountId": 1234}
        with self.assertRaisesRegex(RuntimeError, "stale"):
            self.service.verify_root(request)
        self.owner.placement["candidate"] = {"mount": {"source": "prior-disk", "filesystem": "ext4"}}
        with self.assertRaisesRegex(RuntimeError, "fixed placement"):
            self.service.verify_root(self.observed())
        self.assertIsNone(self.service.root_registration(self.owner.namespace))

    def test_registration_commit_can_recover_after_pointer_write(self):
        request = self.observed()
        def interrupted(path, value):
            save(path, value)
            if "current" in pathlib.Path(path).parts:
                raise OSError("connection dropped")
        with patch.dict(namespace, {"save": interrupted}), self.assertRaisesRegex(OSError, "connection dropped"):
            self.service.verify_root(request)
        result = self.service.verify_root(request)
        self.assertEqual(result["state"], "verified")
        self.assertEqual(len(list((self.service.root / "registrations-0.1.3/history").glob("*.json"))), 1)

    def test_writer_refusal_preserves_the_pending_registration(self):
        request = self.observed()
        with patch.object(self.service, "registration_writers", side_effect=RuntimeError("writer still running")), self.assertRaisesRegex(RuntimeError, "writer still running"):
            self.service.verify_root(request)
        path = self.service.root / "registrations-0.1.3/operations" / (request["operationId"] + ".json")
        self.assertEqual(load(path)["state"], "requested")
        self.assertIsNone(self.service.root_registration(self.owner.namespace))

    @unittest.skipUnless(os.name == "posix", "Process groups and boot identity require Linux")
    def test_registration_allows_current_agent_but_refuses_live_command_and_other_agent(self):
        snapshot = self.service.root_snapshot(self.owner.namespace)
        folder = self.owner.control / "state/node-home/storages/aspera_node/allocations"
        placement = {**self.owner.placement, "runRoot": str(self.owner.run), "candidate": {"mount": snapshot["mount"]}}
        row = {"experimentId": self.owner.id, "released": False, "node": {"server": {"storagePlacement": placement}}}
        save(folder / (self.owner.id + ".json"), {"record": row})
        identity = {"experimentId": self.owner.id, "serverId": self.owner.server, "hostBootId": pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "pid": os.getpid(), "group": os.getpgid(0), "start": pathlib.Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split()[19]}
        save(self.owner.run / "agent-identities/execution.json", identity)
        self.service.registration_writers(self.owner.namespace, snapshot)
        save(self.owner.run / "process-identities/check.json", identity)
        with self.assertRaisesRegex(RuntimeError, "writer is still running"):
            self.service.registration_writers(self.owner.namespace, snapshot)
        (self.owner.run / "process-identities/check.json").unlink()
        other = str(uuid.uuid4())
        run = self.owner.namespace / "runs" / other
        save(folder / (other + ".json"), {"experimentId": other, "released": False, "node": {"server": {"storagePlacement": {**placement, "runRoot": str(run)}}}})
        save(run / "agent-identities/execution.json", {**identity, "experimentId": other})
        with self.assertRaisesRegex(RuntimeError, "writer is still running"):
            self.service.registration_writers(self.owner.namespace, snapshot)

    @unittest.skipUnless(os.name == "posix", "Evidence publication requires Linux directory descriptors")
    def test_evidence_quota_idempotency_overwrite_and_symlink_rejection(self):
        policy = {"evidenceFileBytes": 12, "evidenceTotalBytes": 20}
        request = {"operationId": str(uuid.uuid4()), "path": "reports/check.txt", "content": "verified", "format": "text"}
        first = self.service.write_evidence(request, policy)
        self.assertEqual(first["sha256"], self.service.write_evidence(request, policy)["sha256"])
        with self.assertRaisesRegex(RuntimeError, "different content"):
            self.service.write_evidence({**request, "content": "changed"}, policy)
        with self.assertRaisesRegex(RuntimeError, "Existing evidence differs"):
            self.service.write_evidence({**request, "operationId": str(uuid.uuid4()), "content": "changed"}, policy)
        (self.owner.workspace / "configs").symlink_to(self.base, target_is_directory=True)
        with self.assertRaises(OSError):
            self.service.write_evidence({**request, "operationId": str(uuid.uuid4()), "path": "configs/out.txt", "content": "x"}, policy)
        with self.assertRaisesRegex(RuntimeError, "byte limit"):
            self.service.write_evidence({**request, "operationId": str(uuid.uuid4()), "path": "reports/large.txt", "content": "x" * 13}, policy)
        with self.assertRaisesRegex(RuntimeError, "byte limit"):
            self.service.write_evidence({**request, "operationId": str(uuid.uuid4()), "path": "reports/next.txt", "content": "x" * 12}, policy)
        self.assertEqual((self.owner.workspace / "reports/check.txt").read_text(), "verified")


if __name__ == "__main__":
    unittest.main()
