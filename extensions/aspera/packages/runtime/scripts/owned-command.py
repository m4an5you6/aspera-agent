"""Publish Linux process-group ownership before executing the unchanged sandbox argv."""
import json
import os
import pathlib
import sys
import tempfile
import fcntl

path = pathlib.Path(sys.argv[1])
binding = json.loads(sys.argv[2])
control = pathlib.Path(binding["controlRoot"])
lock = control / "state/controller-admission.lock"
handle = open(lock, "a")
os.chmod(lock, 0o600)
fcntl.flock(handle, fcntl.LOCK_EX)
if ((control / "state/interruption-fences" / (binding["experimentId"] + ".json")).exists() and not binding.get("cacheCleanup")) or (control / "state/controller-recovery.json").exists():
    raise RuntimeError("Experiment admission is fenced before process launch")
environment_fence = control / "state/environment-fences" / (binding["experimentId"] + ".json")
if environment_fence.exists():
    if environment_fence.is_symlink():
        raise RuntimeError("Environment admission marker cannot be a symbolic link")
    marker = json.loads(environment_fence.read_text())
    if marker["operationId"] != binding.get("environmentOperation") or binding.get("commandId") != marker["commandId"]:
        raise RuntimeError("Environment mutation prevents experiment command launch")
path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
for part in [path, path.parent]:
    if part.is_symlink():
        raise RuntimeError("Command process identity cannot be a symbolic link")
if path.exists():
    raise RuntimeError("Command process identity already exists")
fields = pathlib.Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split()
value = {"version": 1, **binding, "pid": os.getpid(), "group": os.getpgrp(), "start": fields[19],
         "hostBootId": pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()}
fd, incoming = tempfile.mkstemp(prefix=".incoming-", dir=path.parent)
with os.fdopen(fd, "w") as stream:
    json.dump(value, stream); stream.write("\n"); stream.flush(); os.fsync(stream.fileno())
os.replace(incoming, path)
directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
os.execvp(sys.argv[3], sys.argv[3:])
