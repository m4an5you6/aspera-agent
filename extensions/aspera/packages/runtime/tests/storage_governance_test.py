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
helpers = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in ("load", "save", "digest", "relative", "reject_links", "file_hash", "allocated", "now", "main", "release_references")]
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
    namespace["fcntl"] = types.SimpleNamespace(LOCK_EX=1, LOCK_NB=2, LOCK_UN=8, flock=lambda *_: None)
else:
    import fcntl
    namespace["fcntl"] = fcntl
exec(compile((scripts / "storage-placement.py").read_text(), "storage-placement.py", "exec"), namespace)
exec(compile((scripts / "storage-governance.py").read_text(), "storage-governance.py", "exec"), namespace)
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
        self.placement = {"namespaceRoot": str(self.namespace), "minimumFreeBytes": 1024}
        self.policy = {"minimumFreeBytes": 1024, "readTimeoutMs": 1000, "operationPollIntervalMs": 1, "legacyScanDepth": 16}
        self.config = {"deploymentId": "a" * 64, "governancePolicy": {"scanTimeoutMs": 10000, "scanEntryLimit": 10000,
            "verificationTimeoutMs": 1000, "snapshotFileLimit": 1000, "materialHosts": ["huggingface.co", "hf-mirror.com", "modelscope.cn"],
            "metadataBytes": 100000, "materialFileLimit": 100, "transferChunkBytes": 65536, "networkReadTimeoutMs": 1000,
            "materialTimeoutMs": 10000, "maxConcurrentTransfers": 1}}
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
    def material(self, data=b"synthetic weights", **changes):
        request = {"kind": "model", "provider": "huggingface", "repository": "fixture/tiny", "revision": "a" * 40, **changes}
        document = {"id": request["repository"], "sha": request["revision"], "siblings": [{"rfilename": "model.safetensors", "size": len(data),
            "lfs": {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}}]}
        return self.service.inspect_material(request, document)
    def ready_budget(self, material):
        result = self.service.assess(self.request(materialIds=[material["id"]]))
        self.assertEqual(result["state"], "ready")
        return result["operationId"]

    def test_eighteen_gib_model_does_not_fit_a_one_point_six_gib_volume(self):
        material = self.material()
        material["missingBytes"] = 19329394438
        material["files"][0]["bytes"] = material["missingBytes"]
        save(self.service.root / "materials" / (material["id"] + ".json"), material)
        with patch.object(namespace["shutil"], "disk_usage", return_value=shutil._ntuple_diskusage(31526391808, 29858443264, 1667948544)):
            plan = self.service.assess(self.request(materialIds=[material["id"]]))
        self.assertEqual(plan["state"], "insufficient")
        self.assertGreater(plan["volumes"][0]["requiredBytes"], plan["volumes"][0]["availableBytes"])

    def test_unknown_environment_peak_is_pending_and_not_zero(self):
        result = self.service.assess(self.request(requirements=["torch==2.14.1"]))
        self.assertEqual(result["state"], "requirements-pending")
        self.assertIsNone(result["volumes"][0]["environmentBytes"])
        self.assertIsNone(result["volumes"][0]["requiredBytes"])

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
        save(self.service.root / "materials" / (material["id"] + ".json"), material)
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
        candidate = {"id": "b" * 64, "directory": str(directory), "python": str(directory / "bin/python"),
            "runRoot": str(source_run), "sourceExperimentId": source_id}
        request = {"environmentId": "training", "operationId": str(uuid.uuid4()), "action": "create", "requirements": ["tiny-fixture==1"],
            "modules": ["tiny_fixture"], "requireCuda": False, "reuseCandidateId": candidate["id"]}
        self.owner.sandbox = lambda *_args, **_options: ['probe']
        self.service.find_candidate = lambda _: candidate
        self.service.source_released = lambda *_: "confirmed-original-release"
        before = {str(path): path.read_bytes() for path in directory.rglob('*') if path.is_file()}
        result = subprocess.CompletedProcess([], 0, json.dumps({"prefix": str(directory), "userSite": False, "pythonVersion": "3.10.12", "pythonAbi": "cp310", "cuda": False}), '')
        with patch.object(namespace["subprocess"], "run", return_value=result) as commands:
            binding = self.service.borrowing(request)
        self.assertEqual(commands.call_count, 1)
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
        with patch.object(namespace["urllib"].request, "urlopen", side_effect=AssertionError("duplicate download")):
            outcome = self.service.prepare_material({"operationId": str(uuid.uuid4()), "materialId": material["id"], "budgetId": self.ready_budget(inspected), "action": "acquire"})
        self.assertEqual(outcome["state"], "completed")
        self.assertEqual(outcome["downloadedBytes"], 0)

    def test_identical_files_across_revisions_share_an_inode_and_preserve_the_original_publication(self):
        data = b"same fixed file in distinct revisions"
        first = self.material(data)
        with patch.object(namespace["urllib"].request, "urlopen", return_value=Response(data)):
            self.service.prepare_material({"operationId": str(uuid.uuid4()), "materialId": first["id"], "budgetId": self.ready_budget(first), "action": "acquire"})
        publication = self.service.root / "material-publications" / (first["id"] + '.json')
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
        self.assertIn('missing or damaged', second['detail'])
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
        path = self.owner.workspace / "one"; path.write_bytes(b"x" * 8192)
        os.link(path, self.owner.workspace / "two")
        result = self.service.catalog(refresh=True)
        measured = sum(row["allocatedBytes"] for volume in result["volumes"] for row in volume["categories"] if row["kind"] == "other")
        self.assertGreaterEqual(measured, path.stat().st_blocks * 512)
        self.assertLess(measured, path.stat().st_blocks * 512 * 2 + 4096)


if __name__ == "__main__":
    unittest.main()
