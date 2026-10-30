"""Real service decisions distinguish trial estimates, approval and partial material reuse."""
import importlib.util
import pathlib
import json
import subprocess
import unittest
import uuid
from unittest.mock import patch

fixture = importlib.util.spec_from_file_location("storage_fixture", pathlib.Path(__file__).with_name("storage_governance_test.py"))
module = importlib.util.module_from_spec(fixture)
fixture.loader.exec_module(module)
namespace = module.namespace


class PreflightCase(unittest.TestCase):
    setUp = module.GovernanceCase.setUp
    request = module.GovernanceCase.request
    material = module.GovernanceCase.material
    targeted_material = module.GovernanceCase.targeted_material

    def test_unavailable_alternative_source_does_not_invalidate_verified_partial_content(self):
        self.enable()
        good, _directory, _ = self.targeted_material(b"verified weight")
        occupied, _other, _ = self.targeted_material(b"other weight")
        def released(identifier, _run):
            if identifier == occupied["sourceExperimentId"]:
                raise RuntimeError("Original allocation is not released")
            return "confirmed-release"
        self.service.source_released = released
        files = [("model.safetensors", b"verified weight"), ("config.json", b"{}")]
        request = {"kind": "model", "provider": "huggingface", "repository": "fixture/tiny", "revision": "a" * 40}
        material = self.service.inspect_material(request, {"id": request["repository"], "sha": request["revision"], "siblings": [
            {"rfilename": name, "size": len(data), "lfs": {"sha256": module.hashlib.sha256(data).hexdigest(), "size": len(data)}} for name, data in files]})
        result = self.service.prepare_material({"operationId": str(uuid.uuid4()), "materialId": material["id"], "action": "verify"})
        self.assertEqual(result["state"], "completed", result.get("detail"))
        self.assertEqual(result["verificationStatus"], "partial")
        self.assertEqual(result["reuse"]["candidateId"], good["id"])
        self.assertTrue(any("not released" in row for row in result["reuse"]["diagnostics"]))
        self.assertEqual(result["downloadedBytes"], 0)
        self.assertEqual(self.service.material_operation(result["operationId"])["state"], "completed")
        (_directory / "model.safetensors").write_bytes(b"source was changed")
        observed = self.service.material_operation(result["operationId"])
        self.assertEqual(observed["state"], "blocked")
        self.assertIn("source changed", observed["detail"])

    def test_retention_status_and_decision_do_not_wait_for_full_inventory_lock(self):
        self.approve()
        request = {"operationId": str(uuid.uuid4()), "expectedRevision": 1, "policy": self.policy(checkpointCount=1), "reason": "Confirm one checkpoint"}
        second = namespace["StorageGovernance"](self.owner)
        service = namespace["storage_preflight"](second)
        with self.service.locked():
            self.assertEqual(service.observations()["current"]["revision"], 1)
            with service.locked():
                service.propose(request)
                value = service.decide({"proposalId": request["operationId"], "expectedRevision": 1, "approve": True})
        self.assertEqual(value["revision"], 2)

    def test_preview_does_not_authorize_ordinary_training_commands(self):
        self.enable()
        self.service.assess(self.request())
        with self.assertRaisesRegex(RuntimeError, "committed capacity"):
            self.service.reserve_command("train")

    def test_completion_rechecks_a_policy_changed_after_the_last_command(self):
        service = self.approve()
        plan = self.service.assess(self.request(mode="commit", outputBytes=100, checkpointBytes=200, assessmentScope="experiment",
            materialRequirements={"planRevision": 1, "complete": True, "materials": []}))
        self.assertEqual(plan["state"], "ready")
        self.assertIsNotNone(self.service.admitted_plan())
        request = {"operationId": str(uuid.uuid4()), "expectedRevision": 1, "policy": self.policy(outputMinimumBytes=150), "reason": "Retain an additional result"}
        service.propose(request)
        service.decide({"proposalId": request["operationId"], "expectedRevision": 1, "approve": True})
        with self.assertRaisesRegex(RuntimeError, "current approved policy"):
            self.service.admitted_plan()

    def test_new_verified_budget_supersedes_old_deficit_under_the_same_policy(self):
        self.approve()
        first = self.service.assess(self.request(mode="commit", outputBytes=10 ** 18, checkpointBytes=200))
        self.assertEqual(first["state"], "insufficient")
        current = self.service.assess(self.request(mode="commit", outputBytes=100, checkpointBytes=200))
        self.assertEqual(current["state"], "ready")
        self.assertIsNone(self.service.requirement_evidence({"serverId": self.owner.server, "kind": "storage-plan", "id": first["operationId"]}))

    def test_positive_source_preflight_is_reused_but_added_package_paths_invalidate_it(self):
        self.enable()
        source = self.owner.namespace / "runs" / str(uuid.uuid4())
        directory = source / "workspace/pyenv"
        (directory / "bin").mkdir(parents=True)
        namespace["save"](source / ".aspera-owner.json", {"version": 1, "experimentId": source.name, "serverId": self.owner.server})
        (directory / "pyvenv.cfg").write_text("include-system-site-packages = false\n")
        (directory / "bin/python").write_bytes(b"fixture interpreter")
        metadata = directory / "lib/python3.10/site-packages/tiny_fixture-1.dist-info/METADATA"
        metadata.parent.mkdir(parents=True)
        metadata.write_text("Metadata-Version: 2.1\nName: tiny-fixture\nVersion: 1\n")
        self.service.source_released = lambda *_: "confirmed-original-release"
        self.owner.sandbox = lambda command, **_kwargs: ["bwrap", "--", *command]
        candidate = self.service.candidate(source, directory, self.owner.namespace)
        response = subprocess.CompletedProcess([], 0, json.dumps({"prefix": str(directory), "userSite": False,
            "pythonVersion": "3.10.12", "pythonAbi": "cp310", "cuda": False}), "")
        request = {"operationId": str(uuid.uuid4()), "environmentId": "training", "action": "verify-reuse", "reuseCandidateId": candidate["id"],
            "requirements": ["tiny-fixture==1"], "modules": [], "requireCuda": False}
        service = namespace["storage_preflight"](self.service)
        def run(argv, **_kwargs):
            return subprocess.CompletedProcess(argv, 0, "uv 0.13.0\n", "") if "--version" in argv else response
        with patch.object(namespace["subprocess"], "run", side_effect=run):
            preflight, _ = service.preflight_environment(request, self.owner.workspace / "tmp")
        self.assertEqual(preflight["status"], "reusable", preflight)
        self.assertFalse(self.service.bindings.exists())
        published = service.borrow_verified_source({**request, "action": "create", "operationId": str(uuid.uuid4())})
        self.assertEqual(published["candidateId"], candidate["id"])
        self.assertTrue(self.service.environment_satisfies(request))
        self.assertFalse(self.service.environment_satisfies({**request, "requirements": ["tiny-fixture==2"]}))
        self.owner.config["evidenceContext"] = {"sessionId": "resumed-execution", "planRevision": 1}
        self.owner.config["approvedStoragePolicy"] = self.policy()
        budget = self.service.assess(self.request(mode="commit", outputBytes=100, checkpointBytes=200,
            requirements=["tiny-fixture==1"], assessmentScope="experiment", materialRequirements={"planRevision": 1, "complete": True, "materials": []}))
        self.assertEqual(budget["state"], "ready", budget)
        self.assertEqual(budget["volumes"][0]["environmentBytes"], 0)
        omitted = self.service.assess(self.request(requirements=[], materialRequirements={"planRevision": 1, "complete": True, "materials": []}))
        self.assertEqual(omitted["state"], "requirements-pending")
        self.assertIn("tiny-fixture==1", omitted["detail"])
        self.enable()
        (directory / "injected.pth").write_text("/unowned\n")
        with self.assertRaisesRegex(RuntimeError, "file list changed|candidate is absent or its identity changed"):
            service.borrow_verified_source({**request, "action": "create", "operationId": str(uuid.uuid4())})

    def dependency_fixture(self):
        directory = self.owner.workspace / "historical"
        metadata = directory / "lib/python3.10/site-packages/tiny_fixture-1.dist-info/METADATA"
        metadata.parent.mkdir(parents=True)
        metadata.write_text("Metadata-Version: 2.1\nName: tiny-fixture\nVersion: 1\nRequires-Dist: existing-dependency>=1\n\nOriginal description\n")
        self.owner.sandbox = lambda command, **_kwargs: ["bwrap", "--", *command]
        return {"directory": str(directory), "python": str(directory / "bin/python")}, metadata

    def test_historical_dependency_check_uses_uv_without_installing_packaging_in_the_source(self):
        candidate, metadata = self.dependency_fixture()
        original = metadata.read_bytes()
        observed = []
        def run(argv, **_kwargs):
            observed.append(argv)
            return subprocess.CompletedProcess(argv, 0, "uv 0.13.0\n" if "--version" in argv else "", "")
        work = self.owner.workspace / "tmp/check"
        with patch.object(namespace["subprocess"], "run", side_effect=run):
            self.service.verify_borrowed_dependencies(candidate, {"requirements": ["tiny-fixture==1"]}, work)
        self.assertEqual(metadata.read_bytes(), original)
        self.assertIn("Requires-Dist: existing-dependency>=1", (work / "historical-check.metadata").read_text())
        self.assertIn("Requires-Dist: tiny-fixture==1", (work / "historical-check.metadata").read_text())
        self.assertEqual(observed[1][1:4], ["--ro-bind", str(work / "historical-check.metadata"), str(metadata)])
        self.assertIn("check", observed[1])
        self.assertIn("--offline", observed[1])
        self.assertFalse(any("install" in argv or "venv" in argv for argv in observed))

    def test_historical_dependency_conflicts_still_reject_the_source(self):
        candidate, metadata = self.dependency_fixture()
        original = metadata.read_bytes()
        def run(argv, **_kwargs):
            return subprocess.CompletedProcess(argv, 0, "uv 0.13.0\n", "") if "--version" in argv else subprocess.CompletedProcess(argv, 1, "", "tiny-fixture==2 is required but 1 is installed")
        with patch.object(namespace["subprocess"], "run", side_effect=run), self.assertRaisesRegex(RuntimeError, "required but 1 is installed"):
            self.service.verify_borrowed_dependencies(candidate, {"requirements": ["tiny-fixture==2"]}, self.owner.workspace / "tmp/check")
        self.assertEqual(metadata.read_bytes(), original)

    def test_historical_constraints_cannot_inject_headers_or_unverified_urls(self):
        candidate, _metadata = self.dependency_fixture()
        for value in ["tiny-fixture==1\nRequires-Dist: another", "tiny-fixture @ https://fixture.test/package.whl"]:
            with self.assertRaisesRegex(RuntimeError, "single-line dependency constraints|Only authenticated"):
                self.service.verify_borrowed_dependencies(candidate, {"requirements": [value]}, self.owner.workspace / "tmp/check")

    def enable(self):
        self.owner.config["storagePreflightVersion"] = 2
        self.owner.config["reuseVerificationVersion"] = 1
        self.owner.config["evidenceContext"] = {"sessionId": "execution-fixture", "planRevision": 1}

    def test_trial_does_not_publish_a_plan_or_lock_first_output_estimate(self):
        self.enable()
        first = self.service.assess(self.request(outputBytes=3000000000, checkpointBytes=4500000000))
        second = self.service.assess(self.request(outputBytes=150000000, checkpointBytes=1500000000))
        self.assertEqual(first["mode"], "preview")
        self.assertNotEqual(second["state"], "requirements-pending")
        self.assertFalse((self.owner.run / "storage-plan.v1.json").exists())
        self.assertEqual(list((self.service.root / "reservations").glob("*.json")), [])

    def test_commit_requires_an_approved_retention_policy(self):
        self.enable()
        result = self.service.assess(self.request(mode="commit"))
        self.assertEqual(result["state"], "requirements-pending")
        self.assertIn("approved", result["detail"].lower())

    def test_corrected_dependency_trial_uses_published_environment_instead_of_trial_union(self):
        self.approve()
        typo = self.service.assess(self.request(requirements=["environment:training"], environmentEstimate={"peakBytes": 1000, "basis": "Trial"}))
        failed = self.service.assess(self.request(mode="commit", requirements=["wrong-extra==1"], outputBytes=100, checkpointBytes=200))
        self.assertEqual(failed["state"], "requirements-pending")
        self.owner.environment = lambda _identifier: {"state": "ready", "requirements": ["tiny-fixture==1"]}
        corrected = self.service.assess(self.request(mode="commit", requirements=["tiny-fixture==1"], outputBytes=100, checkpointBytes=200))
        self.assertEqual(corrected["state"], "ready", corrected["detail"])
        self.assertEqual(corrected["volumes"][0]["environmentBytes"], 0)
        self.assertEqual(namespace["load"](self.owner.run / "storage-plans-v1" / (typo["operationId"] + ".json"))["requirements"], ["environment:training"])

    def test_trial_cannot_omit_a_published_environment_dependency(self):
        self.approve()
        self.owner.environment = lambda _identifier: {"state": "ready", "requirements": ["tiny-fixture==1", "retained-package==2"]}
        result = self.service.assess(self.request(mode="commit", requirements=["tiny-fixture==1"], outputBytes=100, checkpointBytes=200))
        self.assertEqual(result["state"], "requirements-pending")
        self.assertIn("retained-package==2", result["detail"])
        self.assertNotIn("tiny-fixture==1", result["detail"])

    def test_installation_changes_the_dependency_basis_without_rewriting_old_trials(self):
        self.approve()
        current = {"state": "ready", "requirements": ["tiny-fixture==1", "retained-package==2"]}
        self.owner.environment = lambda _identifier: current
        original = self.service.assess(self.request(mode="commit", requirements=current["requirements"], outputBytes=100, checkpointBytes=200))
        self.assertEqual(original["state"], "ready", original["detail"])
        current["requirements"] = ["tiny-fixture==2"]
        updated = self.service.assess(self.request(mode="commit", requirements=current["requirements"], outputBytes=100, checkpointBytes=200))
        self.assertEqual(updated["state"], "ready", updated["detail"])
        saved = namespace["load"](self.owner.run / "storage-plans-v1" / (original["operationId"] + ".json"))
        self.assertEqual(saved["requirements"], ["tiny-fixture==1", "retained-package==2"])

    def test_partial_model_verification_completes_investigation_without_readiness(self):
        self.enable()
        material = self.material()
        result = self.service.prepare_material({"operationId": str(uuid.uuid4()), "materialId": material["id"], "action": "verify"})
        self.assertEqual(result["state"], "completed")
        self.assertEqual(result["verificationStatus"], "none")
        self.assertFalse(result["materialReady"])
        self.assertEqual(result["downloadedBytes"], 0)

    def policy(self, **changes):
        return {"artifact": "adapter", "checkpointCount": 2, "optimizerState": True, "schedulerState": True,
            "recoveryPoints": ["checkpoint-30", "checkpoint-230"], "outputMinimumBytes": 100,
            "checkpointMinimumBytes": 200, "basis": "Keep both approved stage recovery points", **changes}

    def approve(self):
        self.enable()
        service = namespace["storage_preflight"](self.service)
        request = {"operationId": str(uuid.uuid4()), "expectedRevision": 0, "policy": self.policy(), "reason": "Initial policy"}
        proposed = service.propose(request)
        self.assertEqual(proposed["state"], "pending")
        approved = service.decide({"proposalId": request["operationId"], "expectedRevision": 0, "approve": True})
        self.assertEqual(approved["revision"], 1)
        return service

    def test_same_policy_corrected_estimate_can_commit_without_lowering_retained_content(self):
        service = self.approve()
        first = self.service.assess(self.request(mode="commit", outputBytes=3000, checkpointBytes=4500))
        second = self.service.assess(self.request(mode="commit", outputBytes=150, checkpointBytes=1500))
        self.assertEqual(first["state"], "ready")
        self.assertEqual(second["state"], "ready")
        self.assertEqual(service.policy()["revision"], 1)
        self.assertEqual(namespace["load"](self.owner.run / "storage-plan.v1.json")["operationId"], second["operationId"])

    def test_explicit_minimum_requires_a_new_policy_and_approval(self):
        service = self.approve()
        blocked = self.service.assess(self.request(mode="commit", outputBytes=99, checkpointBytes=200))
        self.assertEqual(blocked["state"], "requirements-pending")
        request = {"operationId": str(uuid.uuid4()), "expectedRevision": 1, "policy": self.policy(outputMinimumBytes=50), "reason": "Operator-reviewed change"}
        service.propose(request)
        self.assertEqual(service.policy()["policy"]["outputMinimumBytes"], 100)
        service.decide({"proposalId": request["operationId"], "expectedRevision": 1, "approve": True})
        ready = self.service.assess(self.request(mode="commit", outputBytes=99, checkpointBytes=200))
        self.assertEqual(ready["state"], "ready")
        self.assertEqual(ready["policyRevision"], 2)

    def test_proposal_content_and_concurrent_decisions_are_bound(self):
        service = self.approve()
        request = {"operationId": str(uuid.uuid4()), "expectedRevision": 1, "policy": self.policy(), "reason": "Same requirement"}
        service.propose(request)
        with self.assertRaisesRegex(RuntimeError, "another request"):
            service.propose({**request, "reason": "Changed content"})
        with self.assertRaisesRegex(RuntimeError, "conflict"):
            service.decide({"proposalId": request["operationId"], "expectedRevision": 0, "approve": True})
        decision = {"proposalId": request["operationId"], "expectedRevision": 1, "approve": True}
        first = service.decide(decision)
        self.assertEqual(service.decide(decision), first)
        with self.assertRaisesRegex(RuntimeError, "another decision"):
            service.decide({**decision, "approve": False})

    def test_approval_recovers_saved_decision_without_publishing_old_revision(self):
        service = self.approve()
        approved = service.policy()
        (service.root / "policy-current.v1.json").unlink()
        service.decide({"proposalId": approved["proposalId"], "expectedRevision": 0, "approve": True})
        self.assertEqual(service.policy(), approved)

    def test_preview_does_not_replace_committed_reservation(self):
        self.approve()
        committed = self.service.assess(self.request(mode="commit", outputBytes=500, checkpointBytes=500))
        before = (self.owner.run / "storage-plan.v1.json").read_bytes()
        self.service.assess(self.request(mode="preview", outputBytes=100, checkpointBytes=200))
        self.assertEqual((self.owner.run / "storage-plan.v1.json").read_bytes(), before)
        self.assertEqual(namespace["load"](self.owner.run / "storage-plan.v1.json")["operationId"], committed["operationId"])

    def test_whole_install_estimate_does_not_skip_readonly_reuse_preflight(self):
        self.approve()
        result = self.service.assess(self.request(mode="commit", requirements=["tiny==1"], outputBytes=100, checkpointBytes=200,
            environmentEstimate={"peakBytes": 1000, "basis": "Unverified complete installation"}))
        self.assertEqual(result["state"], "requirements-pending")
        self.assertIn("verify-reuse", result["detail"])

    def test_preview_cannot_authorize_material_download(self):
        self.enable()
        material = self.material()
        plan = self.service.assess(self.request(materialIds=[material["id"]]))
        with self.assertRaisesRegex(RuntimeError, "only a preview"):
            self.service.reserve(str(uuid.uuid4()), material, plan["operationId"])

    def test_preview_requirements_cannot_be_forgotten_at_commit(self):
        self.approve()
        material = self.material()
        self.service.assess(self.request(materialIds=[material["id"]]))
        result = self.service.assess(self.request(mode="commit", outputBytes=100, checkpointBytes=200))
        self.assertEqual(result["state"], "requirements-pending")
        self.assertIn("omitted", result["detail"])

    def test_complete_nested_requirements_are_charged_without_repeating_flat_ids(self):
        self.approve()
        material = self.material()
        declared = {"planRevision": 1, "complete": True, "materials": [{"kind": "model", "repository": "fixture/tiny", "revision": "a" * 40, "materialId": material["id"]}]}
        result = self.service.assess(self.request(materialRequirements=declared, outputBytes=100, checkpointBytes=200))
        self.assertEqual(result["materialIds"], [material["id"]])
        self.assertEqual(result["coverage"]["scope"], "experiment")
        self.assertEqual(len(result["materialEstimates"]), 1)
        self.assertNotEqual(result["state"], "ready", "Unverified files remain pending after identity resolution")
        self.assertFalse((self.owner.run / "storage-plan.v1.json").exists())
        partial = self.service.assess(self.request(materialRequirements=declared, assessmentScope="declared", outputBytes=100, checkpointBytes=200))
        self.assertEqual(partial["coverage"]["scope"], "declared")
        self.assertFalse(partial["coverage"]["complete"])


if __name__ == "__main__":
    unittest.main()
