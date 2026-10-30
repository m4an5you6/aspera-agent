"""Probe and install a content-addressed private-proc bubblewrap launcher for one account."""
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time


class ProbeFailure(RuntimeError):
    """A stopped probe retains its output and independently confirmed process exit."""
    def __init__(self, reason, code, stdout, stderr, confirmed):
        super().__init__(reason)
        self.code, self.stdout, self.stderr, self.confirmed = code, stdout, stderr, confirmed


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def atomic_json(path, value):
    temporary = path.with_name(path.name + ".tmp-" + str(os.getpid()))
    with temporary.open("x") as stream:
        json.dump(value, stream, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def owned_directory(path):
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
        raise RuntimeError("Program directory is a symlink: " + str(path))
    if not path.exists():
        owned_directory(path.parent)
        path.mkdir(mode=0o700)
    current = path.stat()
    if not stat.S_ISDIR(current.st_mode) or current.st_uid != os.geteuid() or current.st_mode & 0o022:
        raise RuntimeError("Program directory is not private to the selected account: " + str(path))


def own_control_root(request):
    root = Path(request["controlRoot"])
    owned_directory(root)
    marker = root / ".aspera-owner.json"
    # storage.mjs compares this exact canonical encoding when preparation reaches storage selection.
    expected = json.dumps({"version": 1, "serverId": request["serverId"], "kind": "control"}, separators=(",", ":"))
    if marker.exists():
        if marker.is_symlink() or marker.read_text() != expected:
            raise RuntimeError("Control directory belongs to another server or owner")
        return
    if not request["adoptLegacyControlRoot"] and any(not entry.name.startswith(".aspera-owner-") for entry in root.iterdir()):
        raise RuntimeError("Refusing to adopt a nonempty unowned control directory")
    temporary = root / (".aspera-owner-" + str(os.getpid()) + ".tmp")
    try:
        with temporary.open("x") as stream:
            stream.write(expected)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, marker)
        except FileExistsError:
            if marker.is_symlink() or marker.read_text() != expected:
                raise RuntimeError("Concurrent control directory owner differs")
    finally:
        temporary.unlink(missing_ok=True)


def child_lifetime(parent):
    if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "Cannot bind probe to its supervisor")
    if os.getppid() != parent:
        os.kill(os.getpid(), signal.SIGKILL)


def process_snapshot():
    entries = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
            entries[int(entry.name)] = (fields[0], int(fields[1]), fields[19], os.readlink(entry / "ns" / "pid"))
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    return entries


def run_probe(argv, request):
    parent = os.getpid()
    process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               start_new_session=True, preexec_fn=lambda: child_lifetime(parent))
    interrupted = None
    owned = set()
    namespaces = set()
    parent_namespace = os.readlink("/proc/self/ns/pid")
    root_start = None

    def collect():
        nonlocal root_start
        entries = process_snapshot()
        root = entries.get(process.pid)
        if root_start is None and root is not None:
            root_start = root[2]
        if root is not None and root[2] == root_start:
            owned.add((process.pid, root[2]))
        changed = True
        while changed:
            changed = False
            for pid, item in entries.items():
                if (pid, item[2]) in owned or item[3] in namespaces or any(parent == item[1] and entries[parent][2] == start for parent, start in owned if parent in entries):
                    if (pid, item[2]) not in owned:
                        owned.add((pid, item[2])); changed = True
                    if item[3] != parent_namespace:
                        namespaces.add(item[3])
        return any(item[0] != "Z" and ((pid, item[2]) in owned or item[3] in namespaces) for pid, item in entries.items())

    def communicate(timeout):
        deadline = time.monotonic() + timeout
        while True:
            collect()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(argv, timeout)
            try:
                return process.communicate(timeout=min(request["pollIntervalMs"] / 1000, remaining))
            except subprocess.TimeoutExpired:
                continue

    def cancel(signum, _frame):
        raise InterruptedError("Compatibility probe interrupted by signal " + str(signum))

    previous = {signum: signal.signal(signum, cancel) for signum in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT)}
    try:
        try:
            stdout, stderr = communicate(request["probeTimeoutMs"] / 1000)
        except (subprocess.TimeoutExpired, InterruptedError) as error:
            interrupted = error
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                stdout, stderr = communicate(request["cleanupTimeoutMs"] / 1000)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                stdout, stderr = communicate(request["cleanupTimeoutMs"] / 1000)
        # unshare --fork ignores TERM. SIGKILL of its PID namespace owner also terminates
        # the inner bubblewrap session; an exit receipt requires that cascade to finish.
        deadline = time.monotonic() + request["cleanupTimeoutMs"] / 1000
        for line in stdout.decode(errors="replace").splitlines():
            if line.startswith("ASPERA_PROBE_PID_NS="):
                namespaces.add(line.split("=", 1)[1])
        while collect():
            if time.monotonic() >= deadline:
                raise RuntimeError("Compatibility probe process range has not exited; outcome remains unknown")
            time.sleep(min(request["pollIntervalMs"] / 1000, max(0, deadline - time.monotonic())))
        if interrupted is not None:
            raise ProbeFailure(str(interrupted), process.returncode, stdout.decode(errors="replace"),
                               stderr.decode(errors="replace"), True)
        return process.returncode, stdout.decode(errors="replace"), stderr.decode(errors="replace")
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=request["cleanupTimeoutMs"] / 1000)


