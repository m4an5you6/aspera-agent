"""Linux filesystem regressions exercise package publication, confined requests and durable recovery."""
import base64
import csv
import errno
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import shutil
import tempfile
import subprocess
import sys
import unittest
import uuid
import zipfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("managed_environment", os.environ.get("ASPERA_ENVIRONMENT_SOURCE") or pathlib.Path(__file__).parents[1] / "scripts/managed-environment.py")
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


def wheel(path, version="1.0", text=b"value = 17\n", corrupt=False, extra=None, distribution="tiny-fixture"):
    module_name = distribution.replace("-", "_")
    prefix = module_name + "-" + version + ".dist-info"
    entries = {module_name + "/__init__.py": text,
        prefix + "/METADATA": ("Metadata-Version: 2.1\nName: " + distribution + "\nVersion: " + version + "\n").encode(),
        prefix + "/WHEEL": b"Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n"}
    entries.update(extra or {})
    output = io.StringIO(); writer = csv.writer(output)
    for name, data in entries.items():
        checksum = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        writer.writerow([name, "sha256=" + checksum, len(data)])
    writer.writerow([prefix + "/RECORD", "", ""]); entries[prefix + "/RECORD"] = output.getvalue().encode()
    if corrupt:
        entries["tiny_fixture/__init__.py"] = b"changed"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return entries


class MountCleanupCase(unittest.TestCase):
    def test_overlay_files_with_a_different_device_on_the_same_mount_are_removed(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as folder:
            root = pathlib.Path(folder)
            work = root / "operation"; work.mkdir()
            item = work / "requirements.in"; item.write_text("tiny-fixture==1.0\n")
            module.remove_private(work, root)
            self.assertFalse(work.exists())

    def test_same_device_bind_mount_and_nested_mount_are_rejected_before_deletion(self):
        for boundary in ("operation", "nested"):
            with self.subTest(boundary=boundary), tempfile.TemporaryDirectory() as folder:
                root = pathlib.Path(folder); work = root / "operation"; work.mkdir()
                nested = work / "nested"; nested.mkdir(); (nested / "keep").write_text("protected")
                real = module.fd_identity
                def identity(fd, path, stage):
                    value = real(fd, path, stage)
                    return (value[0] + 1, *value[1:]) if pathlib.Path(path).name == boundary else value
                with patch.object(module, "fd_identity", side_effect=identity):
                    with self.assertRaisesRegex(module.CleanupSafetyError, "mounted filesystem"):
                        module.remove_private(work, root)
                self.assertEqual((nested / "keep").read_text(), "protected")

    def test_internal_links_are_unlinked_without_visiting_their_targets(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder); work = root / "operation"; work.mkdir()
            outside = root / "keep"; outside.write_text("untouched")
            (work / "link").symlink_to(outside); (work / "dangling").symlink_to(root / "missing")
            (work / "children").write_text("legal filename")
            module.remove_private(work, root)
            self.assertEqual(outside.read_text(), "untouched")

    def test_scope_root_and_symlinked_ancestors_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder); work = root / "operation"; work.mkdir()
            (root / "alias").symlink_to(work, target_is_directory=True)
            for target in (root, root / ".." / "outside", root / "alias" / "child"):
                with self.subTest(target=target), self.assertRaises(module.CleanupSafetyError):
                    module.remove_private(target, root)

    def test_unreadable_mount_identity_is_a_safety_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder); work = root / "operation"; work.mkdir()
            with patch.object(module.pathlib.Path, "read_text", side_effect=PermissionError("fdinfo inaccessible")):
                with self.assertRaises(module.CleanupSafetyError) as failure:
                    module.remove_private(work, root)
            self.assertEqual(failure.exception.diagnostic["stage"], "anchor")
            self.assertIn("device", failure.exception.diagnostic)

    def test_directory_replacement_after_inspection_preserves_the_original_tree(self):
        with tempfile.TemporaryDirectory() as folder, tempfile.TemporaryDirectory() as escaped:
            root = pathlib.Path(folder); work = root / "operation"; work.mkdir()
            (work / "keep").write_text("original")
            moved = pathlib.Path(escaped) / "moved"
            real = module.os.listdir; visits = 0
            def listing(fd):
                nonlocal visits
                visits += 1
                if visits == 2:
                    os.rename(work, moved); work.mkdir()
                return real(fd)
            with patch.object(module.os, "listdir", side_effect=listing):
                with self.assertRaisesRegex(module.CleanupSafetyError, "replaced"):
                    module.remove_private(work, root)
            self.assertEqual((moved / "keep").read_text(), "original")


class EnvironmentCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.server, self.id = str(uuid.uuid4()), str(uuid.uuid4())
        self.namespace = self.root / "data" / ".aspera" / self.server
        self.run = self.namespace / "runs" / self.id; self.workspace = self.run / "workspace"
        self.workspace.mkdir(parents=True); self.control = self.root / "control"; self.control.mkdir()
        module.save(self.run / ".aspera-owner.json", {"version": 1, "experimentId": self.id, "serverId": self.server})
        self.policy = {"minimumFreeBytes": 0, "maxPackageBytes": 1024 ** 2, "maxPackageFiles": 100,
            "legacyCandidateLimit": 20, "legacyEntryLimit": 100000, "legacyScanDepth": 16, "legacyRunLimit": 20, "uvVersion": "0.13.0", "pipVersion": "26.2.1", "readTimeoutMs": 30000, "timeoutMs": 1000, "stopTimeoutMs": 1000}
        self.config = {"placement": {"experimentId": self.id, "serverId": self.server, "namespaceRoot": str(self.namespace),
            "runRoot": str(self.run), "workspaceRoot": str(self.workspace), "controlRoot": str(self.control), "minimumFreeBytes": 0},
            "serverName": "fixture", "deploymentId": "a" * 64, "policy": self.policy,
            "uvPath": "/usr/local/bin/uv", "pythonPath": "/usr/bin/python3", "backendPath": "/usr/bin/bwrap",
            "sandboxBase": ["/usr/bin/bwrap", "--unshare-user", "--unshare-pid", "--proc", "/proc"]}
        self.owner = module.Environments(self.config)
        with self.owner.locked(write=True):
            pass

    def package(self, directory, version="1.0", text=b"value = 17\n", abi="cpython-312-x86_64-linux-gnu", origin="fixture"):
        directory.mkdir(parents=True, exist_ok=True)
        path = self.root / ("tiny_fixture-" + version + "-py3-none-any.whl")
        entries = wheel(path, version, text)
        for name, data in entries.items():
            target = directory / name; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
        return self.owner.publish_package(path, directory, abi, origin, module.empty_sharing())

    def environment(self, name="training", version="1.0"):
        directory = self.workspace / "env" / name; site = directory / "lib/python3.12/site-packages"
        package = self.package(site, version)
        environment = {"version": 1, "experimentId": self.id, "serverId": self.server, "deploymentId": "a" * 64,
            "environmentId": name, "generation": str(uuid.uuid4()), "purpose": "training", "directory": str(directory), "python": str(directory / "bin/python"),
            "pythonVersion": "3.12", "pythonAbi": package["pythonAbi"], "uv": "/usr/local/bin/uv", "uvVersion": "0.13.0",
            "state": "ready", "requirements": ["tiny-fixture==" + version], "packages": [package], "privateFiles": [], "sharing": module.empty_sharing(), "updatedAt": 1,
            "verification": {"verified": True, "dependenciesValid": True, "prefix": str(directory), "userSiteEnabled": False}}
        module.save(directory / ".aspera-environment.json", {"version": 1, "generation": environment["generation"], "environmentId": name})
        module.save(self.owner.manifests / (name + ".json"), environment); self.owner.write_reference(environment)
        return environment, site

    def request(self, action="verify", name="training"):
        return {"operationId": str(uuid.uuid4()), "environmentId": name, "action": action, "modules": [], "requirements": [], "files": [], "requireCuda": False}

    def test_two_environments_share_file_identity_deleting_one_link_preserves_the_other(self):
        a, site_a = self.environment(); b, site_b = self.environment("secondary")
        first, second = site_a / "tiny_fixture/__init__.py", site_b / "tiny_fixture/__init__.py"
        self.assertEqual(first.stat().st_ino, second.stat().st_ino)
        checksum = module.file_hash(first); first.unlink()
        self.assertEqual(module.file_hash(second), checksum)
        self.assertEqual(len(self.owner.refs()), 2)

    def test_file_separation_and_patch_leave_shared_content_and_other_environment_unchanged(self):
        a, site_a = self.environment(); b, site_b = self.environment("secondary")
        source = site_b / "tiny_fixture/__init__.py"; checksum = module.file_hash(source)
        result = self.owner.make_writable(a, ["tiny_fixture/__init__.py"])
        target = site_a / "tiny_fixture/__init__.py"
        self.assertNotEqual(target.stat().st_ino, source.stat().st_ino)
        target.write_text("value = 42\n")
        self.assertEqual(module.file_hash(source), checksum)
        self.assertTrue(result["packages"][0]["modified"])
        self.assertIn(a["packages"][0]["id"], self.owner.refs()[0]["packages"])

    def test_completion_rejects_a_detached_file_changed_since_the_last_verification(self):
        environment, site = self.environment()
        self.assertTrue(self.owner.acceptance()["verified"])
        self.owner.make_writable(environment, ["tiny_fixture/__init__.py"])
        (site / "tiny_fixture/__init__.py").write_bytes(b"value = 42\n")
        with self.assertRaisesRegex(RuntimeError, "fresh verification"):
            self.owner.acceptance()
        request = self.request(); work = self.workspace / "tmp"; work.mkdir()
        observed = {"python": environment["python"], "prefix": environment["directory"], "userSiteEnabled": False, "modules": []}
        with patch.object(self.owner, "command", return_value=json.dumps(observed)):
            environment["verification"] = self.owner.verify(environment, request, work)
        module.save(self.owner.manifests / "training.json", environment)
        self.assertTrue(self.owner.acceptance()["verified"])

    def test_version_abi_and_source_build_identity_never_reuse_an_incompatible_object(self):
        identities = [self.package(self.workspace / ("site-" + str(index)), version, abi=abi, origin=origin)["id"]
            for index, (version, abi, origin) in enumerate([("1.0", "abi-a", "source-a"), ("2.0", "abi-a", "source-a"),
                ("1.0", "abi-b", "source-a"), ("1.0", "abi-a", "source-b")])]
        self.assertEqual(len(set(identities)), 4)

    def test_upgrade_links_do_not_change_legacy_environment(self):
        old, site = self.environment(); checksum = module.file_hash(site / "tiny_fixture/__init__.py")
        new = self.package(self.workspace / "new/lib", "2.0", b"value = 42\n")
        self.assertNotEqual(new["id"], old["packages"][0]["id"])
        self.assertEqual(module.file_hash(site / "tiny_fixture/__init__.py"), checksum)

    def test_wheel_record_corruption_is_rejected(self):
        path = self.root / "broken.whl"; wheel(path, corrupt=True)
        with self.assertRaisesRegex(RuntimeError, "digest differs"):
            self.owner.wheel(path)

    def test_nested_vendor_metadata_does_not_replace_the_top_level_wheel_identity(self):
        path = self.root / "nested.whl"
        wheel(path, extra={"tiny_fixture/_vendor/helper-2.0.dist-info/METADATA": b"Name: helper\nVersion: 2.0\n"})
        self.assertEqual(self.owner.wheel(path)["name"], "tiny-fixture")

    def test_universal_wheel_preserves_all_filename_tags_and_build(self):
        path = self.root / "tiny_fixture-1.0-2-py2.py3-none-any.whl"
        wheel(path, extra={"tiny_fixture-1.0.dist-info/WHEEL": b"Wheel-Version: 1.0\nBuild: 2\nTag: py2-none-any\nTag: py3-none-any\n"})
        info = self.owner.wheel(path)
        self.assertEqual(info["filename"], path.name)
        stored, material = self.owner.retain_material(path)
        self.assertEqual(stored.name, path.name)
        self.assertEqual(material["tags"], ["py2-none-any", "py3-none-any"])

    def test_existing_create_preserves_requirements_and_installs_missing_dependencies(self):
        environment, _ = self.environment(); request = self.request("create")
        request["requirements"] = ["another-fixture==2.0"]
        with patch.object(self.owner, "install", return_value=environment) as install, patch.object(self.owner, "verify", return_value=environment["verification"]):
            result = self.owner.prepare(request)
        self.assertEqual(result["state"], "completed", result.get("detail"))
        install.assert_called_once()
        self.assertEqual(install.call_args.args[0]["requirements"], ["tiny-fixture==1.0", "another-fixture==2.0"])
        original = module.load(self.owner.operations / request["operationId"] / "receipt.v1.json")
        self.assertEqual(original["requestHash"], module.digest(request))

    def test_create_with_no_new_dependencies_reverifies_the_same_generation(self):
        environment, _ = self.environment(); request = self.request("create")
        with patch.object(self.owner, "command", return_value="uv 0.13.0"), patch.object(self.owner, "verify", return_value=environment["verification"]):
            result = self.owner.prepare(request)
        self.assertEqual(result["state"], "completed", result.get("detail"))
        self.assertEqual(result["environment"]["generation"], environment["generation"])
        self.assertEqual(result["environment"]["requirements"], environment["requirements"])

    def test_space_failure_commits_a_receipt_instead_of_leaving_an_unknown_operation(self):
        request = self.request("create")
        with patch.object(self.owner, "free", side_effect=RuntimeError("space budget unavailable")):
            result = self.owner.prepare(request)
        self.assertEqual(result["state"], "blocked"); self.assertTrue(result["exitConfirmed"])
        self.assertEqual(module.load(self.owner.operations / request["operationId"] / "receipt.v1.json"), result)
        self.assertIn("space budget", result["detail"])

    def test_verified_material_survives_install_failure_and_a_new_operation(self):
        request = self.request("install")
        path = self.root / "tiny_fixture-1.0-py3-none-any.whl"; wheel(path)
        def failing_install(*_args):
            self.owner.retain_material(path)
            raise RuntimeError("injected import failure")
        with patch.object(self.owner, "install", side_effect=failing_install):
            self.assertTrue(self.owner.prepare(request)["exitConfirmed"])
        material = self.owner.material_records()[0]; stored = self.owner.materials / material["hash"] / material["filename"]
        inode = stored.stat().st_ino
        self.owner.current_operation = self.owner.operations / str(uuid.uuid4())
        reused, _ = self.owner.retain_material(path)
        self.assertEqual(reused.stat().st_ino, inode)
        self.assertEqual(module.file_hash(reused), module.file_hash(path))

    def test_unchanged_shared_conflict_rejects_a_new_operation_before_installation(self):
        request = self.request("create"); request["requirements"] = ["tiny-fixture==1.0"]
        def failing_install(*_args):
            self.owner.failure_context = {"python": "fixture", "installer": "fixture"}
            raise module.DependencyConflict("tiny_fixture/__init__.py", ["a" * 64], "Existing package owns this file")
        with patch.object(self.owner, "install", side_effect=failing_install):
            first = self.owner.prepare(request)
        self.assertEqual(first["state"], "blocked")
        original = module.load(self.owner.operations / request["operationId"] / "receipt.v1.json")
        retry = self.request("install"); retry["requirements"] = request["requirements"]
        def inspect_failure(*_args):
            self.owner.failure_context = {"python": "fixture", "installer": "fixture"}
            self.owner.check_failed_installation(retry["requirements"])
            self.fail("Unchanged failure must stop before installation")
        with patch.object(self.owner, "install", side_effect=inspect_failure):
            second = self.owner.prepare(retry)
        self.assertEqual(second["state"], "blocked")
        self.assertEqual(second["failure"]["previousOperationId"], request["operationId"])
        self.assertEqual(module.load(self.owner.operations / request["operationId"] / "receipt.v1.json"), original)

    def test_changed_installer_or_related_package_allows_the_failed_environment_to_continue(self):
        request = self.request("create"); request["requirements"] = ["tiny-fixture==1.0"]
        def failing_install(*_args):
            self.owner.failure_context = {"python": "fixture", "installer": "fixture"}
            raise module.DependencyConflict("tiny_fixture/__init__.py", ["a" * 64], "Existing package owns this file")
        with patch.object(self.owner, "install", side_effect=failing_install):
            self.owner.prepare(request)
        self.owner.failure_context = {"python": "fixture", "installer": "repaired"}
        self.owner.check_failed_installation(request["requirements"])
        self.owner.failure_context = {"python": "fixture", "installer": "fixture"}
        self.owner.check_failed_installation(["tiny-fixture==2.0"], ["b" * 64])
        with self.assertRaisesRegex(module.UnchangedInstallationFailure, "original operation"):
            self.owner.check_failed_installation(["tiny-fixture==1.0", "another-fixture==2"], ["a" * 64, "b" * 64])

    def test_changed_cached_material_is_quarantined_and_replaced_by_verified_bytes(self):
        path = self.root / "tiny_fixture-1.0-py3-none-any.whl"; wheel(path)
        stored, record = self.owner.retain_material(path)
        stored.write_bytes(b"damaged cached wheel")
        restored, _ = self.owner.retain_material(path)
        self.assertEqual(module.file_hash(restored), record["hash"])
        self.assertEqual(len(list((self.owner.store / "quarantine").iterdir())), 1)

    def test_pending_operation_material_reference_prevents_cleanup(self):
        path = self.root / "tiny_fixture-1.0-py3-none-any.whl"; wheel(path)
        _, record = self.owner.retain_material(path)
        self.owner.current_operation = self.owner.operations / str(uuid.uuid4())
        self.owner.hold_materials([record["hash"]])
        self.assertFalse(any(row["kind"] == "material" for row in self.owner.candidates()))

    def test_unchanged_environment_is_reverified_without_creating_another_venv(self):
        environment, _ = self.environment(); request = self.request("install")
        request["requirements"] = environment["requirements"]
        with patch.object(self.owner, "command", return_value="uv 0.13.0"), patch.object(self.owner, "verify", return_value=environment["verification"]) as verified:
            result = self.owner.prepare(request)
        self.assertEqual(result["state"], "completed"); verified.assert_called_once()
        self.assertEqual(result["environment"]["generation"], environment["generation"])
        self.assertEqual(module.load(self.owner.operations / request["operationId"] / "reuse-plan.v1.json")["downloadBytes"], 0)

    def test_verified_environment_remains_ready_when_only_temporary_unlink_fails(self):
        environment, site = self.environment(); request = self.request()
        checksum = module.file_hash(site / "tiny_fixture/__init__.py")
        with patch.object(self.owner, "verify", return_value=environment["verification"]), patch.object(module, "remove_private",
            side_effect=module.CleanupIoError(self.workspace / "tmp", OSError(errno.EACCES, "unlink refused"))):
            result = self.owner.prepare(request)
        self.assertEqual(result["state"], "completed"); self.assertEqual(result["cleanup"]["state"], "pending")
        self.assertTrue(self.owner.acceptance()["verified"])
        self.assertEqual(self.owner.environment("training")["generation"], environment["generation"])
        self.assertIn(environment["packages"][0]["id"], self.owner.refs()[0]["packages"])
        original = module.load(self.owner.operations / request["operationId"] / "receipt.v1.json")
        self.owner.config["launchFailureConfirmed"] = True
        recovered = self.owner.recover(request)
        self.assertEqual(recovered["recovery"]["state"], "verification-required")
        self.assertEqual(recovered["cleanup"]["state"], "completed")
        self.assertEqual(module.load(self.owner.operations / request["operationId"] / "receipt.v1.json"), original)
        self.assertEqual(self.owner.recover(request)["recovery"], recovered["recovery"])
        with self.assertRaisesRegex(RuntimeError, "program verification"):
            self.owner.acceptance()
        retry = self.request("install"); retry["requirements"] = environment["requirements"]
        with patch.object(self.owner, "command", return_value="uv 0.13.0") as command, patch.object(self.owner, "verify", return_value=environment["verification"]):
            verified = self.owner.prepare(retry)
        command.assert_called_once()
        self.assertEqual(verified["environment"]["state"], "ready")
        self.assertEqual(module.file_hash(site / "tiny_fixture/__init__.py"), checksum)

    def test_cleanup_safety_failure_after_verification_still_blocks_execution(self):
        environment, _ = self.environment(); request = self.request()
        with patch.object(self.owner, "verify", return_value=environment["verification"]), patch.object(module, "remove_private",
            side_effect=module.CleanupSafetyError(self.workspace / "tmp", "scan", "Nested mount", (2, 10), (1, 10))):
            result = self.owner.prepare(request)
        self.assertEqual(result["state"], "blocked")
        self.assertEqual(self.owner.environment("training")["state"], "blocked")
        record = module.load(self.owner.cleanups / (request["operationId"] + ".json"))
        self.assertEqual(record["state"], "blocked"); self.assertEqual(record["diagnostic"]["mountId"], 2)
        with self.assertRaisesRegex(RuntimeError, "program verification"):
            self.owner.acceptance()

    def test_reference_commit_failure_does_not_open_the_verified_environment(self):
        environment, _ = self.environment(); request = self.request()
        with patch.object(self.owner, "verify", return_value=environment["verification"]), patch.object(self.owner, "write_reference", side_effect=OSError(errno.ENOSPC, "reference commit unavailable")):
            result = self.owner.prepare(request)
        self.assertEqual(result["state"], "blocked"); self.assertEqual(self.owner.environment("training")["state"], "blocked")
        self.assertIn("reference commit", result["detail"])

    def test_confirmed_failed_receipt_is_reconciled_and_preserved_before_another_install(self):
        environment, _ = self.environment(); request = self.request()
        with patch.object(self.owner, "verify", return_value=environment["verification"]), patch.object(module, "remove_private",
            side_effect=module.CleanupSafetyError(self.workspace / "tmp", "scan", "Mount identity unknown")):
            failed = self.owner.prepare(request)
        receipt_path = self.owner.operations / request["operationId"] / "receipt.v1.json"
        original = receipt_path.read_bytes(); self.owner.config["launchFailureConfirmed"] = True
        recovered = self.owner.recover(request)
        self.assertTrue(failed["exitConfirmed"]); self.assertEqual(receipt_path.read_bytes(), original)
        self.assertEqual(recovered["updatedAt"], failed["updatedAt"])
        self.assertEqual(recovered["recovery"]["generation"], environment["generation"])
        with patch.object(self.owner, "install", return_value=environment), patch.object(self.owner, "verify", return_value=environment["verification"]):
            retry = self.owner.prepare(self.request("install"))
        self.assertEqual(retry["state"], "completed")
        changed = self.owner.environment("training"); changed["generation"] = str(uuid.uuid4())
        module.save(self.owner.manifests / "training.json", changed)
        with self.assertRaisesRegex(RuntimeError, "conflicts"):
            self.owner.recover(request)

    def test_shared_install_uses_metadata_wheels_and_keeps_large_payload_inode(self):
        environment, old_site = self.environment(); record = environment["packages"][0]
        request = self.request("install")
        op = self.owner.operations / request["operationId"]; op.mkdir()
        self.owner.current_operation = op
        self.owner.reuse_plan = {"packages": [], "downloadBytes": 0, "reusedBytes": 0}
        work = self.workspace / "tmp" / ("environment-" + request["operationId"]); work.mkdir(parents=True)
        stage = work / "venv"; site = stage / "lib/python3.12/site-packages"; site.mkdir(parents=True)
        self.owner.installer_directory = work / "installer"
        self.owner.effective_requirements = ["tiny-fixture==1.0"]
        self.owner.failure_context = {}
        self.owner.reuse_plan["environmentId"] = "training"
        facts = {"abi": record["pythonAbi"], "version": "3.12", "tags": ["py3-none-any"]}
        observed = []
        def command(args, *_args, **_kwargs):
            observed.append(args)
            if module.WHEEL_NAMES in args:
                return json.dumps({record["wheelHash"]: {"filename": "tiny_fixture-1.0-py3-none-any.whl"}})
            if args[1:3] == ["pip", "compile"]:
                pathlib.Path(args[args.index("--output-file") + 1]).write_text("tiny-fixture==1.0 --hash=sha256:" + record["wheelHash"] + "\n")
            if args[1:3] == ["pip", "install"]:
                with zipfile.ZipFile(work / "installation/tiny_fixture-1.0-py3-none-any.whl") as archive:
                    self.assertNotIn("tiny_fixture/__init__.py", archive.namelist())
                    archive.extractall(site)
            return ""
        with patch.object(self.owner, "command", side_effect=command):
            installed, sharing = self.owner.install_dependencies(["tiny-fixture==1.0"], facts, stage, work, shutil.disk_usage(self.namespace).free)
        self.assertFalse(any("download" in args for args in observed))
        self.assertEqual((old_site / "tiny_fixture/__init__.py").stat().st_ino, (site / "tiny_fixture/__init__.py").stat().st_ino)
        self.assertEqual(installed[0]["id"], record["id"]); self.assertGreater(sharing["hardlinkBytes"], 0)
        self.assertEqual(self.owner.reuse_plan["downloadBytes"], 0)

    def test_metadata_wheel_contains_entry_points_but_no_shared_package_payload(self):
        path = self.root / "with-entry.whl"
        wheel(path, extra={"tiny_fixture-1.0.dist-info/entry_points.txt": b"[console_scripts]\ntiny = tiny_fixture:main\n"})
        generated = self.root / "metadata.whl"; self.owner.metadata_wheel(path, generated)
        self.assertEqual(self.owner.wheel(generated)["name"], "tiny-fixture")
        with zipfile.ZipFile(generated) as archive:
            self.assertNotIn("tiny_fixture/__init__.py", archive.namelist())
            self.assertIn("tiny_fixture-1.0.dist-info/entry_points.txt", archive.namelist())

    def test_incomplete_legacy_wheel_retains_a_diagnostic_instead_of_aborting_inspection(self):
        path = self.workspace / "cache/broken.whl"; path.parent.mkdir()
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("tiny_fixture-1.0.dist-info/METADATA", b"Name: tiny-fixture\nVersion: 1.0\n")
        candidates = self.owner.legacy()
        self.assertEqual(len(candidates), 1)
        self.assertFalse(candidates[0]["reusable"])
        self.assertIn("incomplete", candidates[0]["reason"])

    def test_unindexed_and_escaping_wheel_files_are_rejected(self):
        path = self.root / "bad.whl"; wheel(path)
        with zipfile.ZipFile(path, "a") as archive:
            archive.writestr("../escape", b"bad")
        with self.assertRaisesRegex(RuntimeError, "escapes"):
            self.owner.wheel(path)

    def test_hardlink_restriction_uses_only_a_confirmed_reflink_or_budgeted_copy(self):
        source = self.workspace / "file"; source.write_bytes(b"a" * 8192); sharing = module.empty_sharing()
        with patch.object(module.os, "link", side_effect=OSError(errno.EXDEV, "cross disk")), patch.object(module.fcntl, "ioctl", side_effect=OSError(errno.EOPNOTSUPP, "no clone")):
            self.owner.link_file(source, self.workspace / "copy", sharing)
        self.assertEqual(sharing["copyBytes"], 8192); self.assertEqual(sharing["estimatedCopyBytes"], 8192)
        self.assertEqual(sharing["cloneBytes"], 0); self.assertEqual(len(sharing["reasons"]), 2)
        self.assertNotEqual(source.stat().st_ino, (self.workspace / "copy").stat().st_ino)

    def test_insufficient_space_prevents_independent_copy(self):
        source = self.workspace / "file"; source.write_bytes(b"a" * 8192)
        with patch.object(module.os, "link", side_effect=OSError(errno.EXDEV, "cross disk")), patch.object(module.fcntl, "ioctl", side_effect=OSError(errno.EOPNOTSUPP, "no clone")), patch.object(self.owner, "free", side_effect=RuntimeError("Space budget exhausted")):
            with self.assertRaisesRegex(RuntimeError, "Space budget"):
                self.owner.link_file(source, self.workspace / "copy", module.empty_sharing())
        self.assertFalse((self.workspace / "copy").exists())

    def test_inode_based_usage_does_not_count_hardlinked_payload_twice(self):
        source = self.workspace / "file"; source.write_bytes(b"a" * 8192); os.link(source, self.workspace / "linked")
        self.assertEqual(module.allocated(self.workspace), source.stat().st_blocks * 512)

    def test_package_with_environment_reference_or_external_link_cannot_be_collected(self):
        environment, site = self.environment()
        self.assertEqual(self.owner.candidates(), [])
        self.owner.reference_path("training").unlink()
        self.assertEqual(self.owner.candidates(), [])
        module.remove_private(pathlib.Path(environment["directory"]), self.workspace)
        self.assertEqual(len(self.owner.candidates()), 1)

    def test_missing_environment_reference_is_not_silently_released(self):
        environment, _ = self.environment(); module.remove_private(pathlib.Path(environment["directory"]), self.workspace)
        with self.assertRaisesRegex(RuntimeError, "confirmed environment deletion"):
            self.owner.preview()

    def test_cleanup_refuses_stale_snapshot_and_duplicate_id_reuses_result(self):
        self.package(self.root / "unlinked")
        module.remove_private(self.root / "unlinked", self.root)
        preview = self.owner.preview(); operation = str(uuid.uuid4())
        with self.assertRaisesRegex(RuntimeError, "changed"):
            self.owner.cleanup(operation, "a" * 64)
        first = self.owner.cleanup(operation, preview["fingerprint"])
        self.assertEqual(self.owner.cleanup(operation, preview["fingerprint"]), first)
        self.assertEqual(self.owner.records(), [])

    def test_unknown_operation_requires_identity_proof_before_recovery(self):
        request = self.request(); op = self.owner.operations / request["operationId"]
        module.save(op / "receipt.v1.json", {"requestHash": module.digest(request), "exitConfirmed": False, "commandId": "environment-" + request["operationId"]})
        with self.assertRaisesRegex(RuntimeError, "outcome is unknown"):
            self.owner.prepare(request)
        with self.assertRaisesRegex(RuntimeError, "identity is missing"):
            self.owner.recover(request)
        self.owner.config["launchFailureConfirmed"] = True
        result = self.owner.recover(request)
        self.assertTrue(result["exitConfirmed"]); self.assertIsNone(result["exitCode"])

    def test_running_process_group_blocks_recovery_even_when_pid_is_reused(self):
        request = self.request(); command = "environment-" + request["operationId"]
        module.save(self.run / "process-identities" / (command + ".v1.json"), {"experimentId": self.id, "serverId": self.server,
            "commandId": command, "group": os.getpgrp(), "pid": os.getpid(), "start": "wrong", "hostBootId": pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()})
        with self.assertRaisesRegex(RuntimeError, "has not exited"):
            self.owner.recover(request)

    def test_missing_receipt_recovery_retains_the_original_request_time(self):
        request = self.request()
        path = self.run / "environment-requests-v1" / (request["operationId"] + ".json")
        module.save(path, {"request": request}); os.utime(path, (10, 10))
        self.owner.config["launchFailureConfirmed"] = True
        result = self.owner.recover(request)
        self.assertEqual(result["startedAt"], 10000); self.assertEqual(result["updatedAt"], 10000)
        self.assertFalse(module.load(self.owner.operations / request["operationId"] / "receipt.v1.json")["exitConfirmed"])

    def test_recovery_rejects_another_experiment_receipt_before_changing_publication(self):
        request = self.request(); path = self.owner.operations / request["operationId"] / "receipt.v1.json"
        module.save(path, {"requestHash": module.digest(request), "exitConfirmed": True, "commandId": "environment-" + request["operationId"], "experimentId": str(uuid.uuid4())})
        original = path.read_bytes(); self.owner.config["launchFailureConfirmed"] = True
        with self.assertRaisesRegex(RuntimeError, "another operation"):
            self.owner.recover(request)
        self.assertEqual(path.read_bytes(), original)

    def test_confirmed_recovery_releases_only_its_pending_material_lease(self):
        request = self.request(); op = self.owner.operations / request["operationId"]
        module.save(op / "receipt.v1.json", {"requestHash": module.digest(request), "exitConfirmed": True,
            "commandId": "environment-" + request["operationId"], "updatedAt": 12})
        lease = self.owner.material_references / (self.id + "-" + request["operationId"] + ".json")
        module.save(lease, {"version": 1, "materials": []})
        other = self.owner.material_references / (self.id + "-another.json")
        module.save(other, {"version": 1, "materials": []})
        with self.assertRaisesRegex(RuntimeError, "identity is missing"):
            self.owner.recover(request)
        self.assertTrue(lease.exists())
        self.owner.config["launchFailureConfirmed"] = True
        result = self.owner.recover(request)
        self.assertEqual(result["updatedAt"], 12); self.assertFalse(lease.exists()); self.assertTrue(other.exists())

    def test_read_only_inspection_never_creates_a_store(self):
        module.remove_private(self.owner.store, self.namespace)
        with self.owner.locked():
            result = self.owner.inspect()
        self.assertFalse(self.owner.store.exists()); self.assertEqual(result["environments"], [])

    def test_unregistered_execution_environment_cannot_substitute_for_acceptance(self):
        self.owner.config["requiredEnvironments"] = ["unmanaged-venv"]
        with self.assertRaisesRegex(RuntimeError, "not registered"):
            self.owner.acceptance()

    def test_inspection_reads_atomic_plans_while_cleanup_eligibility_is_unconfirmed(self):
        observer = module.Environments({**self.config, "action": "inspect"})
        with self.owner.locked(write=True), observer.locked():
            result = observer.inspect()
        self.assertFalse(result["complete"]); self.assertIn("not yet confirmed", result["error"])

    def test_completed_materials_are_retained_when_another_wheel_is_partial(self):
        request = self.request("install"); op = self.owner.operations / request["operationId"]; op.mkdir()
        self.owner.current_operation = op; self.owner.reuse_plan = {"downloadBytes": 0}
        wheels = self.workspace / "tmp" / ("environment-" + request["operationId"]) / "wheels"; wheels.mkdir(parents=True)
        complete = wheels / "tiny_fixture-1.0-py3-none-any.whl"; wheel(complete)
        (wheels / "partial.whl").write_bytes(b"partial")
        checksum = module.file_hash(complete)
        retained = self.owner.retain_downloads(wheels, [{"name": "tiny-fixture", "version": "1.0", "hashes": [checksum]}], partial=True)
        self.assertEqual(retained[0]["hash"], checksum); self.assertEqual(len(self.owner.material_records()), 1)

    def test_an_incompatible_source_build_does_not_shadow_its_locked_source_download(self):
        path = self.root / "tiny_fixture-1.0-py3-none-any.whl"; wheel(path)
        source_hash = "a" * 64
        self.owner.retain_material(path, "source-sha256:" + source_hash + ";wheel-sha256:" + module.file_hash(path) + ";build-sha256:" + "b" * 64)
        request = self.request("install"); self.owner.current_operation = self.owner.operations / request["operationId"]; self.owner.current_operation.mkdir()
        self.owner.reuse_plan = {"packages": [], "downloadBytes": 0, "reusedBytes": 0}
        work = self.workspace / "tmp" / ("environment-" + request["operationId"]); work.mkdir(parents=True)
        stage = work / "venv"; stage.mkdir()
        self.owner.installer_directory = work / "installer"
        self.owner.effective_requirements = ["tiny-fixture==1.0"]
        self.owner.failure_context = {}
        self.owner.reuse_plan["environmentId"] = "training"
        def command(args, *_args, **_kwargs):
            if module.WHEEL_NAMES in args:
                return json.dumps({module.file_hash(path): {"filename": path.name}})
            if args[1:3] == ["pip", "compile"]:
                (work / "requirements.lock").write_text("tiny-fixture==1.0 --hash=sha256:" + source_hash + "\n")
            if "download" in args:
                self.assertEqual(list((work / "download-catalog").iterdir()), [])
                self.assertIn(str(work / "download-catalog"), args)
                self.assertNotIn(str(work / "catalog"), args)
                raise RuntimeError("fixture reached the missing source download")
            return ""
        with patch.object(self.owner, "command", side_effect=command), patch.object(self.owner, "source_build_identity", return_value="c" * 64):
            with self.assertRaisesRegex(RuntimeError, "missing source download"):
                self.owner.install_dependencies(["tiny-fixture==1.0"], {"abi": "fixture", "version": "3.12", "tags": ["py3-none-any"]}, stage, work, shutil.disk_usage(self.namespace).free)
        self.assertEqual(len(self.owner.material_records()), 1)

    def test_source_build_identity_changes_with_compiler_and_granted_gpu(self):
        work = self.workspace / "tmp"; work.mkdir(); facts = {"abi": "fixture", "version": "3.12"}
        with patch.object(self.owner, "command", return_value='{"cc":"compiler-a","nvcc":null}'):
            first = self.owner.source_build_identity(facts, work, work)
        changed = module.Environments({**self.config, "gpuInfo": "another GPU", "devicePaths": ["/dev/nvidia5"]})
        with patch.object(changed, "command", return_value='{"cc":"compiler-b","nvcc":null}'):
            self.assertNotEqual(first, changed.source_build_identity(facts, work, work))

    def test_concurrent_install_and_collection_are_fenced_by_the_remote_lock(self):
        with self.owner.locked(write=True):
            with self.assertRaisesRegex(RuntimeError, "holds the server package lock"):
                with module.Environments(self.config).locked(write=True):
                    self.fail("Concurrent lock should not be granted")

    def test_no_user_site_prefix_fallback_is_accepted(self):
        environment, _ = self.environment(); work = self.workspace / "tmp"; work.mkdir()
        with patch.object(self.owner, "command", return_value=json.dumps({"python": "/usr/bin/python3", "prefix": str(self.workspace / ".local"), "userSiteEnabled": True, "modules": []})):
            with self.assertRaisesRegex(RuntimeError, "prefix or user-site"):
                self.owner.verify(environment, self.request(), work)

    def test_unknown_python_abi_prevents_environment_installation(self):
        work = self.workspace / "tmp"; work.mkdir()
        request = self.request("create")
        def command(args, *_args, **_kwargs):
            if args[1:] == ["--version"]:
                return "uv 0.13.0\n"
            return json.dumps({"version": "3.12", "abi": None, "prefix": str(work / "venv")})
        with patch.object(self.owner, "command", side_effect=command):
            with self.assertRaisesRegex(RuntimeError, "Python ABI"):
                self.owner.install(request, None, work, 0)

    def test_duplicate_separation_reuses_its_receipt_without_copying_again(self):
        environment, site = self.environment(); request = self.request("make-writable")
        request["files"] = ["tiny_fixture/__init__.py"]
        first = self.owner.prepare(request); inode = (site / request["files"][0]).stat().st_ino
        self.assertEqual(first["state"], "completed")
        self.assertEqual(self.owner.prepare(request), first)
        self.assertEqual((site / request["files"][0]).stat().st_ino, inode)
        request["files"] = ["other.py"]
        with self.assertRaisesRegex(RuntimeError, "different content"):
            self.owner.prepare(request)

    def test_install_verification_failure_rolls_back_only_the_current_generation(self):
        previous, site = self.environment(); checksum = module.file_hash(site / "tiny_fixture/__init__.py")
        request = self.request("install")
        work = self.workspace / "tmp" / ("environment-" + request["operationId"])
        def command(args, *_args, **_kwargs):
            if args[1:] == ["--version"]:
                return "uv 0.13.0\n"
            if args[1] == "venv":
                (work / "venv/lib/python3.12/site-packages").mkdir(parents=True)
                (work / "venv/bin").mkdir(); (work / "venv/bin/python").write_text("interpreter fixture")
                (work / "venv/pyvenv.cfg").write_text(str(work / "venv"))
            if "-c" in args:
                return json.dumps({"version": "3.12", "abi": "cpython-312-fixture", "prefix": str(work / "venv")})
            return ""
        with patch.object(self.owner, "command", side_effect=command), patch.object(self.owner, "verify", side_effect=RuntimeError("Required CUDA verification failed")):
            result = self.owner.prepare(request)
        self.assertEqual(result["state"], "blocked"); self.assertTrue(result["exitConfirmed"])
        self.assertEqual(self.owner.environment("training")["generation"], previous["generation"])
        self.assertEqual(module.file_hash(site / "tiny_fixture/__init__.py"), checksum)
        self.assertEqual(self.owner.refs()[0]["packages"], [previous["packages"][0]["id"]])

    def test_recovery_restores_a_backed_up_generation_after_an_interrupted_publication(self):
        previous, site = self.environment(); checksum = module.file_hash(site / "tiny_fixture/__init__.py")
        request = self.request("install"); op = self.owner.operations / request["operationId"]
        work = self.workspace / "tmp" / ("environment-" + request["operationId"]); work.mkdir(parents=True)
        backup = work / "previous"; directory = pathlib.Path(previous["directory"])
        os.rename(directory, backup); directory.mkdir()
        following = dict(previous, generation=str(uuid.uuid4()), state="verifying")
        module.save(directory / ".aspera-environment.json", {"version": 1, "environmentId": "training", "generation": following["generation"]})
        module.save(op / "publication.v1.json", {"version": 1, "previous": previous, "next": following, "backup": str(backup), "stage": str(work / "venv")})
        module.save(op / "receipt.v1.json", {"requestHash": module.digest(request), "exitConfirmed": False, "commandId": "environment-" + request["operationId"]})
        self.owner.config["launchFailureConfirmed"] = True
        result = self.owner.recover(request)
        self.assertEqual(result["state"], "blocked"); self.assertIsNone(result["exitCode"])
        self.assertEqual(module.file_hash(site / "tiny_fixture/__init__.py"), checksum)
        self.assertEqual(self.owner.environment("training")["generation"], previous["generation"])

    def test_cleanup_recovery_does_not_blindly_repeat_an_unconfirmed_deletion(self):
        operation_id = str(uuid.uuid4()); fingerprint = "d" * 64
        module.save(self.owner.operations / ("cleanup-" + operation_id + ".json"), {"version": 1, "fingerprint": fingerprint, "state": "running"})
        with self.assertRaisesRegex(RuntimeError, "identity is missing"):
            self.owner.recover_cleanup(operation_id, fingerprint)
        self.owner.config["launchFailureConfirmed"] = True
        result = self.owner.recover_cleanup(operation_id, fingerprint)
        self.assertEqual(result["state"], "blocked"); self.assertIn("fresh preview", result["detail"])

    def test_reference_release_requires_confirmed_remote_deletion_and_preserves_other_environments(self):
        environment, _ = self.environment()
        with self.assertRaisesRegex(RuntimeError, "confirmed remote deletion"):
            module.release_references(self.config)
        other_id = str(uuid.uuid4()); other_run = self.namespace / "runs" / other_id
        other_run.mkdir(); (other_run / "workspace").mkdir()
        other_config = {**self.config, "placement": {**self.config["placement"], "experimentId": other_id, "runRoot": str(other_run), "workspaceRoot": str(other_run / "workspace")}}
        module.save(other_run / ".aspera-owner.json", {"version": 1, "serverId": self.server, "experimentId": other_id})
        other_owner = module.Environments(other_config)
        other_directory = other_run / "workspace/env/python"; other_directory.mkdir(parents=True)
        other = dict(environment, experimentId=other_id, directory=str(other_directory))
        module.save(other_run / "environments-v1/training.json", other); other_owner.write_reference(other)
        module.remove_private(self.run, self.namespace)
        self.assertTrue(module.release_references(self.config)["released"])
        self.assertTrue(other_owner.reference_path("training").exists())
        self.assertFalse(self.owner.reference_path("training").exists())

    def test_sandbox_keeps_mandatory_isolation_and_ro_shared_inputs(self):
        work = self.workspace / "tmp"; work.mkdir()
        argv = self.owner.sandbox(["true"], [work], [self.owner.store])
        self.assertIn("--unshare-user", argv); self.assertIn("--proc", argv)
        self.assertIn("PYTHONNOUSERSITE", argv); self.assertIn("PIP_REQUIRE_VIRTUALENV", argv)
        self.assertEqual(argv[-2:], ["--", "true"])
        self.assertIn(str(self.owner.store), argv)

    def test_mutable_old_installation_is_reported_but_never_linked(self):
        site = self.workspace / ".local/lib/python3.12/site-packages/tiny_fixture-1.0.dist-info"; site.mkdir(parents=True)
        (site / "METADATA").write_text("Name: tiny-fixture\nVersion: 1.0\n")
        before = module.file_hash(site / "METADATA"); candidate = self.owner.legacy()[0]
        self.assertFalse(candidate["reusable"]); self.assertEqual(candidate["kind"], "installed")
        self.assertEqual(module.file_hash(site / "METADATA"), before)

    def test_symlink_escape_and_other_experiment_manifest_are_rejected(self):
        environment, site = self.environment()
        module.remove_private(site / "tiny_fixture", site); (site / "tiny_fixture").symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "symbolic link"):
            self.owner.make_writable(environment, ["tiny_fixture/__init__.py"])
        environment["experimentId"] = str(uuid.uuid4()); module.save(self.owner.manifests / "training.json", environment)
        with self.assertRaisesRegex(RuntimeError, "another experiment"):
            self.owner.environment("training")


