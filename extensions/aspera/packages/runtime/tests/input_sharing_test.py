"""Input compaction preserves released snapshots and excludes every active writable source."""
import importlib.util
import contextlib
import os
import pathlib
import types
import unittest
import uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("input_fixture", pathlib.Path(__file__).with_name("managed_environment_test.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
managed = fixture.module


class InputSharingCase(unittest.TestCase):
    setUp = fixture.EnvironmentCase.setUp

    def sources(self):
        self.config["inputSharingVersion"] = 1
        proof = {"version": 1, "experimentId": self.id, "serverId": self.server, "name": "fixture.whl",
            "sha256": managed.hashlib.sha256(b"original" * 4096).hexdigest(), "checkedAt": 1}
        managed.save(self.run / "input-verifications-v1" / (managed.hashlib.sha256(proof["name"].encode()).hexdigest() + ".json"), proof)
        self.files = []
        for _ in range(2):
            run = self.namespace / "runs" / str(uuid.uuid4())
            managed.save(run / ".aspera-owner.json", {"version": 1, "serverId": self.server, "experimentId": run.name})
            for relative in ("inputs/fixture.whl", "workspace/inputs/fixture.whl"):
                target = run / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"original" * 4096)
                self.files.append(target)
        self.governance = types.SimpleNamespace(source_released=lambda identity, run: "released-" + identity,
            protect_path=lambda _: None, locked=contextlib.nullcontext)
        return proof

    def test_explicit_compaction_retains_paths_bytes_and_metadata_and_uses_one_inode(self):
        proof = self.sources()
        before = [(path.read_bytes(), path.stat().st_mode, path.stat().st_uid, path.stat().st_gid) for path in self.files]
        with patch.object(managed, "storage_governance", return_value=self.governance):
            service = managed.input_sharing(self.owner)
            row, = service.discover()
            self.assertEqual(row["bytes"], 3 * self.files[0].stat().st_blocks * 512)
            service.compact(row["id"])
            self.assertEqual(service.discover(), [])
        self.assertEqual(len({path.stat().st_ino for path in self.files}), 1)
        self.assertEqual(before, [(path.read_bytes(), path.stat().st_mode, path.stat().st_uid, path.stat().st_gid) for path in self.files])
        records = list((self.run / "input-sharing-v1").glob("*.json"))
        self.assertEqual(len(records), 1)
        self.assertEqual(managed.load(records[0])["state"], "completed")
        self.assertEqual(managed.load(records[0])["sha256"], proof["sha256"])

    def test_current_or_unreleased_experiment_and_unverified_content_are_excluded(self):
        self.sources()
        target = self.run / "workspace/inputs/fixture.whl"
        target.parent.mkdir(parents=True)
        target.write_bytes(self.files[0].read_bytes())
        blocked = self.files[0].parents[1]
        def released(identity, run):
            if run == blocked:
                raise RuntimeError("active")
            return "released-" + identity
        self.governance.source_released = released
        self.files[-1].write_bytes(b"different")
        with patch.object(managed, "storage_governance", return_value=self.governance):
            self.assertEqual(managed.input_sharing(self.owner).discover(), [])
        self.assertEqual(target.stat().st_nlink, 1)

    def test_changed_release_or_file_requires_a_new_preview_without_rewriting_any_file(self):
        for change in ("release", "content", "mode", "parent"):
            with self.subTest(change=change):
                self.setUp()
                self.sources()
                with patch.object(managed, "storage_governance", return_value=self.governance):
                    service = managed.input_sharing(self.owner)
                    row, = service.discover()
                    if change == "release":
                        self.governance.source_released = lambda *_: "changed"
                    elif change == "content":
                        self.files[0].write_bytes(b"changed")
                    elif change == "mode":
                        self.files[0].chmod(0o600)
                    else:
                        self.files[0].parent.rename(self.files[0].parent.with_name("moved"))
                    with self.assertRaisesRegex(RuntimeError, "changed"):
                        service.compact(row["id"])
                self.assertTrue(all(path.stat().st_nlink == 1 for path in self.files if path.exists()))

    def test_symlinks_mounts_and_open_source_protection_are_excluded(self):
        self.sources()
        self.files[0].unlink()
        self.files[0].symlink_to(self.files[1])
        with patch.object(managed, "storage_governance", return_value=self.governance):
            service = managed.input_sharing(self.owner)
            row, = service.discover()
            self.assertEqual(len(row["files"]), 3)
            with patch.object(service, "snapshot", side_effect=RuntimeError("other mount")):
                self.assertEqual(service.discover(), [])
            self.governance.protect_path = lambda _: (_ for _ in ()).throw(RuntimeError("active source"))
            self.assertEqual(service.discover(), [])

    def test_an_unknown_external_alias_excludes_its_inode_without_hiding_other_safe_copies(self):
        self.sources()
        external = self.root / "external-reference"
        os.link(self.files[0], external)
        original = self.files[0].stat().st_ino
        with patch.object(managed, "storage_governance", return_value=self.governance):
            service = managed.input_sharing(self.owner)
            row, = service.discover()
            self.assertEqual(len(row["files"]), 3)
            self.assertNotIn(str(self.files[0]), [value["path"] for value in row["files"]])
            service.compact(row["id"])
        self.assertEqual(self.files[0].stat().st_ino, original)
        self.assertEqual(external.stat().st_ino, original)

    def test_default_cleanup_does_not_compact_inputs(self):
        row = {"id": "input-duplicate-" + "a" * 64, "kind": "input-duplicate", "bytes": 4096, "reason": "Identical released inputs"}
        with patch.object(self.owner, "candidates", return_value=[row]), patch.object(managed, "input_sharing") as sharing:
            preview = self.owner.preview()
            self.owner.cleanup(str(uuid.uuid4()), preview["fingerprint"])
            sharing.return_value.compact.assert_not_called()
            self.config["candidateIds"] = [row["id"]]
            self.config["inputSharingVersion"] = 1
            self.owner.cleanup(str(uuid.uuid4()), preview["fingerprint"])
            sharing.return_value.compact.assert_called_once_with(row["id"])

    def test_partial_failure_keeps_all_bytes_and_a_fresh_preview_reuses_the_verified_anchor(self):
        self.sources()
        with patch.object(managed, "storage_governance", return_value=self.governance):
            service = managed.input_sharing(self.owner)
            row, = service.discover()
            original = service.confirm_source
            calls = 0
            def confirm(value, governance):
                nonlocal calls
                calls += 1
                if calls == 8:
                    raise RuntimeError("source activity changed")
                original(value, governance)
            with patch.object(service, "confirm_source", side_effect=confirm), self.assertRaisesRegex(RuntimeError, "activity changed"):
                service.compact(row["id"])
            self.assertTrue(all(path.read_bytes() == b"original" * 4096 for path in self.files))
            receipt, = (self.run / "input-sharing-v1").glob("*.json")
            self.assertEqual(managed.load(receipt)["state"], "blocked")
            remaining, = service.discover()
            self.assertIsNotNone(remaining["existingAnchor"])
            service.compact(remaining["id"])
        self.assertEqual(len({path.stat().st_ino for path in self.files}), 1)

    def test_real_release_records_are_required_before_a_historical_workspace_can_be_shared(self):
        self.sources()
        self.config["governancePolicy"] = {}
        governance = managed.storage_governance(self.owner)
        for run in {path.parents[1] if path.parent.name == "inputs" and path.parent.parent.name != "workspace" else path.parents[2] for path in self.files}:
            placement = {"runRoot": str(run), "serverId": self.server, "namespaceRoot": str(self.namespace)}
            node = {"server": {"id": self.server, "storagePlacement": placement}}
            managed.save(self.control / "state/node-home/storages/aspera_node/allocations" / (run.name + ".json"),
                {"experimentId": run.name, "released": True, "deploymentId": "a" * 64, "node": node})
            managed.save(self.control / "state/coordinator-home/storages/aspera_queue/experiments" / (run.name + ".json"),
                {"state": "blocked", "resourcesReleased": True,
                    "submission": {"experimentId": run.name, "deploymentId": "a" * 64, "nodes": [node]}})
        service = managed.input_sharing(self.owner)
        row, = service.discover()
        command = self.control / "state/node-home/storages/aspera_node/commands/active.json"
        managed.save(command, {"experimentId": self.files[0].parents[1].name, "released": False})
        with self.assertRaisesRegex(RuntimeError, "changed"):
            service.compact(row["id"])
        command.unlink()
        service.compact(service.discover()[0]["id"])
        self.assertEqual(len({path.stat().st_ino for path in self.files}), 1)

    def test_atomic_replacement_refuses_a_parent_swap_and_preserves_the_moved_source(self):
        self.sources()
        with patch.object(managed, "storage_governance", return_value=self.governance):
            service = managed.input_sharing(self.owner)
            row, = service.discover()
            original = managed.os.link
            moved = None
            def link(source, destination, **kwargs):
                nonlocal moved
                original(source, destination, **kwargs)
                if str(destination).startswith(".aspera-input-link-"):
                    path = pathlib.Path(row["files"][1]["path"])
                    moved = path.parent.with_name("moved")
                    path.parent.rename(moved)
                    path.parent.mkdir()
            with patch.object(managed.os, "link", side_effect=link), self.assertRaisesRegex(RuntimeError, "parent changed"):
                service.compact(row["id"])
            self.assertIsNotNone(moved)
            self.assertEqual((moved / "fixture.whl").read_bytes(), b"original" * 4096)


class ReleasedAssetCase(unittest.TestCase):
    setUp = fixture.EnvironmentCase.setUp

    def assets(self):
        self.config["releaseAssetSharingVersion"] = 1
        self.governance = types.SimpleNamespace(protect_path=lambda _: None, locked=contextlib.nullcontext)
        self.files = []
        for key in ("b", "c", "d"):
            release = self.namespace / "releases" / (key * 64)
            release.mkdir(parents=True)
            managed.save(release / "aspera-release.json", {"version": 1, "deploymentId": release.name})
            managed.save(release / "package.json", {"name": "aspera-installed-release"})
            (release / ".ready").write_text("")
            path = release / "node_modules/.pnpm/@deepseek-ai+libreoffice-kit-wasm@0.1.4/node_modules/@deepseek-ai/libreoffice-kit-wasm/assets/soffice.wasm"
            path.parent.mkdir(parents=True)
            path.write_bytes(b"unchanged resource" * 4096)
            self.files.append(path)

    def test_identical_idle_known_assets_retain_all_release_paths_and_original_digests(self):
        self.assets()
        with patch.object(managed, "storage_governance", return_value=self.governance):
            service = managed.release_assets(self.owner)
            row, = service.discover()
            service.compact(row["id"])
            self.assertEqual(service.discover(), [])
        self.assertEqual(len({path.stat().st_ino for path in self.files}), 1)
        self.assertTrue(all(managed.file_hash(path) == row["sha256"] for path in self.files))
        record, = (self.run / "release-asset-sharing-v1").glob("*.json")
        self.assertEqual(managed.load(record)["state"], "completed")

    def test_preview_hashes_an_already_shared_payload_once_and_rechecks_it_on_the_next_preview(self):
        self.assets()
        for path in self.files[1:]:
            path.unlink()
            os.link(self.files[0], path)
        content = self.files[0].read_bytes()
        original = managed.hashlib.sha256
        reads = []
        class Checksum:
            def __init__(self, *args, **kwargs):
                self.value = original(*args, **kwargs)
            def update(self, data):
                if data == content:
                    reads.append(len(data))
                self.value.update(data)
            def hexdigest(self):
                return self.value.hexdigest()
        with patch.object(managed, "storage_governance", return_value=self.governance), \
                patch.object(managed.hashlib, "sha256", side_effect=Checksum):
            service = managed.release_assets(self.owner)
            self.assertEqual(service.discover(), [])
            self.assertEqual(len(reads), 1, "Hardlinked release assets must not be reread for every retained release")
            self.assertEqual(service.discover(), [])
            self.assertEqual(len(reads), 2, "A later preview must obtain its own content proof")

    def test_preview_rehashes_a_shared_file_changed_with_its_original_mtime_restored(self):
        self.assets()
        for path in self.files[1:]:
            path.unlink()
            os.link(self.files[0], path)
        with patch.object(managed, "storage_governance", return_value=self.governance):
            service = managed.release_assets(self.owner)
            snapshot = service.snapshot
            hashes = []
            def changing(path):
                value = snapshot(path)
                if path in self.files:
                    hashes.append(value["sha256"])
                    if len(hashes) == 1:
                        before = path.stat()
                        path.write_bytes(b"x" * before.st_size)
                        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
                return value
            with patch.object(service, "snapshot", side_effect=changing):
                self.assertEqual(service.discover(), [])
        self.assertEqual(len(hashes), 3)
        self.assertNotEqual(hashes[0], hashes[1])
        self.assertEqual(hashes[1], hashes[2])

    def test_active_selected_unsealed_and_unknown_files_are_excluded(self):
        self.assets()
        with patch.object(managed, "storage_governance", return_value=self.governance):
            service = managed.release_assets(self.owner)
            active = self.files[0].parents[7]
            with patch.object(service, "users", return_value={str(active)}):
                row, = service.discover()
                self.assertEqual(len(row["files"]), 2)
            (self.files[1].parents[7] / ".ready").unlink()
            self.config["deploymentId"] = self.files[2].parents[7].name
            self.assertEqual(service.discover(), [])
            unknown = self.files[0].with_name("unknown.bin")
            unknown.write_bytes(self.files[0].read_bytes())
            self.assertNotIn(str(unknown), [value["path"] for row in service.discover() for value in row["files"]])

    def test_a_release_becoming_active_after_preview_is_not_rewritten(self):
        self.assets()
        with patch.object(managed, "storage_governance", return_value=self.governance):
            service = managed.release_assets(self.owner)
            row, = service.discover()
            with patch.object(service, "users", return_value={str(self.files[0].parents[7])}), self.assertRaisesRegex(RuntimeError, "changed"):
                service.compact(row["id"])
        self.assertTrue(all(path.stat().st_nlink == 1 for path in self.files))

    def test_release_asset_compaction_requires_explicit_selection(self):
        row = {"id": "release-asset-duplicate-" + "e" * 64, "kind": "release-asset-duplicate", "bytes": 4096, "reason": "Idle immutable resources"}
        self.config["releaseAssetSharingVersion"] = 1
        with patch.object(self.owner, "candidates", return_value=[row]), patch.object(managed, "release_assets") as service:
            preview = self.owner.preview()
            self.owner.cleanup(str(uuid.uuid4()), preview["fingerprint"])
            service.return_value.compact.assert_not_called()
            self.config["candidateIds"] = [row["id"]]
            self.owner.cleanup(str(uuid.uuid4()), preview["fingerprint"])
            service.return_value.compact.assert_called_once_with(row["id"])


if __name__ == "__main__":
    unittest.main()
