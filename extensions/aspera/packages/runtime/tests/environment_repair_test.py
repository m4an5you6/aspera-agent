"""Real source-integrity failures produce scoped, repeatable Agent repair choices."""
import importlib.util
import pathlib
import unittest
import uuid
from unittest.mock import patch

fixture = importlib.util.spec_from_file_location("storage_fixture", pathlib.Path(__file__).with_name("storage_governance_test.py"))
module = importlib.util.module_from_spec(fixture)
fixture.loader.exec_module(module)
namespace = module.namespace
save, digest = namespace["save"], namespace["digest"]


class EnvironmentRepairCase(unittest.TestCase):
    setUp = module.GovernanceCase.setUp

    def historical(self):
        run = self.owner.namespace / "runs" / str(uuid.uuid4())
        directory = run / "workspace/pyenv"
        (directory / "bin").mkdir(parents=True)
        (directory / "bin/python").write_bytes(b"interpreter fixture")
        (directory / "pyvenv.cfg").write_text("include-system-site-packages = false\n")
        info = directory / "lib/python3.10/site-packages/decord-0.6.0.dist-info"
        info.mkdir(parents=True)
        (info / "top_level.txt").write_bytes(b"decord\n")
        (info / "METADATA").write_text("Name: decord\nVersion: 0.6.0\n")
        (info / "RECORD").write_text("decord-0.6.0.dist-info/top_level.txt,sha256=8TBMC8W9caRfSBphoy47j2wFImKqCOgWKD3JVELo5e0,17\n")
        save(run / ".aspera-owner.json", {"version": 1, "serverId": self.owner.server, "experimentId": run.name})
        self.service.source_released = lambda *_: "confirmed-release"
        self.owner.config["reuseVerificationVersion"] = 1
        candidate = self.service.candidate(run, directory, self.owner.namespace)
        self.service.find_candidate = lambda identifier: candidate if identifier == candidate["id"] else None
        self.owner._storage_governance = self.service
        return candidate, info

    def request(self, **changes):
        return {"operationId": str(uuid.uuid4()), "environmentId": "training", "action": "create",
            "requirements": ["decord==0.6.0"], "modules": [], "files": [], "requireCuda": False, **changes}

    def test_record_mismatch_retains_original_bytes_and_reuses_negative_proof(self):
        candidate, info = self.historical()
        original = {path.name: path.read_bytes() for path in info.iterdir()}
        request = self.request(reuseCandidateId=candidate["id"])
        repair = namespace["environment_repair"](self.owner)
        with self.assertRaisesRegex(RuntimeError, "differs from its RECORD"):
            self.service.borrowing(request)
        diagnostics, _ = repair.observations()
        self.assertEqual(diagnostics[0]["code"], "content-mismatch")
        self.assertEqual(diagnostics[0]["actualBytes"], 7)
        self.assertEqual(diagnostics[0]["expectedBytes"], 17)
        self.assertEqual(diagnostics[0]["package"], "decord")
        with patch.object(self.service, "verify_borrowed", side_effect=AssertionError("unchanged source must not be rescanned")):
            with self.assertRaisesRegex(RuntimeError, "differs from its RECORD"):
                self.service.borrowing(self.request(reuseCandidateId=candidate["id"]))
        self.assertEqual(original, {path.name: path.read_bytes() for path in info.iterdir()})
        proof = self.service.root / "environment-failures-v1" / (candidate["id"] + ".json")
        saved = namespace["load"](proof)
        saved["sourceState"]["verificationRule"] = "older-record-rule"
        save(proof, saved)
        self.assertIsNone(repair.cached_failure(candidate))
        (info / "top_level.txt").write_bytes(b"changed")
        self.assertIsNone(repair.cached_failure(candidate))

    def test_empty_base_creation_does_not_verify_unrelated_historical_packages(self):
        self.historical()
        with patch.object(self.service, "verify_borrowed", side_effect=AssertionError("base interpreter has no package requirement")):
            self.assertIsNone(self.service.borrowing(self.request(requirements=[])))

    def test_agent_selects_bound_repair_without_changing_dependencies_or_source(self):
        candidate, _ = self.historical()
        request = self.request(reuseCandidateId=candidate["id"])
        repair = namespace["environment_repair"](self.owner)
        with self.assertRaisesRegex(RuntimeError, "differs from its RECORD"):
            self.service.borrowing(request)
        diagnostics, _ = repair.observations()
        plan = repair.propose(request, diagnostics)
        save(self.owner.operations / request["operationId"] / "receipt.v1.json",
            {"experimentId": self.owner.id, "serverId": self.owner.server, "exitConfirmed": True, "requestHash": plan["requestHash"]})
        selected = self.request(action="repair", repairPlanId=plan["id"])
        result = repair.resolve(selected)
        self.assertEqual(result["environmentId"], "training")
        self.assertEqual(result["requirements"], request["requirements"])
        self.assertNotIn("reuseCandidateId", result)
        self.assertIsNone(plan["downloadBytes"])
        self.assertIsNone(plan["peakBytes"])
        self.assertEqual(self.owner.checked_command, "environment-" + request["operationId"])
        for changed in ({"environmentId": "foreign"}, {"requirements": ["different==2"]}, {"directory": "second-env"}):
            with self.assertRaisesRegex(RuntimeError, "another|cannot change"):
                repair.resolve({**selected, **changed})

    def test_timeout_is_not_cached_as_corrupt_content(self):
        candidate, _ = self.historical()
        repair = namespace["environment_repair"](self.owner)
        row = repair.diagnose(self.request(), TimeoutError("original verification deadline expired"), candidate)
        self.assertEqual(row["code"], "verification-timeout")
        self.assertIsNone(repair.cached_failure(candidate))

    def removed(self):
        run = self.owner.namespace / "runs" / str(uuid.uuid4())
        directory = run / "workspace/env/training"
        directory.parent.mkdir(parents=True)
        manifest = run / "environments-v1/training.json"
        save(run / ".aspera-owner.json", {"version": 1, "experimentId": run.name, "serverId": self.owner.server})
        declared = {"version": 1, "experimentId": run.name, "serverId": self.owner.server, "environmentId": "training",
            "generation": str(uuid.uuid4()), "directory": str(directory), "packages": [{"id": "a" * 64}]}
        save(manifest, declared)
        self.owner.references = self.owner.namespace / "packages-v1/references"
        reference = {"version": 1, "experimentId": run.name, "serverId": self.owner.server, "environmentId": "training",
            "directory": str(directory), "manifest": str(manifest), "packages": ["a" * 64]}
        path = self.owner.references / (digest([run.name, "training"]) + ".json")
        save(path, reference)
        self.owner._storage_governance = self.service
        self.service.roots = lambda: ([{"directory": str(self.owner.namespace), "confirmed": True, "registrationId": "current-volume"}], [])
        self.service.source_released = lambda *_: "released-original-task"
        receipt = {**declared, "state": "completed"}
        save(run / "environment-removals-v1/training.json", receipt)
        return run, directory, path, declared

    def test_confirm_removed_environment_releases_only_its_reference_and_retains_manifest(self):
        run, directory, path, declared = self.removed()
        log = run / "workspace/train.log"; log.write_text("preserved")
        repair = namespace["environment_repair"](self.owner)
        candidate = repair.reference_candidates()[0]
        self.assertTrue(candidate["eligible"], candidate["detail"])
        self.assertEqual(repair.release_references([candidate["id"]]), [candidate["id"]])
        self.assertEqual(repair.release_references([candidate["id"]]), [candidate["id"]])
        self.assertFalse(path.exists())
        self.assertEqual(log.read_text(), "preserved")
        self.assertEqual(namespace["load"](run / "environments-v1/training.json"), declared)
        self.assertFalse(directory.exists())

    def test_repeated_confirmation_rechecks_a_restored_reference_and_environment(self):
        _run, directory, path, _declared = self.removed()
        reference = namespace["load"](path)
        repair = namespace["environment_repair"](self.owner)
        identifier = repair.reference_candidates()[0]["id"]
        repair.release_references([identifier])
        save(path, reference)
        directory.mkdir()
        with self.assertRaisesRegex(RuntimeError, "still exists"):
            repair.release_references([identifier])
        self.assertTrue(path.exists())

    def test_missing_receipt_live_task_or_restored_directory_never_releases_reference(self):
        run, directory, path, _ = self.removed()
        repair = namespace["environment_repair"](self.owner)
        identifier = repair.reference_candidates()[0]["id"]
        (run / "environment-removals-v1/training.json").unlink()
        self.assertFalse(repair.reference_candidates()[0]["eligible"])
        with self.assertRaisesRegex(RuntimeError, "receipt is missing"):
            repair.release_references([identifier])
        self.assertTrue(path.exists())
        self.service.source_released = lambda *_: (_ for _ in ()).throw(RuntimeError("Original commands remain occupied"))
        with self.assertRaisesRegex(RuntimeError, "occupied"):
            repair.release_references([identifier])
        self.assertTrue(path.exists())

    def test_manual_removal_uses_original_mount_proof_not_parent_device_number(self):
        run, directory, path, _ = self.removed()
        (run / "environment-removals-v1/training.json").unlink()
        manual = self.base / "home/.local/state/aspera/manual-cache-cleanup/retained"
        preview = {"version": 1, "serverId": self.owner.server, "base": str(run.parent.parent), "mountId": 12,
            "candidates": [{"id": "removed-env", "path": str(directory), "runId": run.name, "mountId": 12,
                "identity": [directory.parent.stat().st_dev + 1, 99, 16832, 1, 1, 1]}]}
        save(manual / "preview.v1.json", preview)
        save(manual / "result.v1.json", {"state": "complete", "removedTargets": [{"id": "removed-env", "path": str(directory)}]})
        repair = namespace["environment_repair"](self.owner)
        with patch.object(pathlib.Path, "home", return_value=self.base / "home"):
            self.assertTrue(repair.reference_candidates()[0]["eligible"])
            preview["candidates"][0]["mountId"] = 13
            save(manual / "preview.v1.json", preview)
            self.assertFalse(repair.reference_candidates()[0]["eligible"])
        self.assertTrue(path.exists())

    def test_changed_current_mount_or_pending_publication_keeps_reference(self):
        run, directory, path, _ = self.removed()
        repair = namespace["environment_repair"](self.owner)
        mount = self.service.mount
        self.service.mount = lambda target: {**mount(target), "mountId": 9 if target == directory.parent else 2}
        self.assertFalse(repair.reference_candidates()[0]["eligible"])
        self.service.mount = mount
        operation = str(uuid.uuid4())
        save(run / "environment-requests-v1" / (operation + ".json"), {"request": {"environmentId": "training"}})
        receipt = {"exitConfirmed": True}
        save(run / "environment-operations-v1" / operation / "receipt.v1.json", receipt)
        save(run / "environment-operations-v1" / operation / "publication.v1.json", {"phase": "swapped"})
        self.assertIn("requires recovery", repair.reference_candidates()[0]["detail"])
        save(run / "environment-recoveries-v1" / (operation + ".json"), {"sourceReceiptHash": digest(receipt)})
        self.assertTrue(repair.reference_candidates()[0]["eligible"])
        save(run / "environment-cleanups-v1" / (operation + ".json"), {"environmentId": "training", "state": "pending"})
        self.assertIn("cleanup retains", repair.reference_candidates()[0]["detail"])
        self.assertTrue(path.exists())


if __name__ == "__main__":
    unittest.main()