def native_programs(request, root):
    backend = Path(request["bwrap"])
    if root in backend.parents:
        descriptor = json.loads((backend.parent.parent / "launcher.json").read_text())
        if descriptor["version"] != 1 or descriptor["serverId"] != request["serverId"]:
            raise RuntimeError("Existing launcher belongs to a different server or format")
        native = dict(descriptor["native"])
        if descriptor["launcher"]["path"] != str(backend) or digest(backend) != descriptor["launcher"]["digest"]:
            raise RuntimeError("Existing launcher content differs from its saved identity")
        for item in native.values():
            if digest(item["path"]) != item["digest"]:
                raise RuntimeError("A launcher's native executable changed: " + item["path"])
    else:
        native = {}
    for name in ("bwrap", "unshare", "setpriv", "sha256sum", "env"):
        if name in native:
            continue
        path = str(backend) if name == "bwrap" else shutil.which(name)
        if path is None:
            raise FileNotFoundError("Required compatibility utility is missing: " + name)
        path = os.path.realpath(path)
        if not os.path.isabs(path) or not os.access(path, os.X_OK):
            raise RuntimeError("Utility is not an absolute executable: " + path)
        if Path(path).read_bytes()[:4] != b"\x7fELF":
            raise RuntimeError("Compatibility utilities must be native Linux executables: " + path)
        native[name] = {"path": path, "digest": digest(path)}
    return native


def launcher_source(native):
    quote = shlex.quote
    checksum = quote(native["sha256sum"]["path"])
    source = ["#!/bin/sh", "set -eu", 'root=${0%/bin/bwrap}', 'identity=${root##*/}',
              'actual=$(' + checksum + ' -- "$0")',
              '[ "${actual%% *}" = "$identity" ] || { printf \'Aspera launcher identity mismatch\\n\' >&2; exit 125; }']
    for name in ("bwrap", "unshare", "setpriv", "env"):
        item = native[name]
        source.extend(["actual=$(" + checksum + " -- " + quote(item["path"]) + ")",
                       '[ "${actual%% *}" = ' + quote(item["digest"]) +
                       " ] || { printf 'Aspera native utility identity mismatch: " + name + "\\n' >&2; exit 125; }"])
    source.extend(['case "$#:${1-}" in',
                   '  1:--version|1:--help) exec ' + quote(native["bwrap"]["path"]) + ' "$@" ;;', 'esac',
                   "exec " + quote(native["setpriv"]["path"]) + " --no-new-privs --pdeathsig KILL " +
                   quote(native["unshare"]["path"]) + " --pid --fork --kill-child=SIGKILL --mount-proc -- " +
                   quote(native["env"]["path"]) + " --default-signal=TERM,INT -- " +
                   quote(native["bwrap"]["path"]) + ' --cap-drop ALL "$@"'])
    return "\n".join(source) + "\n"