@unittest.skipUnless(os.environ.get("ASPERA_TEST_UV"), "Native installer cases require the manifest's fixed uv executable")
class NativeInstallerCase(unittest.TestCase):
    def setUp(self):
        self.fixture = EnvironmentCase(); self.fixture.setUp(); self.addCleanup(self.fixture.doCleanups)
        self.config = copy_config = dict(self.fixture.config)
        copy_config["uvPath"] = os.environ["ASPERA_TEST_UV"]; copy_config["pythonPath"] = sys.executable
        copy_config["policy"] = {**self.fixture.policy, "maxPackageBytes": 8 * 1024 ** 2, "timeoutMs": 30000}
        self.owner = module.Environments(copy_config)
        self.commands = []
        if os.environ.get("ASPERA_TEST_PIP_WHEEL"):
            self.bootstrap = pathlib.Path(os.environ["ASPERA_TEST_PIP_WHEEL"]).parent
        else:
            import ensurepip
            self.bootstrap = pathlib.Path(ensurepip.__file__).parent / "_bundled"
        self.owner.policy["pipVersion"] = next(self.bootstrap.glob("pip-*.whl")).name.split("-")[1]

    def native_command(self, owner, args, work, **_kwargs):
        self.commands.append(args[:])
        if "download" in args:
            self.fail("Verified fixture materials must prevent a dependency download")
        actual = list(args)
        if actual[1:3] == ["pip", "compile"] and "--no-index" not in actual:
            actual.append("--no-index")
        if actual[1:3] == ["pip", "install"] and any(str(part).endswith("installer/bin/python") for part in actual):
            actual += ["--no-index", "--find-links", str(self.bootstrap)]
        environment = {**os.environ, "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1"}
        result = subprocess.run(actual, cwd=owner.workspace, env=environment, capture_output=True, text=True, timeout=120)
        if result.returncode:
            raise RuntimeError(result.stderr)
        return result.stdout

    def install(self, owner, action="install", requirements=None):
        request = self.fixture.request(action); request["requirements"] = ["tiny-fixture==1.0"] if requirements is None else requirements; request["modules"] = ["tiny_fixture"]
        with patch.object(owner, "command", side_effect=lambda args, work, **kwargs: self.native_command(owner, args, work, **kwargs)):
            result = owner.prepare(request)
        self.assertEqual(result["state"], "completed", result.get("detail"))
        return result, module.load(owner.operations / request["operationId"] / "reuse-plan.v1.json")

    def seed_material(self):
        path = self.fixture.root / "tiny_fixture-1.0-py3-none-any.whl"
        wheel(path, text=b"def main(): print('native-entry-ok')\n", extra={"tiny_fixture/payload.bin": b"x" * (2 * 1024 ** 2),
            "tiny_fixture-1.0.dist-info/entry_points.txt": b"[console_scripts]\ntiny-fixture = tiny_fixture:main\n"})
        self.owner.retain_material(path)

    def test_base_training_interpreter_has_no_implicit_installer_distributions(self):
        request = self.fixture.request("create")
        with patch.object(self.owner, "command", side_effect=lambda args, work, **kwargs: self.native_command(self.owner, args, work, **kwargs)):
            result = self.owner.prepare(request)
        self.assertEqual(result["state"], "completed", result.get("detail"))
        code = "import importlib.metadata,json; print(json.dumps([d.metadata['Name'] for d in importlib.metadata.distributions()]))"
        installed = json.loads(subprocess.check_output([result["environment"]["python"], "-I", "-c", code], text=True))
        self.assertEqual(installed, [], "Training must not inherit the installer's pip, packaging or setuptools")

    def test_workspace_modules_cannot_replace_private_installation_parsers(self):
        self.seed_material()
        (self.fixture.workspace / "pip.py").write_text("raise RuntimeError('workspace pip must not replace installer code')\n")
        verify = self.owner.verify
        def isolated_tools(*args):
            path = self.owner.site(self.owner.installer_directory) / "pip/__init__.py"
            self.assertEqual(path.stat().st_nlink, 1, "Installer code must not share writable build-cache inodes")
            return verify(*args)
        with patch.object(self.owner, "verify", side_effect=isolated_tools):
            result, _ = self.install(self.owner)
        self.assertTrue(result["environment"]["verification"]["verified"])

    def test_shared_payload_conflict_cannot_repeat_by_changing_operation_or_action(self):
        self.seed_material(); first, _ = self.install(self.owner)
        original_generation = first["environment"]["generation"]
        path = self.fixture.root / "other_fixture-1.0-py3-none-any.whl"
        wheel(path, distribution="other-fixture", extra={"tiny_fixture/__init__.py": b"value = 'conflicting owner'\n"})
        site = self.fixture.root / "other-package"; site.mkdir()
        with zipfile.ZipFile(path) as archive:
            archive.extractall(site)
        self.owner.publish_package(path, site, first["environment"]["pythonAbi"], "wheel-sha256:" + module.file_hash(path), module.empty_sharing())
        request = self.fixture.request("install"); request["requirements"] = ["tiny-fixture==1.0", "other-fixture==1.0"]
        with patch.object(self.owner, "command", side_effect=lambda args, work, **kwargs: self.native_command(self.owner, args, work, **kwargs)):
            failed = self.owner.prepare(request)
        self.assertEqual(failed["state"], "blocked", failed)
        before = (self.owner.operations / request["operationId"] / "receipt.v1.json").read_bytes()
        retry = self.fixture.request("create"); retry["requirements"] = list(reversed(request["requirements"]))
        start = len(self.commands)
        with patch.object(self.owner, "command", side_effect=lambda args, work, **kwargs: self.native_command(self.owner, args, work, **kwargs)):
            repeated = self.owner.prepare(retry)
        new_commands = self.commands[start:]
        self.assertFalse(any(args[1:3] == ["pip", "compile"] or "download" in args for args in new_commands))
        self.assertFalse(any(args[1:2] == ["venv"] for args in new_commands), "Unchanged failures must not recreate even the small installer")
        self.assertEqual(failed["failure"]["code"], "shared-content-conflict")
        self.assertEqual(len(failed["failure"]["packages"]), 2)
        self.assertEqual(repeated["failure"]["previousOperationId"], request["operationId"])
        self.assertEqual(self.owner.environment("training")["generation"], original_generation)
        self.assertEqual((self.owner.operations / request["operationId"] / "receipt.v1.json").read_bytes(), before)

    def test_explicit_training_pip_reuses_shared_contents_without_conflicting_with_installer_pip(self):
        self.owner.policy.update(maxPackageFiles=10000, maxPackageBytes=64 * 1024 ** 2)
        path = next(self.bootstrap.glob("pip-*.whl")); self.owner.retain_material(path)
        version = self.owner.policy["pipVersion"]
        results = []
        for requirement in ("pip==" + version, "pip>=" + version):
            request = self.fixture.request("install"); request["requirements"] = [requirement]; request["modules"] = ["pip"]
            with patch.object(self.owner, "command", side_effect=lambda args, work, **kwargs: self.native_command(self.owner, args, work, **kwargs)):
                result = self.owner.prepare(request)
            self.assertEqual(result["state"], "completed", result.get("detail")); results.append(result)
        self.assertNotEqual(results[0]["environment"]["generation"], results[1]["environment"]["generation"])
        plan = module.load(self.owner.operations / request["operationId"] / "reuse-plan.v1.json")
        self.assertEqual(plan["packages"][0]["decision"], "shared"); self.assertEqual(plan["downloadBytes"], 0)

    def test_new_experiment_reuses_payload_and_generates_its_own_native_entry(self):
        self.seed_material(); first, _ = self.install(self.owner)
        other_id = str(uuid.uuid4()); run = self.fixture.namespace / "runs" / other_id; workspace = run / "workspace"; workspace.mkdir(parents=True)
        module.save(run / ".aspera-owner.json", {"version": 1, "serverId": self.fixture.server, "experimentId": other_id})
        config = {**self.config, "placement": {**self.config["placement"], "experimentId": other_id, "runRoot": str(run), "workspaceRoot": str(workspace)}}
        other = module.Environments(config)
        with other.locked(write=True):
            second, plan = self.install(other)
        old = self.owner.site(pathlib.Path(first["environment"]["directory"])) / "tiny_fixture/payload.bin"
        new = other.site(pathlib.Path(second["environment"]["directory"])) / "tiny_fixture/payload.bin"
        self.assertEqual((old.stat().st_dev, old.stat().st_ino), (new.stat().st_dev, new.stat().st_ino))
        self.assertEqual(module.file_hash(old), module.file_hash(new))
        self.assertEqual(plan["downloadBytes"], 0); self.assertGreaterEqual(plan["reusedBytes"], 2 * 1024 ** 2)
        self.assertGreaterEqual(plan["estimatedPeakBytes"], plan["addedBytes"])
        self.assertLess(plan["estimatedPeakBytes"] - plan["addedBytes"], plan["installerTemporaryBytes"] + 2 * 1024 ** 2)
        self.assertEqual(sum(args[1:3] == ["pip", "compile"] for args in self.commands), 1)
        for environment in [first["environment"], second["environment"]]:
            entry = pathlib.Path(environment["directory"]) / "bin/tiny-fixture"
            self.assertIn(environment["python"], entry.read_text())
            output = subprocess.check_output([environment["python"], str(entry)], env={**os.environ, "PYTHONNOUSERSITE": "1"}, text=True)
            self.assertIn("native-entry-ok", output)
        print("NATIVE_REUSE_EVIDENCE " + json.dumps({"python": sys.version.split()[0], "uv": second["environment"]["uvVersion"],
            "payload": {"bytes": old.stat().st_size, "device": old.stat().st_dev, "inode": old.stat().st_ino,
                "linkCount": old.stat().st_nlink, "sha256": module.file_hash(old), "sameIdentity": True},
            "secondPreparation": {key: plan[key] for key in ["downloadBytes", "reusedBytes", "estimatedPeakBytes", "addedBytes"]},
            "sharing": second["environment"]["sharing"], "separateEntryPoints": True, "oldEntryStillWorks": True}), flush=True)

    def test_failed_import_retries_the_same_environment_with_retained_materials(self):
        self.seed_material(); request = self.fixture.request("install"); request["requirements"] = ["tiny-fixture==1.0"]
        with patch.object(self.owner, "command", side_effect=lambda args, work, **kwargs: self.native_command(self.owner, args, work, **kwargs)), patch.object(self.owner, "verify", side_effect=RuntimeError("injected import failure")):
            failed = self.owner.prepare(request)
        self.assertEqual(failed["state"], "blocked"); self.assertTrue(failed["exitConfirmed"])
        self.assertIn("injected import failure", failed["detail"])
        recovered, plan = self.install(self.owner)
        self.assertEqual(recovered["environment"]["environmentId"], "training"); self.assertEqual(plan["downloadBytes"], 0)
        self.assertEqual(len(self.owner.material_records()), 1)

    def test_historical_py2_filename_reuses_full_and_shared_wheels_without_rewriting_material(self):
        path = self.fixture.root / "tiny_fixture-1.0-py2-none-any.whl"
        wheel(path, extra={"tiny_fixture-1.0.dist-info/WHEEL": b"Wheel-Version: 1.0\nTag: py2-none-any\nTag: py3-none-any\n"})
        original, material = self.owner.retain_material(path)
        index = (original.parent / "record.v1.json").read_bytes(); checksum = module.file_hash(original)
        first, plan = self.install(self.owner, "create")
        self.assertEqual(first["environment"]["requirements"], ["tiny-fixture==1.0"])
        self.assertEqual(plan["downloadBytes"], 0)
        # A fresh private generation exercises the metadata-only shared installation path.
        second, plan = self.install(self.owner, "install", ["tiny-fixture>=1.0"])
        self.assertTrue(second["environment"]["verification"]["verified"])
        self.assertEqual(plan["packages"][0]["decision"], "shared")
        self.assertEqual(plan["downloadBytes"], 0)
        self.assertEqual((original.parent / "record.v1.json").read_bytes(), index)
        self.assertEqual(module.file_hash(original), checksum)
        self.assertEqual(material["filename"], "tiny_fixture-1.0-py2-none-any.whl")
        self.assertEqual(len(self.owner.material_records()), 1)

    def test_create_fills_a_base_environment_preserves_direct_constraints_and_rolls_back_conflicts(self):
        self.seed_material()
        base_request = self.fixture.request("create")
        with patch.object(self.owner, "command", side_effect=lambda args, work, **kwargs: self.native_command(self.owner, args, work, **kwargs)):
            base = self.owner.prepare(base_request)
        self.assertEqual(base["state"], "completed", base.get("detail")); self.assertEqual(base["environment"]["requirements"], [])
        first, _ = self.install(self.owner, "create")
        self.assertNotEqual(first["environment"]["generation"], base["environment"]["generation"])
        calls = len(self.commands)
        second, plan = self.install(self.owner, "create", ["tiny-fixture>=1.0"])
        self.assertEqual(second["environment"]["generation"], first["environment"]["generation"])
        self.assertEqual(second["environment"]["requirements"], ["tiny-fixture==1.0", "tiny-fixture>=1.0"])
        self.assertFalse(any(args[1:3] == ["pip", "compile"] or "download" in args
            or args[1:2] == ["venv"] and any(str(arg).endswith("/venv") for arg in args)
            or args[1:3] == ["pip", "install"] and any(str(arg).endswith("venv/bin/python") for arg in args)
            for args in self.commands[calls:]))
        request = self.fixture.request("create"); request["requirements"] = ["tiny-fixture<1.0"]
        with patch.object(self.owner, "command", side_effect=lambda args, work, **kwargs: self.native_command(self.owner, args, work, **kwargs)):
            conflict = self.owner.prepare(request)
        self.assertEqual(conflict["state"], "blocked"); self.assertIn("No solution found", conflict["detail"])
        self.assertEqual(self.owner.environment("training")["generation"], first["environment"]["generation"])
        self.assertEqual(plan["downloadBytes"], 0)

    def test_standard_parser_keeps_build_and_compressed_tags_and_rejects_incompatible_or_invented_tags(self):
        request = self.fixture.request("create")
        with patch.object(self.owner, "command", side_effect=lambda args, work, **kwargs: self.native_command(self.owner, args, work, **kwargs)):
            base = self.owner.prepare(request)
        self.assertEqual(base["state"], "completed", base.get("detail"))
        work = self.fixture.workspace / "tag-check"; work.mkdir()
        paths = []
        for name, tags in [("tiny_fixture-1.0-2-py2.py3-none-any.whl", "Build: 2\nTag: py2-none-any\nTag: py3-none-any\n"),
                           ("tiny_fixture-1.0-cp27-cp27m-win32.whl", "Tag: cp27-cp27m-win32\n"),
                           ("tiny_fixture-1.0-py3-none-linux_x86_64.any.whl", "Tag: py3-none-linux_x86_64\nTag: py3-none-any\n"),
                           ("tiny_fixture-1.0-py3-none-win32.any.whl", "Tag: py3-none-any\n")]:
            path = work / name; wheel(path, extra={"tiny_fixture-1.0.dist-info/WHEEL": ("Wheel-Version: 1.0\n" + tags).encode()}); paths.append(path)
        self.owner.wheel_names = {}
        with patch.object(self.owner, "command", side_effect=lambda args, wd, **kwargs: self.native_command(self.owner, args, wd, **kwargs)):
            self.owner.installer(work)
            names = self.owner.installation_names(paths, pathlib.Path(base["environment"]["directory"]), work)
        self.assertEqual(names[module.file_hash(paths[0])]["filename"], paths[0].name)
        self.assertIn("no compatible", names[module.file_hash(paths[1])]["error"])
        self.assertEqual(names[module.file_hash(paths[2])]["filename"], paths[2].name)
        self.assertIn("tags differ", names[module.file_hash(paths[3])]["error"])

    def test_historical_wheel_resolves_offline_before_becoming_shared_material(self):
        directory = self.fixture.workspace / "old-wheel-cache"; directory.mkdir()
        path = directory / "tiny_fixture-1.0-py3-none-any.whl"; wheel(path)
        original = module.file_hash(path); self.assertEqual(self.owner.material_records(), [])
        result, plan = self.install(self.owner)
        self.assertEqual(plan["downloadBytes"], 0); self.assertEqual(module.file_hash(path), original)
        self.assertEqual(len(self.owner.material_records()), 1)
        compile_commands = [args for args in self.commands if args[1:3] == ["pip", "compile"]]
        self.assertEqual(len(compile_commands), 1); self.assertIn("--no-index", compile_commands[0])
        self.assertTrue(result["environment"]["verification"]["verified"])
        print("NATIVE_HISTORY_EVIDENCE " + json.dumps({"wheelHash": original, "downloadBytes": plan["downloadBytes"],
            "offlineResolution": True, "originalWheelUnchanged": True, "materials": 1, "verified": True}), flush=True)


if __name__ == "__main__":
    unittest.main()
