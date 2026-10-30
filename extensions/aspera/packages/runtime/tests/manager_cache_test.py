"""Cache eviction requires known manager layouts, unchanged topology and explicit selection."""
import importlib.util
import pathlib
import types
import unittest
import uuid
from unittest.mock import patch

fixture = importlib.util.spec_from_file_location("cache_fixture", pathlib.Path(__file__).with_name("managed_environment_test.py"))
module = importlib.util.module_from_spec(fixture)
fixture.loader.exec_module(module)
managed = module.module


class ManagerCacheCase(unittest.TestCase):
    setUp = module.EnvironmentCase.setUp

    def cache(self):
        root = self.owner.namespace / "tests" / ("synthetic-" + uuid.uuid4().hex) / "uv-cache"
        root.mkdir(parents=True)
        (root / "CACHEDIR.TAG").write_text("Signature: 8a477f597d28d172789f06886806bc55\n")
        (root / "archive-v0").mkdir()
        (root / "archive-v0/unused").write_bytes(b"x" * 8192)
        return root

    def governance(self):
        return types.SimpleNamespace(protect_path=lambda _: None, reclaimable=managed.allocated)

    def test_known_idle_uv_cache_uses_only_the_configured_manager_and_confined_path(self):
        root = self.cache()
        with patch.object(managed, "storage_governance", return_value=self.governance()), patch.object(managed.shutil, "which", return_value=None):
            service = managed.manager_caches(self.owner)
            rows = service.discover()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["path"], str(root))
            with patch.object(managed.subprocess, "run", return_value=types.SimpleNamespace(returncode=0, stdout="cleaned", stderr="")) as run:
                service.clean(rows[0]["id"])
            self.assertEqual(run.call_args.args[0], [self.config["uvPath"], "cache", "clean", "--cache-dir", str(root)])
            self.assertTrue(root.exists())

    def test_unknown_payload_or_a_link_never_becomes_an_eviction_candidate(self):
        root = self.cache()
        with patch.object(managed, "storage_governance", return_value=self.governance()), patch.object(managed.shutil, "which", return_value=None):
            service = managed.manager_caches(self.owner)
            (root / "model.safetensors").write_bytes(b"preserved")
            self.assertEqual(service.discover(), [])
            (root / "model.safetensors").unlink()
            (root / "archive-v0/link").symlink_to(self.root)
            self.assertEqual(service.discover(), [])

    def test_active_referenced_or_replaced_cache_is_not_evicted(self):
        root = self.cache()
        with patch.object(managed, "storage_governance", return_value=self.governance()), patch.object(managed.shutil, "which", return_value=None):
            service = managed.manager_caches(self.owner)
            original = service.discover()[0]
            (root / "archive-v0/unused").write_bytes(b"changed")
            with self.assertRaisesRegex(RuntimeError, "changed"):
                service.clean(original["id"])
            with patch.object(service, "idle", side_effect=RuntimeError("retained source")):
                self.assertEqual(service.discover(), [])

    def test_internal_cache_links_are_preserved_in_the_preview_identity(self):
        root = self.cache()
        (root / "archive-v0/link").symlink_to("unused")
        with patch.object(managed, "storage_governance", return_value=self.governance()), patch.object(managed.shutil, "which", return_value=None):
            service = managed.manager_caches(self.owner)
            self.assertEqual(len(service.discover()), 1)
            original = service.snapshot(root)[0]
            (root / "archive-v0/link").unlink()
            (root / "archive-v0/link").symlink_to("../CACHEDIR.TAG")
            self.assertNotEqual(service.snapshot(root)[0], original)

    def test_only_pnpm_project_slots_may_reference_owned_releases_without_following_them(self):
        root = self.owner.namespace / "cache/pnpm"
        projects = root / "v11/projects"
        projects.mkdir(parents=True)
        link = projects / ("a" * 32)
        release = self.owner.namespace / "releases" / ("b" * 64 + ".building-v1")
        link.symlink_to(release)
        with patch.object(managed, "storage_governance", return_value=self.governance()):
            service = managed.manager_caches(self.owner)
            service.snapshot(root)
            self.assertFalse(release.exists())
            link.unlink()
            link.symlink_to(self.root)
            with self.assertRaisesRegex(RuntimeError, "escapes"):
                service.snapshot(root)

    def test_manager_cache_requires_an_explicit_candidate_selection(self):
        row = {"id": "manager-cache-" + "a" * 64, "kind": "manager-cache", "bytes": 4096, "reason": "Owned cache"}
        self.config["managerCacheVersion"] = 1
        with patch.object(self.owner, "candidates", return_value=[row]), patch.object(managed, "manager_caches") as caches:
            preview = self.owner.preview()
            self.assertEqual(self.owner.cleanup(str(uuid.uuid4()), preview["fingerprint"])["state"], "completed")
            caches.return_value.clean.assert_not_called()
            self.config["candidateIds"] = [row["id"]]
            self.assertEqual(self.owner.cleanup(str(uuid.uuid4()), preview["fingerprint"])["state"], "completed")
            caches.return_value.clean.assert_called_once_with(row["id"])


if __name__ == "__main__":
    unittest.main()
