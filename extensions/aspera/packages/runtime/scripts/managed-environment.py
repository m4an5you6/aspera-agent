"""Own immutable wheel payloads, environment references and confined installation operations."""
import base64
import contextlib
import copy
import csv
import email
import errno
import fcntl
import hashlib
import io
import json
import os
import pathlib
import platform
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile


def storage_governance(owner):
    if "environment_arrangement" not in globals():
        source = pathlib.Path(__file__).with_name("storage-placement.py")
        exec(compile(source.read_text(), str(source), "exec"), globals())
    if "StorageGovernance" not in globals():
        source = pathlib.Path(__file__).with_name("storage-governance.py")
        exec(compile(source.read_text(), str(source), "exec"), globals())
    if not hasattr(owner, "_storage_governance"):
        owner._storage_governance = StorageGovernance(owner)
    return owner._storage_governance


# The private installer supplies parsers; its Python version and ABI match the training interpreter.
WHEEL_NAMES = r'''
import json, sys
from pip._vendor.packaging.tags import parse_tag, sys_tags
from pip._vendor.packaging.utils import canonicalize_name, parse_wheel_filename
from pip._vendor.packaging.version import Version
result = {}
priority = list(sys_tags())
for item in json.load(open(sys.argv[1])):
    try:
        declared = set().union(*(parse_tag(tag) for tag in item['tags']))
        compatible = next((tag for tag in priority if tag in declared), None)
        if compatible is None:
            raise ValueError('Wheel metadata has no compatible target interpreter tag')
        name, version, build, filename_tags = parse_wheel_filename(item['filename'])
        if name != canonicalize_name(item['name']) or version != Version(item['version']):
            raise ValueError('Wheel filename package identity differs from METADATA')
        build_text = item.get('build')
        declared_build = parse_wheel_filename(item['name'].replace('-', '_') + '-' + item['version'] + '-' + build_text + '-' + str(compatible) + '.whl')[2] if build_text else ()
        if build_text and build and build != declared_build:
            raise ValueError('Wheel filename build differs from WHEEL')
        legacy = item['filename'] == item['name'].replace('-', '_') + '-' + item['version'] + '-' + item['tags'][0] + '.whl'
        if filename_tags == declared and (not build_text or build):
            filename = item['filename']
        elif legacy and filename_tags.issubset(declared):
            filename = item['name'].replace('-', '_') + '-' + item['version'] + ('-' + build_text if build_text else '') + '-' + str(compatible) + '.whl'
            alias_name, alias_version, _, alias_tags = parse_wheel_filename(filename)
            if alias_name != name or alias_version != version or not alias_tags.issubset(declared):
                raise ValueError('Historical wheel alias changed its declared identity')
        else:
            raise ValueError('Wheel filename tags differ from its complete WHEEL tags')
        result[item['hash']] = {'filename': filename}
    except (ValueError, TypeError) as error:
        result[item['hash']] = {'error': str(error)}
print(json.dumps(result))
'''

REQUIREMENTS_SATISFIED = r'''
import importlib.metadata, json, sys
from pip._vendor.packaging.requirements import Requirement
from pip._vendor.packaging.utils import canonicalize_name
requirements, recorded = json.loads(sys.argv[1]), json.loads(sys.argv[2])
installed = {canonicalize_name(d.metadata['Name']): d.version for d in importlib.metadata.distributions(path=[sys.argv[3]])}
satisfied = True
for text in requirements:
    requirement = Requirement(text)
    if requirement.marker and not requirement.marker.evaluate():
        continue
    version = installed.get(canonicalize_name(requirement.name))
    if version is None:
        satisfied = False
        continue
    if not requirement.specifier.contains(version, prereleases=True):
        satisfied = False
    # URL origins and extras need their saved resolution, not a matching version alone.
    if (requirement.url or requirement.extras) and text not in recorded:
        satisfied = False
print(json.dumps(satisfied))
'''

NORMALIZE_REQUIREMENTS = r'''
import json,sys
from pip._vendor.packaging.requirements import Requirement
from pip._vendor.packaging.utils import canonicalize_name
result = []
for text in json.loads(sys.argv[1]):
    item = Requirement(text)
    item.name = canonicalize_name(item.name)
    result.append(str(item))
print(json.dumps(sorted(set(result))))
'''


class DependencyConflict(RuntimeError):
    """A known package/file collision persists until its relevant inputs change."""
    def __init__(self, path, packages, detail):
        self.path, self.packages = relative(path), sorted(set(packages))
        super().__init__("Shared dependency conflicts with installed contents: " + path + ": " + detail)


class UnchangedInstallationFailure(RuntimeError):
    """Reject another full installation without changing the original failure receipt."""
    def __init__(self, failure):
        self.failure = failure
        super().__init__("Unresolved dependency conflict from original operation " + failure["operationId"]
            + "; changing operation ID or create/install does not repair it. " + failure["detail"])


def now():
    return int(time.time() * 1000)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def file_hash(path):
    value = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def sync_file(path):
    with open(path, "rb") as stream:
        os.fsync(stream.fileno())


def reject_links(path):
    path = pathlib.Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise RuntimeError("Managed storage requires a normalized absolute path")
    for part in [*reversed(path.parents), path]:
        if part.is_symlink():
            raise RuntimeError("Managed directory contains a symbolic link: " + str(part))


def relative(value):
    if not isinstance(value, str) or not value or value.startswith("/") or any(c in value for c in "\\\0\r\n") or any(p in ("", ".", "..") for p in value.split("/")):
        raise RuntimeError("Managed file path escapes its registered directory")
    return value


def load(path):
    reject_links(path)
    with open(path) as stream:
        return json.load(stream)


