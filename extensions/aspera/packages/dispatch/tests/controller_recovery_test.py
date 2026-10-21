"""Offline recovery keeps original records and requires complete process/resource evidence."""
import importlib.util
import json
import pathlib
import tempfile
import unittest
import uuid
import os
import subprocess
import time
import fcntl
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts/controller-recovery.py"
spec = importlib.util.spec_from_file_location("controller_recovery", SCRIPT)
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = pathlib.Path(self.folder.name)
        self.server = str(uuid.uuid4()); self.experiment = str(uuid.uuid4()); self.operation = str(uuid.uuid4())
        (self.root / "state").mkdir(mode=0o700)
        (self.root / ".aspera-owner.json").write_text(json.dumps({"version": 1, "serverId": self.server, "kind": "control"}))
        self.request = {"root": str(self.root), "role": "node", "serverId": self.server, "mode": "inspect",
                        "basePort": 0, "port": 0, "timeoutSeconds": 1, "release": str(self.root / "release"),
                        "runRoot": str(self.root / "runs" / self.experiment), "operationId": self.operation,
                        "directory": str(self.root / "runs" / self.experiment / "controller-repairs/node" / self.operation)}
        self.request["allowedExperimentIds"] = [self.experiment]
        self.request["allowedServerIds"] = [self.server]
        self.request["allowedSubmissions"] = []
        self.server_value = {"id": self.server, "name": "CPU fixture", "remoteRoot": str(self.root)}
        run = self.root / "runs" / self.experiment
        run.mkdir(parents=True, mode=0o700)
        (run / ".aspera-owner.json").write_text(json.dumps({"version": 1, "serverId": self.server, "experimentId": self.experiment}))
        a = patch.object(recovery, "processes", return_value=([], [])); a.start(); self.addCleanup(a.stop)
        b = patch.object(recovery, "listening", return_value=False); b.start(); self.addCleanup(b.stop)

    def record(self, role, unit, table, key, row):
        if table == "commands": row = {"commandId": key.split("_", 1)[1], **row}
        if table == "allocations": row = {"node": {"server": self.server_value}, "deploymentId": "a" * 64, **row}
        if table == "experiments":
            submission = {"coordinator": self.server_value, "deploymentId": "a" * 64, **row["submission"]}
            if "nodes" in submission:
                submission["nodes"] = [{**node, "server": {**self.server_value, **node["server"]}} for node in submission["nodes"]]
            row = {"payloadHash": "a" * 64, **row, "submission": submission}
            self.request["allowedSubmissions"] = [{"submission": submission, "payloadHash": row["payloadHash"]}]
        folder = self.root / "state" / (role + "-home") / "storages" / unit / table
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        file = folder / (key + ".json")
        file.write_text(json.dumps({"version": 4, "record": row})); return file

    def begin(self):
        self.request["expectedDigest"] = recovery.run(self.request)["digest"]
        self.request["mode"] = "begin"
        return recovery.run(self.request)

    def test_empty_controller_can_be_fenced_and_completed_idempotently(self):
        value = self.begin(); self.assertEqual(value["phase"], "fenced")
        self.assertEqual(recovery.run(self.request), value)
        self.request["mode"] = "complete"
        self.assertTrue(recovery.run(self.request)["completed"])
        self.assertTrue(recovery.run(self.request)["completed"])
        self.assertFalse((self.root / "state/controller-recovery.json").exists())

    def test_unconfirmed_command_prevents_recovery(self):
        self.record("node", "aspera_node", "commands", self.experiment + "_cmd", {"experimentId": self.experiment, "released": False})
        value = recovery.run(self.request)
        self.assertEqual(value["state"], "occupied")
        self.assertEqual(value["blockers"][0]["kind"], "command")

    def test_releases_allocation_only_after_all_commands_are_released(self):
        file = self.record("node", "aspera_node", "allocations", self.experiment, {"experimentId": self.experiment, "released": False, "releasing": True})
        self.record("node", "aspera_node", "commands", self.experiment + "_cmd", {"experimentId": self.experiment, "released": True})
        self.record("coordinator", "aspera_queue", "experiments", self.experiment,
                    {"state": "failed", "resourcesReleased": False, "revision": 2, "services": [],
                     "submission": {"experimentId": self.experiment, "nodes": [{"server": self.server_value}]}})
        self.begin()
        self.assertTrue(json.loads(file.read_text())["record"]["released"])
        self.assertEqual(json.loads(file.read_text())["version"], 4)

    def test_preserves_terminal_result_when_confirming_local_task_release(self):
        self.record("node", "aspera_node", "allocations", self.experiment, {"experimentId": self.experiment, "released": False})
        row = {"state": "blocked", "detail": "Original measured failure", "resourcesReleased": False, "revision": 9,
               "services": [], "submission": {"experimentId": self.experiment, "nodes": [{"server": {"remoteRoot": str(self.root)}}]}}
        file = self.record("coordinator", "aspera_queue", "experiments", self.experiment, row)
        self.begin(); updated = json.loads(file.read_text())["record"]
        self.assertEqual(updated["detail"], row["detail"]); self.assertEqual(updated["state"], "blocked")
        self.assertTrue(updated["resourcesReleased"]); self.assertEqual(updated["revision"], 10)
        receipt = json.loads((self.root / "runs" / self.experiment / "interruption.v1.json").read_text())
        self.assertEqual(receipt["result"], updated); self.assertEqual(receipt["phase"], "released")

    def test_settles_exited_running_experiment_without_inventing_training_success(self):
        self.record("node", "aspera_node", "allocations", self.experiment, {"experimentId": self.experiment, "released": False})
        self.record("node", "aspera_node", "commands", self.experiment + "_dryrun", {"experimentId": self.experiment, "released": True})
        row = {"state": "running", "resourcesReleased": False, "revision": 9, "services": [], "payloadHash": "a" * 64,
               "startedAt": 100, "sessionId": "original-session", "progress": {"phase": "dry run"},
               "submission": {"experimentId": self.experiment, "nodes": [{"server": {"id": self.server, "remoteRoot": str(self.root)}}]}}
        file = self.record("coordinator", "aspera_queue", "experiments", self.experiment, row)
        self.begin(); updated = json.loads(file.read_text())["record"]
        self.assertEqual(updated["state"], "interrupted")
        self.assertTrue(updated["resourcesReleased"]); self.assertEqual(updated["revision"], 10)
        self.assertEqual(updated["sessionId"], row["sessionId"])
        self.assertEqual(updated["progress"], row["progress"])

    def test_queued_or_multi_node_unreleased_task_is_not_restarted_or_settled(self):
        for state in ["queued", "running", "serving"]:
            self.record("coordinator", "aspera_queue", "experiments", self.experiment,
                        {"state": state, "resourcesReleased": False, "services": [], "submission": {"experimentId": self.experiment}})
            self.assertEqual(recovery.run(self.request)["state"], "occupied")

    def test_service_listener_or_unconfirmed_command_blocks_recovery(self):
        self.record("node", "aspera_node", "services", "service", {"experimentId": self.experiment, "commandId": "cmd", "released": False, "port": 0})
        self.assertEqual(recovery.run(self.request)["state"], "occupied")
        self.record("node", "aspera_node", "commands", self.experiment + "_cmd", {"experimentId": self.experiment, "released": True})
        with patch.object(recovery, "listening", return_value=True):
            self.assertEqual(recovery.run(self.request)["state"], "occupied")

    def test_confirmed_service_release_preserves_node_and_queue_failure_results(self):
        self.record("node", "aspera_node", "allocations", self.experiment, {"experimentId": self.experiment, "released": True})
        self.record("node", "aspera_node", "commands", self.experiment + "_cmd", {"experimentId": self.experiment, "released": True})
        service = {"id": "service", "experimentId": self.experiment, "commandId": "cmd", "port": 0,
                   "released": False, "state": "failed", "detail": "Original service failure"}
        file = self.record("node", "aspera_node", "services", "service", service)
        row = {"state": "failed", "resourcesReleased": False, "revision": 9, "services": [service],
               "submission": {"experimentId": self.experiment, "nodes": [{"server": {"remoteRoot": str(self.root)}}]}}
        task = self.record("coordinator", "aspera_queue", "experiments", self.experiment, row)
        self.begin()
        for restored in [json.loads(file.read_text())["record"], json.loads(task.read_text())["record"]["services"][0]]:
            self.assertTrue(restored["released"])
            self.assertEqual(restored["state"], "failed")
            self.assertEqual(restored["detail"], "Original service failure")

    def test_live_agent_or_unreadable_process_prevents_offline_claim(self):
        with patch.object(recovery, "processes", return_value=([{"pid": 123, "role": "agent", "start": "1"}], [])):
            self.assertEqual(recovery.run(self.request)["state"], "active")
        with patch.object(recovery, "processes", return_value=([], [123])):
            self.assertEqual(recovery.run(self.request)["state"], "occupied")

    def test_changed_state_and_foreign_operation_are_rejected(self):
        digest = recovery.run(self.request)["digest"]
        self.record("node", "aspera_node", "allocations", self.experiment, {"experimentId": self.experiment, "released": True})
        self.request.update(mode="begin", expectedDigest=digest)
        with self.assertRaisesRegex(RuntimeError, "changed"):
            recovery.run(self.request)
        self.request["mode"] = "inspect"; self.begin()
        foreign = {**self.request, "operationId": str(uuid.uuid4())}
        foreign["directory"] = str(pathlib.Path(self.request["directory"]).parent / foreign["operationId"])
        with self.assertRaisesRegex(RuntimeError, "Another recovery"):
            recovery.run(foreign)

    def test_malformed_or_symlinked_records_do_not_become_empty_storage(self):
        file = self.record("node", "aspera_node", "commands", self.experiment + "_bad", {"experimentId": self.experiment, "released": True})
        file.write_text('{"version":99,"record":{}}')
        with self.assertRaisesRegex(RuntimeError, "Unsupported"):
            recovery.run(self.request)
        file.unlink(); file.symlink_to(self.root / ".aspera-owner.json")
        with self.assertRaisesRegex(RuntimeError, "symbolic"):
            recovery.run(self.request)

    def test_counterpart_admission_is_fenced_and_restored_by_the_same_identity(self):
        calls = []
        def endpoint(request, role, path, body=None):
            calls.append((role, path, body))
            if path.endswith("health"):
                return {"features": ["controller-maintenance-v1"], "controller": {"role": "coordinator", "root": str(self.root), "bootId": "same-controller", "policyDigest": "same-policy"}}
            return {}
        with patch.object(recovery, "listening", side_effect=lambda port, timeout: port == 1), patch.object(recovery, "endpoint", side_effect=endpoint):
            self.begin(); self.request["mode"] = "complete"; recovery.run(self.request)
        self.assertEqual([path for _, path, _ in calls], ["/aspera/v1/health", "/aspera/v1/maintenance-begin", "/aspera/v1/maintenance-cancel"])
        self.assertEqual(calls[-1][2]["operationId"], self.operation)

    def test_launch_in_progress_prevents_recovery(self):
        (self.root / "state/coordinator.launch").mkdir()
        self.assertEqual(recovery.run(self.request)["state"], "occupied")

    def test_original_worker_terminal_outcome_is_retained(self):
        self.record("node", "aspera_node", "allocations", self.experiment, {"experimentId": self.experiment, "released": True})
        file = self.record("coordinator", "aspera_queue", "experiments", self.experiment,
                           {"state": "running", "resourcesReleased": False, "revision": 2, "services": [], "sessionId": "original",
                            "submission": {"experimentId": self.experiment, "nodes": [{"server": self.server_value}]}})
        run = self.root / "runs" / self.experiment
        (run / "outcome.json").write_text(json.dumps({"state": "blocked", "detail": "Recorded original failure"}))
        (run / "started.json").write_text(json.dumps({"sessionId": "original"}))
        self.begin()
        row = json.loads(file.read_text())["record"]
        self.assertEqual(row["state"], "blocked"); self.assertEqual(row["detail"], "Recorded original failure")
        self.assertEqual(json.loads((run / "interruption.v1.json").read_text())["result"], row)

    def test_foreign_submission_or_directory_marker_blocks_auto_closure(self):
        self.record("node", "aspera_node", "allocations", self.experiment, {"experimentId": self.experiment, "released": True})
        self.record("coordinator", "aspera_queue", "experiments", self.experiment,
                    {"state": "running", "resourcesReleased": False, "revision": 2, "services": [],
                     "submission": {"experimentId": self.experiment, "nodes": [{"server": self.server_value}]}})
        self.request["allowedSubmissions"][0]["payloadHash"] = "b" * 64
        self.assertEqual(recovery.run(self.request)["state"], "occupied")
        self.request["allowedSubmissions"][0]["payloadHash"] = "a" * 64
        (self.root / "runs" / self.experiment / ".aspera-owner.json").unlink()
        with self.assertRaisesRegex(RuntimeError, "ownership"):
            recovery.run(self.request)

    def test_interruption_fence_prevents_controller_recovery(self):
        folder = self.root / "state/interruption-fences"; folder.mkdir(mode=0o700)
        (folder / (self.experiment + ".json")).write_text(json.dumps({"experimentId": self.experiment}))
        self.assertEqual(recovery.run(self.request)["state"], "occupied")

    def test_unknown_terminal_task_cannot_release_allocation_outside_preparation_authorization(self):
        self.record("node", "aspera_node", "allocations", self.experiment, {"experimentId": self.experiment, "released": True})
        file = self.record("coordinator", "aspera_queue", "experiments", self.experiment,
                           {"state": "failed", "resourcesReleased": False, "revision": 2, "services": [],
                            "submission": {"experimentId": self.experiment, "nodes": [{"server": self.server_value}]}})
        before = file.read_bytes(); self.request["allowedExperimentIds"] = []
        self.assertEqual(recovery.run(self.request)["state"], "occupied")
        self.assertEqual(file.read_bytes(), before)

    def test_node_only_release_cannot_claim_whole_multi_node_or_foreign_scope_release(self):
        self.record("node", "aspera_node", "allocations", self.experiment, {"experimentId": self.experiment, "released": False})
        other = {**self.server_value, "id": str(uuid.uuid4()), "name": "Unselected node", "remoteRoot": "/other-root"}
        self.record("coordinator", "aspera_queue", "experiments", self.experiment,
                    {"state": "running", "resourcesReleased": False, "revision": 2, "services": [],
                     "submission": {"experimentId": self.experiment, "nodes": [{"server": self.server_value}, {"server": other}]}})
        value = recovery.run(self.request)
        self.assertEqual(value["state"], "occupied")
        self.assertIn("Unselected node", json.dumps(value["blockers"]))
        self.request["allowedServerIds"].append(other["id"])
        self.assertEqual(recovery.run(self.request)["state"], "occupied")


    def test_deleted_task_discovery_is_scoped_and_keeps_the_original_records_unchanged(self):
        allocation = self.record("node", "aspera_node", "allocations", self.experiment, {"experimentId": self.experiment, "released": False})
        task = self.record("coordinator", "aspera_queue", "experiments", self.experiment,
                           {"state": "running", "resourcesReleased": False, "revision": 2, "services": [],
                            "submission": {"protocol": 4, "experimentId": self.experiment, "nodes": [{"server": self.server_value}]}})
        original = [allocation.read_bytes(), task.read_bytes()]
        self.request.update(mode="discover", experimentIds=[self.experiment], allowedExperimentIds=[], allowedSubmissions=[])
        found = recovery.run(self.request)["records"]
        self.assertEqual([row["submission"]["experimentId"] for row in found], [self.experiment])
        self.assertEqual(original, [allocation.read_bytes(), task.read_bytes()])
        self.request["experimentIds"] = [str(uuid.uuid4())]
        self.assertEqual(recovery.run(self.request)["records"], [])
        self.request["mode"] = "inspect"
        self.assertEqual(recovery.run(self.request)["state"], "occupied")

    def test_deleted_task_discovery_refuses_a_different_node_allocation(self):
        self.record("node", "aspera_node", "allocations", self.experiment,
                    {"experimentId": self.experiment, "released": False, "deploymentId": "b" * 64})
        self.record("coordinator", "aspera_queue", "experiments", self.experiment,
                    {"state": "running", "resourcesReleased": False, "revision": 2, "services": [],
                     "submission": {"protocol": 4, "experimentId": self.experiment, "nodes": [{"server": self.server_value}]}})
        self.request.update(mode="discover", experimentIds=[self.experiment])
        with self.assertRaisesRegex(RuntimeError, "allocation identity differ"):
            recovery.run(self.request)


