"""Linux regressions for SSH-independent preparation supervision and cached tools."""
import importlib.util
import contextlib
import hashlib
import io
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile
from unittest import mock

SOURCE = pathlib.Path(os.environ.get("ASPERA_PREPARATION_COMMAND_SOURCE", pathlib.Path(__file__).parent.parent / "scripts/preparation-command.py"))
spec = importlib.util.spec_from_file_location("preparation_command", SOURCE)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


@unittest.skipUnless(sys.platform == "linux", "Linux /proc identities and process groups are required")
class CommandCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="aspera-preparation-command-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name) / "experiment" / "server" / "command"
        self.root.mkdir(parents=True)
        self.request = {"version": 1, "experimentId": "experiment", "serverId": "server", "commandId": "command",
                        "sessionId": "fixture-session", "toolCallId": "fixture-call", "timeoutMs": 5000, "pollIntervalMs": 10,
                        "stopGraceMs": 50, "readTimeoutMs": 500, "cacheDirectory": str(self.root.parent / "cache"), "command": "true"}

    def invoke(self, mode, offset=0):
        result = subprocess.run([sys.executable, "-B", "-I", str(SOURCE), mode, str(self.root), str(offset)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout) if result.stdout else None

    def start(self, command, timeout=5000):
        self.request.update(command=command, timeoutMs=timeout)
        helper.save(self.root / "request.v1.json", self.request)
        self.invoke("start")
        self.addCleanup(self.release)

    def release(self):
        if not (self.root / "request.v1.json").exists():
            return
        self.invoke("stop")
        self.wait()

    def wait(self):
        limit = time.monotonic() + 10
        while time.monotonic() < limit:
            result = self.invoke("read")
            if result["status"].get("finishedAt"):
                return result
            time.sleep(0.01)
        self.fail("Supervisor did not reach a terminal record")

    def test_logs_after_the_ssh_reader_exits_are_retained_with_original_exit(self):
        gate = self.root / "continue"
        self.start("printf 'before\\n'; while [ ! -f '" + str(gate) + "' ]; do sleep .01; done; printf 'after\\n'; printf 'failure\\n' >&2; exit 2")
        limit = time.monotonic() + 5
        while not (self.root / "stdout.log").exists() or "before" not in (self.root / "stdout.log").read_text():
            self.assertLess(time.monotonic(), limit); time.sleep(.01)
        first = self.invoke("read")
        self.assertFalse(first["status"]["exitConfirmed"])
        gate.touch()
        final = self.wait()
        self.assertEqual(final["status"]["exitCode"], 2)
        self.assertTrue(final["status"]["exitConfirmed"])
        self.assertEqual((self.root / "stdout.log").read_text(), "before\nafter\n")
        self.assertEqual((self.root / "stderr.log").read_text(), "failure\n")
        self.assertEqual((self.root / "exited").read_text(), "2\n")

    def test_deadline_stops_the_original_process_group_and_retains_output(self):
        self.start("printf 'download started\\n'; trap '' TERM; sleep 120", timeout=150)
        final = self.wait()["status"]
        self.assertTrue(final["timedOut"])
        self.assertTrue(final["exitConfirmed"])
        self.assertFalse(helper.members(helper.load(self.root / "process.v1.json")))

    def test_cancel_uses_the_same_operation_and_preserves_the_original_deadline(self):
        ready = self.root / "ready"
        self.start("trap 'exit 0' TERM; touch '" + str(ready) + "'; while :; do sleep .02; done")
        limit = time.monotonic() + 5
        while not ready.exists():
            self.assertLess(time.monotonic(), limit); time.sleep(.01)
        deadline = helper.load(self.root / "status.v1.json")["deadline"]
        self.invoke("stop")
        final = self.wait()["status"]
        self.assertTrue(final["cancelled"])
        self.assertTrue(final["exitConfirmed"])
        self.assertEqual(final["exitCode"], 0)
        self.assertEqual(final["deadline"], deadline)

    def test_foreign_experiment_request_is_rejected(self):
        self.request["experimentId"] = "foreign"
        helper.save(self.root / "request.v1.json", self.request)
        result = subprocess.run([sys.executable, "-B", "-I", str(SOURCE), "start", str(self.root)], text=True, capture_output=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("another experiment", result.stderr)
        self.assertFalse((self.root / "status.v1.json").exists())

    def test_pid_reuse_is_not_signalled(self):
        current = helper.process(os.getpid())
        identity = {**current, "bootId": pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip(), "start": str(int(current["start"]) + 1)}
        with mock.patch.object(helper.os, "killpg") as kill:
            with self.assertRaisesRegex(RuntimeError, "PID was reused"):
                helper.members(identity)
            kill.assert_not_called()

    def test_changed_exit_receipt_cannot_establish_a_confirmed_outcome(self):
        self.start("exit 2")
        self.assertTrue(self.wait()["status"]["exitConfirmed"])
        (self.root / "exited").write_text("0\n")
        self.assertFalse(self.invoke("read")["status"]["exitConfirmed"])
        (self.root / "exited").write_text("2\n")

    def test_utf8_and_large_output_survive_pagination_and_repeated_reads(self):
        text = "准备进度α" * 20000
        command = "exec " + sys.executable + " -c " + __import__("shlex").quote("import sys;sys.stdout.write('准备进度α'*20000)")
        self.start(command)
        self.wait()
        rows = []; offset = 0
        while True:
            page = self.invoke("read", offset)
            rows.extend(row for row in page["lines"] if row["stream"] == "stdout")
            offset = page["offset"]
            if not page["hasMore"]:
                break
        self.assertEqual("".join(row["text"] for row in rows), text)
        self.assertEqual([row["seq"] for row in rows], list(range(len(rows))))
        self.assertFalse(self.invoke("read", offset)["lines"])


@unittest.skipUnless(sys.platform == "linux", "Executable wheel fixtures use POSIX shell entrypoints")
class ToolCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="aspera-preparation-material-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.request = {"uvVersion": "0.13.0", "cacheDirectory": str(self.root), "readTimeoutMs": 1000}
        self.cache = self.root / "uv/0.13.0"; self.cache.mkdir(parents=True)
        self.environment = mock.patch.dict(os.environ, ASPERA_PREPARATION_DEADLINE_MS=str(int(time.time() * 1000) + 60000))
        self.environment.start(); self.addCleanup(self.environment.stop)
        from pip._vendor.packaging.tags import sys_tags
        tag = next(sys_tags()); self.filename = "uv-0.13.0-" + str(tag) + ".whl"
        content = io.BytesIO()
        with zipfile.ZipFile(content, "w") as archive:
            archive.writestr("uv-0.13.0.dist-info/METADATA", "Name: uv\nVersion: 0.13.0\n")
            for name in ["uv", "uvx"]:
                archive.writestr("uv-0.13.0.data/scripts/" + name, "#!/bin/sh\nprintf 'uv 0.13.0\\n'\n")
        self.wheel = content.getvalue()
        self.metadata = {"format": 1, "name": "uv", "version": "0.13.0", "filename": self.filename,
                         "sha256": hashlib.sha256(self.wheel).hexdigest(), "size": len(self.wheel),
                         "url": "https://files.pythonhosted.org/fixture/" + self.filename}
        helper.save(self.cache / "material.v1.json", self.metadata)

    def prepare(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            helper.prepare_uv(self.root, self.request)
        return json.loads(output.getvalue().splitlines()[-1])

    def test_complete_material_and_second_ready_tool_need_no_download(self):
        (self.cache / self.filename).write_bytes(self.wheel)
        with mock.patch.object(helper.urllib.request, "urlopen", side_effect=AssertionError("No download expected")):
            first = self.prepare(); second = self.prepare()
        self.assertEqual(first["downloadBytes"], 0)
        self.assertEqual(second["downloadBytes"], 0)
        self.assertTrue(second["reused"])
        self.assertEqual(first["pathEntries"], second["pathEntries"])

    def test_complete_partial_material_is_verified_without_a_range_request(self):
        (self.cache / (self.filename + ".part")).write_bytes(self.wheel)
        with mock.patch.object(helper.urllib.request, "urlopen", side_effect=AssertionError("No download expected")):
            self.assertEqual(self.prepare()["downloadBytes"], 0)

    def test_partial_material_resumes_and_verifies_the_complete_digest(self):
        offset = 37; (self.cache / (self.filename + ".part")).write_bytes(self.wheel[:offset])
        response = io.BytesIO(self.wheel[offset:]); response.status = 206; response.headers = {"Content-Range": "bytes 37-" + str(len(self.wheel) - 1) + "/" + str(len(self.wheel))}
        with mock.patch.object(helper.urllib.request, "urlopen", return_value=response) as download:
            result = self.prepare()
        self.assertEqual(download.call_args.args[0].get_header("Range"), "bytes=37-")
        self.assertEqual(result["downloadBytes"], len(self.wheel) - offset)
        self.assertEqual((self.cache / self.filename).read_bytes(), self.wheel)

    def test_incompatible_cached_tags_are_rejected_before_download(self):
        helper.save(self.cache / "material.v1.json", {**self.metadata, "filename": "uv-0.13.0-py2-none-win32.whl"})
        with mock.patch.object(helper.urllib.request, "urlopen") as download:
            with self.assertRaisesRegex(RuntimeError, "incompatible"):
                self.prepare()
            download.assert_not_called()

    def test_existing_verified_version_is_used_before_material_acquisition(self):
        (self.cache / self.filename).write_bytes(self.wheel)
        ready = self.prepare(); self.request["uvPath"] = str(pathlib.Path(ready["pathEntries"][0]) / "uv")
        with mock.patch.object(helper.urllib.request, "urlopen", side_effect=AssertionError("No download expected")):
            self.assertEqual(self.prepare()["downloadBytes"], 0)


if __name__ == "__main__":
    unittest.main()