def save(path, value):
    path = pathlib.Path(path)
    reject_links(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, incoming = tempfile.mkstemp(prefix=".incoming-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, sort_keys=True); stream.write("\n"); stream.flush(); os.fsync(stream.fileno())
        os.replace(incoming, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if os.path.exists(incoming):
            os.unlink(incoming)


def allocated(path, seen=None):
    seen = set() if seen is None else seen
    if not pathlib.Path(path).exists():
        return 0
    total = 0
    for current, dirs, files in os.walk(path, followlinks=False):
        dirs[:] = [name for name in dirs if not (pathlib.Path(current) / name).is_symlink()]
        for name in files:
            st = (pathlib.Path(current) / name).lstat()
            if stat.S_ISREG(st.st_mode) and (st.st_dev, st.st_ino) not in seen:
                seen.add((st.st_dev, st.st_ino)); total += st.st_blocks * 512
    return total


class CleanupSafetyError(RuntimeError):
    """Identity failures block execution even after an environment has been verified."""
    def __init__(self, path, stage, detail, observed=None, expected=None):
        self.diagnostic = {"path": str(path), "stage": stage, "detail": detail}
        for prefix, value in (("", observed), ("expected", expected)):
            if value is not None:
                self.diagnostic[(prefix + "MountId") if prefix else "mountId"] = value[0]
                self.diagnostic[(prefix + "Device") if prefix else "device"] = value[1]
        super().__init__("Cleanup safety check failed: " + json.dumps(self.diagnostic, sort_keys=True))


class CleanupIoError(OSError):
    """A failed unlink after identity validation leaves eligible private files pending."""
    def __init__(self, path, error, identity=None):
        self.diagnostic = {"path": str(path), "stage": "unlink", "detail": str(error)}
        if identity is not None:
            self.diagnostic.update(mountId=identity[0], device=identity[1])
        super().__init__(error.errno, "Private temporary cleanup failed: " + str(path) + ": " + str(error))


def fd_identity(fd, path, stage):
    """Mount IDs authorize only the current descriptor traversal, never a later operation."""
    observed = os.fstat(fd)
    try:
        rows = pathlib.Path("/proc/self/fdinfo/" + str(fd)).read_text().splitlines()
        values = [line.split(":", 1)[1].strip() for line in rows if line.startswith("mnt_id:")]
        if len(values) != 1 or not values[0].isdigit():
            raise ValueError("mnt_id is unavailable")
        return (int(values[0]), observed.st_dev, observed.st_ino, stat.S_IFMT(observed.st_mode))
    except (OSError, ValueError) as error:
        raise CleanupSafetyError(path, stage, "Mount identity cannot be read: " + str(error), (None, observed.st_dev)) from error


def remove_private(path, root, ownership_check=None):
    """Delete beneath anchored descriptors; mount crossings and replaced entries are rejected."""
    path, root = pathlib.Path(path), pathlib.Path(root)
    if not path.is_absolute() or not root.is_absolute() or ".." in path.parts or ".." in root.parts or path == root or root not in path.parents:
        raise CleanupSafetyError(path, "scope", "Cleanup target is outside its owned directory")
    flags = os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC
    with contextlib.ExitStack() as stack:
        anchors = []
        def opened(parent, name, display, missing=False):
            try:
                fd = os.open(name, flags, dir_fd=parent)
            except FileNotFoundError:
                if missing:
                    return None
                raise CleanupSafetyError(display, "open", "Directory entry disappeared during cleanup")
            stack.callback(os.close, fd)
            return fd
        parent = opened(None, "/", "/")
        display = pathlib.Path("/")
        for part in root.parts[1:]:
            display /= part
            fd = opened(parent, part, display)
            identity = fd_identity(fd, display, "anchor")
            if identity[3] != stat.S_IFDIR:
                raise CleanupSafetyError(display, "anchor", "Owned directory contains a symbolic link or non-directory", identity)
            anchors.append((parent, part, fd, identity, display)); parent = fd
        root_identity = fd_identity(parent, root, "root")
        for part in path.relative_to(root).parts[:-1]:
            display /= part
            fd = opened(parent, part, display)
            identity = fd_identity(fd, display, "anchor")
            if identity[3] != stat.S_IFDIR or identity[0] != root_identity[0]:
                raise CleanupSafetyError(display, "anchor", "Cleanup traverses a link or nested mount", identity, root_identity)
            anchors.append((parent, part, fd, identity, display)); parent = fd
        name = path.name
        target = opened(parent, name, path, missing=True)
        if target is None:
            if ownership_check is not None:
                ownership_check()
            for base, part, fd, identity, entry in anchors:
                probe = opened(base, part, entry)
                observed = fd_identity(probe, entry, "missing-target-recheck")
                if observed != identity or fd_identity(fd, entry, "missing-target-recheck") != identity:
                    raise CleanupSafetyError(entry, "missing-target-recheck", "Owned directory was replaced", observed, identity)
            return
        snapshot = {}
        def checked(fd, entry, stage):
            identity = fd_identity(fd, entry, stage)
            if identity[0] != root_identity[0]:
                raise CleanupSafetyError(entry, stage, "Cleanup target contains a mounted filesystem", identity, root_identity)
            if stage == "scan":
                snapshot[str(entry)] = identity
            elif snapshot.get(str(entry)) != identity:
                raise CleanupSafetyError(entry, stage, "Directory entry identity changed", identity, snapshot.get(str(entry)))
            return identity
        def validate_anchors():
            if ownership_check is not None:
                ownership_check()
            for base, part, fd, identity, entry in anchors:
                with contextlib.ExitStack() as probe:
                    observed_fd = os.open(part, flags, dir_fd=base); probe.callback(os.close, observed_fd)
                    observed = fd_identity(observed_fd, entry, "anchor-recheck")
                    if observed != identity or fd_identity(fd, entry, "anchor-recheck") != identity:
                        raise CleanupSafetyError(entry, "anchor-recheck", "Owned directory was replaced", observed, identity)
        def walk(base, part, fd, entry, delete):
            identity = checked(fd, entry, "delete" if delete else "scan")
            with contextlib.ExitStack() as children:
                if identity[3] == stat.S_IFDIR:
                    readable = os.open(".", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                    children.callback(os.close, readable)
                    if fd_identity(readable, entry, "directory-open") != identity:
                        raise CleanupSafetyError(entry, "directory-open", "Directory changed while opening", expected=identity)
                    names = sorted(os.listdir(readable))
                    if delete and names != snapshot[(str(entry), "children")]:
                        raise CleanupSafetyError(entry, "delete", "Directory contents changed after inspection", identity)
                    if not delete:
                        snapshot[(str(entry), "children")] = names
                    anchors.append((base, part, fd, identity, entry))
                    try:
                        for child in names:
                            child_fd = os.open(child, flags, dir_fd=readable)
                            try:
                                walk(readable, child, child_fd, entry / child, delete)
                            finally:
                                os.close(child_fd)
                    finally:
                        anchors.pop()
                if delete:
                    validate_anchors()
                    probe = os.open(part, flags, dir_fd=base); children.callback(os.close, probe)
                    checked(probe, entry, "unlink-recheck")
                    try:
                        if identity[3] == stat.S_IFDIR:
                            os.rmdir(part, dir_fd=base)
                        else:
                            os.unlink(part, dir_fd=base)
                    except OSError as error:
                        if error.errno in (errno.ENOENT, errno.ENOTEMPTY, errno.EBUSY):
                            raise CleanupSafetyError(entry, "unlink", "Entry disappeared, changed or became a mount", identity) from error
                        validate_anchors()
                        checked(probe, entry, "unlink-recheck")
                        raise CleanupIoError(entry, error, identity) from error
        try:
            walk(parent, name, target, path, False)
        except OSError as error:
            raise CleanupSafetyError(path, "scan", "Cleanup tree cannot be inspected: " + str(error)) from error
        validate_anchors()
        try:
            walk(parent, name, target, path, True)
        except FileNotFoundError as error:
            raise CleanupSafetyError(path, "delete", "Directory entry disappeared after inspection") from error
        except OSError as error:
            if isinstance(error, CleanupIoError):
                raise
            raise CleanupSafetyError(path, "delete", "Cleanup identity cannot be rechecked: " + str(error)) from error


def empty_sharing():
    return dict(hardlinkBytes=0, cloneBytes=0, copyBytes=0, logicalBytes=0, allocatedBytes=0, addedBytes=0, estimatedCopyBytes=0, reasons=[])


def locked_requirements(text):
    rows = []
    for line in re.sub(r"\\\s*\n", " ", text).splitlines():
        line = re.split(r"\s+#", line.strip(), maxsplit=1)[0]
        if not line or line.startswith("#"):
            continue
        match = re.match(r"([A-Za-z0-9_.-]+)(?:\[[^]]+\])?(?:==([^\s;]+)|\s+@\s+\S+)", line)
        hashes = re.findall(r"--hash=sha256:([a-f0-9]{64})", line)
        if not match or not hashes:
            raise RuntimeError("Resolved dependency lacks an exact version or source digest: " + line[:200])
        rows.append({"name": match[1], "version": match[2] or "source", "hashes": hashes, "requirement": line})
    return rows


def package_name(value):
    return re.sub(r"[-_.]+", "-", value).lower()


class Environments:
    def __init__(self, config):
        self.config = config
        self.placement = config["placement"]
        self.id, self.server = self.placement["experimentId"], self.placement["serverId"]
        self.namespace = pathlib.Path(self.placement["namespaceRoot"])
        self.run = pathlib.Path(self.placement["runRoot"])
        self.workspace = pathlib.Path(self.placement["workspaceRoot"])
        self.control = pathlib.Path(self.placement["controlRoot"])
        if self.run != self.namespace / "runs" / self.id or self.workspace != self.run / "workspace":
            raise RuntimeError("Environment storage differs from the saved submission")
        for path in [self.namespace, self.run, self.workspace, self.control]:
            reject_links(path)
        self.store = self.namespace / "packages-v1"
        self.manifests = self.run / "environments-v1"
        self.operations = self.run / "environment-operations-v1"
        self.objects = self.store / "objects"
        self.references = self.store / "references"
        self.materials = self.store / "materials"
        self.resolutions = self.store / "resolutions"
        self.material_references = self.store / "material-references"
        self.cleanups = self.run / "environment-cleanups-v1"
        self.recoveries = self.run / "environment-recoveries-v1"
        self.policy = {**config["policy"], "legacyEntryLimit": config["policy"].get("legacyEntryLimit", config["policy"]["maxPackageFiles"])}
        self.expanded_limit = self.policy.get("maxPackageBytes")
        if (self.run / "storage-arrangement.v1.json").exists():
            storage_governance(self)
            apply_environment_arrangement(self)

    def owner(self, missing=False):
        if missing and not self.run.exists():
            return
        if load(self.run / ".aspera-owner.json") != {"version": 1, "serverId": self.server, "experimentId": self.id}:
            raise RuntimeError("Experiment environment directory ownership differs")
        data_workspace = pathlib.Path(self.placement["workspaceRoot"])
        if self.workspace != data_workspace:
            environment_arrangement(self)
        if self.config.get("governancePolicy") and self.placement.get("candidate"):
            observed = storage_governance(self).mount(data_workspace)
            original = self.placement["candidate"]["mount"]
            if observed["source"] != original["source"] or observed["filesystem"] != original["filesystem"] or observed["directory"] != original["mountPoint"]:
                raise RuntimeError("Original data workspace filesystem changed")
        for path in (data_workspace, self.namespace):
            reject_links(path)
        with contextlib.ExitStack() as stack:
            observations = []
            for path in (data_workspace, self.namespace):
                fd = os.open(path, os.O_PATH | os.O_NOFOLLOW | os.O_DIRECTORY); stack.callback(os.close, fd)
                observations.append(fd_identity(fd, path, "ownership"))
            if observations[0][0] != observations[1][0]:
                raise CleanupSafetyError(self.workspace, "ownership", "Environment workspace is on another mount", observations[0], observations[1])

    @contextlib.contextmanager
    def locked(self, write=False):
        self.inspection_busy = False
        self.owner()
        reject_links(self.store)
        if write:
            self.store.mkdir(mode=0o700, exist_ok=True)
            marker = self.store / "owner.v1.json"
            if marker.exists():
                if load(marker) != {"version": 1, "serverId": self.server}:
                    raise RuntimeError("Package store belongs to another server")
            elif list(self.store.iterdir()):
                raise RuntimeError("Refusing a nonempty unowned package store")
            else:
                save(marker, {"version": 1, "serverId": self.server})
            for folder in [self.objects, self.references, self.operations, self.manifests, self.materials, self.resolutions, self.material_references, self.cleanups, self.recoveries]:
                reject_links(folder); folder.mkdir(mode=0o700, exist_ok=True)
        if not self.store.exists():
            yield
            return
        if load(self.store / "owner.v1.json") != {"version": 1, "serverId": self.server}:
            raise RuntimeError("Package store ownership differs")
        lock = self.store / "lock"
        reject_links(lock)
        if not write and not lock.exists():
            raise RuntimeError("Package store lock is missing")
        with open(lock, "a" if write else "r") as handle:
            try:
                fcntl.flock(handle, (fcntl.LOCK_EX if write else fcntl.LOCK_SH) | fcntl.LOCK_NB)
            except BlockingIOError:
                if write or self.config.get("action") != "inspect":
                    raise RuntimeError("Another environment operation holds the server package lock; inspect its receipt")
                self.inspection_busy = True
            yield

    def free(self, needed=0):
        available = shutil.disk_usage(self.workspace).free
        reserve = max(self.placement["minimumFreeBytes"], self.policy["minimumFreeBytes"])
        if available < reserve + needed:
            raise RuntimeError(f"Environment needs {needed} additional bytes; {available} available, {reserve} reserved")
        if self.config.get("governancePolicy"):
            governance = storage_governance(self)
            with governance.locked():
                governance.reserve_environment(needed)
        return available

    def free_for_path(self, path, needed=0):
        reserve = max(self.placement["minimumFreeBytes"], self.policy["minimumFreeBytes"])
        if self.config.get("governancePolicy"):
            reserve = reserve_bytes(storage_governance(self), path)
        available = shutil.disk_usage(path).free
        if available < reserve + needed:
            raise RuntimeError(f"Storage at {path} needs {needed} bytes; {available} available and {reserve} reserved")
        return available

    def environment(self, name):
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", name):
            raise RuntimeError("Invalid environment identity")
        path = self.manifests / (name + ".json")
        if not path.exists():
            return None
        value = load(path)
        if value["version"] != 1 or value["experimentId"] != self.id or value["serverId"] != self.server or value["environmentId"] != name:
            raise RuntimeError("Environment manifest belongs to another experiment")
        directory = pathlib.Path(value["directory"])
        reject_links(directory)
        if self.workspace not in directory.parents:
            raise RuntimeError("Environment manifest escaped the workspace")
        return value

    def records(self):
        if not self.objects.exists():
            return []
        values = []
        for folder in sorted(self.objects.iterdir()):
            if not re.fullmatch(r"[a-f0-9]{64}", folder.name):
                raise RuntimeError("Unknown package store entry")
            value = load(folder / "record.v1.json")
            if value["id"] != folder.name or value["version"] != 1:
                raise RuntimeError("Package store identity differs")
            values.append(value)
        return values

    def refs(self):
        if not self.references.exists():
            return []
        values = []
        for path in self.references.glob("*.json"):
            item = load(path)
            if item["version"] != 1 or item["serverId"] != self.server:
                raise RuntimeError("Package reference identity differs")
            directory = pathlib.Path(item["directory"])
            manifest = pathlib.Path(item["manifest"])
            reject_links(directory); reject_links(manifest)
            expected = self.namespace / "runs" / item["experimentId"]
            if self.workspace != pathlib.Path(self.placement["workspaceRoot"]):
                expected = manifest.parent.parent
                if expected.name != item["experimentId"] or expected.parent.name != "runs" or load(expected / ".aspera-owner.json") != {"version": 1, "serverId": self.server, "experimentId": item["experimentId"]}:
                    raise RuntimeError("Training package reference source owner differs")
                allowed = source_training_workspace(self, expected)
            else:
                allowed = expected / "workspace"
            if allowed not in directory.parents or manifest.parent != expected / "environments-v1":
                raise RuntimeError("Package reference escaped its original experiment")
            if not directory.exists() or not manifest.exists():
                raise RuntimeError("Package reference requires confirmed environment deletion: " + item["experimentId"])
            declared = load(manifest)
            if declared["experimentId"] != item["experimentId"] or declared["serverId"] != self.server or declared["environmentId"] != item["environmentId"] or declared["directory"] != str(directory):
                raise RuntimeError("Package reference differs from its environment manifest")
            expected_packages = {package["id"] for package in declared["packages"]}
            if not expected_packages.issubset(set(item["packages"])) or any(not re.fullmatch(r"[a-f0-9]{64}", package) for package in item["packages"]):
                raise RuntimeError("Package reference omits a registered dependency")
            values.append(item)
        return values

    def reference_path(self, name):
        return self.references / (digest([self.id, self.server, name]) + ".json")

    def write_reference(self, environment, packages=None):
        held = set(packages if packages is not None else [p["id"] for p in environment["packages"]])
        for record in self.cleanup_records():
            if record["environmentId"] == environment["environmentId"] and record["state"] != "completed":
                held.update(record["packages"])
        save(self.reference_path(environment["environmentId"]), {"version": 1, "serverId": self.server, "experimentId": self.id,
            "environmentId": environment["environmentId"], "directory": environment["directory"],
            "manifest": str(self.manifests / (environment["environmentId"] + ".json")),
            "packages": sorted(held)})

    def cleanup_records(self):
        rows = [load(path) for path in sorted(self.cleanups.glob("*.json"))]
        for row in rows:
            expected = self.workspace / "tmp" / ("environment-" + row["operationId"])
            if row.get("version") != 1 or row["experimentId"] != self.id or row["serverId"] != self.server or row["paths"] != [str(expected)]:
                raise RuntimeError("Temporary cleanup record ownership differs")
        return rows

    def cleanup_work(self, operation_id, environment):
        """References and hidden residue remain registered until physical deletion completes."""
        op = self.operations / operation_id
        work = self.workspace / "tmp" / ("environment-" + operation_id)
        path = self.cleanups / (operation_id + ".json")
        record = load(path) if path.exists() else {"version": 1, "experimentId": self.id, "serverId": self.server,
            "operationId": operation_id, "environmentId": environment["environmentId"], "generation": environment["generation"],
            "paths": [str(work)], "packages": [p["id"] for p in environment["packages"]], "createdAt": now()}
        if record["experimentId"] != self.id or record["serverId"] != self.server or record["paths"] != [str(work)]:
            raise RuntimeError("Temporary cleanup identity differs")
        journal = op / "publication.v1.json"
        if journal.exists():
            published = load(journal)
            record["packages"] = sorted(set(record["packages"] + [p["id"] for generation in (published.get("previous"), published.get("next")) if generation for p in generation["packages"]]))
        record.update(state="pending", updatedAt=now())
        save(path, record)
        self.write_reference(environment)
        try:
            remove_private(work, self.workspace, self.owner)
        except CleanupIoError as error:
            record.update(state="pending", updatedAt=now(), detail=str(error), diagnostic=error.diagnostic)
            save(path, record)
            return record
        except CleanupSafetyError as error:
            record.update(state="blocked", updatedAt=now(), detail=str(error), diagnostic=error.diagnostic)
            save(path, record)
            raise
        record.update(state="completed", updatedAt=now())
        record.pop("detail", None); record.pop("diagnostic", None)
        save(path, record)
        (self.material_references / (self.id + "-" + operation_id + ".json")).unlink(missing_ok=True)
        self.write_reference(environment)
        return record

    def candidates(self):
        refs = self.refs()
        held = {package for row in refs for package in row["packages"]}
        rows = []
        for package in self.records():
            if package["id"] in held:
                continue
            folder = self.objects / package["id"]
            if any(path.stat().st_nlink > 1 for path in (folder / "payload").rglob("*") if path.is_file()):
                continue
            rows.append({"id": package["id"], "kind": "package", "bytes": allocated(folder), "reason": "No environment reference or external hard link"})
        held_materials = {package["wheelHash"] for package in self.records() if package["id"] in held}
        if self.material_references.exists():
            for path in self.material_references.glob("*.json"):
                lease = load(path)
                if lease.get("version") != 1 or lease.get("serverId") != self.server:
                    raise RuntimeError("Material reference belongs to another server")
                held_materials.update(lease["hashes"])
        for material in self.material_records():
            if self.config.get("governancePolicy"):
                # Unique verified wheels remain reusable after the last environment reference.
                continue
            path = self.materials / material["hash"] / material["filename"]
            if material["hash"] in held_materials or path.stat().st_nlink > 1:
                continue
            rows.append({"id": "material-" + material["hash"], "kind": "material", "bytes": allocated(path.parent),
                "reason": "Verified installation material without an environment, pending operation or external link"})
        for receipt_path in self.operations.glob("*/receipt.v1.json"):
            receipt = load(receipt_path)
            if not receipt.get("exitConfirmed") or receipt.get("state") not in ("completed", "blocked"):
                continue
            operation_id = receipt.get("operationId")
            if not isinstance(operation_id, str) or not re.fullmatch(r"[a-f0-9-]{36}", operation_id) or receipt.get("experimentId") != self.id or receipt.get("serverId") != self.server:
                raise RuntimeError("Temporary operation ownership differs")
            work = self.workspace / "tmp" / ("environment-" + operation_id)
            residue = self.cleanups / (operation_id + ".json")
            confirmed = residue.exists() and load(residue)["state"] == "pending"
            if work.exists() and (confirmed or not (work / "previous").exists()):
                rows.append({"id": "temporary-" + operation_id, "kind": "temporary", "bytes": allocated(work), "reason": "Private temporary files of a confirmed exited environment operation"})
        return rows

    def preview(self):
        rows = self.candidates()
        if self.config.get("governancePolicy"):
            rows.extend({key: value for key, value in row.items() if key in ("id", "kind", "bytes", "reason", "sourceExperimentId")}
                for row in storage_governance(self).historical_cleanup())
        signature = digest({"references": self.refs(), "candidates": rows, "packages": self.records(), "materials": self.material_records(), "cleanups": self.cleanup_records()})
        return {"serverId": self.server, "checkedAt": now(), "fingerprint": signature, "candidates": rows, "eligible": True}

    def legacy(self, wheels_only=False, verify=True):
        rows = []; scanned = 0; self.legacy_truncated = False
        for site in self.legacy_roots():
            for current, dirs, files in os.walk(site, followlinks=False):
                scanned += len(dirs) + len(files)
                if scanned > self.policy["legacyEntryLimit"]:
                    self.legacy_truncated = True; return rows
                dirs[:] = [name for name in dirs if not (pathlib.Path(current) / name).is_symlink()
                    and name not in ("models", "model", "data", "datasets", "node_modules", ".git")
                    and len(pathlib.Path(current).relative_to(site).parts) < self.policy["legacyScanDepth"]]
                if not wheels_only and "METADATA" in files and current.endswith(".dist-info"):
                    path = pathlib.Path(current) / "METADATA"
                    reject_links(path)
                    if path.stat().st_size > 1024 * 1024:
                        continue
                    metadata = email.message_from_bytes(path.read_bytes())
                    rows.append({"directory": str(path.parent), "name": metadata.get("Name", "unknown"), "version": metadata.get("Version", "unknown"),
                        "kind": "installed", "bytes": path.stat().st_size, "reusable": False,
                        "reason": "Historical installed metadata; verify and borrow its complete released environment, not individual mutable package files" if self.config.get("governancePolicy")
                            else "Writable legacy installation; original environment retained, a verified wheel is required"})
                    if len(rows) >= self.policy["legacyCandidateLimit"]:
                        self.legacy_truncated = True
                        return rows
                for name in files:
                    if not name.endswith((".whl", ".body")):
                        continue
                    path = pathlib.Path(current) / name
                    if path.is_symlink() or not zipfile.is_zipfile(path):
                        continue
                    try:
                        if verify:
                            info = self.wheel(path)
                        else:
                            with zipfile.ZipFile(path) as archive:
                                metas = [name for name in archive.namelist() if re.fullmatch(r"[^/]+\.dist-info/METADATA", name)]
                                if len(metas) != 1 or archive.getinfo(metas[0]).file_size > 1024 * 1024:
                                    raise RuntimeError("Wheel metadata is incomplete or oversized")
                                metadata = email.message_from_bytes(archive.read(metas[0]))
                                info = {"name": metadata.get("Name", "unknown"), "version": metadata.get("Version", "unknown")}
                        rows.append({"directory": str(path), "name": info["name"], "version": info["version"], "kind": "wheel",
                            "bytes": path.stat().st_size, "reusable": verify, "reason": "Complete wheel verified by RECORD; resolved dependency hash and ABI must still match" if verify
                            else "Historical candidate metadata; installation must verify complete content, dependency digest and ABI"})
                    except (OSError, RuntimeError, ValueError, zipfile.BadZipFile) as error:
                        rows.append({"directory": str(path), "name": name, "version": "unknown", "kind": "wheel", "bytes": path.stat().st_size,
                            "reusable": False, "reason": "Cached wheel is incomplete or invalid: " + str(error)})
                    if len(rows) >= self.policy["legacyCandidateLimit"]:
                        self.legacy_truncated = True
                        return rows
        return rows

    def legacy_roots(self):
        roots = []
        for run in sorted((self.namespace / "runs").iterdir()):
            if run.is_symlink() or not run.is_dir():
                continue
            marker = run / ".aspera-owner.json"
            if not marker.exists():
                continue
            if load(marker) != {"version": 1, "experimentId": run.name, "serverId": self.server}:
                raise RuntimeError("Legacy environment ownership differs")
            workspace = run / "workspace"; reject_links(workspace)
            if workspace.exists():
                roots.append(workspace)
            if len(roots) >= self.policy["legacyRunLimit"]:
                break
        return roots

    def inspect(self):
        usage = shutil.disk_usage(self.namespace)
        environments = [self.environment(path.stem) for path in sorted(self.manifests.glob("*.json"))] if self.manifests.exists() else []
        plans = [load(path) for path in sorted(self.operations.glob("*/reuse-plan.v1.json"))]
        if any(plan["experimentId"] != self.id or plan["serverId"] != self.server for plan in plans):
            raise RuntimeError("Reuse plan belongs to another experiment")
        busy = getattr(self, "inspection_busy", False)
        result = {"serverId": self.server, "name": self.config["serverName"], "checkedAt": now(), "source": "remote",
            "availableBytes": usage.free, "capacityBytes": usage.total, "workspaceBytes": allocated(self.workspace) + (allocated(pathlib.Path(self.placement["workspaceRoot"])) if str(self.workspace) != self.placement["workspaceRoot"] else 0),
            "sharedBytes": allocated(self.store), "reclaimableBytes": 0 if busy else sum(row["bytes"] for row in self.candidates()),
            "environments": environments, "legacy": [] if busy else self.legacy(verify=False), "reusePlans": plans, "complete": not busy,
            "cleanups": self.cleanup_records(), "recoveries": [load(path) for path in sorted(self.recoveries.glob("*.json"))],
            "materials": [{"name": row["name"], "version": row["versionString"], "wheelHash": row["hash"], "source": row["source"],
                "bytes": row["bytes"], "cachedAt": row["createdAt"], "available": (self.materials / row["hash"] / row["filename"]).is_file()}
                for row in self.material_records()]}
        if self.config.get("governancePolicy"):
            governance = storage_governance(self)
            result["catalog"] = governance.catalog()
            result["borrowings"] = [{**{key: value for key, value in row.items() if key != "files"}, "fileCount": len(row["files"])}
                for row in governance.validate_borrowings()]
            budget = self.run / "storage-plan.v1.json"
            if budget.exists():
                result["storagePlan"] = load(budget)
            arrangement = environment_arrangement(self)
            if arrangement is not None:
                result["arrangement"] = arrangement
            result["assets"] = [{**{key: value for key, value in row.items() if key != "files"}, "fileCount": len(row["files"])}
                for row in [load(path) for path in (governance.root / "materials").glob("*.json")]]
            result["materialOperations"] = [governance.material_operation(path.parent.name)
                for path in sorted((self.run / "material-operations-v1").glob("*/receipt.v1.json"))[-self.policy["legacyCandidateLimit"]:]]
        if busy:
            result["error"] = "Environment mutation is in progress; atomic reuse plans are available, cleanup eligibility is not yet confirmed"
        elif getattr(self, "legacy_truncated", False):
            result.update(complete=False, error="Historical environment scan reached its configured limit; retained candidates are partial")
        return result

    def acceptance(self):
        borrowed = []
        if self.config.get("governancePolicy"):
            borrowed = storage_governance(self).validate_borrowings()
        environments = [self.environment(path.stem) for path in sorted(self.manifests.glob("*.json"))] if self.manifests.exists() else []
        for required in self.config.get("requiredEnvironments", []):
            if any(required in (row["environmentId"], row["directory"], row["python"]) for row in borrowed):
                continue
            if not any(required in [environment["environmentId"], environment["directory"], environment["python"],
                pathlib.Path(environment["directory"]).relative_to(self.workspace).as_posix()] for environment in environments):
                raise RuntimeError("Recorded execution environment is not registered and verified: " + required)
        for environment in environments:
            verification = environment.get("verification", {})
            if environment["state"] != "ready" or verification.get("verified") is not True or verification.get("dependenciesValid") is not True:
                raise RuntimeError("Environment requires program verification before completion")
            if verification.get("prefix") != environment["directory"] or verification.get("userSiteEnabled") is not False:
                raise RuntimeError("Environment interpreter verification differs from its registered directory")
            directory = pathlib.Path(environment["directory"])
            marker = load(directory / ".aspera-environment.json")
            if marker != {"version": 1, "generation": environment["generation"], "environmentId": environment["environmentId"]}:
                raise RuntimeError("Environment publication identity changed")
            site = self.site(directory)
            for package in environment["packages"]:
                record = load(self.objects / package["id"] / "record.v1.json")
                observed = []
                for name in package["files"]:
                    path = site / relative(name); reject_links(path)
                    checksum = file_hash(path)
                    if name not in environment["privateFiles"] and checksum != record["hashes"][name]:
                        raise RuntimeError("Shared dependency content changed; verify before completion: " + name)
                    observed.append((name, checksum))
                if digest(sorted(observed)) != package["contentHash"]:
                    raise RuntimeError("Modified dependency content requires fresh verification before completion")
            gpu_required = any(re.fullmatch(r"/dev/nvidia\d+", path) for path in self.config.get("devicePaths", [])) and any(package["name"].lower() == "torch" for package in environment["packages"])
            if gpu_required and verification.get("cuda") is not True:
                raise RuntimeError("Required CUDA verification is missing")
        return {"verified": True, "environments": len(environments) + len(borrowed)}

    def wheel(self, path):
        reject_links(path)
        if not path.is_file() or path.stat().st_size > self.expanded_limit:
            raise RuntimeError("Invalid or oversized wheel")
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            if len(names) > self.policy["maxPackageFiles"] or len(names) != len(set(names)):
                raise RuntimeError("Wheel file count or duplicate entries exceed the policy")
            if sum(item.file_size for item in archive.infolist()) > self.expanded_limit:
                raise RuntimeError("Wheel expanded size exceeds the policy")
            for item in archive.infolist():
                relative(item.filename.rstrip("/"))
                if stat.S_ISLNK(item.external_attr >> 16):
                    raise RuntimeError("Wheel contains a symbolic link")
            metas = [name for name in names if re.fullmatch(r"[^/]+\.dist-info/METADATA", name)]
            if len(metas) != 1:
                raise RuntimeError("Wheel metadata is ambiguous")
            prefix = metas[0].rsplit("/", 1)[0]
            if prefix + "/WHEEL" not in names or prefix + "/RECORD" not in names:
                raise RuntimeError("Wheel metadata is incomplete")
            metadata = email.message_from_bytes(archive.read(metas[0]))
            wheel = email.message_from_bytes(archive.read(prefix + "/WHEEL"))
            name, version = metadata.get("Name"), metadata.get("Version")
            if not name or not version or not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or not re.fullmatch(r"[A-Za-z0-9_.+!-]+", version):
                raise RuntimeError("Invalid wheel package identity")
            tags = wheel.get_all("Tag", [])
            if not tags or any(not re.fullmatch(r"[A-Za-z0-9_.]+-[A-Za-z0-9_.]+-[A-Za-z0-9_.]+", tag) for tag in tags):
                raise RuntimeError("Invalid wheel platform tags")
            records = list(csv.reader(io.StringIO(archive.read(prefix + "/RECORD").decode())))
            checked = set()
            for row in records:
                if len(row) != 3:
                    raise RuntimeError("Invalid wheel RECORD")
                filename, checksum, size = row
                relative(filename)
                if filename not in names or filename in checked:
                    raise RuntimeError("Wheel RECORD does not match its entries")
                checked.add(filename)
                if checksum:
                    algorithm, encoded = checksum.split("=", 1)
                    if algorithm not in ("sha256", "sha384", "sha512"):
                        raise RuntimeError("Wheel RECORD uses an unsupported digest")
                    value = hashlib.new(algorithm); length = 0
                    with archive.open(filename) as stream:
                        for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
                            value.update(block); length += len(block)
                    if base64.urlsafe_b64encode(value.digest()).rstrip(b"=").decode() != encoded:
                        raise RuntimeError("Wheel RECORD content digest differs")
                    if size != str(length):
                        raise RuntimeError("Wheel RECORD size differs")
                elif filename != prefix + "/RECORD":
                    raise RuntimeError("Wheel entry has no content digest")
            if set(name for name in names if not name.endswith("/")) != checked:
                raise RuntimeError("Wheel includes unindexed files")
            build = wheel.get("Build")
            if build and not re.fullmatch(r"[0-9][A-Za-z0-9_]*", build):
                raise RuntimeError("Invalid wheel build identifier")
            return {"name": name, "version": version, "tags": tags, "hash": file_hash(path), "distInfo": prefix,
                "filename": path.name, "build": build}

    def installation_names(self, paths, stage, work):
        """The isolated installer validates tags for its matching target Python ABI."""
        if not hasattr(self, "wheel_names"):
            self.wheel_names = {}
        pending = []
        for path in paths:
            info = self.wheel(path)
            if info["hash"] not in self.wheel_names:
                pending.append(info)
        if pending:
            source = work / "wheel-identities.json"
            source.write_text(json.dumps(pending))
            installer = self.installer_directory
            result = json.loads(self.command([str(installer / "bin/python"), "-I", "-c", WHEEL_NAMES, str(source)], work,
                readonly=[installer], environment=installer))
            if set(result) != {item["hash"] for item in pending}:
                raise RuntimeError("Target interpreter returned incomplete wheel identities")
            self.wheel_names.update(result)
        return self.wheel_names

    def material_records(self):
        if not self.materials.exists():
            return []
        rows = []
        for folder in sorted(self.materials.iterdir()):
            if not re.fullmatch(r"[a-f0-9]{64}", folder.name):
                raise RuntimeError("Unknown installation material entry")
            value = load(folder / "record.v1.json")
            if value.get("version") != 1 or value.get("hash") != folder.name or value.get("serverId") != self.server:
                raise RuntimeError("Installation material identity differs")
            relative(value["filename"])
            rows.append(value)
        return rows

    def retain_material(self, path, source=None, immutable=False):
        info = self.wheel(path)
        folder = self.materials / info["hash"]
        target = folder / info["filename"]
        if folder.exists():
            record = load(folder / "record.v1.json")
            if record["hash"] != info["hash"] or record["serverId"] != self.server:
                raise RuntimeError("Installation material ownership changed")
            original = folder / relative(record["filename"])
            reject_links(original)
            if original.is_file() and file_hash(original) == info["hash"]:
                return original, record
            quarantine = self.store / "quarantine"; quarantine.mkdir(mode=0o700, exist_ok=True)
            reject_links(quarantine)
            os.rename(folder, quarantine / (info["hash"] + "-" + uuid.uuid4().hex)); sync_directory(self.materials)
        self.materials.mkdir(mode=0o700, exist_ok=True)
        incoming = self.store / (".material-" + uuid.uuid4().hex)
        incoming.mkdir(mode=0o700)
        moved = False
        try:
            size = path.stat().st_size
            with zipfile.ZipFile(path) as archive:
                expanded = sum(item.file_size for item in archive.infolist())
            destination = incoming / info["filename"]
            operation = getattr(self, "current_operation", None)
            work = self.workspace / "tmp" / ("environment-" + operation.name) if operation else None
            if work is not None and work in path.parents:
                os.rename(path, destination); moved = True
            elif immutable:
                self.link_file(path, destination, empty_sharing())
            else:
                # Writable historical files require one independent import into the immutable store.
                self.free(size); shutil.copyfile(path, destination)
            if file_hash(incoming / info["filename"]) != info["hash"]:
                raise RuntimeError("Installation material changed while importing")
            record = {"version": 1, "serverId": self.server, "hash": info["hash"], "name": info["name"], "versionString": info["version"],
                "filename": info["filename"], "tags": info["tags"], "bytes": size, "expandedBytes": expanded,
                "source": source or "wheel-sha256:" + info["hash"], "createdAt": now()}
            sync_file(incoming / info["filename"]); save(incoming / "record.v1.json", record)
            os.rename(incoming, folder); sync_directory(self.materials)
        except (Exception, KeyboardInterrupt):
            if moved and incoming.exists() and (incoming / info["filename"]).exists() and not path.exists():
                os.rename(incoming / info["filename"], path)
            raise
        finally:
            if incoming.exists():
                remove_private(incoming, self.store)
        return target, record

    def hold_materials(self, hashes):
        save(self.material_references / (self.id + "-" + self.current_operation.name + ".json"),
            {"version": 1, "experimentId": self.id, "serverId": self.server, "operationId": self.current_operation.name, "hashes": sorted(set(hashes))})

    def plan_stage(self, stage, **values):
        self.reuse_plan.update(stage=stage, updatedAt=now(), **values)
        save(self.current_operation / "reuse-plan.v1.json", self.reuse_plan)
        print("Environment " + stage + ": " + str(len(self.reuse_plan["packages"])) + " dependencies", file=sys.stderr, flush=True)

    def metadata_wheel(self, original, target):
        """uv creates private metadata and entry points; verified payloads are linked afterwards."""
        info = self.wheel(original)
        rows = []
        with zipfile.ZipFile(original) as archive, zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as output:
            for item in archive.infolist():
                name = item.filename
                if name.endswith("/") or name == info["distInfo"] + "/RECORD":
                    continue
                if not name.startswith(info["distInfo"] + "/") and not (".data/" in name and name.split(".data/", 1)[1].startswith("scripts/")):
                    continue
                content = archive.read(name); output.writestr(name, content)
                checksum = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=").decode()
                rows.append([name, "sha256=" + checksum, str(len(content))])
            record = io.StringIO(); writer = csv.writer(record)
            writer.writerows(rows); writer.writerow([info["distInfo"] + "/RECORD", "", ""])
            output.writestr(info["distInfo"] + "/RECORD", record.getvalue())
        return info

    def shared_copy_budget(self, records, work):
        if not records:
            return 0
        source = self.store / (".link-probe-" + uuid.uuid4().hex)
        target = work / "link-probe"
        source.write_bytes(b"managed-package-link-probe\n")
        sharing = empty_sharing()
        try:
            self.link_file(source, target, sharing)
            if sharing["hardlinkBytes"] or sharing["cloneBytes"]:
                return 0
            return sum((self.objects / item["id"] / "payload" / name).stat().st_size for item in records for name in item["files"])
        finally:
            target.unlink(missing_ok=True); source.unlink(missing_ok=True)

    def source_build_identity(self, facts, stage, work):
        if hasattr(self, "build_identity"):
            return self.build_identity
        code = "import json,shutil,subprocess; out={}; "
        code += "\nfor tool in ['cc','nvcc']:\n path=shutil.which(tool); out[tool]=subprocess.run([path,'--version'],capture_output=True,text=True,timeout=" + str(self.policy["readTimeoutMs"] / 1000) + ").stdout if path else None"
        code += "\nprint(json.dumps(out))"
        observed = json.loads(self.command([str(stage / "bin/python"), "-I", "-c", code], work, environment=stage).strip())
        self.build_identity = digest([facts["abi"], facts["version"], self.policy["uvVersion"], platform.system(), platform.machine(),
            self.config.get("gpuInfo"), sorted(self.config.get("devicePaths", [])), observed])
        return self.build_identity

    def refresh_installation_records(self, packages, directory):
        site = self.site(directory)
        for package in packages:
            shared = load(self.objects / package["id"] / "record.v1.json")
            info = self.wheel(self.materials / package["wheelHash"] / shared["wheel"])
            record = site / info["distInfo"] / "RECORD"
            rows = list(csv.reader(io.StringIO(record.read_text())))
            for row in rows:
                target = (site / row[0]).resolve()
                if directory not in target.parents:
                    raise RuntimeError("Installed metadata references files outside its environment")
                if target != record and target.is_file():
                    reject_links(target)
                    row[1] = "sha256=" + base64.urlsafe_b64encode(bytes.fromhex(file_hash(target))).rstrip(b"=").decode()
                    row[2] = str(target.stat().st_size)
            output = io.StringIO(); csv.writer(output).writerows(rows); record.write_text(output.getvalue()); sync_file(record)

    def reusable_package(self, info, facts):
        matches = [record for record in self.records() if record["wheelHash"] == info["hash"] and record["pythonAbi"] == facts["abi"]
            and record["source"] == info["source"] and self.wheel_names.get(info["hash"], {}).get("filename")]
        if not matches:
            return None
        record = matches[0]
        original = self.materials / info["hash"] / info["filename"]
        with zipfile.ZipFile(original) as archive:
            if any(".data/" in name and not name.split(".data/", 1)[1].startswith(("purelib/", "platlib/", "scripts/")) for name in archive.namelist()):
                return None
        for name, checksum in record["hashes"].items():
            if file_hash(self.objects / record["id"] / "payload" / relative(name)) != checksum:
                raise RuntimeError("Shared dependency content changed: " + name)
        return record

    def install_shared(self, record, site, sharing):
        for name in record["files"]:
            target = site / relative(name)
            if target.exists() or target.is_symlink():
                owners = []
                for path in site.glob("*.dist-info/RECORD"):
                    reject_links(path)
                    if any(row and row[0] == name for row in csv.reader(io.StringIO(path.read_text()))):
                        metadata = email.message_from_string((path.parent / "METADATA").read_text())
                        owners.append((package_name(metadata["Name"]), metadata["Version"]))
                packages = [item["hash"] for item in getattr(self, "selected_materials", [])
                    if (package_name(item["name"]), item["versionString"]) in owners]
                packages.append(record["wheelHash"])
                raise DependencyConflict(name, packages, "Owners: " + json.dumps(owners))
            self.link_file(self.objects / record["id"] / "payload" / name, target, sharing)
        info = self.wheel(self.materials / record["wheelHash"] / record["wheel"])
        path = site / info["distInfo"] / "RECORD"
        rows = list(csv.reader(io.StringIO(path.read_text())))
        entries = {row[0]: row for row in rows}
        for name in record["files"]:
            file = site / name
            encoded = base64.urlsafe_b64encode(bytes.fromhex(record["hashes"][name])).rstrip(b"=").decode()
            entries[name] = [name, "sha256=" + encoded, str(file.stat().st_size)]
        direct = path.parent / "direct_url.json"
        if direct.exists():
            direct.write_text(json.dumps({"url": (self.materials / record["wheelHash"] / record["wheel"]).as_uri(),
                "archive_info": {"hashes": {"sha256": record["wheelHash"]}}}) + "\n")
            direct_name = direct.relative_to(site).as_posix()
            encoded = base64.urlsafe_b64encode(bytes.fromhex(file_hash(direct))).rstrip(b"=").decode()
            entries[direct_name] = [direct_name, "sha256=" + encoded, str(direct.stat().st_size)]
        content = io.StringIO(); csv.writer(content).writerows(entries.values()); path.write_text(content.getvalue())
        return {"id": record["id"], "name": record["name"], "version": record["versionString"], "wheelHash": record["wheelHash"],
            "source": record["source"], "tags": record["tags"], "pythonAbi": record["pythonAbi"], "contentHash": record["contentHash"],
            "modified": False, "files": record["files"]}

    def link_file(self, source, target, sharing):
        reject_links(source); reject_links(target)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        size = source.stat().st_size
        sharing["logicalBytes"] += size
        try:
            os.link(source, target)
            a, b = source.stat(), target.stat()
            if (a.st_dev, a.st_ino) != (b.st_dev, b.st_ino):
                raise RuntimeError("Hard link did not share the original file")
            sharing["hardlinkBytes"] += size
            return
        except OSError as error:
            if error.errno not in (errno.EXDEV, errno.EPERM, errno.EACCES, errno.EOPNOTSUPP, errno.EMLINK):
                raise
            sharing["reasons"].append("Hard link unavailable: " + str(error))
        try:
            with open(source, "rb") as incoming, open(target, "xb") as outgoing:
                fcntl.ioctl(outgoing.fileno(), 0x40049409, incoming.fileno())
            if file_hash(source) != file_hash(target):
                raise RuntimeError("Copy-on-write content verification failed")
            sharing["cloneBytes"] += size
            return
        except OSError as error:
            if target.exists():
                target.unlink()
            if error.errno not in (errno.EXDEV, errno.EPERM, errno.EACCES, errno.EOPNOTSUPP, errno.ENOTTY, errno.EINVAL):
                raise
            sharing["reasons"].append("Copy-on-write unavailable: " + str(error))
        sharing["estimatedCopyBytes"] += size
        self.free(size)
        shutil.copyfile(source, target)
        if file_hash(source) != file_hash(target):
            raise RuntimeError("Independent copy content verification failed")
        sharing["copyBytes"] += size

    def publish_package(self, wheel, site, python_abi, source, sharing):
        info = self.wheel(wheel)
        material, _ = self.retain_material(wheel, source)
        wheel = material
        with zipfile.ZipFile(wheel) as archive:
            payload = []
            for item in archive.infolist():
                name = item.filename
                if name.endswith("/") or name.startswith(info["distInfo"] + "/"):
                    continue
                if ".data/" in name:
                    section = name.split(".data/", 1)[1]
                    if section.startswith(("purelib/", "platlib/")):
                        name = section.split("/", 1)[1]
                    else:
                        continue
                path = site / relative(name)
                reject_links(path)
                checksum = hashlib.sha256()
                with archive.open(item.filename) as stream:
                    for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
                        checksum.update(block)
                if not path.is_file() or file_hash(path) != checksum.hexdigest():
                    raise RuntimeError("Installed package differs from its verified wheel: " + name)
                payload.append((name, file_hash(path)))
        content_hash = digest(sorted(payload))
        package_id = digest([info["hash"], source, python_abi, info["tags"], content_hash])
        folder = self.objects / package_id
        record = {"version": 1, "id": package_id, "name": info["name"], "versionString": info["version"], "wheelHash": info["hash"],
            "source": source, "tags": info["tags"], "pythonAbi": python_abi, "contentHash": content_hash,
            "files": [name for name, _ in payload], "hashes": dict(payload), "wheel": info["filename"]}
        if not folder.exists():
            incoming = self.store / (".publish-" + uuid.uuid4().hex)
            incoming.mkdir(mode=0o700)
            try:
                (incoming / "payload").mkdir(mode=0o700)
                for name, _ in payload:
                    path = incoming / "payload" / name
                    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    publishing = empty_sharing()
                    self.link_file(site / name, path, publishing)
                    sharing["reasons"] += publishing["reasons"]
                    sharing["estimatedCopyBytes"] += publishing["estimatedCopyBytes"]
                self.link_file(material, incoming / info["filename"], empty_sharing())
                sync_file(incoming / info["filename"])
                for name, _ in payload:
                    sync_file(incoming / "payload" / name)
                save(incoming / "record.v1.json", record)
                os.rename(incoming, folder)
                sync_directory(self.objects)
            finally:
                if incoming.exists():
                    remove_private(incoming, self.store)
        else:
            previous = load(folder / "record.v1.json")
            if any(previous[key] != record[key] for key in ["id", "wheelHash", "pythonAbi", "contentHash", "files", "hashes"]):
                raise RuntimeError("Existing shared package metadata differs")
        for name, checksum in payload:
            source_file = folder / "payload" / name
            if file_hash(source_file) != checksum:
                raise RuntimeError("Shared package content changed")
            target = site / name
            target.unlink()
            self.link_file(source_file, target, sharing)
        return {"id": package_id, "name": info["name"], "version": info["version"], "wheelHash": info["hash"],
            "source": source, "tags": info["tags"], "pythonAbi": python_abi, "contentHash": content_hash, "modified": False, "files": record["files"]}

    def make_writable(self, environment, paths):
        if environment["state"] != "ready" or not paths:
            raise RuntimeError("File separation requires a verified environment and registered files")
        directory = pathlib.Path(environment["directory"])
        site = self.site(directory)
        registered = {name: package for package in environment["packages"] for name in package["files"]}
        for name in paths:
            relative(name)
            if name not in registered:
                raise RuntimeError("Writable file is outside registered package contents")
        for name in paths:
            target = site / name
            reject_links(target)
            self.free(target.stat().st_size)
            fd, incoming = tempfile.mkstemp(prefix=".private-", dir=target.parent)
            os.close(fd)
            try:
                shutil.copyfile(target, incoming)
                os.chmod(incoming, stat.S_IMODE(target.stat().st_mode))
                if file_hash(target) != file_hash(incoming):
                    raise RuntimeError("File separation content verification failed")
                sync_file(incoming); os.replace(incoming, target); sync_directory(target.parent)
            finally:
                if os.path.exists(incoming):
                    os.unlink(incoming)
            package = registered[name]
            package["modified"] = True
            package["contentHash"] = digest([(item, file_hash(site / item)) for item in package["files"]])
        environment["privateFiles"] = sorted(set(environment["privateFiles"] + paths))
        environment["updatedAt"] = now()
        save(self.manifests / (environment["environmentId"] + ".json"), environment)
        # Modified packages still hold their unchanged shared files until all links are separated.
        self.write_reference(environment, [p["id"] for p in environment["packages"]])
        return environment

    def site(self, directory):
        choices = list((directory / "lib").glob("python*/site-packages"))
        if len(choices) != 1:
            raise RuntimeError("Environment site-packages cannot be confirmed")
        reject_links(choices[0])
        return choices[0]

    def sandbox(self, command, writable=None, readonly=None, environment=None):
        workspace = str(self.workspace)
        argv = list(self.config["sandboxBase"])
        if not argv or argv[0] != self.config["backendPath"] or "--unshare-user" not in argv or "--proc" not in argv:
            raise RuntimeError("Managed installation requires the verified experiment isolation flags")
        argv += ["--clearenv", "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin", "--setenv", "HOME", workspace,
            "--setenv", "PYTHONNOUSERSITE", "1", "--setenv", "PYTHONDONTWRITEBYTECODE", "1", "--setenv", "PIP_REQUIRE_VIRTUALENV", "1",
            "--setenv", "PYTHONUNBUFFERED", "1", "--ro-bind", workspace, workspace]
        for path in writable or []:
            reject_links(path)
            argv += ["--bind", str(path), str(path)]
        if writable:
            work = pathlib.Path(writable[0])
            for name in ("tmp", "home", "cache"):
                (work / name).mkdir(mode=0o700, exist_ok=True)
            argv += ["--setenv", "TMPDIR", str(work / "tmp"), "--setenv", "HOME", str(work / "home"),
                "--setenv", "XDG_CACHE_HOME", str(work / "cache"), "--setenv", "UV_CACHE_DIR", str(work / "uv"),
                "--setenv", "PIP_CACHE_DIR", str(work / "pip")]
        for path in readonly or []:
            reject_links(path)
            argv += ["--ro-bind", str(path), str(path)]
        if environment:
            argv += ["--setenv", "VIRTUAL_ENV", str(environment), "--setenv", "PATH", str(environment / "bin") + ":/usr/local/bin:/usr/bin:/bin"]
        argv += ["--chdir", workspace, "--", *map(str, command)]
        return argv

    def command(self, args, work, timeout=None, readonly=None, environment=None):
        argv = self.sandbox(args, [work], readonly, environment)
        with open(self.current_operation / "stdout.log", "a+") as output, open(self.current_operation / "stderr.log", "a+") as error:
            offset = error.tell(); output_offset = output.tell()
            child = subprocess.Popen(argv, env={"PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"},
                stdout=output, stderr=error)
            try:
                deadline = time.monotonic() + (timeout or self.policy["timeoutMs"] / 1000)
                next_capacity = time.monotonic()
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise subprocess.TimeoutExpired(argv, timeout or self.policy["timeoutMs"] / 1000)
                    try:
                        child.wait(timeout=min(remaining, self.policy.get("operationPollIntervalMs", 1000) / 1000)); break
                    except subprocess.TimeoutExpired:
                        if getattr(self, "check_install_space", False) and time.monotonic() >= next_capacity:
                            self.free()
                            next_capacity = time.monotonic() + self.config.get("governancePolicy", {}).get("capacityRecheckMs", 5000) / 1000
            except (Exception, KeyboardInterrupt):
                child.terminate()
                try:
                    child.wait(timeout=self.policy["stopTimeoutMs"] / 1000)
                except subprocess.TimeoutExpired:
                    child.kill(); child.wait()
                raise
            error.seek(offset); diagnostic = error.read(); output.seek(output_offset); text = output.read()
            print(text + diagnostic, file=sys.stderr, flush=True)
            if child.returncode != 0:
                raise RuntimeError("Confined environment command exited " + str(child.returncode) + ": " + diagnostic[-12000:])
        return text

    def verify(self, environment, request, work):
        directory = pathlib.Path(environment["directory"])
        site = self.site(directory)
        for package in environment["packages"]:
            record = load(self.objects / package["id"] / "record.v1.json")
            observed = []
            for name in package["files"]:
                path = site / relative(name)
                reject_links(path)
                checksum = file_hash(path)
                if name not in environment["privateFiles"] and checksum != record["hashes"][name]:
                    raise RuntimeError("Shared dependency content changed: " + name)
                observed.append((name, checksum))
            if package["modified"]:
                package["contentHash"] = digest(sorted(observed))
        code = "import json,sys,site,importlib,sysconfig; modules=json.loads(sys.argv[1]); [importlib.import_module(m) for m in modules]; assert sysconfig.get_config_var('SOABI')==sys.argv[2], 'Python ABI changed'; out={'python':sys.executable,'prefix':sys.prefix,'userSiteEnabled':bool(site.ENABLE_USER_SITE),'modules':modules}; "
        require_cuda = request["requireCuda"] or any(re.fullmatch(r"/dev/nvidia\d+", path) for path in self.config.get("devicePaths", [])) and any(package["name"].lower() == "torch" for package in environment["packages"])
        if require_cuda:
            code += "import torch; out['cuda']=bool(torch.cuda.is_available()); assert out['cuda'], 'CUDA access is unavailable'; "
        code += "print(json.dumps(out))"
        raw = self.command([environment["python"], "-I", "-c", code, json.dumps(request["modules"]), environment["pythonAbi"]], work, readonly=[directory], environment=directory)
        observed = json.loads(raw.strip().splitlines()[-1])
        valid = observed["prefix"] == str(directory) and not observed["userSiteEnabled"]
        if not valid:
            raise RuntimeError("Interpreter prefix or user-site isolation differs from its registered environment")
        self.command([environment["uv"], "pip", "check", "--python", environment["python"]], work, readonly=[directory], environment=directory)
        return {"verified": True, "checkedAt": now(), **observed, "dependenciesValid": True}

    def prepare(self, request):
        operation_id = request["operationId"]
        if not re.fullmatch(r"[a-f0-9-]{36}", operation_id):
            raise RuntimeError("Invalid environment operation identity")
        op = self.operations / operation_id
        reject_links(op)
        signature = digest(request)
        if op.exists():
            receipt = load(op / "receipt.v1.json")
            if receipt["requestHash"] != signature:
                raise RuntimeError("Environment operation identity is bound to different content")
            if receipt["exitConfirmed"]:
                return receipt
            raise RuntimeError("Environment operation outcome is unknown; inspect its original process before retrying")
        environment = self.environment(request["environmentId"])
        if environment and environment["state"] != "ready" and request["action"] != "verify":
            recovered = any(row.get("experimentId") == self.id and row.get("serverId") == self.server
                and row.get("environmentId") == environment["environmentId"] and row.get("generation") == environment["generation"]
                for row in [load(path) for path in self.recoveries.glob("*.json")])
            if not recovered:
                raise RuntimeError("Previous environment mutation requires recovery before another operation")
        if environment and request.get("directory") and str(self.workspace / relative(request["directory"])) != environment["directory"]:
            raise RuntimeError("Environment directory is already bound to another location")
        op.mkdir(mode=0o700)
        self.current_operation = op
        self.wheel_names = {}
        receipt = {"version": 1, "experimentId": self.id, "serverId": self.server, "operationId": operation_id,
            "environmentId": request["environmentId"], "requestHash": signature, "action": request["action"], "state": "running",
            "commandId": "environment-" + operation_id, "startedAt": now(), "updatedAt": now(), "exitConfirmed": False, "exitCode": None}
        save(op / "receipt.v1.json", receipt)
        self.reuse_plan = {"version": 1, "experimentId": self.id, "serverId": self.server, "operationId": operation_id,
            "environmentId": request["environmentId"], "requirementsHash": digest(request["requirements"]), "pythonAbi": "",
            "uvVersion": self.policy["uvVersion"], "stage": "checking", "packages": [], "downloadBytes": 0, "reusedBytes": 0,
            "estimatedPeakBytes": 0, "addedBytes": 0, "updatedAt": now()}
        work = self.workspace / "tmp" / ("environment-" + operation_id)
        reject_links(work); work.mkdir(parents=True, mode=0o700)
        previous = copy.deepcopy(environment)
        if request["action"] == "create" and environment:
            request = {**request, "requirements": list(dict.fromkeys(environment["requirements"] + request["requirements"]))}
        self.effective_requirements = sorted(set(request["requirements"]))
        save(op / "requirements.v1.json", {"version": 1, "requestHash": signature, "requirements": request["requirements"]})
        self.reuse_plan["requirementsHash"] = digest(request["requirements"])
        self.commit_started = False
        before = shutil.disk_usage(self.workspace).free
        try:
            self.plan_stage("checking")
            if self.config.get("governancePolicy"):
                governance = storage_governance(self)
                with governance.locked():
                    governance.protect_source(self.id)
                    borrowed = governance.borrowing(request) if environment is None else None
                if borrowed is not None:
                    summary = {**{key: value for key, value in borrowed.items() if key != "files"}, "fileCount": len(borrowed["files"])}
                    receipt.update(state="completed", exitConfirmed=True, exitCode=0, borrowed=summary, updatedAt=now())
                    save(op / "receipt.v1.json", receipt)
                    self.plan_stage("completed", reusedBytes=sum(row["size"] for row in borrowed["files"]))
                    try:
                        remove_private(work, self.workspace, self.owner)
                    except CleanupIoError as error:
                        receipt["detail"] = "Historical environment verified; private verification files pending cleanup: " + str(error)
                        save(op / "receipt.v1.json", receipt)
                    return receipt
            if request["action"] in ("create", "install", "make-writable"):
                self.free()
            if request["action"] == "make-writable":
                if not environment:
                    raise RuntimeError("Environment is not registered")
                environment = self.make_writable(environment, request["files"])
            elif request["action"] == "verify":
                if not environment:
                    raise RuntimeError("Environment is not registered")
                environment["verification"] = self.verify(environment, request, work)
                environment["state"] = "ready"
                environment.pop("detail", None)
                environment["updatedAt"] = now()
                self.commit_started = True
                save(self.manifests / (environment["environmentId"] + ".json"), environment)
                self.write_reference(environment)
            else:
                environment = self.install(request, environment, work, before)
            receipt["cleanup"] = self.cleanup_work(operation_id, environment)
            environment["sharing"]["addedBytes"] = max(0, before - shutil.disk_usage(self.workspace).free)
            save(self.manifests / (environment["environmentId"] + ".json"), environment)
            receipt.update(state="completed", exitConfirmed=True, exitCode=0, environment=environment, updatedAt=now())
            save(op / "receipt.v1.json", receipt)
            self.plan_stage("completed", addedBytes=environment["sharing"]["addedBytes"])
        except (Exception, KeyboardInterrupt) as error:
            # A failed installation retains the original manifest and its live references.
            previous_path = pathlib.Path(previous["directory"]) if previous else None
            previous_restored = previous_path is not None and previous_path.exists() and load(previous_path / ".aspera-environment.json")["generation"] == previous["generation"]
            if previous_restored:
                if isinstance(error, CleanupSafetyError) or self.commit_started:
                    previous.update(state="blocked", detail=str(error), updatedAt=now())
                save(self.manifests / (previous["environmentId"] + ".json"), previous)
                if not self.commit_started:
                    self.write_reference(previous, [p["id"] for p in previous["packages"]])
            else:
                manifest = self.manifests / (request["environmentId"] + ".json")
                if manifest.exists():
                    failed = load(manifest)
                    if not pathlib.Path(failed["directory"]).exists():
                        manifest.unlink(); self.reference_path(request["environmentId"]).unlink(missing_ok=True)
                    else:
                        failed.update(state="blocked", detail=str(error), updatedAt=now()); save(manifest, failed)
            receipt.update(state="blocked", exitConfirmed=True, exitCode=1, detail=str(error), updatedAt=now())
            if isinstance(error, DependencyConflict):
                failure = {"version": 1, "experimentId": self.id, "serverId": self.server, "operationId": operation_id,
                    "environmentId": request["environmentId"], "requestHash": signature, "code": "shared-content-conflict",
                    "contextHash": digest(self.failure_context), "requirementsHash": digest(self.effective_requirements),
                    "inputRequirementsHash": digest(sorted(set(request["requirements"]))),
                    "packages": error.packages, "path": error.path, "detail": str(error), "createdAt": now()}
                save(op / "failure.v1.json", failure); receipt["failure"] = failure
            elif isinstance(error, UnchangedInstallationFailure):
                receipt["failure"] = {**error.failure, "operationId": operation_id, "requestHash": signature,
                    "previousOperationId": error.failure["operationId"], "code": "unchanged-failure", "createdAt": now()}
            save(op / "receipt.v1.json", receipt)
            self.plan_stage("blocked", detail=str(error), addedBytes=max(0, before - shutil.disk_usage(self.workspace).free))
        lease = self.material_references / (self.id + "-" + operation_id + ".json")
        if not work.exists():
            lease.unlink(missing_ok=True)
        return receipt

    def recover(self, request):
        """Recover only after the original ownership identity proves the entire process group exited."""
        self.recovery_request = request
        op = self.operations / request["operationId"]
        receipt_path = op / "receipt.v1.json"
        if receipt_path.exists():
            receipt = load(receipt_path)
            if receipt["requestHash"] != digest(request):
                raise RuntimeError("Recovery request differs from the original operation")
            expected = {"experimentId": self.id, "serverId": self.server, "operationId": request["operationId"],
                "environmentId": request["environmentId"], "commandId": "environment-" + request["operationId"]}
            if any(key in receipt and receipt[key] != value for key, value in expected.items()):
                raise RuntimeError("Environment recovery receipt belongs to another operation")
        else:
            request_path = self.run / "environment-requests-v1" / (request["operationId"] + ".json")
            requested_at = int(request_path.stat().st_mtime * 1000) if request_path.exists() else now()
            receipt = {"version": 1, "experimentId": self.id, "serverId": self.server, "operationId": request["operationId"],
                "environmentId": request["environmentId"], "requestHash": digest(request), "action": request["action"], "state": "requested",
                "commandId": "environment-" + request["operationId"], "startedAt": requested_at, "updatedAt": requested_at, "exitConfirmed": False, "exitCode": None}
        self.assert_exited(receipt["commandId"], self.config.get("launchFailureConfirmed", False))
        if not receipt_path.exists():
            op.mkdir(parents=True, mode=0o700, exist_ok=True)
            save(receipt_path, receipt)
        return self.recover_publication(op, receipt, receipt_path)

    def assert_exited(self, command_id, launch_failure=False):
        identity = self.run / "process-identities" / (command_id + ".v1.json")
        if not identity.exists():
            if not launch_failure:
                raise RuntimeError("Original environment process identity is missing; exit cannot be confirmed")
        else:
            process = load(identity)
            if process["experimentId"] != self.id or process["serverId"] != self.server or process["commandId"] != command_id:
                raise RuntimeError("Original environment process identity belongs to another operation")
            boot = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()
            if boot == process["hostBootId"]:
                for path in pathlib.Path("/proc").iterdir():
                    if not path.name.isdigit():
                        continue
                    try:
                        fields = (path / "stat").read_text().rsplit(")", 1)[1].split()
                    except FileNotFoundError:
                        continue
                    if fields[0] != "Z" and int(fields[2]) == process["group"]:
                        raise RuntimeError("Original environment process group has not exited")
    def recover_publication(self, op, receipt, receipt_path):
        """Retain the original receipt; recovery authorizes only a subsequent verification/preparation."""
        recovery_path = self.recoveries / (op.name + ".json")
        environment_id = receipt.get("environmentId") or self.config.get("request", {}).get("environmentId")
        if not environment_id:
            environment_id = self.recovery_request["environmentId"]
        current = self.environment(environment_id)
        if recovery_path.exists():
            saved = load(recovery_path)
            if saved["sourceReceiptHash"] != digest(receipt) or saved.get("generation") != (current or {}).get("generation"):
                raise RuntimeError("Environment recovery conflicts with changed receipt or generation")
            if current:
                marker = load(pathlib.Path(current["directory"]) / ".aspera-environment.json")
                if marker["generation"] != current["generation"]:
                    raise RuntimeError("Recovered environment directory identity changed")
            return {**receipt, "state": "blocked", "exitConfirmed": True, "exitCode": receipt.get("exitCode"), "recovery": saved,
                "detail": saved["detail"], **({"environment": current} if current else {})}
        journal_path = op / "publication.v1.json"
        work = self.workspace / "tmp" / ("environment-" + op.name)
        if journal_path.exists():
            journal = load(journal_path); previous, following = journal["previous"], journal["next"]
            directory, backup = pathlib.Path(following["directory"]), pathlib.Path(journal["backup"])
            if following["experimentId"] != self.id or following["serverId"] != self.server or following["environmentId"] != environment_id:
                raise RuntimeError("Environment publication belongs to another experiment")
            if backup != work / "previous" or pathlib.Path(journal["stage"]) != work / "venv":
                raise RuntimeError("Environment publication recovery paths differ")
            if directory == self.workspace or self.workspace not in directory.parents:
                raise RuntimeError("Environment publication escaped its workspace")
            reject_links(directory); reject_links(backup)
            marker = load(directory / ".aspera-environment.json") if directory.exists() else None
            committed = marker and marker["generation"] == following["generation"] and current and current["generation"] == following["generation"] and current.get("verification", {}).get("verified") is True
            if not committed:
                if marker and marker["generation"] == following["generation"] and previous and backup.exists():
                    discarded = work / "recovered-generation"
                    if discarded.exists():
                        raise RuntimeError("Interrupted publication quarantine already exists")
                    os.rename(directory, discarded); sync_directory(directory.parent)
                    marker = None
                elif marker and marker["generation"] not in [following["generation"], (previous or {}).get("generation")]:
                    raise RuntimeError("Environment generation changed during interrupted publication")
                if backup.exists():
                    if directory.exists() or not previous or load(backup / ".aspera-environment.json")["generation"] != previous["generation"]:
                        raise RuntimeError("Previous environment recovery identity cannot be confirmed")
                    os.rename(backup, directory); sync_directory(directory.parent)
                    current = copy.deepcopy(previous)
                elif previous and marker and marker["generation"] == previous["generation"]:
                    current = copy.deepcopy(previous)
                elif previous:
                    raise RuntimeError("Previous usable environment is missing during recovery")
                elif directory.exists():
                    current = copy.deepcopy(following)
                else:
                    current = None
                    (self.manifests / (environment_id + ".json")).unlink(missing_ok=True)
                    self.reference_path(environment_id).unlink(missing_ok=True)
        detail = "Original process group exit confirmed; verify the retained environment, or install missing dependencies with a new operation ID under the same environment identity."
        cleanup = None
        if current:
            current.update(state="blocked", detail=detail, updatedAt=now())
            save(self.manifests / (environment_id + ".json"), current)
            self.write_reference(current)
            cleanup = self.cleanup_work(op.name, current)
        elif work.exists():
            # No published generation is available; retain the failed private stage as evidence.
            detail = "Original process group exit confirmed; no usable generation is published. Prepare a new generation under the original environment identity; failed-stage evidence and verified materials are retained."
        else:
            (self.material_references / (self.id + "-" + op.name + ".json")).unlink(missing_ok=True)
        recovery = {"version": 1, "experimentId": self.id, "serverId": self.server, "operationId": op.name,
            "environmentId": environment_id, "sourceReceiptHash": digest(receipt), "state": "verification-required" if current else "prepare-required",
            "createdAt": now(), "updatedAt": now(), "detail": detail}
        if current:
            recovery["generation"] = current["generation"]
        save(recovery_path, recovery)
        return {**receipt, "state": "blocked", "exitConfirmed": True, "exitCode": receipt.get("exitCode"), "recovery": recovery, "detail": detail,
            **({"environment": current} if current else {}), **({"cleanup": cleanup} if cleanup else {})}

    def recover_cleanup(self, operation_id, fingerprint):
        self.assert_exited("environment-cleanup-" + operation_id, self.config.get("launchFailureConfirmed", False))
        path = self.operations / ("cleanup-" + operation_id + ".json")
        saved = load(path) if path.exists() else None
        if saved and saved["fingerprint"] != fingerprint:
            raise RuntimeError("Cleanup recovery content differs from the original preview")
        if saved and saved.get("result"):
            return saved["result"]
        result = {"serverId": self.server, "state": "blocked", "reclaimedBytes": 0, "checkedAt": now(),
            "detail": "Original cleanup process exit confirmed without a complete result. Reclaimed space is unconfirmed; retained candidates require a fresh preview and operation ID."}
        save(path, {"version": 1, "fingerprint": fingerprint, "state": "blocked", "result": result})
        return result

    def installer(self, work):
        """Keep fixed pip and its parsers outside the trainable dependency set."""
        directory = work / "installer"
        uv = self.config["uvPath"]
        self.command([uv, "venv", "--python", self.config["pythonPath"], str(directory), "--cache-dir", str(work / "uv-tools")], work)
        catalog = work / "installer-catalog"; catalog.mkdir(mode=0o700)
        for material in self.material_records():
            if package_name(material["name"]) == "pip" and material["versionString"] == self.policy["pipVersion"]:
                path = self.materials / material["hash"] / material["filename"]
                info = self.wheel(path)
                if info["hash"] != material["hash"]:
                    raise RuntimeError("Installer material digest changed")
                self.link_file(path, catalog / path.name, empty_sharing())
        # Build caches stay writable; installer code must not share their file identities.
        self.command([uv, "pip", "install", "--python", str(directory / "bin/python"), "--link-mode", "copy", "--cache-dir", str(work / "uv-tools"),
            "--find-links", str(catalog), "pip==" + self.policy["pipVersion"]], work, readonly=[catalog], environment=directory)
        code = "import importlib.metadata,json,sys,sysconfig; from pip._vendor.packaging.tags import sys_tags; print(json.dumps({'version':sys.version.split()[0],'abi':sysconfig.get_config_var('SOABI'),'prefix':sys.prefix,'pip':importlib.metadata.version('pip'),'tags':[str(tag) for tag in sys_tags()]}))"
        facts = json.loads(self.command([str(directory / "bin/python"), "-I", "-c", code], work, readonly=[directory], environment=directory))
        if facts["prefix"] != str(directory) or facts["pip"] != self.policy["pipVersion"] or not isinstance(facts.get("abi"), str) or not facts["abi"]:
            raise RuntimeError("Installer interpreter, fixed pip version or Python ABI cannot be confirmed")
        self.installer_directory = directory
        self.installer_facts = facts
        self.reuse_plan["installerTemporaryBytes"] = allocated(work)
        return facts

    def check_failed_installation(self, requirements, selected=None, raw=False):
        """Match failure causes across operation IDs without blocking unrelated transient failures."""
        context_hash = digest(self.failure_context)
        requirements_hash = digest(requirements)
        for path in sorted(self.operations.glob("*/failure.v1.json")):
            failure = load(path)
            receipt = load(path.parent / "receipt.v1.json")
            if failure.get("version") != 1 or failure.get("experimentId") != self.id or failure.get("serverId") != self.server \
                or failure.get("operationId") != path.parent.name or failure.get("requestHash") != receipt.get("requestHash"):
                raise RuntimeError("Installation failure record belongs to another operation")
            if failure["environmentId"] != self.reuse_plan["environmentId"] or failure["contextHash"] != context_hash:
                continue
            if receipt.get("state") != "blocked" or not receipt.get("exitConfirmed"):
                raise RuntimeError("Original failed installation exit requires recovery before retrying")
            unchanged_packages = selected is not None and failure["packages"] and set(failure["packages"]).issubset(selected)
            if requirements_hash == failure["inputRequirementsHash" if raw else "requirementsHash"] or unchanged_packages:
                raise UnchangedInstallationFailure(failure)

    def install(self, request, previous, work, before):
        self.check_install_space = True
        uv = self.config["uvPath"]
        observed_uv = self.command([uv, "--version"], work).strip().split()
        if len(observed_uv) < 2 or observed_uv[1] != self.policy["uvVersion"]:
            raise RuntimeError("Managed uv must be " + self.policy["uvVersion"])
        directory = pathlib.Path(previous["directory"]) if previous else self.workspace / relative(request.get("directory") or "env/python")
        if request["environmentId"] != "training" and not (request.get("purpose") or previous):
            raise RuntimeError("An additional environment requires an explicit purpose")
        if request["environmentId"] != "training" and not previous and not request.get("directory"):
            raise RuntimeError("An additional environment requires its own directory")
        reject_links(directory)
        if self.workspace / "tmp" in directory.parents and any(re.fullmatch(r"environment-[a-f0-9-]{36}", part) for part in directory.relative_to(self.workspace).parts):
            raise RuntimeError("Published environment cannot occupy a private operation directory")
        if not previous and directory.exists() and list(directory.iterdir()):
            raise RuntimeError("Refusing to overwrite an unregistered or legacy environment")
        satisfied = previous and request["requirements"] == previous["requirements"]
        if not satisfied:
            code = "import json,sys,sysconfig; print(json.dumps({'version':sys.version.split()[0],'abi':sysconfig.get_config_var('SOABI')}))"
            target = json.loads(self.command([self.config["pythonPath"], "-I", "-c", code], work))
            if not isinstance(target.get("abi"), str) or not target["abi"]:
                raise RuntimeError("Python ABI cannot be confirmed; package reuse is blocked")
            self.failure_context = {"installer": file_hash(pathlib.Path(__file__)), "uv": self.policy["uvVersion"], "pip": self.policy["pipVersion"],
                "python": target["version"], "abi": target["abi"], "platform": [platform.system(), platform.machine(), platform.libc_ver()],
                "sandbox": [self.config["backendPath"], self.config["sandboxBase"]], "gpu": self.config.get("gpuInfo"),
                "devices": sorted(self.config.get("devicePaths", [])), "previous": None if previous is None else
                    {key: previous[key] for key in ("generation", "packages", "privateFiles")}}
            self.check_failed_installation(sorted(set(request["requirements"])), raw=True)
            facts = self.installer(work)
            if target["abi"] != facts["abi"] or target["version"] != facts["version"]:
                raise RuntimeError("Installer Python ABI or version differs from the configured interpreter")
        if previous and request["action"] == "create" and not satisfied:
            installer = self.installer_directory
            satisfied = json.loads(self.command([str(installer / "bin/python"), "-I", "-c", REQUIREMENTS_SATISFIED,
                json.dumps(request["requirements"]), json.dumps(previous["requirements"]), str(self.site(directory))], work,
                readonly=[directory, installer], environment=installer))
        if previous and satisfied:
            self.reuse_plan["pythonAbi"] = previous["pythonAbi"]
            self.reuse_plan["packages"] = [{"name": item["name"], "version": item["version"], "wheelHash": item["wheelHash"], "decision": "current"} for item in previous["packages"]]
            self.plan_stage("verifying")
            previous["verification"] = self.verify(previous, request, work)
            previous["requirements"] = request["requirements"]
            previous["state"] = "ready"
            previous.pop("detail", None)
            previous["updatedAt"] = now()
            self.commit_started = True
            save(self.manifests / (request["environmentId"] + ".json"), previous)
            return previous
        self.effective_requirements = json.loads(self.command([str(self.installer_directory / "bin/python"), "-I", "-c", NORMALIZE_REQUIREMENTS,
            json.dumps(request["requirements"])], work, readonly=[self.installer_directory], environment=self.installer_directory))
        self.check_failed_installation(self.effective_requirements)
        stage = work / "venv"
        self.command([uv, "venv", "--python", self.config["pythonPath"], str(stage), "--cache-dir", str(work / "uv")], work)
        interpreter = stage / "bin/python"
        target = json.loads(self.command([str(interpreter), "-I", "-c", "import json,sys,sysconfig; print(json.dumps({'version':sys.version.split()[0],'abi':sysconfig.get_config_var('SOABI'),'prefix':sys.prefix}))"], work).strip())
        if target["prefix"] != str(stage):
            raise RuntimeError("Virtual environment creation did not bind its interpreter")
        if target.get("abi") != facts["abi"] or target["version"] != facts["version"]:
            raise RuntimeError("Training Python ABI or version differs from its isolated installer")
        requirements = request["requirements"]
        packages, sharing = self.install_dependencies(requirements, facts, stage, work, before)
        generation = str(uuid.uuid4())
        manifest = {"version": 1, "experimentId": self.id, "serverId": self.server, "deploymentId": self.config["deploymentId"],
            "environmentId": request["environmentId"], "generation": generation, "directory": str(directory), "python": str(directory / "bin/python"),
            "purpose": request.get("purpose") or (previous["purpose"] if previous else "training"),
            "pythonVersion": facts["version"], "pythonAbi": facts["abi"], "uv": uv, "uvVersion": self.policy["uvVersion"], "state": "verifying",
            "requirements": requirements, "packages": packages, "privateFiles": [], "sharing": sharing, "updatedAt": now()}
        # Scripts and activation metadata are environment-owned; payload bytes are never rewritten.
        for path in list((stage / "bin").iterdir()) + [stage / "pyvenv.cfg"]:
            if path.is_symlink() or not path.is_file() or path.stat().st_size > 1024 * 1024:
                continue
            data = path.read_bytes()
            if b"\0" not in data and str(stage).encode() in data:
                path.write_bytes(data.replace(str(stage).encode(), str(directory).encode()))
                sync_file(path)
        self.refresh_installation_records(packages, stage)
        save(stage / ".aspera-environment.json", {"version": 1, "generation": generation, "environmentId": request["environmentId"]})
        backup = work / "previous"
        directory.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        journal_path = self.current_operation / "publication.v1.json"
        self.commit_started = True
        journal = {"version": 1, "previous": previous, "next": manifest, "backup": str(backup), "stage": str(stage), "phase": "intent"}
        save(journal_path, journal)
        save(self.manifests / (request["environmentId"] + ".json"), manifest)
        self.write_reference(manifest, sorted(set([p["id"] for p in packages] + ([p["id"] for p in previous["packages"]] if previous else []))))
        journal["phase"] = "references-saved"; save(journal_path, journal)
        if directory.exists():
            os.rename(directory, backup)
        os.rename(stage, directory)
        sync_directory(directory.parent)
        journal["phase"] = "swapped"; save(journal_path, journal)
        try:
            self.plan_stage("verifying")
            manifest["verification"] = self.verify(manifest, request, work)
            manifest["state"] = "ready"
            sharing["allocatedBytes"] = allocated(directory)
            sharing["addedBytes"] = max(0, before - shutil.disk_usage(self.workspace).free)
            manifest["updatedAt"] = now()
            save(self.manifests / (request["environmentId"] + ".json"), manifest)
            journal.update(phase="verified", next=manifest); save(journal_path, journal)
            self.write_reference(manifest, sorted(set([p["id"] for p in packages] + ([p["id"] for p in previous["packages"]] if previous else []))))
            journal["phase"] = "committed"; save(journal_path, journal)
        except (Exception, KeyboardInterrupt):
            remove_private(directory, self.workspace)
            if backup.exists():
                os.rename(backup, directory)
            raise
        return manifest

    def install_dependencies(self, requirements, facts, stage, work, before):
        uv, interpreter = self.config["uvPath"], stage / "bin/python"
        self.reuse_plan["pythonAbi"] = facts["abi"]
        requirements_file = work / "requirements.in"
        for requirement in requirements:
            if "\n" in requirement or "\r" in requirement or requirement.lstrip().startswith("-") or re.search(r"https?://[^/\s]*@", requirement):
                raise RuntimeError("Dependency request contains an option or embedded credential")
        requirements_file.write_text("\n".join(requirements) + "\n")
        wheels = work / "wheels"
        wheels.mkdir(mode=0o700)
        catalog = work / "catalog"
        catalog.mkdir(mode=0o700)
        if self.config.get("governancePolicy"):
            governance = storage_governance(self)
            with governance.locked():
                governance.import_installation_cache(facts)
        for package in self.records():
            path = self.objects / package["id"] / package["wheel"]
            if not path.is_file() or file_hash(path) != package["wheelHash"]:
                print("Cached package wheel is unavailable or changed; acquire verified material: " + package["name"], file=sys.stderr, flush=True)
                continue
            self.retain_material(path, package["source"], immutable=True)
        catalog_sources = []
        for material in self.material_records():
            path = self.materials / material["hash"] / material["filename"]
            if not path.is_file() or file_hash(path) != material["hash"]:
                print("Cached wheel failed its digest; it cannot be reused: " + material["name"], file=sys.stderr, flush=True)
                continue
            catalog_sources.append(path)
        names = self.installation_names(catalog_sources, stage, work)
        for path in catalog_sources:
            identity = names[file_hash(path)]
            if "error" in identity:
                print("Cached wheel cannot be reused: " + path.name + ": " + identity["error"], file=sys.stderr, flush=True)
                continue
            target = catalog / identity["filename"]
            if not target.exists():
                self.link_file(path, target, empty_sharing())
        lock = work / "requirements.lock"
        if requirements:
            key = digest([requirements, facts["abi"], facts["version"], facts["tags"], self.policy["uvVersion"], platform.system(), platform.machine()])
            resolution = self.resolutions / (key + ".v1.json")
            if resolution.exists():
                saved = load(resolution)
                if saved.get("version") != 1 or saved.get("key") != key or digest(saved["text"]) != saved["hash"]:
                    raise RuntimeError("Saved dependency resolution changed")
                lock.write_text(saved["text"])
            else:
                compile_args = [uv, "pip", "compile", str(requirements_file), "--python", str(interpreter), "--generate-hashes", "--output-file", str(lock),
                    "--cache-dir", str(work / "uv"), "--find-links", str(catalog)]
                for candidate in self.legacy(wheels_only=True, verify=False):
                    source = pathlib.Path(candidate["directory"])
                    if candidate["kind"] != "wheel" or (catalog / source.name).exists():
                        continue
                    try:
                        info = self.wheel(source)
                        identity = self.installation_names([source], stage, work)[info["hash"]]
                        if "error" in identity:
                            raise RuntimeError(identity["error"])
                    except (OSError, RuntimeError, ValueError, zipfile.BadZipFile) as error:
                        print("Historical wheel cannot resolve dependencies: " + source.name + ": " + str(error), file=sys.stderr, flush=True)
                        continue
                    target = catalog / identity["filename"]
                    if not target.exists():
                        self.link_file(source, target, empty_sharing())
                if any(catalog.glob("*.whl")):
                    try:
                        self.command(compile_args + ["--no-index"], work, readonly=[catalog], environment=stage)
                    except RuntimeError as error:
                        if "No solution found" not in str(error) and "not found in the provided package locations" not in str(error):
                            raise
                        self.command(compile_args, work, readonly=[catalog], environment=stage)
                else:
                    self.command(compile_args, work, readonly=[catalog], environment=stage)
                text = "\n".join(row["requirement"] for row in locked_requirements(lock.read_text())) + "\n"
                lock.write_text(text); save(resolution, {"version": 1, "key": key, "text": text, "hash": digest(text)})
            locked = locked_requirements(lock.read_text())
            self.reuse_plan["lockHash"] = digest(lock.read_text())
            allowed_hashes = {value for row in locked for value in row["hashes"]}
            known = {row["hash"] for row in self.material_records() if (self.materials / row["hash"] / row["filename"]).is_file()
                and file_hash(self.materials / row["hash"] / row["filename"]) == row["hash"]}
            for candidate in self.legacy(wheels_only=True):
                if candidate["kind"] != "wheel" or not candidate["reusable"]:
                    continue
                source = pathlib.Path(candidate["directory"]); info = self.wheel(source)
                if info["hash"] not in allowed_hashes:
                    continue
                if info["hash"] not in known and names.get(info["hash"], {}).get("filename"):
                    self.retain_material(source); known.add(info["hash"])
            selected, missing = [], []
            materials = [row for row in self.material_records() if (self.materials / row["hash"] / row["filename"]).is_file()
                and file_hash(self.materials / row["hash"] / row["filename"]) == row["hash"]]
            build_identity = self.source_build_identity(facts, stage, work) if any(item["source"].startswith("source-sha256:") for item in materials) else None
            for row in locked:
                match = next((item for item in materials if package_name(item["name"]) == package_name(row["name"])
                    and (row["version"] == "source" or item["versionString"] == row["version"])
                    and (item["hash"] in row["hashes"] or build_identity is not None and ";build-sha256:" + build_identity in item["source"]
                        and any("source-sha256:" + value + ";" in item["source"] for value in row["hashes"]))
                    and names.get(item["hash"], {}).get("filename")), None)
                if match:
                    selected.append(match)
                    decision = "shared" if self.reusable_package(match, facts) else "material"
                    self.reuse_plan["packages"].append({"name": row["name"], "version": match["versionString"], "wheelHash": match["hash"], "decision": decision, "bytes": match["bytes"]})
                else:
                    missing.append(row)
                    self.reuse_plan["packages"].append({"name": row["name"], "version": row["version"], "decision": "download", "reason": "No verified material matches the dependency digest and target tags"})
            self.check_failed_installation(self.effective_requirements, [item["hash"] for item in selected])
            self.hold_materials([item["hash"] for item in selected])
            missing_lock = work / "missing.lock"
            missing_lock.write_text("\n".join(row["requirement"] for row in missing) + "\n")
            self.plan_stage("reusing" if not missing else "downloading")
            # A source build from another target must not shadow the locked source archive in pip.
            download_catalog = work / "download-catalog"; download_catalog.mkdir(mode=0o700)
            missing_hashes = {value for row in missing for value in row["hashes"]}
            for path in catalog.glob("*.whl"):
                if file_hash(path) in missing_hashes:
                    self.link_file(path, download_catalog / path.name, empty_sharing())
            download = [str(self.installer_directory / "bin/python"), "-I", "-m", "pip", "download", "--require-hashes", "--no-deps", "--no-cache-dir", "-r", str(missing_lock),
                "--find-links", str(download_catalog), "--find-links", str(wheels), "--dest", str(wheels)]
            download_error = None; acquired_initial = []
            if missing:
                try:
                    self.command(download[:5] + ["--only-binary=:all:"] + download[5:], work, readonly=[catalog, self.installer_directory], environment=self.installer_directory)
                except RuntimeError as error:
                    download_error = error
                    acquired_initial = self.retain_downloads(wheels, missing, partial=True)
                    if "No matching distribution found" in str(error) or "Could not find a version that satisfies" in str(error):
                        known = self.material_records()
                        remaining = [row for row in missing if not any(item["hash"] in row["hashes"] and package_name(item["name"]) == package_name(row["name"]) for item in known)]
                        missing_lock.write_text("\n".join(row["requirement"] for row in remaining) + "\n")
                        try:
                            self.command(download, work, readonly=[catalog, self.installer_directory], environment=self.installer_directory); download_error = None
                        except RuntimeError as fallback:
                            download_error = fallback; self.retain_downloads(wheels, remaining, partial=True)
                    if download_error is not None:
                        raise download_error
            acquired = acquired_initial + self.retain_downloads(wheels, missing)
            for item in acquired:
                if item["hash"] not in {candidate["hash"] for candidate in selected}:
                    selected.append(item)
            built = work / "built"; built.mkdir(mode=0o700)
            source_origins = {}
            for source in list(wheels.iterdir()):
                if source.suffix == ".whl":
                    continue
                source_hash = file_hash(source)
                if source_hash not in allowed_hashes:
                    raise RuntimeError("Source archive differs from the resolved dependency digest")
                self.command([str(self.installer_directory / "bin/python"), "-I", "-m", "pip", "wheel", "--no-deps", "--no-cache-dir", "--wheel-dir", str(built), str(source)],
                    work, readonly=[catalog, self.installer_directory], environment=self.installer_directory)
                for wheel in built.glob("*.whl"):
                    source_origins[wheel.name] = "source-sha256:" + source_hash + ";wheel-sha256:" + file_hash(wheel) + ";build-sha256:" + self.source_build_identity(facts, stage, work)
                    os.rename(wheel, wheels / wheel.name)
            resolved = work / "built.lock"
            entries = []; installation = work / "installation"; installation.mkdir(mode=0o700)
            for wheel in list(wheels.glob("*.whl")):
                info = self.wheel(wheel)
                if info["hash"] not in allowed_hashes and wheel.name not in source_origins:
                    raise RuntimeError("Downloaded wheel differs from the resolved digest")
                path, retained = self.retain_material(wheel, source_origins.get(wheel.name))
                selected.append(retained)
                self.reuse_plan["downloadBytes"] += retained["bytes"]
                self.hold_materials([item["hash"] for item in selected])
            selected_names = {package_name(item["name"]) for item in selected}
            if selected_names != {package_name(row["name"]) for row in locked}:
                raise RuntimeError("Acquired materials do not match the resolved dependency set")
            shared = {}; expanded = 0; metadata_entries = 0
            names = self.installation_names([self.materials / item["hash"] / item["filename"] for item in selected], stage, work)
            for item in selected:
                original = self.materials / item["hash"] / item["filename"]
                identity = names[item["hash"]]
                if "error" in identity:
                    raise RuntimeError(item["filename"] + ": " + identity["error"])
                target = installation / identity["filename"]
                record = self.reusable_package(item, facts)
                if record:
                    self.metadata_wheel(original, target); shared[item["hash"]] = record
                    self.reuse_plan["reusedBytes"] += sum((self.objects / record["id"] / "payload" / name).stat().st_size for name in record["files"])
                    with zipfile.ZipFile(target) as archive:
                        expanded += sum(part.file_size for part in archive.infolist())
                else:
                    self.link_file(original, target, empty_sharing()); expanded += item["expandedBytes"]
                with zipfile.ZipFile(original) as archive:
                    metadata_entries += len(archive.infolist()) + len({str(pathlib.PurePosixPath(part.filename).parent) for part in archive.infolist()})
                entries.append(item["name"] + "==" + item["versionString"] + " --hash=sha256:" + file_hash(target))
            pending_bytes = expanded * 2 + metadata_entries * os.statvfs(self.namespace).f_frsize + sum(path.stat().st_size for path in installation.glob("*.whl") if path.stat().st_nlink == 1) + self.shared_copy_budget(list(shared.values()), work)
            self.reuse_plan["estimatedPeakBytes"] = max(0, before - shutil.disk_usage(self.workspace).free) + pending_bytes
            self.free(pending_bytes)
            resolved.write_text("\n".join(entries) + "\n"); self.plan_stage("installing")
            self.command([uv, "pip", "install", "--python", str(interpreter), "--require-hashes", "--no-index", "--find-links", str(wheels),
                "--find-links", str(installation), "--no-deps", "--link-mode", "hardlink", "--cache-dir", str(work / "uv"), "-r", str(resolved)],
                work, readonly=[catalog, installation], environment=stage)
        else:
            selected, shared = [], {}
        self.reuse_plan["estimatedPeakBytes"] = max(self.reuse_plan["estimatedPeakBytes"], max(0, before - shutil.disk_usage(self.workspace).free))
        self.command([uv, "cache", "clean", "--cache-dir", str(work / "uv")], work, readonly=[catalog], environment=stage)
        packages, sharing = [], empty_sharing()
        site = self.site(stage)
        self.selected_materials = selected
        for item in selected:
            path = self.materials / item["hash"] / item["filename"]
            record = shared.get(item["hash"])
            packages.append(self.install_shared(record, site, sharing) if record else self.publish_package(path, site, facts["abi"], item["source"], sharing))
        return packages, sharing

    def retain_downloads(self, wheels, locked, partial=False):
        """Complete hash-pinned wheels survive an unrelated download or installation failure."""
        retained = []
        for path in list(wheels.glob("*.whl")):
            try:
                info = self.wheel(path)
            except (OSError, RuntimeError, ValueError, zipfile.BadZipFile) as error:
                if not partial:
                    raise
                print("Incomplete material retained privately: " + path.name + ": " + str(error), file=sys.stderr, flush=True)
                continue
            requested = next((row for row in locked if package_name(row["name"]) == package_name(info["name"])
                and (row["version"] == "source" or row["version"] == info["version"]) and info["hash"] in row["hashes"]), None)
            if requested is None:
                raise RuntimeError("Acquired wheel does not match its resolved package identity and digest")
            _, value = self.retain_material(path)
            retained.append(value)
            self.reuse_plan["downloadBytes"] += value["bytes"]
            hashes = [item["hash"] for item in retained]
            lease = self.material_references / (self.id + "-" + self.current_operation.name + ".json")
            if lease.exists():
                hashes += load(lease)["hashes"]
            self.hold_materials(hashes)
        return retained

    def cleanup(self, operation_id, fingerprint):
        path = self.operations / ("cleanup-" + operation_id + ".json")
        if path.exists():
            saved = load(path)
            if saved["fingerprint"] != fingerprint:
                raise RuntimeError("Cleanup identity is bound to another preview")
            if saved["state"] == "completed":
                return saved["result"]
            raise RuntimeError("Cleanup outcome is unknown; inspect before retrying")
        preview = self.preview()
        if preview["fingerprint"] != fingerprint:
            raise RuntimeError("Package references or cleanup candidates changed; refresh the preview")
        selected = self.config.get("candidateIds")
        if selected is not None and (not selected or not set(selected).issubset({row["id"] for row in preview["candidates"]})):
            raise RuntimeError("Cleanup selection differs from its preview")
        preview["candidates"] = [row for row in preview["candidates"] if (not row["kind"].startswith("historical-") and selected is None) or (selected is not None and row["id"] in selected)]
        save(path, {"version": 1, "fingerprint": fingerprint, "state": "running", "candidates": preview["candidates"]})
        before = shutil.disk_usage(self.namespace).free
        for row in preview["candidates"]:
            if row["kind"].startswith("historical-") and self.config.get("governancePolicy"):
                governance = storage_governance(self)
                with governance.locked():
                    expected = next((item for item in governance.historical_cleanup() if item["id"] == row["id"]), None)
                    if expected is None:
                        raise RuntimeError("Historical cleanup release evidence changed")
                    governance.clean_historical(row["id"], expected)
            elif row["kind"] == "package":
                remove_private(self.objects / row["id"], self.store)
            elif row["kind"] == "temporary" and re.fullmatch(r"temporary-[a-f0-9-]{36}", row["id"]):
                original = row["id"][10:]
                self.assert_exited("environment-" + original, self.config.get("launchFailureConfirmed", False))
                cleanup_path = self.cleanups / (original + ".json")
                if cleanup_path.exists():
                    cleanup = load(cleanup_path)
                    environment = self.environment(cleanup["environmentId"])
                    if not environment:
                        raise RuntimeError("Pending cleanup environment identity cannot be confirmed")
                    result = self.cleanup_work(original, environment)
                    if result["state"] != "completed":
                        result = {"serverId": self.server, "state": "blocked", "reclaimedBytes": max(0, shutil.disk_usage(self.namespace).free - before),
                            "checkedAt": now(), "detail": result.get("detail", "Private temporary cleanup remains pending")}
                        save(path, {"version": 1, "fingerprint": fingerprint, "state": "completed", "result": result})
                        return result
                else:
                    remove_private(self.workspace / "tmp" / ("environment-" + original), self.workspace, self.owner)
                    (self.material_references / (self.id + "-" + original + ".json")).unlink(missing_ok=True)
            elif row["kind"] == "material" and re.fullmatch(r"material-[a-f0-9]{64}", row["id"]):
                remove_private(self.materials / row["id"][9:], self.store)
            else:
                raise RuntimeError("Unknown cleanup candidate kind")
        result = {"serverId": self.server, "state": "completed", "reclaimedBytes": max(0, shutil.disk_usage(self.namespace).free - before), "checkedAt": now()}
        save(path, {"version": 1, "fingerprint": fingerprint, "state": "completed", "result": result})
        return result


def release_references(config):
    owner = Environments(config)
    if owner.run.exists() or (owner.namespace / (".cleanup-" + owner.id)).exists():
        raise RuntimeError("Environment references cannot be released before confirmed remote deletion")
    if config.get("governancePolicy"):
        governance = storage_governance(owner)
        with governance.locked():
            governance.release()
    if (owner.control / "training-storage-v1/runs" / owner.id).exists():
        raise RuntimeError("Training environment files have not finished deletion")
    for store in {owner.store, owner.control / "training-storage-v1/packages-v1"}:
        if not store.exists():
            continue
        reject_links(store)
        if load(store / "owner.v1.json") != {"version": 1, "serverId": owner.server}:
            raise RuntimeError("Package store ownership differs")
        with open(store / "lock", "r") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            for path in (store / "references").glob("*.json"):
                row = load(path)
                if row["serverId"] != owner.server:
                    raise RuntimeError("Package reference server differs")
                if row["experimentId"] == owner.id:
                    if pathlib.Path(row["directory"]).exists() or pathlib.Path(row["manifest"]).exists():
                        raise RuntimeError("Deleted experiment still has an environment or manifest")
                    path.unlink()
    return {"released": True}


def main(config):
    action = config["action"]
    if action == "release-references":
        return release_references(config)
    owner = Environments(config)
    if action.startswith("history-"):
        marker = load(owner.control / ".aspera-owner.json")
        if marker.get("serverId") != owner.server or marker.get("kind") != "control":
            raise RuntimeError("Original control directory ownership cannot be confirmed for historical preparation")
        owner.run = owner.control / "state/preparation-storage-v1" / owner.id
        if config.get("storageLocation"):
            owner.workspace = pathlib.Path(config["storageLocation"])
        governance = storage_governance(owner)
        with governance.locked():
            if action == "history-inspect":
                return governance.catalog(config.get("refresh", True), config.get("cursor"))
            if action == "history-preview":
                return governance.history_preview()
            if action == "history-cleanup":
                return governance.history_cleanup(config["request"])
            if action == "history-assess":
                return governance.assess(config["request"])
            if action == "history-material-inspect":
                return governance.inspect_material(config["request"], config.get("canonical"))
            raise RuntimeError("Unknown preparation storage operation")
    if action.startswith("storage-") or action.startswith("material-"):
        owner.owner()
        governance = storage_governance(owner)
        if action == "material-prepare":
            try:
                return governance.prepare_material(config["request"])
            except (Exception, KeyboardInterrupt) as error:
                value = governance.register_material(config["request"])
                value.update(state="blocked", stage="blocked", detail=str(error), updatedAt=now(), exitConfirmed=True, admissionReleased=False)
                save(owner.run / "material-operations-v1" / config["request"]["operationId"] / "receipt.v1.json", value)
                return value
        with governance.locked():
            if action == "storage-inspect":
                return governance.catalog(config.get("refresh", False), config.get("cursor"))
            if action == "storage-assess":
                return governance.assess(config["request"])
            if action == "storage-plan":
                path = owner.run / "storage-plan.v1.json"
                return load(path) if path.exists() else None
            if action == "storage-command-reserve":
                return governance.reserve_command(config["commandId"])
            if action == "storage-command-settle":
                return governance.settle_capacity(config["commandId"], config.get("launchFailureConfirmed", False))
            if action == "storage-release":
                return governance.release_capacity()
            if action == "material-inspect":
                return governance.inspect_material(config["request"], config.get("canonical"))
            if action == "material-status":
                return governance.material_operation(config["operationId"])
            if action == "material-register":
                return governance.register_material(config["request"])
            if action == "material-metadata-pending":
                return governance.pending_metadata()
            if action == "material-metadata-error":
                return governance.metadata_error(config["requestId"], config["detail"])
            if action == "material-settle":
                return governance.settle_material(config["operationId"])
            if action == "material-stop":
                return governance.stop_material(config["operationId"], config["reason"])
            raise RuntimeError("Unknown storage governance operation")
    with owner.locked(write=action in ("prepare", "cleanup", "recover", "recover-cleanup")):
        if action == "inspect":
            return owner.inspect()
        if action == "acceptance":
            return owner.acceptance()
        if action == "preview":
            return owner.preview()
        if action == "cleanup":
            return owner.cleanup(config["operationId"], config["fingerprint"])
        if action == "prepare":
            return owner.prepare(config["request"])
        if action == "recover":
            return owner.recover(config["request"])
        if action == "recover-cleanup":
            return owner.recover_cleanup(config["operationId"], config["fingerprint"])
        raise RuntimeError("Unknown managed environment operation")


if __name__ == "__main__":
    try:
        config = json.loads(sys.stdin.read(1048577)) if len(sys.argv) == 1 else load(sys.argv[1])
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt("Environment operation cancelled")))
        result = main(config)
        print(json.dumps(result))
        if config["action"] in ("prepare", "material-prepare") and result.get("state") == "blocked":
            sys.exit(1)
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
