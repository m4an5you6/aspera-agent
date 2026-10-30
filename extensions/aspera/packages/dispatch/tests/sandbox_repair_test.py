"""Linux CPU checks for owned repair files and supervised exit; no mocked GPU acceptance."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "repair-sandbox.py"
spec = importlib.util.spec_from_file_location("sandbox_repair", SCRIPT)
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


class OwnershipTests(unittest.TestCase):
    def request(self, root):
        return {"version": 1, "serverId": "selected-server", "experimentId": "experiment", "controlRoot": str(root),
                "adoptLegacyControlRoot": False, "mode": "repair", "maxAttempts": 2,
                "probeTimeoutMs": 15000, "cleanupTimeoutMs": 1000, "pollIntervalMs": 20,
                "python": "/usr/bin/python3", "bwrap": "/usr/bin/true", "isolationArgs": ["--unshare-user", "--cap-drop", "ALL"]}

    def test_bootstrap_control_marker_matches_storage_encoding(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "control"
            request = self.request(root)
            repair.own_control_root(request)
            self.assertEqual((root / ".aspera-owner.json").read_text(), '{"version":1,"serverId":"selected-server","kind":"control"}')
            repair.own_control_root(request)

    def test_nonempty_unowned_and_conflicting_control_roots_are_retained(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "user-file").write_text("retained")
            request = self.request(root)
            with self.assertRaisesRegex(RuntimeError, "unowned"):
                repair.own_control_root(request)
            request["adoptLegacyControlRoot"] = True
            repair.own_control_root(request)
            request["serverId"] = "another-server"
            with self.assertRaisesRegex(RuntimeError, "another server"):
                repair.own_control_root(request)
            self.assertEqual((root / "user-file").read_text(), "retained")

    def test_symlink_parent_cannot_receive_program_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); (root / "target").mkdir()
            (root / "link").symlink_to(root / "target", target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "symlink"):
                repair.owned_directory(root / "link" / "tools")
            self.assertFalse((root / "target" / "tools").exists())

    def test_failed_probe_does_not_publish_a_launcher(self):
        with tempfile.TemporaryDirectory() as folder, self.native_fixture(), patch.object(repair, "run_probe", return_value=(1, "", "Operation not permitted")):
            root = Path(folder) / "control"; result = {}
            repair.inspect_or_repair(self.request(root), result)
            self.assertEqual(result["state"], "unavailable")
            self.assertTrue(result["requiresPlatformAction"])
            self.assertFalse(root.exists())

    def native_fixture(self):
        original = Path.read_text
        def read(path, *args, **kwargs):
            return "CapEff: 00200000\n" if str(path) == "/proc/self/status" else original(path, *args, **kwargs)
        return patch.object(Path, "read_text", read)

    def test_repeated_install_reuses_material_and_tampering_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as folder, self.native_fixture(), patch.object(repair, "run_probe", return_value=(0, "CPU probe fixture", "")):
            root = Path(folder); command = root / "preparation" / "operation"; command.mkdir(parents=True)
            request = self.request(root / "control")
            with patch.dict(os.environ, {"ASPERA_PREPARATION_COMMAND_DIRECTORY": str(command)}):
                first = {}; repair.inspect_or_repair(request, first)
                second = {}; repair.inspect_or_repair(request, second)
                self.assertEqual(first["launcher"], second["launcher"])
                self.assertEqual(len(json.loads((command.parent / "sandbox-repair.json").read_text())["operations"]), 1)
                path = Path(first["launcher"]["path"]); path.write_text(path.read_text() + "# changed\n")
                with self.assertRaisesRegex(RuntimeError, "changed"):
                    repair.inspect_or_repair(request, {})
                self.assertTrue(path.read_text().endswith("# changed\n"))


class LifecycleTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("ASPERA_TEST_SANDBOX_ARGV"), "Requires an actual compatible Linux sandbox")
    def test_private_proc_children_preserve_graceful_termination(self):
        argv = json.loads(os.environ["ASPERA_TEST_SANDBOX_ARGV"])
        program = """import signal,subprocess,sys
assert not any(signal.getsignal(s)==signal.SIG_IGN for s in (signal.SIGTERM,signal.SIGINT))
child=subprocess.Popen([sys.executable,'-c',"import time;print('ready',flush=True);time.sleep(60)"],stdout=subprocess.PIPE,text=True)
try:
    assert child.stdout.readline().strip()=='ready'
    child.terminate()
    assert child.wait(timeout=1)==-signal.SIGTERM
finally:
    if child.poll() is None:child.kill();child.wait()
    child.stdout.close()
print('graceful child termination')
"""
        code, stdout, _ = repair.run_probe(argv + ["--", sys.executable, "-B", "-c", program],
            {"probeTimeoutMs": 3000, "cleanupTimeoutMs": 1000, "pollIntervalMs": 10})
        self.assertEqual(code, 0)
        self.assertIn("graceful child termination", stdout)

    def test_parent_death_setup_rejects_an_already_changed_parent(self):
        program = "import importlib.util;spec=importlib.util.spec_from_file_location('repair'," + repr(str(SCRIPT)) + ");module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);module.child_lifetime(0);print('unexpected continuation')"
        result = subprocess.run([sys.executable, "-c", program], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
        self.assertEqual(result.returncode, -9)
        self.assertEqual(result.stdout, b"")

    def test_timeout_with_confirmed_cleanup_retains_a_recoverable_outcome(self):
        with self.assertRaises(repair.ProbeFailure) as outcome:
            repair.run_probe(["/bin/sleep", "10"], {"probeTimeoutMs": 100, "cleanupTimeoutMs": 1000, "pollIntervalMs": 10})
        self.assertTrue(outcome.exception.confirmed)
        self.assertIsNotNone(outcome.exception.code)

    def test_term_resistant_child_is_killed_before_returning_a_receipt(self):
        with self.assertRaises(repair.ProbeFailure) as outcome:
            repair.run_probe(["/bin/sh", "-c", "trap '' TERM; exec sleep 10"], {"probeTimeoutMs": 100, "cleanupTimeoutMs": 100, "pollIntervalMs": 10})
        self.assertTrue(outcome.exception.confirmed)
        self.assertEqual(outcome.exception.code, -9)

    @unittest.skipUnless(os.environ.get("ASPERA_TEST_SANDBOX_ARGV"), "Requires an actual compatible Linux sandbox")
    def test_actual_private_proc_launcher_exits_after_term_then_kill(self):
        argv = json.loads(os.environ["ASPERA_TEST_SANDBOX_ARGV"])
        with self.assertRaises(repair.ProbeFailure) as outcome:
            repair.run_probe(argv + ["--", "/bin/sh", "-c", "trap '' TERM; exec sleep 10"],
                             {"probeTimeoutMs": 100, "cleanupTimeoutMs": 1000, "pollIntervalMs": 10})
        self.assertTrue(outcome.exception.confirmed)
        self.assertEqual(outcome.exception.code, -9)


if __name__ == "__main__":
    unittest.main()