def inspect_or_repair(request, result):
    root = Path(request["controlRoot"]) / "tools" / "sandbox"
    if not root.is_absolute() or request["mode"] not in ("inspect", "repair"):
        raise RuntimeError("Invalid program-owned compatibility location")
    native = native_programs(request, root)
    if 'nativeRecipe' in request:
        native = ensure_native_sandbox(request, native, result)
        if native is None:
            return
    source = launcher_source(native)
    identity = hashlib.sha256(source.encode()).hexdigest()
    directory = root / identity
    launcher = {"version": 1, "path": str(directory / "bin" / "bwrap"), "digest": identity}
    descriptor = {"version": 1, "recipe": "private-proc-v1", "serverId": request["serverId"],
                  "launcher": launcher, "native": native, "isolationArgs": request["isolationArgs"]}
    if directory.exists():
        owner = Path(request["controlRoot"]) / ".aspera-owner.json"
        expected_owner = {"version": 1, "serverId": request["serverId"], "kind": "control"}
        if owner.is_symlink() or json.loads(owner.read_text()) != expected_owner:
            raise RuntimeError("Existing launcher's control directory owner does not match the selected server")
        if directory.is_symlink() or json.loads((directory / "launcher.json").read_text()) != descriptor:
            raise RuntimeError("Existing immutable launcher descriptor does not match its program configuration")
        if digest(launcher["path"]) != identity:
            raise RuntimeError("Existing immutable launcher content has changed; it will not be overwritten")
        for file in (directory, directory / "bin", Path(launcher["path"]), directory / "launcher.json"):
            metadata = file.lstat()
            if file.is_symlink() or metadata.st_uid != os.geteuid() or metadata.st_mode & 0o077:
                raise RuntimeError("Existing launcher is not private to the selected account")
    capabilities = int(next(line.split(":", 1)[1].strip() for line in Path("/proc/self/status").read_text().splitlines()
                            if line.startswith("CapEff:")), 16)
    if not capabilities & (1 << 21):
        result.update(state="unavailable", requiresPlatformAction=True,
                      reason="The selected account lacks CAP_SYS_ADMIN for creating a private PID/proc parent. The cloud platform must supply compatible namespace/proc permissions; keep all inner isolation flags.")
        return
    namespaces = {name: os.readlink("/proc/self/ns/" + name) for name in ("user", "pid", "mnt", "ipc", "uts")}
    probe = """import json,os,pathlib,signal,subprocess,sys
expected=json.loads(os.environ['ASPERA_PARENT_NAMESPACES'])
assert all(os.readlink('/proc/self/ns/'+name) != value for name,value in expected.items()), 'Namespaces were not isolated'
status=dict(line.split(':',1) for line in pathlib.Path('/proc/self/status').read_text().splitlines() if ':' in line)
assert all(int(status[name].strip(),16)==0 for name in ('CapInh','CapPrm','CapEff','CapBnd','CapAmb')), 'Capabilities were retained'
assert status['NoNewPrivs'].strip() == '1', 'Privilege gain is not disabled'
assert len([name for name in os.listdir('/proc') if name.isdigit()]) <= 3, 'proc exposes unrelated processes'
assert all(signal.getsignal(number) != signal.SIG_IGN for number in (signal.SIGTERM,signal.SIGINT)), 'Command termination signals are ignored'
child=subprocess.Popen([sys.executable,'-c',"import time;print('ready',flush=True);time.sleep(60)"],stdout=subprocess.PIPE,text=True)
try:
    assert child.stdout.readline().strip() == 'ready', 'Signal probe child did not start'
    child.terminate()
    assert child.wait(timeout=ASPERA_SIGNAL_CHECK_TIMEOUT_SECONDS) == -signal.SIGTERM, 'Signal probe child did not terminate normally'
finally:
    if child.poll() is None:child.kill();child.wait()
    child.stdout.close()
print('Private user/PID/mount/IPC/UTS namespaces, private proc, zero capabilities and no_new_privs verified')
print('Default SIGTERM/SIGINT and child termination verified')
print('ASPERA_PROBE_PID_NS='+os.readlink('/proc/self/ns/pid'))
"""
    probe = probe.replace("ASPERA_SIGNAL_CHECK_TIMEOUT_SECONDS", repr(request["cleanupTimeoutMs"] / 1000))
    argv = [native["setpriv"]["path"], "--no-new-privs", "--pdeathsig", "KILL", native["unshare"]["path"],
            "--pid", "--fork", "--kill-child=SIGKILL", "--mount-proc", "--", native["env"]["path"],
            "--default-signal=TERM,INT", "--", native["bwrap"]["path"],
            "--cap-drop", "ALL", *request["isolationArgs"], "--clearenv", "--setenv", "ASPERA_PARENT_NAMESPACES",
            json.dumps(namespaces), "--", request["python"], "-c", probe]
    code, stdout, stderr = run_probe(argv, request)
    result.update(stdout=stdout, stderr=stderr, exitCode=code)
    if code != 0:
        result.update(state="unavailable", requiresPlatformAction="permitted" in stderr.lower() or "permission" in stderr.lower(),
                      reason="The measured private-proc launch failed. Preserve isolation and inspect the exact utility/kernel error before requesting platform action.")
        return
    if directory.exists():
        result.update(state="configured", reason="The immutable launcher and native executable digests match; independent provider verification is required.",
                      launcher=launcher, pathEntries=[str(directory / "bin")])
        return
    if request["maxAttempts"] == 0:
        result.update(state="unavailable", reason="Sandbox repairs are disabled by deployment configuration.")
        return
    if request["mode"] == "inspect":
        result.update(state="available", reason="The measured private PID/proc parent preserves every inner isolation flag with zero capabilities. Call repair_preparation_sandbox, then verify_preparation_environment.")
        return
    command_directory = Path(os.environ["ASPERA_PREPARATION_COMMAND_DIRECTORY"])
    attempts_path = command_directory.parent / "sandbox-repair.json"
    own_control_root(request)
    owned_directory(root)
    with (root / ".repair.lock").open("a") as lock:
        os.chmod(root / ".repair.lock", 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        attempts = json.loads(attempts_path.read_text()) if attempts_path.exists() else {
            "version": 1, "experimentId": request["experimentId"], "serverId": request["serverId"], "operations": []}
        if attempts["version"] != 1 or attempts["experimentId"] != request["experimentId"] or attempts["serverId"] != request["serverId"]:
            raise RuntimeError("Repair attempts belong to a different preparation owner")
        operation = str(command_directory)
        if operation not in attempts["operations"]:
            if len(attempts["operations"]) >= request["maxAttempts"]:
                result.update(state="unavailable", reason="Sandbox repair attempt limit reached; inspect the saved command receipts before retrying.")
                return
            attempts["operations"].append(operation)
            atomic_json(attempts_path, attempts)
        if directory.exists():
            raise RuntimeError("A concurrent repair installed this launcher; inspect and verify its identity before reuse")
        stage = Path(tempfile.mkdtemp(prefix=".install-", dir=root))
        try:
            (stage / "bin").mkdir(mode=0o700)
            (stage / "bin" / "bwrap").write_text(source)
            os.chmod(stage / "bin" / "bwrap", 0o700)
            atomic_json(stage / "launcher.json", descriptor)
            stage.rename(directory)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
    result.update(state="configured", reason="Installed the immutable private-proc launcher. Call verify_preparation_environment; configuration does not complete preparation.",
                  launcher=launcher, pathEntries=[str(directory / "bin")])


def main():
    os.umask(0o077)
    request = json.loads(sys.argv[1])
    result = {"version": 1, "strategy": "private-proc", "state": "unknown", "reason": "Compatibility probe has not completed",
              "stdout": "", "stderr": "", "exitCode": None, "requiresPlatformAction": False}
    command = os.environ.get("ASPERA_PREPARATION_COMMAND_DIRECTORY") if request["mode"] == "repair" else None
    receipt = None if command is None else Path(command) / "sandbox-repair-receipt.json"
    operation = {"version": 1, "experimentId": request["experimentId"], "serverId": request["serverId"],
                 "commandDirectory": command, "sessionId": os.environ.get("ASPERA_PREPARATION_SESSION_ID"),
                 "toolCallId": os.environ.get("ASPERA_PREPARATION_TOOL_CALL_ID"), "phase": "probing", "startedAt": int(time.time() * 1000)}
    operation["supervisor"] = {"pid": os.getpid(), "startTicks": Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split()[19],
                               "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip()}
    if receipt is not None:
        atomic_json(receipt, operation)
    confirmed = True
    try:
        if request["version"] != 1:
            raise RuntimeError("Unsupported sandbox repair request")
        inspect_or_repair(request, result)
    except FileNotFoundError as error:
        result.update(state="unavailable", reason=str(error))
    except ProbeFailure as error:
        result.update(state="unknown", reason=str(error), stdout=error.stdout, stderr=error.stderr, exitCode=error.code)
        confirmed = error.confirmed
    except (Exception, KeyboardInterrupt) as error:
        result.update(state="unknown", reason=str(error))
        if "has not exited" in str(error) or isinstance(error, subprocess.TimeoutExpired):
            confirmed = False
    if receipt is not None:
        atomic_json(receipt, {**operation, "phase": "exited" if confirmed else "unconfirmed", "result": result,
                              "finishedAt": int(time.time() * 1000), "exitConfirmed": confirmed})
        if confirmed:
            # This receipt survives SSH channel loss; it is written only after supervised children exit.
            (Path(command) / "exited").write_text("0\n")
        else:
            (Path(command) / "sandbox-repair-unconfirmed").write_text("Probe exit has not been confirmed\n")
    print(json.dumps(result))
    return 0 if confirmed else 1


if __name__ == "__main__":
    sys.exit(main())
