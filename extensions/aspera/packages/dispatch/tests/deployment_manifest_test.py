"""Execute the actual SSH manifest reader rather than a second test-only parser."""
import json
import pathlib
import subprocess
import sys
import unittest

SOURCE = (pathlib.Path(__file__).resolve().parent.parent / "src/deploy.ts").read_text(encoding="utf-8")
START = SOURCE.index("required=['managed-environment-reuse-v1']")
END = SOURCE.index("hidden=[", START)
PROGRAM = "import json,sys\nmanifest=json.loads(sys.argv[1]);required=[]\n" + SOURCE[START:END] + "\nprint(json.dumps(required))\n"

class PlanningManifest(unittest.TestCase):
    def read(self, value):
        return subprocess.run([sys.executable, "-c", PROGRAM, json.dumps(value)], capture_output=True, text=True, timeout=10)

    def test_absent_and_original_planning_release_remain_supported(self):
        for value in [{}, {"asperaPlanningTools": {"version": 1, "formatVersion": "0.1.0"}}]:
            self.assertEqual(self.read(value).returncode, 0)

    def test_new_requirements_format_requests_its_actual_capability(self):
        value = self.read({"asperaPlanningTools": {"version": 1, "formatVersion": "0.1.0", "requirementsVersion": 1}})
        self.assertEqual(value.returncode, 0, value.stderr)
        self.assertIn("planning-requirements-v1", json.loads(value.stdout))

    def test_inference_planning_requires_a_matching_controller(self):
        value = self.read({"asperaPlanningTools": {"version": 1, "formatVersion": "0.1.0", "inferenceVersion": 1}})
        self.assertEqual(value.returncode, 0, value.stderr)
        self.assertIn("inference-plan-v1", json.loads(value.stdout))

    def test_dependency_ledger_semantics_require_a_matching_controller(self):
        value = self.read({"asperaEnvironmentTools": {"requirementLedgerVersion": 1}})
        self.assertEqual(value.returncode, 0, value.stderr)
        self.assertIn("storage-requirement-ledger-v1", json.loads(value.stdout))

    def test_stage_public_verification_and_readonly_consumer_changes_require_capable_controllers(self):
        result = self.read({"asperaStageEvidenceVersion": 2, "asperaServiceVerificationVersion": 1,
                            "asperaEnvironmentTools": {"readonlyConsumerVersion": 2}})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue({"stage-evidence-reading-v1", "stage-evidence-reading-v2", "public-inference-verification-v1", "readonly-source-consumers-v1", "readonly-source-consumers-v2"}.issubset(json.loads(result.stdout)))

    def test_unknown_keys_and_versions_are_rejected(self):
        self.assertNotEqual(self.read({"asperaStageEvidenceVersion": 5}).returncode, 0)
        self.assertNotEqual(self.read({"asperaAgentRecoveryVersion": 2}).returncode, 0)
        recovery = self.read({"asperaAgentRecoveryVersion": 1})
        self.assertEqual(recovery.returncode, 0, recovery.stderr)
        self.assertIn("agent-recovery-v1", json.loads(recovery.stdout))
        self.assertNotEqual(self.read({"asperaCheckpointProtectionVersion": 2}).returncode, 0)
        result = self.read({"asperaCheckpointProtectionVersion": 1})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("checkpoint-protection-v1", json.loads(result.stdout))
        for value in [None, [], {"version": 2, "formatVersion": "0.1.0"}, {"version": 1, "formatVersion": "0.1.1"},
                      {"version": 1, "formatVersion": "0.1.0", "requirementsVersion": 2},
                      {"version": 1, "formatVersion": "0.1.0", "inferenceVersion": 2},
                      {"version": 1, "formatVersion": "0.1.0", "unknown": 1}]:
            if value is None:
                continue
            with self.subTest(value=value):
                result = self.read({"asperaPlanningTools": value})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Unsupported fixed-release planning tools format", result.stderr)

    def test_checkpoint_evidence_v3_keeps_original_stage_readers_and_requires_save_validation(self):
        result = self.read({"asperaStageEvidenceVersion": 3})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue({"stage-evidence-reading-v1", "stage-evidence-reading-v2", "stage-checkpoint-evidence-v3"}.issubset(json.loads(result.stdout)))

    def test_checkpoint_evidence_v4_requires_native_identity_and_retains_predecessor_capabilities(self):
        result = self.read({"asperaStageEvidenceVersion": 4})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue({"stage-evidence-reading-v1", "stage-evidence-reading-v2", "stage-checkpoint-evidence-v3", "stage-checkpoint-evidence-v4"}.issubset(json.loads(result.stdout)))

    def test_service_lifecycle_requires_the_agent_stop_capability(self):
        result = self.read({"asperaServiceLifecycleVersion": 1})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("inference-service-lifecycle-v1", json.loads(result.stdout))
        self.assertNotEqual(self.read({"asperaServiceLifecycleVersion": 2}).returncode, 0)

    def test_inference_snapshot_requires_a_capable_controller(self):
        result = self.read({"asperaInferenceCheckpointVersion": 1})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("inference-checkpoint-snapshots-v1", json.loads(result.stdout))
        self.assertNotEqual(self.read({"asperaInferenceCheckpointVersion": 2}).returncode, 0)

if __name__ == "__main__":
    unittest.main()
