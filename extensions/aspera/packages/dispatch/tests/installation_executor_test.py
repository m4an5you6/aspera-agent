"""CPU-only checks exercise the shipped Linux installer, without SSH, APIs or GPUs."""
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "install-release.py"
spec = importlib.util.spec_from_file_location("installer", SCRIPT)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InputTests(unittest.TestCase):
    def test_repeated_retry_messages_do_not_count_as_progress(self):
        counters = {"bytes": 0, "packages": 0}
        downloaded, imported = {}, set()
        self.assertFalse(installer.progress_event('{"name":"pnpm:retry","message":"still alive"}', counters, downloaded, imported))
        event = json.dumps({"name": "pnpm:fetching-progress", "packageId": "fixed@1", "downloaded": 4096})
        self.assertTrue(installer.progress_event(event, counters, downloaded, imported))
        self.assertFalse(installer.progress_event(event, counters, downloaded, imported))
        self.assertEqual(counters["bytes"], 4096)

    def test_sources_and_redirects_keep_https_and_exclude_credentials(self):
        for url in ("http://example.test", "https://user:secret@example.test", "https://example.test/?token=secret"):
            with self.assertRaises(ValueError):
                installer.source_url(url)
        with self.assertRaises(ValueError):
            installer.HttpsRedirect().redirect_request(None, None, 302, "", {}, "http://example.test")

    def test_archive_rejects_links_and_parent_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            for name, kind in (("../outside", tarfile.REGTYPE), ("escape", tarfile.SYMTYPE)):
                archive = root / "unsafe.tar"
                with tarfile.open(archive, "w") as output:
                    entry = tarfile.TarInfo(name); entry.type = kind; entry.linkname = "/tmp"
                    output.addfile(entry)
                with self.assertRaises(ValueError):
                    installer.extract(archive, root / "stage")

    def test_child_environment_does_not_forward_account_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            config = {"directory": directory, "cache": str(root / "cache"),
                      "sources": {"npm": "https://mirror.example.test", "nodeHeaders": "https://nodejs.org/download/release"}}
            with patch.dict(os.environ, {"NPM_TOKEN": "secret", "npm_config__authToken": "secret", "HTTPS_PROXY": "https://user:secret@proxy", "DEEPSEEK_API_KEY": "secret"}):
                env = installer.sanitized_environment(config, root)
            self.assertFalse(any("secret" in value for value in env.values()))
            self.assertEqual(env["npm_config_strict_ssl"], "true")
            self.assertEqual(pathlib.Path(env["npm_config_userconfig"]).read_text(), "")

    def test_headers_use_official_checksum_and_reuse_verified_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); payload = io.BytesIO()
            with tarfile.open(fileobj=payload, mode="w:gz") as output:
                entry = tarfile.TarInfo("node-v22.23.3/include/node/node.h"); entry.size = 4
                output.addfile(entry, io.BytesIO(b"node"))
            data = payload.getvalue(); expected = hashlib.sha256(data).hexdigest()
            config = {"cache": directory, "sources": {"nodeHeaders": "https://mirror.example.test"}, "idleTimeoutMs": 1000}
            def fetch(url, *args):
                return (expected + "  node-v22.23.3-headers.tar.gz\n").encode() if "SHASUMS256" in url else data
            with patch.object(installer.subprocess, "check_output", return_value=b"v22.23.3\n"), patch.object(installer, "fetch", side_effect=fetch) as reader:
                env = {}; installer.headers(config, env, installer.now() + 5000, lambda _size: None)
                installer.headers(config, env, installer.now() + 5000, lambda _size: None)
                self.assertEqual(len([call for call in reader.call_args_list if "headers.tar.gz" in call.args[0]]), 1)
                self.assertTrue(pathlib.Path(env["npm_config_nodedir"], "include/node/node.h").is_file())
            with patch.object(installer.subprocess, "check_output", return_value=b"v22.23.3\n"), patch.object(installer, "fetch", side_effect=lambda url, *args: b"0" * 64 + b"  node-v22.23.3-headers.tar.gz\n" if "SHASUMS256" in url else data):
                with self.assertRaisesRegex(ValueError, "integrity"):
                    installer.headers(config, {}, installer.now() + 5000, lambda _size: None)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux process identities and pipe monitoring")
class ProcessTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="aspera-installer-test-")
        self.root = pathlib.Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)
        self.bin = self.root / "bin"; self.bin.mkdir()
        self.archive = self.root / "release.tar"
        manifest = json.dumps({"version": 1, "deploymentId": "a" * 64, "dsh": "0.2.0-rc.2", "extension": "0.1.1"}).encode()
        with tarfile.open(self.archive, "w") as output:
            entry = tarfile.TarInfo("aspera-release.json"); entry.size = len(manifest)
            output.addfile(entry, io.BytesIO(manifest))

    def config(self, idle=1200, total=10000):
        directory = self.root / ("attempt-" + str(time.time_ns())); directory.mkdir()
        return {"version": 1, "attemptId": directory.name, "experimentId": "experiment", "serverId": "node",
                "directory": str(directory), "archive": str(self.archive), "archiveHash": hashlib.sha256(self.archive.read_bytes()).hexdigest(),
                "digest": "a" * 64, "release": str(self.root / "release"), "stage": str(self.root / "release.building-v1"),
                "cache": str(self.root / "cache"), "pathEntries": [str(self.bin)], "deadline": installer.now() + total,
                "idleTimeoutMs": idle, "sampleIntervalMs": 50,
                "sources": {"npm": "https://registry.npmjs.org/", "nodeHeaders": "https://nodejs.org/download/release"}}

    def pnpm(self, behavior):
        success = '''
stage = pathlib.Path.cwd()
(stage / 'checkpoint').write_text('retained')
deps = stage / 'node_modules/@deepseek-ai/dsh/lib'; deps.mkdir(parents=True, exist_ok=True)
(deps / 'bin.js').write_text('fixed executable')
(deps.parent / 'package.json').write_text(json.dumps({'version':'0.2.0-rc.2'}))
'''
        script = f"#!{sys.executable}\nimport pathlib,time,json,subprocess,sys,os\n" + behavior + success
        path = self.bin / "pnpm"; path.write_text(script); path.chmod(0o700)

    def run_attempt(self, config):
        path = pathlib.Path(config["directory"], "config.json"); installer.atomic(path, config)
        subprocess.run([sys.executable, str(SCRIPT), "launch", str(path)], check=True, capture_output=True, timeout=5)
        until = time.monotonic() + 15
        status = None
        while time.monotonic() < until:
            status = installer.read(path.parent / "status.json")
            if status["state"] not in ("starting", "running"):
                break
            time.sleep(0.05)
        self.assertNotIn(status["state"], ("starting", "running"), status)
        self.assertTrue(status["exitConfirmed"], status)
        rows = [json.loads(line) for line in (path.parent / "output.jsonl").read_text().splitlines()]
        self.assertEqual([row["seq"] for row in rows], list(range(len(rows))))
        return status, rows

    def test_slow_download_progress_extends_idle_time(self):
        self.pnpm("for index in range(7):\n print(json.dumps({'name':'pnpm:fetching-progress','packageId':'fixed@1','downloaded':(index+1)*100}), flush=True)\n time.sleep(0.3)\n")
        status, _ = self.run_attempt(self.config())
        self.assertEqual(status["state"], "completed", status)
        self.assertEqual(status["progress"]["bytes"], 700)

    def test_compilation_without_output_counts_measured_child_cpu(self):
        compiler = self.bin / "gcc"
        compiler.write_text(f"#!{sys.executable}\nimport time\nuntil=time.monotonic()+2.5\nwhile time.monotonic()<until: sum(range(10000))\n")
        compiler.chmod(0o700)
        self.pnpm("subprocess.run(['gcc'], check=True)\n")
        status, _ = self.run_attempt(self.config(idle=1200))
        self.assertEqual(status["state"], "completed", status)
        self.assertGreater(status["progress"]["cpuTicks"], 0)

    def test_heartbeat_cannot_prevent_idle_timeout_and_final_output_is_saved(self):
        self.pnpm("print('last diagnostic without newline', end='', flush=True)\nwhile True:\n print(json.dumps({'name':'heartbeat'}), file=sys.stderr, flush=True)\n time.sleep(0.2)\n")
        status, rows = self.run_attempt(self.config())
        self.assertEqual(status["state"], "failed")
        self.assertIn("idle timeout", status["reason"])
        self.assertIn("last diagnostic without newline", "".join(row["text"] for row in rows))
        self.assertTrue(pathlib.Path(self.config()["stage"]).is_dir())

    def test_total_budget_stops_a_download_even_with_progress(self):
        self.pnpm("for index in range(100):\n print(json.dumps({'name':'pnpm:fetching-progress','packageId':'fixed@1','downloaded':index*100}), flush=True)\n time.sleep(0.15)\n")
        status, _ = self.run_attempt(self.config(idle=2000, total=1500))
        self.assertIn("total budget", status["reason"])
        self.assertFalse(pathlib.Path(self.config()["release"], ".ready").exists())

    def test_failed_attempt_keeps_checkpoint_and_next_attempt_seals_same_material(self):
        self.pnpm("pathlib.Path('checkpoint').write_text('cached')\nprint('failed first download', file=sys.stderr)\nsys.exit(1)\n")
        first = self.config(); status, _ = self.run_attempt(first)
        self.assertEqual(status["state"], "failed")
        self.pnpm("assert pathlib.Path('checkpoint').read_text() == 'cached'\n")
        second = self.config(); second["sources"]["npm"] = "https://mirror.example.test"
        status, _ = self.run_attempt(second)
        self.assertEqual(status["state"], "completed", status)
        self.assertTrue(pathlib.Path(first["release"], ".ready").is_file())

    def test_material_hash_failure_is_logged_and_never_published(self):
        self.pnpm("")
        config = self.config(); config["archiveHash"] = "0" * 64
        status, rows = self.run_attempt(config)
        self.assertEqual(status["state"], "failed")
        self.assertIn("integrity", status["reason"])
        self.assertIn("integrity", "".join(row["text"] for row in rows))

    def test_wrong_process_identity_is_not_signalled(self):
        child = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"], start_new_session=True)
        try:
            self.assertFalse(installer.stop_group(child, "wrong-start-ticks", installer.now() + 1000))
            self.assertIsNone(child.poll())
        finally:
            os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=5)

    def test_original_manifest_changes_cannot_be_sealed(self):
        self.pnpm("pathlib.Path('aspera-release.json').write_text('{}')\n")
        status, _ = self.run_attempt(self.config())
        self.assertEqual(status["state"], "failed")
        self.assertIn("Fixed installation material changed", status["reason"])
        self.assertFalse((self.root / 'release/.ready').exists())

    def test_duplicate_launch_and_cancel_keep_one_owned_attempt(self):
        self.pnpm("while True: time.sleep(0.1)\n")
        config = self.config(total=12000, idle=8000)
        path = pathlib.Path(config['directory'], 'config.json'); installer.atomic(path, config)
        for _ in range(2):
            subprocess.run([sys.executable, str(SCRIPT), 'launch', str(path)], check=True, capture_output=True, timeout=5)
        until = time.monotonic() + 10
        while time.monotonic() < until:
            first = installer.read(path.parent / 'status.json')
            if first.get('childPid'):
                break
            time.sleep(0.05)
        self.assertTrue(first.get('childPid'), first)
        subprocess.run([sys.executable, str(SCRIPT), 'stop', str(path)], check=True, capture_output=True, timeout=5)
        while time.monotonic() < until:
            stopped = installer.read(path.parent / 'status.json')
            if stopped['exitConfirmed']:
                break
            time.sleep(0.05)
        self.assertEqual(stopped['attemptId'], first['attemptId'])
        self.assertTrue(stopped['exitConfirmed'], stopped)
        self.assertEqual(stopped['state'], 'cancelled')
        self.assertFalse(installer.group_members(first['childPid']))


if __name__ == "__main__":
    unittest.main(verbosity=2)
