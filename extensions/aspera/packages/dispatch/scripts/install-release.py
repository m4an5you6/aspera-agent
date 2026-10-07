"""Supervise a fixed Aspera release independently of the SSH command channel."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import selectors
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request


def now():
    return int(time.time() * 1000)


def atomic(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".incoming", dir=path.parent)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        json.dump(value, output)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def read(path):
    with open(path, encoding="utf-8") as source:
        return json.load(source)


def owned_path(value):
    path = pathlib.Path(value)
    if not path.is_absolute() or any(part == ".." for part in path.parts):
        raise ValueError("Installation path must be absolute")
    current = pathlib.Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        if current.is_symlink():
            raise ValueError("Installation path contains a symbolic link: " + str(current))
    return path


def process(pid):
    try:
        stat = pathlib.Path("/proc", str(pid), "stat").read_text().rsplit(")", 1)[1].split()
        return {"pid": pid, "parent": int(stat[1]), "group": int(stat[2]), "ticks": stat[19],
                "cpu": int(stat[11]) + int(stat[12]), "state": stat[0]}
    except (OSError, ValueError, IndexError):
        return None


def matches(pid, ticks):
    found = process(pid)
    return found is not None and found["ticks"] == ticks and found["state"] != "Z"


def boot_id():
    return pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def group_members(pid):
    return [entry for item in pathlib.Path("/proc").iterdir() if item.name.isdigit()
            for entry in [process(int(item.name))]
            if entry and entry["group"] == pid and entry["state"] != "Z"]


def stop_group(child, ticks, deadline):
    if not matches(child.pid, ticks):
        return child.poll() is not None and not group_members(child.pid)
    # Signals only target the process group created by this supervised attempt.
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        return child.poll() is not None and not group_members(child.pid)
    until = min(deadline, now() + 1000)
    while now() < until and group_members(child.pid):
        time.sleep(0.05)
    if group_members(child.pid):
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        child.wait(timeout=1)
    except subprocess.TimeoutExpired:
        return False
    return not group_members(child.pid)


def source_url(value):
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Download source must use HTTPS without credentials")
    return value.rstrip("/")


class HttpsRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        source_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url, deadline, limit=None, idle_timeout_ms=None, progress=None):
    source_url(url)
    remaining = (deadline - now()) / 1000
    if remaining <= 0:
        raise TimeoutError("Installation total budget exhausted")
    # This opener has no proxy authorization, cookies, client certificates or stored npm credentials.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), HttpsRedirect())
    timeout = min(remaining, idle_timeout_ms / 1000) if idle_timeout_ms else remaining
    with opener.open(urllib.request.Request(url, headers={"User-Agent": "Aspera/0.1.1"}), timeout=timeout) as response:
        result = bytearray()
        while limit is None or len(result) < limit:
            if now() >= deadline:
                raise TimeoutError("Installation total budget exhausted")
            block = response.read1(min(65536, limit - len(result)) if limit is not None else 65536)
            if not block:
                break
            result.extend(block)
            if progress:
                progress(len(block))
        return bytes(result)


def extract(archive, destination):
    destination = owned_path(destination)
    with tarfile.open(archive) as source:
        for member in source.getmembers():
            path = pathlib.PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or not (member.isfile() or member.isdir()):
                raise ValueError("Archive contains an unsafe entry: " + member.name)
        # The closed file/directory validation also supports Python versions preceding extraction filters.
        for member in source.getmembers():
            target = owned_path(str(destination / member.name))
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
            else:
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with source.extractfile(member) as contents, open(target, "wb") as output:
                    while True:
                        chunk = contents.read(65536)
                        if not chunk:
                            break
                        output.write(chunk)
                os.chmod(target, member.mode & 0o755)


def sanitized_environment(config, stage):
    allowed = {"PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
               "CC", "CXX", "CFLAGS", "CXXFLAGS", "LDFLAGS", "PKG_CONFIG_PATH", "LD_LIBRARY_PATH", "SYSTEMROOT", "WINDIR"}
    env = {key: value for key, value in os.environ.items() if key in allowed}
    cache = owned_path(config["cache"])
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    empty = pathlib.Path(config["directory"], "npmrc")
    empty.write_text("", encoding="utf-8")
    os.chmod(empty, 0o600)
    # The release's original lockfile is preserved; configuration is confined to this child.
    env.update({"XDG_CACHE_HOME": str(cache), "COREPACK_HOME": str(cache / "corepack"),
                "npm_config_cache": str(cache / "npm"), "npm_config_userconfig": str(empty),
                "npm_config_globalconfig": str(empty), "npm_config_registry": source_url(config["sources"]["npm"]) + "/",
                "npm_config_disturl": source_url(config["sources"]["nodeHeaders"]),
                "npm_config_strict_ssl": "true", "NODE_TLS_REJECT_UNAUTHORIZED": "1",
                "CI": "true", "TMPDIR": str(cache / "tmp")})
    (cache / "tmp").mkdir(exist_ok=True)
    if config.get("pathEntries"):
        env["PATH"] = ":".join(config["pathEntries"]) + ":" + env.get("PATH", "")
    return env


def verify_material(archive, stage):
    with tarfile.open(archive) as source:
        names = {str(pathlib.PurePosixPath(member.name)) for member in source.getmembers() if member.isfile()}
        for hook in (".pnpmfile.cjs", "pnpmfile.cjs", ".pnpmfile.js"):
            if (stage / hook).exists() and hook not in names:
                raise ValueError("Installation stage contains an unindexed package-manager hook")
        for member in source.getmembers():
            if not member.isfile():
                continue
            path = pathlib.PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError("Original material path is invalid")
            original, installed = hashlib.sha256(), hashlib.sha256()
            with source.extractfile(member) as contents, open(owned_path(str(stage / member.name)), "rb") as actual:
                for chunk in iter(lambda: contents.read(65536), b""):
                    original.update(chunk)
                for chunk in iter(lambda: actual.read(65536), b""):
                    installed.update(chunk)
            if original.digest() != installed.digest():
                raise ValueError("Fixed installation material changed: " + member.name)


def compiler_activity(child_pid, observed):
    cpu, disk = 0, 0
    for entry in group_members(child_pid):
        if entry["pid"] == child_pid:
            continue
        try:
            command = pathlib.Path("/proc", str(entry["pid"]), "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
            if not re.search(r"(?:^|[/ ])(?:cc1plus|gcc|g\+\+|c\+\+|clang|make|cmake|ninja|rustc|ld)(?:[ /]|$)|node-gyp.*build", command):
                continue
            counters = pathlib.Path("/proc", str(entry["pid"]), "io").read_text()
            disk_bytes = sum(int(value) for value in re.findall(r"(?:read_bytes|write_bytes): (\d+)", counters))
            identity = (entry["pid"], entry["ticks"])
            previous = observed.get(identity, (0, 0))
            cpu += max(0, entry["cpu"] - previous[0])
            disk += max(0, disk_bytes - previous[1])
            observed[identity] = (entry["cpu"], disk_bytes)
        except OSError:
            continue
    return cpu, disk


def progress_event(text, counters, downloaded, imported):
    try:
        event = json.loads(text)
    except (ValueError, TypeError):
        return False
    before = (counters["bytes"], counters["packages"])
    name = event.get("name", "")
    package = event.get("package", {})
    key = event.get("packageId") or event.get("depPath") or (package.get("name") if isinstance(package, dict) else None)
    if name == "pnpm:fetching-progress" and key:
        amount = event.get("downloaded", event.get("downloadedBytes", 0))
        if isinstance(amount, (int, float)) and amount > downloaded.get(key, 0):
            counters["bytes"] += amount - downloaded.get(key, 0)
            downloaded[key] = amount
    if name == "pnpm:progress" and event.get("status") in ("imported", "resolved", "fetched") and key:
        marker = (str(key), event.get("status"))
        if marker not in imported:
            imported.add(marker)
            counters["packages"] += 1
    return before != (counters["bytes"], counters["packages"])


def pinned_probe(config, kind, url, deadline):
    started = now()
    url = source_url(url)
    if kind == "nodeHeaders":
        env = sanitized_environment(config, pathlib.Path(config["stage"]))
        version = subprocess.check_output(["node", "--version"], env=env, timeout=max(0.001, (deadline - now()) / 1000)).decode().strip()
        archive_url = url + "/" + version + "/node-" + version + "-headers.tar.gz"
        data = fetch(archive_url, deadline, 65536, config["idleTimeoutMs"])
    else:
        # Probe the exact published DSH version pinned by the release, rather than a registry's latest tag.
        manifest = read(pathlib.Path(config["stage"], "aspera-release.json"))
        version = manifest["dsh"]
        metadata = json.loads(fetch(url + "/@deepseek-ai%2Fdsh/" + urllib.parse.quote(version), deadline, 1048576, config["idleTimeoutMs"]))
        if metadata.get("version") != version or not metadata.get("dist", {}).get("integrity"):
            raise ValueError("Candidate does not provide the pinned version and integrity")
        data = fetch(metadata["dist"]["tarball"], deadline, 65536, config["idleTimeoutMs"])
    if not data:
        raise ValueError("Candidate returned no download bytes")
    return {"version": version, "bytes": len(data), "elapsedMs": now() - started,
            "available": True, "detail": "Pinned version and a bounded download were read over verified HTTPS"}


def headers(config, env, deadline, progress):
    # Alternate headers are verified against the official distribution's checksum, never a mirror's checksum.
    if config["sources"]["nodeHeaders"].rstrip("/") == "https://nodejs.org/download/release":
        return
    version = subprocess.check_output(["node", "--version"], env=env, timeout=max(0.001, (deadline - now()) / 1000)).decode().strip()
    name = "node-" + version + "-headers.tar.gz"
    sums = fetch("https://nodejs.org/download/release/" + version + "/SHASUMS256.txt", deadline, 1048576, config["idleTimeoutMs"], progress).decode()
    expected = next((line.split()[0] for line in sums.splitlines() if line.split()[-1] == name), None)
    if not expected:
        raise ValueError("Official Node header checksum is unavailable")
    cache = pathlib.Path(config["cache"], "headers", version)
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / name
    if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
        payload = fetch(source_url(config["sources"]["nodeHeaders"]) + "/" + version + "/" + name, deadline, None, config["idleTimeoutMs"], progress)
        if hashlib.sha256(payload).hexdigest() != expected:
            raise ValueError("Node header integrity check failed")
        archive.write_bytes(payload)
    extract(archive, cache)
    env["npm_config_nodedir"] = str(cache / ("node-" + version))


def run(config):
    import fcntl
    directory = owned_path(config["directory"])
    status_path = directory / "status.json"
    status = read(status_path)
    status.update({"pid": os.getpid(), "startTicks": process(os.getpid())["ticks"], "bootId": boot_id(), "updatedAt": now()})
    lock = None
    child = None
    selector = selectors.DefaultSelector()
    pending = {"stdout": b"", "stderr": b""}
    downloaded, imported, activity = {}, set(), {}
    sequence = 0
    budget_deadline = time.monotonic() + max(0, config["deadline"] - now()) / 1000
    progress_clock = time.monotonic()
    def emit(log, text, stream):
        nonlocal sequence, progress_clock
        if progress_event(text, status["progress"], downloaded, imported):
            status["lastProgressAt"] = now()
            progress_clock = time.monotonic()
        for offset in range(0, max(1, len(text)), 4096):
            row = {"seq": sequence, "time": now(), "stream": stream,
                   "text": text[offset:offset + 4096] + ("\n" if offset + 4096 >= len(text) else "")}
            log.write(json.dumps(row) + "\n")
            sequence += 1
    def consume(log, key):
        chunk = os.read(key.fd, 65536)
        stream = key.data
        if not chunk:
            selector.unregister(key.fileobj)
        pending[stream] += chunk
        lines = pending[stream].split(b"\n")
        pending[stream] = lines.pop()
        if not chunk and pending[stream]:
            lines.append(pending[stream]); pending[stream] = b""
        for line in lines:
            emit(log, line.decode(errors="replace"), stream)
        log.flush()
    def cancel(_signal, _frame):
        raise InterruptedError("Installation cancelled by its owner")
    signal.signal(signal.SIGTERM, cancel)
    try:
        release = owned_path(config["release"])
        stage = owned_path(config["stage"])
        archive = owned_path(config["archive"])
        lock_path = pathlib.Path(str(release) + ".supervised-lock")
        lock = open(lock_path, "a")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        legacy = pathlib.Path(str(release) + ".installing")
        if legacy.exists() and not (legacy / "exited").is_file():
            status.update(state="unconfirmed", reason="Previous legacy installation exit is unconfirmed", exitConfirmed=False)
            return
        if hashlib.sha256(archive.read_bytes()).hexdigest() != config["archiveHash"]:
            raise ValueError("Original release archive integrity check failed")
        if (release / ".ready").is_file():
            verify_material(archive, release)
            if read(release / "aspera-release.json")["deploymentId"] != config["digest"]:
                raise ValueError("Installed release identity differs")
            status.update(state="completed", phase="installed-release", exitCode=0, exitConfirmed=True)
            return
        if release.exists():
            raise ValueError("Unsealed release directory must be inspected before reuse")
        marker = stage / ".aspera-installation.json"
        expected = {"version": 1, "digest": config["digest"], "archiveHash": config["archiveHash"]}
        if stage.exists():
            if not marker.is_file() or read(marker) != expected:
                raise ValueError("Incomplete installation belongs to different material")
        else:
            stage.mkdir(mode=0o700)
            atomic(marker, expected)
        if not (stage / ".aspera-material-ready").is_file():
            extract(archive, stage)
            (stage / ".aspera-material-ready").touch()
        verify_material(archive, stage)
        status.update(state="running", phase="installing-dependencies", lastProgressAt=now())
        atomic(status_path, status)
        env = sanitized_environment(config, stage)
        def download_progress(size):
            nonlocal progress_clock
            status["progress"]["bytes"] += size
            progress_clock = time.monotonic()
            status.update(lastProgressAt=now(), updatedAt=now(), phase="download-node-headers")
            atomic(status_path, status)
        headers(config, env, config["deadline"], download_progress)
        command = ["pnpm", "install", "--frozen-lockfile", "--prod", "--reporter=ndjson", "--store-dir", str(pathlib.Path(config["cache"], "pnpm"))]
        child = subprocess.Popen(command, cwd=stage, env=env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        ticks = process(child.pid)["ticks"]
        status.update(childPid=child.pid, childStartTicks=ticks)
        atomic(status_path, status)
        for stream, pipe in (("stdout", child.stdout), ("stderr", child.stderr)):
            os.set_blocking(pipe.fileno(), False)
            selector.register(pipe, selectors.EVENT_READ, stream)
        with open(directory / "output.jsonl", "a", encoding="utf-8") as log:
            while selector.get_map() or child.poll() is None:
                reason = None
                if (directory / "stop.json").exists():
                    reason = "Installation cancelled by its owner"
                elif now() >= config["deadline"] or time.monotonic() >= budget_deadline:
                    reason = "Installation total budget exhausted"
                elif (time.monotonic() - progress_clock) * 1000 >= config["idleTimeoutMs"]:
                    reason = "Installation idle timeout: no download, package or compiler progress"
                if reason:
                    confirmed = stop_group(child, ticks, config["deadline"])
                    status.update(state="cancelled" if "cancelled" in reason else "failed", reason=reason,
                                  exitConfirmed=confirmed, exitCode=child.poll())
                    if not confirmed:
                        status["state"] = "unconfirmed"
                    break
                for key, _ in selector.select(0.1):
                    consume(log, key)
                cpu, disk = compiler_activity(child.pid, activity)
                if cpu > 0 or disk > 0:
                    status["lastProgressAt"] = now()
                    progress_clock = time.monotonic()
                status["progress"]["cpuTicks"] += cpu
                status["progress"]["ioBytes"] += disk
                if now() - status["updatedAt"] >= config["sampleIntervalMs"]:
                    status["updatedAt"] = now(); atomic(status_path, status)
        if status["state"] == "running":
            code = child.wait()
            confirmed = not group_members(child.pid)
            status.update(exitCode=code, exitConfirmed=confirmed, state="failed" if confirmed else "unconfirmed")
            if code == 0 and confirmed:
                if now() >= config["deadline"]:
                    raise TimeoutError("Installation total budget exhausted before validation")
                verify_material(archive, stage)
                manifest = read(stage / "aspera-release.json")
                if manifest["deploymentId"] != config["digest"] or not (stage / "node_modules/@deepseek-ai/dsh/lib/bin.js").is_file():
                    raise ValueError("Installed release failed fixed-material validation")
                package = read(stage / "node_modules/@deepseek-ai/dsh/package.json")
                if package["version"] != manifest["dsh"]:
                    raise ValueError("Installed DSH version differs from original release")
                # pnpm --frozen-lockfile enforces versions and integrity; sealed releases are immutable.
                (stage / ".ready").touch()
                os.rename(stage, release)
                status.update(state="completed", phase="installed-release")
            elif code != 0:
                status["reason"] = "Pinned dependency installation exited " + str(code)
    except Exception as error:
        if child and child.poll() is None:
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            stop_group(child, status["childStartTicks"], config["deadline"])
        confirmed = child is None or child.poll() is not None and not group_members(child.pid)
        status.update(state=("cancelled" if isinstance(error, InterruptedError) else "failed") if confirmed else "unconfirmed", reason=str(error), exitConfirmed=confirmed,
                      exitCode=child.poll() if child else 1)
    finally:
        # Confirmed exit closes both pipes; drain their remaining bytes, including unterminated lines.
        with open(directory / "output.jsonl", "a", encoding="utf-8") as log:
            if status["exitConfirmed"]:
                while selector.get_map():
                    ready = selector.select(0)
                    if not ready:
                        break
                    for key, _ in ready:
                        consume(log, key)
            if status.get("reason"):
                emit(log, status["reason"], "stderr")
        status["updatedAt"] = now()
        atomic(status_path, status)
        selector.close()
        if lock:
            lock.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["launch", "run", "status", "stop", "probe"])
    parser.add_argument("config")
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--limit", type=int, default=65536)
    parser.add_argument("--kind", choices=["npm", "nodeHeaders"])
    parser.add_argument("--url")
    args = parser.parse_args()
    config = read(owned_path(args.config))
    directory = owned_path(config["directory"])
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / "status.json"
    if args.operation == "run":
        run(config)
    elif args.operation == "launch":
        if not path.exists():
            status = {"version": 1, "attemptId": config["attemptId"], "experimentId": config["experimentId"], "serverId": config["serverId"],
                      "digest": config["digest"], "archiveHash": config["archiveHash"], "state": "starting", "phase": "checking-material",
                      "startedAt": now(), "deadline": config["deadline"], "updatedAt": now(), "lastProgressAt": now(),
                      "progress": {"bytes": 0, "packages": 0, "cpuTicks": 0, "ioBytes": 0}, "pid": 0, "startTicks": "", "bootId": "",
                      "exitCode": None, "exitConfirmed": False}
            atomic(path, status)
            with open(directory / "supervisor.stderr", "ab") as errors:
                child = subprocess.Popen([sys.executable, __file__, "run", args.config], stdin=subprocess.DEVNULL,
                                         stdout=subprocess.DEVNULL, stderr=errors, start_new_session=True, close_fds=True)
                fresh = read(path)
                observed = process(child.pid)
                if fresh["pid"] == 0 and observed:
                    fresh.update(pid=child.pid, startTicks=observed["ticks"], bootId=boot_id())
                    atomic(path, fresh)
        print(json.dumps(read(path)))
    elif args.operation == "status":
        status = read(path)
        if status["state"] in ("starting", "running") and status["pid"] and (
                status["bootId"] != boot_id() or not matches(status["pid"], status["startTicks"])):
            status.update(state="unconfirmed", reason="Installer supervisor is absent; child exit must be reconciled", exitConfirmed=False)
            child = status.get("childPid")
            if child and status["bootId"] == boot_id() and not group_members(child):
                status.update(state="failed", reason="Interrupted installer has no remaining managed processes", exitConfirmed=True)
            elif status["bootId"] != boot_id():
                status.update(state="failed", reason="Server restarted during installation", exitConfirmed=True)
            atomic(path, status)
        rows, offset = [], max(0, args.offset)
        log = directory / "output.jsonl"
        if log.exists():
            with open(log, "rb") as output:
                output.seek(offset)
                while output.tell() - args.offset < min(1048576, max(1, args.limit)):
                    line = output.readline()
                    if not line or not line.endswith(b"\n"):
                        break
                    rows.append(json.loads(line)); offset = output.tell()
        print(json.dumps({"status": status, "lines": rows, "offset": offset, "hasMore": log.exists() and offset < log.stat().st_size}))
    elif args.operation == "stop":
        status = read(path)
        if status["attemptId"] != config["attemptId"] or status["experimentId"] != config["experimentId"]:
            raise ValueError("Installation owner differs")
        atomic(directory / "stop.json", {"attemptId": config["attemptId"], "requestedAt": now()})
        if status["bootId"] == boot_id() and matches(status["pid"], status["startTicks"]):
            os.kill(status["pid"], signal.SIGTERM)
        print(json.dumps(status))
    elif args.operation == "probe":
        try:
            value = pinned_probe(config, args.kind, args.url, config["deadline"])
        except Exception as error:
            value = {"version": "unavailable", "available": False, "bytes": 0, "elapsedMs": 0, "detail": str(error)}
        print(json.dumps(value))


if __name__ == "__main__":
    main()