class InterruptionTests(unittest.TestCase):
    setUp = RecoveryTests.setUp
    record = RecoveryTests.record
    def create_task(self, stop=True, state="running"):
        self.allocation = self.record("node", "aspera_node", "allocations", self.experiment, {"experimentId": self.experiment, "released": False})
        self.task = self.record("coordinator", "aspera_queue", "experiments", self.experiment,
                               {"state": state, "resourcesReleased": False, "revision": 2, "services": [],
                                "submission": {"experimentId": self.experiment, "nodes": [{"server": self.server_value}]}})
        self.request.update(server=self.server_value, submission=json.loads(self.task.read_text())["record"]["submission"], cleanupSeconds=0.1)
        self.request["status"] = {"version": 1, "experimentId": self.experiment, "operationId": self.operation,
                                  "submissionHash": "a" * 64, "reason": "user" if stop else "controller-recovery", "stopRequested": stop,
                                  "phase": "verifying", "startedAt": 1, "updatedAt": 1,
                                  "nodes": [{"serverId": self.server, "name": "CPU fixture", "phase": "verifying"}]}

    def call(self, mode):
        self.request["mode"] = "interrupt-inspect"
        self.request["expectedDigest"] = recovery.run(self.request)["digest"]
        self.request["mode"] = "interrupt-" + mode
        return recovery.run(self.request)

    def finish(self):
        self.call("fence"); self.call("settle")
        self.request["status"]["nodes"][0]["phase"] = "released"
        result = self.call("complete")
        self.request["status"] = result["status"]
        self.call("publish"); self.call("unfence")
        self.assertTrue(self.call("unfence")["released"])
        return result["record"]

    def test_manual_interruption_releases_only_its_task_and_preserves_files(self):
        self.create_task(); file = self.root / "runs" / self.experiment / "agent.log"; file.write_text("original log")
        result = self.finish()
        self.assertEqual(result["state"], "cancelled"); self.assertTrue(result["resourcesReleased"])
        self.assertEqual(file.read_text(), "original log")
        self.assertTrue(json.loads(self.allocation.read_text())["record"]["released"])

    def test_automatic_interruption_preserves_pending_tasks_and_original_results(self):
        self.create_task(False, "queued")
        with self.assertRaisesRegex(RuntimeError, "explicit user"):
            self.call("fence")
        self.assertFalse((self.root / "state/interruption-fences" / (self.experiment + ".json")).exists())
        self.request["status"]["stopRequested"] = True
        self.assertEqual(self.finish()["state"], "cancelled")

    def test_unified_settlement_releases_36_drained_commands_and_retains_training_files(self):
        self.create_task(stop=False)
        run = self.root / "runs" / self.experiment
        retained = [run / name for name in ["environment/marker", "models/weights", "logs/train.log"]]
        for file in retained:
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b"original retained content\n")
        for index in range(36):
            self.record("node", "aspera_node", "commands", self.experiment + "_command" + str(index),
                        {"experimentId": self.experiment, "released": True, "state": "failed"})
        result = self.finish()
        self.assertEqual(result["state"], "interrupted")
        self.assertTrue(result["resourcesReleased"])
        self.assertTrue(json.loads(self.allocation.read_text())["record"]["released"])
        self.assertTrue(all(file.read_bytes() == b"original retained content\n" for file in retained))

    def test_terminal_failure_is_not_replaced_by_user_cancel(self):
        self.create_task(True, "failed")
        raw = json.loads(self.task.read_text()); raw["record"]["detail"] = "Original failure"; self.task.write_text(json.dumps(raw))
        result = self.finish(); self.assertEqual(result["state"], "failed"); self.assertEqual(result["detail"], "Original failure")

    def test_missing_node_and_stale_digest_prevent_release(self):
        self.create_task(); self.request["status"]["nodes"] = []
        with self.assertRaisesRegex(RuntimeError, "omits"):
            self.call("fence")
        self.request["status"]["nodes"] = [{"serverId": self.server, "phase": "verifying"}]
        self.call("fence"); self.request["expectedDigest"] = "b" * 64; self.request["mode"] = "interrupt-settle"
        with self.assertRaisesRegex(RuntimeError, "changed"):
            recovery.run(self.request)

    def test_legacy_command_without_identity_and_reused_pid_remain_held(self):
        self.create_task(); self.record("node", "aspera_node", "commands", self.experiment + "_cmd", {"experimentId": self.experiment, "state": "running", "released": False})
        self.call("fence")
        with self.assertRaisesRegex(RuntimeError, "unconfirmed"):
            self.call("settle")
        identity = self.root / "runs" / self.experiment / "process-identities/cmd.v1.json"; identity.parent.mkdir(mode=0o700)
        identity.write_text(json.dumps({"version": 1, "experimentId": self.experiment, "serverId": self.server, "commandId": "cmd",
                                       "pid": os.getpid(), "group": os.getpgrp(), "start": "0", "hostBootId": pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
                                       "deploymentId": "a" * 64, "controlRoot": str(self.root)}))
        with self.assertRaisesRegex(RuntimeError, "PID was reused"):
            self.call("inspect")

    @unittest.skipUnless(hasattr(os, "pidfd_open"), "This Linux Python build has no pidfd_open")
    def test_real_owned_command_is_stopped_and_unknown_exit_code_remains_unknown(self):
        self.create_task()
        wrapper = SCRIPT.parents[2] / "runtime/scripts/owned-command.py"
        run = self.root / "runs" / self.experiment; identity = run / "process-identities/cmd.v1.json"
        binding = {"experimentId": self.experiment, "serverId": self.server, "commandId": "cmd", "deploymentId": "a" * 64, "controlRoot": str(self.root)}
        process = subprocess.Popen([os.sys.executable, str(wrapper), str(identity), json.dumps(binding), "sleep", "60"], cwd=run, start_new_session=True)
        def cleanup():
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
        self.addCleanup(cleanup)
        deadline = time.monotonic() + 5
        while not identity.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(identity.exists())
        file = self.record("node", "aspera_node", "commands", self.experiment + "_cmd", {"experimentId": self.experiment, "released": False, "state": "running", "exitCode": None})
        self.call("fence"); self.assertFalse(self.call("inspect")["commandsReady"])
        self.call("stop"); process.wait(timeout=5); result = self.finish()
        self.assertEqual(result["state"], "cancelled"); command = json.loads(file.read_text())["record"]
        self.assertTrue(command["released"]); self.assertIsNone(command["exitCode"])

    def test_service_listener_and_unreadable_processes_prevent_mutation(self):
        self.create_task(); self.record("node", "aspera_node", "commands", self.experiment + "_cmd", {"experimentId": self.experiment, "released": True})
        self.record("node", "aspera_node", "services", "s", {"experimentId": self.experiment, "commandId": "cmd", "state": "healthy", "port": 0, "released": False})
        self.call("fence")
        with patch.object(recovery, "listening", return_value=True), self.assertRaisesRegex(RuntimeError, "unconfirmed"):
            self.call("settle")
        with patch.object(recovery, "task_processes", return_value=([], [], [123])), self.assertRaisesRegex(RuntimeError, "identities"):
            self.call("stop")

    def test_invalid_boot_identity_does_not_confirm_an_original_command_exit(self):
        self.create_task()
        self.record("node", "aspera_node", "commands", self.experiment + "_cmd", {"experimentId": self.experiment, "state": "running", "released": False})
        identity = self.root / "runs" / self.experiment / "process-identities/cmd.v1.json"; identity.parent.mkdir(mode=0o700)
        identity.write_text(json.dumps({"version": 1, "experimentId": self.experiment, "serverId": self.server, "commandId": "cmd",
                                       "pid": 999999, "group": 999999, "start": "1", "hostBootId": "",
                                       "deploymentId": "a" * 64, "controlRoot": str(self.root)}))
        self.assertFalse(self.call("inspect")["commandsReady"])
        self.call("fence")
        with self.assertRaisesRegex(RuntimeError, "unconfirmed"):
            self.call("settle")
        self.assertFalse(json.loads(self.allocation.read_text())["record"]["released"])

    def test_exited_leader_cannot_authorize_stopping_an_unconfirmed_surviving_group(self):
        self.create_task()
        wrapper = SCRIPT.parents[2] / "runtime/scripts/owned-command.py"
        run = self.root / "runs" / self.experiment; identity = run / "process-identities/cmd.v1.json"; child_file = run / "child.pid"
        binding = {"experimentId": self.experiment, "serverId": self.server, "commandId": "cmd", "deploymentId": "a" * 64, "controlRoot": str(self.root)}
        child_code = "import subprocess,pathlib; p=subprocess.Popen(['sleep','60'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); pathlib.Path(" + repr(str(child_file)) + ").write_text(str(p.pid))"
        process = subprocess.Popen([os.sys.executable, str(wrapper), str(identity), json.dumps(binding), os.sys.executable, "-c", child_code], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        process.wait(timeout=5)
        self.assertEqual(process.returncode, 0)
        child = int(child_file.read_text()); base = pathlib.Path("/proc") / str(child); start = (base / "stat").read_text().rsplit(")", 1)[1].split()[19]
        def cleanup_child():
            if base.exists() and (base / "stat").read_text().rsplit(")", 1)[1].split()[19] == start:
                os.kill(child, 9)
        self.addCleanup(cleanup_child)
        self.record("node", "aspera_node", "commands", self.experiment + "_cmd", {"experimentId": self.experiment, "state": "running", "released": False})
        facts = self.call("inspect")
        self.assertFalse(facts["commandsReady"]); self.assertEqual(facts["commands"], [])
        self.assertIn("group ownership", " ".join(facts["blockers"]))
        self.call("fence")
        with self.assertRaisesRegex(RuntimeError, "cannot authorize"):
            self.call("stop")
        self.assertTrue(base.exists())

    def test_listener_change_after_inspection_rejects_the_saved_release_digest(self):
        self.create_task()
        self.record("node", "aspera_node", "commands", self.experiment + "_cmd", {"experimentId": self.experiment, "released": True})
        self.record("node", "aspera_node", "services", "s", {"experimentId": self.experiment, "commandId": "cmd", "state": "stopped", "port": 0, "released": True})
        self.call("fence"); self.call("inspect"); self.request["mode"] = "interrupt-settle"
        with patch.object(recovery, "listening", return_value=True), self.assertRaisesRegex(RuntimeError, "changed"):
            recovery.run(self.request)
        self.assertFalse(json.loads(self.allocation.read_text())["record"]["released"])

    def test_pending_command_launch_rechecks_the_interruption_fence_under_the_shared_lock(self):
        self.create_task()
        wrapper = SCRIPT.parents[2] / "runtime/scripts/owned-command.py"
        run = self.root / "runs" / self.experiment; identity = run / "process-identities/cmd.v1.json"
        binding = {"experimentId": self.experiment, "serverId": self.server, "commandId": "cmd", "deploymentId": "a" * 64, "controlRoot": str(self.root)}
        with open(self.root / "state/controller-admission.lock", "a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            process = subprocess.Popen([os.sys.executable, str(wrapper), str(identity), json.dumps(binding), "true"], start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            def cleanup():
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=5)
            self.addCleanup(cleanup)
            deadline = time.monotonic() + 5
            waiting = pathlib.Path("/proc") / str(process.pid) / "wchan"
            while waiting.exists() and "lock" not in waiting.read_text() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertIsNone(process.poll()); self.assertIn("lock", waiting.read_text()); self.assertFalse(identity.exists())
            fence = self.root / "state/interruption-fences" / (self.experiment + ".json")
            fence.parent.mkdir(mode=0o700); fence.write_text("{}")
            fcntl.flock(handle, fcntl.LOCK_UN)
        output, error = process.communicate(timeout=5)
        self.assertNotEqual(process.returncode, 0); self.assertIn(b"admission is fenced", error); self.assertEqual(output, b"")
        self.assertFalse(identity.exists())


if __name__ == "__main__":
    unittest.main()
