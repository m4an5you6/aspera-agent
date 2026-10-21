"""Supervise one preparation command independently of its SSH reader."""
import base64
import codecs
import fcntl
import hashlib
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile


def save(path, value, plain=False):
    fd, incoming = tempfile.mkstemp(prefix=".incoming-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            output.write(str(value) if plain else json.dumps(value)); output.write("\n"); output.flush(); os.fsync(output.fileno())
        os.replace(incoming, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(incoming):
            os.unlink(incoming)


def load(path):
    if path.is_symlink():
        raise RuntimeError("Preparation record cannot be a symbolic link")
    return json.loads(path.read_text())


def prepare_uv(root, request):
    version = request.get("uvVersion")
    if not version:
        raise RuntimeError("The selected release does not declare a uv version")
    existing = request.get("uvPath")
    if existing and pathlib.Path(existing).is_absolute() and pathlib.Path(existing).is_file():
        actual = subprocess.check_output([existing, "--version"], text=True).split()
        if len(actual) > 1 and actual[1] == version:
            print(json.dumps({"ready": True, "version": version, "reused": True, "downloadBytes": 0,
                              "pathEntries": [str(pathlib.Path(existing).parent)]}), flush=True)
            return
    from pip._vendor.packaging.tags import sys_tags
    from pip._vendor.packaging.utils import parse_wheel_filename
    cache = pathlib.Path(request["cacheDirectory"]) / "uv" / version
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    for parent in [cache, cache.parent, cache.parent.parent]:
        if parent.is_symlink():
            raise RuntimeError("Preparation material directory cannot be a symbolic link")
    with open(cache / "material.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        meta_path = cache / "material.v1.json"
        metadata = load(meta_path) if meta_path.exists() else None
        binary = cache / "bin" / "uv"
        published = cache / "ready.v1.json"
        if published.exists() and binary.is_file() and not binary.is_symlink():
            ready = load(published)
            if ready["version"] == version and hashlib.sha256(binary.read_bytes()).hexdigest() == ready["uvSHA256"]:
                actual = subprocess.check_output([str(binary), "--version"], text=True).split()
                if len(actual) > 1 and actual[1] == version:
                    print(json.dumps({"ready": True, "version": version, "reused": True, "downloadBytes": 0, "pathEntries": [str(binary.parent)]}), flush=True)
                    return
        deadline = int(os.environ["ASPERA_PREPARATION_DEADLINE_MS"])

        def remaining():
            value = (deadline - time.time() * 1000) / 1000
            if value <= 0:
                raise TimeoutError("Preparation download budget exhausted; partial material retained")
            return max(0.001, min(request["readTimeoutMs"] / 1000, value))

        if metadata is None:
            with urllib.request.urlopen("https://pypi.org/pypi/uv/" + version + "/json", timeout=remaining()) as response:
                document = json.load(response)
            tags = list(sys_tags()); ranking = {tag: index for index, tag in enumerate(tags)}; candidates = []
            for item in document["urls"]:
                if not item["filename"].endswith(".whl") or item.get("yanked"):
                    continue
                name, actual, _, wheel_tags = parse_wheel_filename(item["filename"])
                positions = [ranking[tag] for tag in wheel_tags if tag in ranking]
                if name == "uv" and str(actual) == version and positions:
                    candidates.append((min(positions), item))
            if not candidates:
                raise RuntimeError("No compatible fixed-version uv material for this Python/platform")
            item = min(candidates, key=lambda candidate: candidate[0])[1]
            metadata = {"format": 1, "name": "uv", "version": version, "filename": item["filename"], "url": item["url"],
                        "sha256": item["digests"]["sha256"], "size": item["size"]}
            if not metadata["url"].startswith("https://files.pythonhosted.org/"):
                raise RuntimeError("uv material must originate from the official package files host")
            save(meta_path, metadata)
        if metadata["format"] != 1 or metadata["name"] != "uv" or metadata["version"] != version or pathlib.Path(metadata["filename"]).name != metadata["filename"]:
            raise RuntimeError("Cached uv material identity does not match the selected release")
        name, actual, _, wheel_tags = parse_wheel_filename(metadata["filename"])
        if name != "uv" or str(actual) != version or not wheel_tags.intersection(sys_tags()) or not metadata["url"].startswith("https://files.pythonhosted.org/"):
            raise RuntimeError("Cached uv material is incompatible with this Python/platform or source")
        wheel = cache / metadata["filename"]; partial = cache / (metadata["filename"] + ".part")
        if any(path.is_symlink() for path in [wheel, partial, published, binary]):
            raise RuntimeError("Preparation material cannot be a symbolic link")
        downloaded = 0
        if partial.is_file() and partial.stat().st_size == metadata["size"] and hashlib.sha256(partial.read_bytes()).hexdigest() == metadata["sha256"]:
            os.replace(partial, wheel)
        if not wheel.exists() or hashlib.sha256(wheel.read_bytes()).hexdigest() != metadata["sha256"]:
            offset = partial.stat().st_size if partial.exists() else 0
            if offset > metadata["size"]:
                raise RuntimeError("Partial uv material exceeds its declared size; retain it for diagnosis")
            req = urllib.request.Request(metadata["url"], headers={"Range": "bytes=" + str(offset) + "-"} if offset else {})
            with urllib.request.urlopen(req, timeout=remaining()) as response:
                if offset and (response.status != 206 or not response.headers.get("Content-Range", "").startswith("bytes " + str(offset) + "-")):
                    offset = 0
                print(json.dumps({"phase": "download", "version": version, "reusedPartialBytes": offset, "totalBytes": metadata["size"]}), flush=True)
                with partial.open("ab" if offset else "wb") as output:
                    while True:
                        remaining(); part = response.read(65536)
                        if not part:
                            break
                        if output.tell() + len(part) > metadata["size"]:
                            raise RuntimeError("uv download exceeds its declared size")
                        output.write(part); output.flush(); downloaded += len(part)
                    os.fsync(output.fileno())
            if partial.stat().st_size != metadata["size"] or hashlib.sha256(partial.read_bytes()).hexdigest() != metadata["sha256"]:
                raise RuntimeError("uv material is incomplete or failed its SHA-256 check; original material retained")
            os.replace(partial, wheel)
        with zipfile.ZipFile(wheel) as archive:
            from email.parser import Parser
            names = archive.namelist()
            identity = [name for name in names if name.endswith(".dist-info/METADATA") and name.count("/") == 1]
            if len(identity) != 1:
                raise RuntimeError("uv wheel metadata is ambiguous")
            package = Parser().parsestr(archive.read(identity[0]).decode())
            if package["Name"].lower() != "uv" or package["Version"] != version:
                raise RuntimeError("uv wheel package identity does not match its manifest")
            binaries = {}
            for name in ["uv", "uvx"]:
                distribution = identity[0].split("/", 1)[0].removesuffix(".dist-info")
                entries = [entry for entry in ["uv/" + name, distribution + ".data/scripts/" + name] if entry in names]
                if len(entries) != 1:
                    raise RuntimeError("uv wheel is missing its expected executable")
                binaries[name] = archive.read(entries[0])
            binary.parent.mkdir(mode=0o700, exist_ok=True)
            if binary.parent.is_symlink():
                raise RuntimeError("uv binary directory cannot be a symbolic link")
            for name, content in binaries.items():
                fd, incoming = tempfile.mkstemp(prefix=".uv-", dir=binary.parent)
                try:
                    with os.fdopen(fd, "wb") as output:
                        output.write(content); output.flush(); os.fsync(output.fileno())
                    os.chmod(incoming, 0o755); os.replace(incoming, binary.parent / name)
                finally:
                    if os.path.exists(incoming):
                        os.unlink(incoming)
        actual = subprocess.check_output([str(binary), "--version"], text=True).split()
        if len(actual) < 2 or actual[1] != version:
            raise RuntimeError("Installed uv version does not match the selected release")
        save(published, {"format": 1, "version": version, "uvSHA256": hashlib.sha256(binary.read_bytes()).hexdigest(), "wheelSHA256": metadata["sha256"]})
        print(json.dumps({"ready": True, "version": version, "reused": downloaded == 0, "downloadBytes": downloaded,
                          "materialSHA256": metadata["sha256"], "pathEntries": [str(binary.parent)]}), flush=True)


def process(pid):
    try:
        fields = pathlib.Path("/proc", str(pid), "stat").read_text().rsplit(")", 1)[1].split()
        return {"pid": pid, "state": fields[0], "group": int(fields[2]), "session": int(fields[3]), "start": fields[19]}
    except FileNotFoundError:
        return None


def members(identity):
    boot = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    if boot != identity["bootId"]:
        return []
    leader = process(identity["pid"])
    if leader is not None and leader["start"] != identity["start"]:
        raise RuntimeError("Preparation PID was reused; refusing to signal it")
    found = []
    for path in pathlib.Path("/proc").iterdir():
        if not path.name.isdigit():
            continue
        item = process(int(path.name))
        if item and item["state"] != "Z" and item["group"] == identity["group"]:
            if item["session"] != identity["pid"] or int(item["start"]) < int(identity["start"]):
                raise RuntimeError("Preparation process group identity changed")
            found.append(item)
    return found


def stop_group(root, grace, poll_ms):
    identity_file = root / "process.v1.json"
    if not identity_file.exists():
        return False
    identity = load(identity_file)
    if not members(identity):
        return True
    os.killpg(identity["group"], signal.SIGTERM)
    end = time.monotonic() + grace / 1000
    while members(identity) and time.monotonic() < end:
        time.sleep(min(poll_ms / 1000, max(0, end - time.monotonic())))
    if members(identity):
        os.killpg(identity["group"], signal.SIGKILL)
    return not members(identity)


def journal(root, final=False):
    with open(root / "logs.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        cursor = load(root / "logs.v1.json") if (root / "logs.v1.json").exists() else {"version": 1, "seq": 0, "streams": {}}
        with open(root / "events.jsonl", "a") as events:
            for stream in ["stdout", "stderr"]:
                previous = cursor["streams"].get(stream, {"offset": 0, "pending": ""})
                path = root / (stream + ".log")
                if not path.exists():
                    continue
                with path.open("rb") as source:
                    source.seek(previous["offset"]); data = source.read(65536)
                decoder = codecs.getincrementaldecoder("utf8")("replace")
                decoder.setstate((base64.b64decode(previous["pending"]), 0))
                text = decoder.decode(data, final and path.stat().st_size == previous["offset"] + len(data))
                for start in range(0, len(text), 4096):
                    row = {"seq": cursor["seq"], "time": int(time.time() * 1000), "stream": stream, "text": text[start:start + 4096]}
                    events.write(json.dumps(row) + "\n"); cursor["seq"] += 1
                cursor["streams"][stream] = {"offset": previous["offset"] + len(data), "pending": base64.b64encode(decoder.getstate()[0]).decode()}
            events.flush(); os.fsync(events.fileno())
        save(root / "logs.v1.json", cursor)
        return all(not (root / (name + ".log")).exists() or (root / (name + ".log")).stat().st_size == cursor["streams"].get(name, {}).get("offset", 0) for name in ["stdout", "stderr"])


def run(root, request):
    with open(root / "supervisor.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        started = time.time()
        state = {"version": 1, "experimentId": request["experimentId"], "serverId": request["serverId"], "commandId": request["commandId"],
                 "sessionId": request["sessionId"], "toolCallId": request["toolCallId"],
                 "startedAt": int(started * 1000), "deadline": int(started * 1000) + request["timeoutMs"], "exitConfirmed": False,
                 "exitCode": None, "timedOut": False, "cancelled": False, "signal": None}
        supervisor = process(os.getpid()); supervisor["bootId"] = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        state["supervisor"] = supervisor
        save(root / "status.v1.json", state)
        child = None
        try:
            with open(root / "stdout.log", "ab", buffering=0) as out, open(root / "stderr.log", "ab", buffering=0) as err:
                child = subprocess.Popen([sys.executable, "-B", "-I", __file__, "exec", str(root)], stdin=subprocess.DEVNULL,
                                         stdout=out, stderr=err, start_new_session=True)
            identity = process(child.pid)
            if identity is not None:
                identity["bootId"] = supervisor["bootId"]; save(root / "process.v1.json", identity)
            until = time.monotonic() + request["timeoutMs"] / 1000
            while child.poll() is None:
                journal(root)
                cancelled = (root / "cancel-requested").exists()
                expired = time.monotonic() >= until
                if cancelled or expired:
                    state["cancelled"] = state["cancelled"] or cancelled
                    state["timedOut"] = state["timedOut"] or expired
                    if (root / "process.v1.json").exists():
                        stop_group(root, request["stopGraceMs"], request["pollIntervalMs"])
                    else:
                        state["reason"] = "Command launch identity is unavailable; exit remains unconfirmed"
                        break
                time.sleep(request["pollIntervalMs"] / 1000)
            if child.poll() is not None:
                code = child.wait()
                state["exitCode"] = code if code >= 0 else 128 - code
                state["signal"] = signal.Signals(-code).name if code < 0 else None
                if (root / "process.v1.json").exists():
                    identity = load(root / "process.v1.json")
                    if members(identity):
                        stop_group(root, request["stopGraceMs"], request["pollIntervalMs"])
                    state["exitConfirmed"] = not members(identity)
                else:
                    state["reason"] = "Command exited without its launch identity"
        except BaseException as error:
            state["reason"] = str(error)
            if child is not None and (root / "process.v1.json").exists():
                stop_group(root, request["stopGraceMs"], request["pollIntervalMs"])
        finally:
            while not journal(root, final=state["exitConfirmed"]):
                pass
            state["finishedAt"] = int(time.time() * 1000)
            if state["exitConfirmed"] and not (root / "sandbox-repair-unconfirmed").exists():
                save(root / "exited", state["exitCode"], plain=True)
            save(root / "status.v1.json", state)


def main():
    mode, root_arg = sys.argv[1:3]
    root = pathlib.Path(root_arg)
    if root.is_symlink() or not root.is_dir():
        raise RuntimeError("Preparation directory is unavailable or is a symbolic link")
    request = load(root / "request.v1.json")
    if request["version"] != 1 or root.name != request["commandId"] or root.parent.name != request["serverId"] or root.parent.parent.name != request["experimentId"]:
        raise RuntimeError("Preparation command belongs to another experiment or node")
    if mode == "exec":
        identity = process(os.getpid()); identity["bootId"] = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        save(root / "process.v1.json", identity)
        environment = {key: value for key, value in os.environ.items() if not any(word in key.upper() for word in ["PASSWORD", "SECRET", "TOKEN", "KEY"])}
        environment.update(ASPERA_PREPARATION_COMMAND_DIRECTORY=str(root), ASPERA_PREPARATION_SESSION_ID=request["sessionId"],
                           ASPERA_PREPARATION_TOOL_CALL_ID=request["toolCallId"], ASPERA_PREPARATION_REMAINING_MS=str(request["timeoutMs"]),
                           ASPERA_PREPARATION_CACHE_DIRECTORY=request["cacheDirectory"],
                           ASPERA_PREPARATION_DEADLINE_MS=str(load(root / "status.v1.json")["deadline"]))
        os.execve("/bin/sh", ["sh", "-c", request["command"]], environment)
    elif mode == "uv":
        prepare_uv(root, request)
    elif mode == "supervise":
        run(root, request)
    elif mode == "start":
        subprocess.Popen([sys.executable, "-B", "-I", __file__, "supervise", str(root)], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    elif mode in ["read", "stop", "follow"]:
        if mode == "stop":
            (root / "cancel-requested").touch(mode=0o600, exist_ok=True)
        if mode == "follow":
            while not (root / "exited").exists():
                state = load(root / "status.v1.json") if (root / "status.v1.json").exists() else {}
                if "finishedAt" in state:
                    return 125
                if state.get("supervisor"):
                    actual = process(state["supervisor"]["pid"])
                    if actual is None or actual["start"] != state["supervisor"]["start"] or actual["state"] == "Z":
                        return 125
                time.sleep(request["pollIntervalMs"] / 1000)
            return int((root / "exited").read_text().strip())
        state = load(root / "status.v1.json") if (root / "status.v1.json").exists() else {
            "version": 1, "experimentId": request["experimentId"], "serverId": request["serverId"], "commandId": request["commandId"],
            "sessionId": request["sessionId"], "toolCallId": request["toolCallId"],
            "exitConfirmed": False, "exitCode": None, "timedOut": False, "cancelled": False, "signal": None}
        if state["exitConfirmed"]:
            state["exitConfirmed"] = (root / "exited").exists() and (root / "exited").read_text().strip() == str(state["exitCode"]) and not members(load(root / "process.v1.json"))
        if not state["exitConfirmed"] and state.get("supervisor") and "finishedAt" not in state:
            supervisor = state["supervisor"]; actual = process(supervisor["pid"])
            if actual is None or actual["start"] != supervisor["start"] or actual["state"] == "Z":
                state["supervisorMissing"] = True; state["reason"] = "Original supervisor is unavailable; command exit is unconfirmed"
        offset = int(sys.argv[3]) if len(sys.argv) > 3 else 0
        rows = []; end = offset
        if (root / "events.jsonl").exists():
            with open(root / "events.jsonl", "rb") as source:
                source.seek(offset)
                while source.tell() - offset < 65536:
                    line = source.readline()
                    if not line or not line.endswith(b"\n"):
                        break
                    rows.append(json.loads(line)); end = source.tell()
        print(json.dumps({"status": state, "offset": end, "lines": rows,
                          "hasMore": (root / "events.jsonl").exists() and (root / "events.jsonl").stat().st_size > end}))
    else:
        raise RuntimeError("Unsupported preparation command operation")
    return 0


if __name__ == "__main__":
    sys.exit(main())
