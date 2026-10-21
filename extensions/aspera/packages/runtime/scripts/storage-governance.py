"""Account-scoped storage inventories, released environment loans and pinned material acquisition.

The managed-environment helper loads this module into its own namespace so SSH reads
and node operations share the same ownership checks and durable implementation.
"""
import urllib.request
import urllib.parse
import urllib.error
import socket


def governance_row(path):
    reject_links(path)
    value = load(path)
    return value.get("record", value)


def governance_identity(path):
    value = pathlib.Path(path).stat()
    return [value.st_dev, value.st_ino, value.st_size, str(value.st_mtime_ns), str(value.st_ctime_ns)]


class StorageGovernance:
    def __init__(self, owner):
        self.owner = owner
        self.config = owner.config
        self.server, self.experiment = owner.server, owner.id
        self.control, self.namespace, self.run = owner.control, owner.namespace, owner.run
        self.root = self.control / "state" / "storage-governance-v1"
        self.policy = self.config["governancePolicy"]
        self.bindings = self.run / "environment-borrowings-v1"
        self.material_bindings = self.run / "material-bindings-v1"
        self._lock_depth = 0
        self._content_keys = {}

    @contextlib.contextmanager
    def locked(self):
        if self._lock_depth:
            yield
            return
        reject_links(self.root)
        self.root.mkdir(parents=True, mode=0o700, exist_ok=True)
        with open(self.root / "lock", "a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self._lock_depth += 1
            try:
                yield
            finally:
                self._lock_depth -= 1

    def roots(self):
        result, errors = {}, []
        candidates = [self.namespace, self.control]
        registry = self.control / "state" / "storage-roots"
        reject_links(registry)
        if registry.exists():
            for path in sorted(registry.glob("*/.aspera-owner.json")):
                candidates.append(pathlib.Path(governance_row(path)["namespaceRoot"]))
        for candidate in candidates:
            try:
                reject_links(candidate)
                marker = governance_row(candidate / ".aspera-owner.json")
                if marker.get("serverId") != self.server or marker.get("kind") not in ("storage", "control"):
                    raise RuntimeError("Storage root ownership cannot be confirmed")
                value = candidate.stat()
                registry_path = self.control / "state/storage-governance-v1/root-identities" / (digest(str(candidate)) + ".json")
                identity = {key: self.mount(candidate)[key] for key in ("directory", "filesystem", "source")}
                if registry_path.exists() and governance_row(registry_path) != identity:
                    raise RuntimeError("Storage volume identity changed; explicit preparation verification is required")
                if str(candidate) == self.owner.placement["namespaceRoot"] and "candidate" in self.owner.placement:
                    original_mount = self.owner.placement["candidate"]["mount"]
                    if original_mount["source"] != identity["source"] or original_mount["filesystem"] != identity["filesystem"]:
                        raise RuntimeError("Actual storage volume differs from the saved submission")
                result[str(candidate)] = {"id": digest([self.server, str(candidate), value.st_dev, value.st_ino]),
                    "directory": str(candidate), "confirmed": True}
            except (OSError, RuntimeError, KeyError, ValueError) as error:
                errors.append(str(candidate) + ": " + str(error))
                result[str(candidate)] = {"id": digest([self.server, str(candidate)]), "directory": str(candidate),
                    "confirmed": False, "detail": str(error)}
        return list(result.values()), errors

    def mount(self, path):
        """Read current mount identity; saved mount IDs never authorize a later operation."""
        target = str(pathlib.Path(path).absolute())
        choices = []
        table = getattr(self, "_scan_mount_table", None)
        if table is None:
            table = pathlib.Path("/proc/self/mountinfo").read_text()
        for line in table.splitlines():
            left, right = line.split(" - ", 1)
            fields, tail = left.split(), right.split()
            mount = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), fields[4])
            if target == mount or target.startswith(mount.rstrip("/") + "/"):
                choices.append((len(mount), {"mountId": int(fields[0]), "directory": mount,
                    "filesystem": tail[0], "source": tail[1], "readonly": "ro" in fields[5].split(",")}))
        if not choices:
            raise RuntimeError("Actual mount identity cannot be read: " + target)
        return max(choices, key=lambda item: item[0])[1]

    def inventory_mounts(self):
        """Observe volume capacity without scanning or adopting unowned directories."""
        result = [self.mount(self.control), self.mount(self.namespace)]
        table = pathlib.Path("/proc/self/mountinfo")
        if not table.exists():
            return result
        prefixes = self.policy["inventoryMountPrefixes"]
        for line in table.read_text().splitlines():
            left, right = line.split(" - ", 1)
            fields, tail = left.split(), right.split()
            directory = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), fields[4])
            if tail[0] not in ("ext4", "xfs", "btrfs", "overlay", "zfs") or not any(directory == prefix or prefix != "/" and directory.startswith(prefix.rstrip("/") + "/") for prefix in prefixes):
                continue
            if pathlib.Path(directory).is_dir():
                result.append(self.mount(directory))
        return result

    def source_released(self, experiment, run):
        """Require both original terminal outcome and local node release, including services."""
        allocation = self.control / "state/node-home/storages/aspera_node/allocations" / (experiment + ".json")
        task = self.control / "state/coordinator-home/storages/aspera_queue/experiments" / (experiment + ".json")
        receipt = run / "interruption.v1.json"
        node = governance_row(allocation) if allocation.exists() else None
        outcome = governance_row(task) if task.exists() else None
        if outcome is None and receipt.exists():
            settled = governance_row(receipt)
            if settled.get("phase") == "released" and all(n.get("phase") == "released" for n in settled.get("nodes", [])):
                outcome = settled.get("result")
        if not node or node.get("released") is not True or node.get("experimentId") != experiment:
            raise RuntimeError("Original node allocation release is unconfirmed: " + experiment)
        if not outcome or outcome.get("state") not in ("completed", "failed", "blocked", "cancelled", "interrupted") or outcome.get("resourcesReleased") is not True:
            raise RuntimeError("Original terminal outcome and resource release are unconfirmed: " + experiment)
        submission = outcome.get("submission", {})
        original = next((row for row in submission.get("nodes", []) if row.get("server", {}).get("id") == self.server), None)
        if submission.get("experimentId") != experiment or original is None or original.get("server", {}).get("storagePlacement", {}).get("runRoot") != str(run):
            raise RuntimeError("Original terminal submission does not confirm this experiment and source node")
        if node.get("deploymentId") != submission.get("deploymentId") or node.get("node", {}).get("server", {}).get("id") != self.server:
            raise RuntimeError("Original allocation and terminal release identities differ")
        saved = node.get("node", {}).get("server", {}).get("storagePlacement", {})
        if saved.get("runRoot") != str(run) or saved.get("serverId") != self.server:
            raise RuntimeError("Original allocation points to a different storage root")
        for table in ("commands", "services"):
            folder = self.control / "state/node-home/storages/aspera_node" / table
            for path in folder.glob("*.json"):
                row = governance_row(path)
                if row.get("experimentId") == experiment and row.get("released") is not True:
                    raise RuntimeError("Original " + table + " remain occupied: " + experiment)
        if any(row.get("released") is not True for row in outcome.get("services", [])):
            raise RuntimeError("Original inference services remain occupied")
        proc = pathlib.Path("/proc")
        for entry in proc.iterdir():
            if not entry.name.isdigit() or int(entry.name) == os.getpid():
                continue
            try:
                command = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
                cwd = str((entry / "cwd").resolve(strict=True))
            except FileNotFoundError:
                continue
            except PermissionError as error:
                raise RuntimeError("Cannot confirm original process exit: " + entry.name) from error
            roots = [str(run), str(source_training_workspace(self.owner, run))]
            if any(root in command or cwd == root or cwd.startswith(root + "/") for root in roots):
                raise RuntimeError("A process still uses the original experiment: " + entry.name)
        return digest([node, outcome])

    def leases(self, source=None):
        result = []
        for path in (self.root / "environment-leases").glob("*.json"):
            row = governance_row(path)
            if row.get("serverId") != self.server:
                raise RuntimeError("Historical environment lease belongs to another server")
            if source is None or row["sourceExperimentId"] == source:
                result.append(row)
        return result

    def protect_source(self, experiment):
        held = self.leases(experiment)
        if held:
            raise RuntimeError("Historical environment is borrowed read-only by: " + ", ".join(sorted({row["experimentId"] for row in held})))
        for path in (self.root / "material-source-leases").glob("*.json"):
            row = governance_row(path)
            if row.get("serverId") != self.server:
                raise RuntimeError("Historical material source lease belongs to another server")
            if row.get("sourceExperimentId") == experiment:
                raise RuntimeError("Historical model/data source is retained by material " + row["materialId"])

    def protect_path(self, path):
        target = pathlib.Path(path)
        sources = [row["directory"] for row in self.leases()]
        sources.extend(governance_row(record)["directory"] for record in (self.root / "material-source-leases").glob("*.json"))
        if any(target == pathlib.Path(source) or target.is_relative_to(source) or pathlib.Path(source).is_relative_to(target) for source in sources):
            raise RuntimeError("Cleanup overlaps a retained environment or model/data source")

    def candidate(self, run, directory, namespace):
        origin_path = run / "source-run.v1.json"
        if origin_path.exists():
            origin = governance_row(origin_path)
            if origin.get("version") != 1 or origin.get("serverId") != self.server or origin.get("experimentId") != run.name:
                raise RuntimeError("Historical training source belongs to another node")
            original = pathlib.Path(origin["runRoot"])
            if original.name != run.name or original.parent.name != "runs" or not directory.is_relative_to(source_training_workspace(self.owner, original)):
                raise RuntimeError("Historical training source differs from its placement")
            run, namespace = original, original.parent.parent
        owner = governance_row(run / ".aspera-owner.json")
        if owner != {"version": 1, "experimentId": run.name, "serverId": self.server}:
            raise RuntimeError("Historical experiment ownership differs")
        reject_links(directory)
        python = directory / "bin/python"
        if not (directory / "pyvenv.cfg").is_file() or not python.exists():
            return None
        identifier = digest([self.server, run.name, str(directory), governance_identity(directory)])
        sites = list((directory / "lib").glob("python*/site-packages"))
        packages = sum(len(list(site.glob("*.dist-info"))) for site in sites)
        distributions = []
        for site in sites:
            reject_links(site)
            for metadata in sorted(site.glob("*.dist-info/METADATA")):
                if len(distributions) >= self.policy["materialFileLimit"]:
                    break
                reject_links(metadata)
                if metadata.stat().st_size > self.policy["metadataBytes"]:
                    continue
                value = email.message_from_bytes(metadata.read_bytes())
                if value.get("Name") and value.get("Version"):
                    distributions.append({"name": value["Name"], "version": value["Version"]})
        return {"id": identifier, "sourceExperimentId": run.name, "directory": str(directory), "python": str(python),
            "namespaceRoot": str(namespace), "runRoot": str(run), "visibility": "sandbox-hidden", "packages": packages,
            "allocatedBytes": None, "reusable": None, "distributions": distributions, "metadataComplete": len(distributions) == packages,
            "detail": "Historical installation candidate; metadata versions guide dependency requests, but release, integrity and dependency verification remain required"}

    def catalog(self, refresh=False, cursor=None):
        saved_path = self.root / "catalog.v1.json"
        progress = self.root / "scan.v1.json"
        if not refresh and not cursor and saved_path.exists():
            return governance_row(saved_path)
        roots, errors = self.roots()
        fingerprint = digest(roots)
        for row in roots:
            if row["confirmed"]:
                observation = self.mount(row["directory"])
                save(self.root / "root-identities" / (digest(row["directory"]) + ".json"),
                    {key: observation[key] for key in ("directory", "filesystem", "source")})
        if cursor:
            state = governance_row(progress)
            if state["cursor"] != cursor or state["fingerprint"] != fingerprint:
                raise RuntimeError("Storage scan cursor is stale; restart the inventory")
        else:
            state = {"version": 1, "cursor": str(uuid.uuid4()), "fingerprint": fingerprint, "seen": [], "volumes": {},
                "todo": [[row["directory"], row["directory"]] for row in roots if row["confirmed"]], "entriesScanned": 0,
                "historicalEnvironments": [], "materialFiles": [], "materialFilesComplete": True, "diagnostics": errors}
            for mount in self.inventory_mounts():
                key = digest([mount["directory"], mount["filesystem"], mount["source"]])
                state["volumes"][key] = {"id": key, "directory": mount["directory"], "filesystem": mount["filesystem"], "source": mount["source"],
                    "categories": {}, "accountWritable": not mount["readonly"] and os.access(mount["directory"], os.W_OK), "sandboxWritable": None}
        seen = {tuple(row) for row in state["seen"]}
        deadline = time.monotonic() + self.policy["scanTimeoutMs"] / 1000
        limit = state["entriesScanned"] + self.policy["scanEntryLimit"]
        mount_file = pathlib.Path("/proc/self/mountinfo")
        if mount_file.exists():
            self._scan_mount_table = mount_file.read_text()
        root_mounts = {row["directory"]: self.mount(row["directory"]) for row in roots if row["confirmed"]}
        while state["todo"] and state["entriesScanned"] < limit and time.monotonic() < deadline:
            name, root = state["todo"].pop()
            path = pathlib.Path(name)
            try:
                info = path.lstat()
                state["entriesScanned"] += 1
                if stat.S_ISLNK(info.st_mode):
                    continue
                mount = self.mount(path)
                root_mount = root_mounts[root]
                if mount["mountId"] != root_mount["mountId"]:
                    state["diagnostics"].append("Nested mount excluded: " + name)
                    continue
                key = digest([mount["directory"], mount["filesystem"], mount["source"]])
                volume = state["volumes"].setdefault(key, {"id": key, "directory": mount["directory"], "filesystem": mount["filesystem"],
                    "source": mount["source"], "categories": {}, "accountWritable": not mount["readonly"] and os.access(root, os.W_OK),
                    "sandboxWritable": None})
                if stat.S_ISDIR(info.st_mode):
                    if (path / "pyvenv.cfg").is_file():
                        parts = path.relative_to(root).parts
                        if len(parts) >= 4 and parts[0] == "runs" and parts[2] == "workspace":
                            row = self.candidate(pathlib.Path(root) / "runs" / parts[1], path, pathlib.Path(root))
                            if row and not any(item["id"] == row["id"] for item in state["historicalEnvironments"]):
                                state["historicalEnvironments"].append(row)
                    with os.scandir(path) as entries:
                        children = []
                        for entry in entries:
                            if len(children) >= self.policy["scanEntryLimit"]:
                                state["diagnostics"].append("Directory enumeration exceeds the configured entry budget; remaining entries unscanned: " + name)
                                break
                            children.append(entry.path)
                    state["todo"].extend([child, root] for child in sorted(children, reverse=True))
                elif stat.S_ISREG(info.st_mode):
                    identity = (info.st_dev, info.st_ino)
                    kind = self.category(path, pathlib.Path(root))
                    bucket = volume["categories"].setdefault(kind, {"kind": kind, "logicalBytes": 0, "allocatedBytes": 0, "files": 0})
                    bucket["logicalBytes"] += info.st_size
                    if identity not in seen:
                        bucket["allocatedBytes"] += getattr(info, "st_blocks", (info.st_size + 511) // 512) * 512
                        seen.add(identity)
                    bucket["files"] += 1
                    parts = path.relative_to(root).parts
                    if len(parts) >= 4 and parts[0] == "runs" and parts[2] == "workspace" and kind not in ("environment", "release", "log", "checkpoint", "result"):
                        if len(state["materialFiles"]) < self.policy["materialFileLimit"]:
                            state["materialFiles"].append({"path": name, "bytes": info.st_size, "runRoot": str(pathlib.Path(root) / "runs" / parts[1]), "sourceExperimentId": parts[1]})
                        else:
                            state["materialFilesComplete"] = False
            except (OSError, RuntimeError, ValueError) as error:
                state["diagnostics"].append(name + ": " + str(error))
        if hasattr(self, "_scan_mount_table"):
            if mount_file.read_text() != self._scan_mount_table:
                state["diagnostics"].append("Mount topology changed during account-side inventory; refresh before using candidates")
            del self._scan_mount_table
        volumes = []
        for volume in state["volumes"].values():
            usage = shutil.disk_usage(volume["directory"])
            categories = list(volume["categories"].values())
            measured = sum(row["allocatedBytes"] for row in categories)
            volumes.append({**volume, "categories": categories, "capacityBytes": usage.total, "availableBytes": usage.free,
                "measuredBytes": measured, "unattributedBytes": max(0, usage.total - usage.free - measured)})
        result = {"version": 1, "serverId": self.server, "checkedAt": now(), "complete": not state["todo"] and not state["diagnostics"],
            "entriesScanned": state["entriesScanned"], "roots": roots, "volumes": volumes,
            "historicalEnvironments": state["historicalEnvironments"], "diagnostics": state["diagnostics"]}
        if state["todo"]:
            result["cursor"] = state["cursor"]
        state["seen"] = list(seen)
        save(progress, state)
        save(saved_path, result)
        return result

    @staticmethod
    def category(path, root):
        parts = path.relative_to(root).parts
        if "releases" in parts:
            return "release"
        if "packages-v1" in parts:
            return "package"
        if "assets-v1" in parts:
            return "dataset" if "datasets" in parts else "model"
        if "site-packages" in parts or any(name in parts for name in ("pyenv", "venv", ".venv", "env")):
            return "environment"
        if path.suffix in (".log", ".jsonl") or "logs" in parts or "observations-v1" in parts:
            return "log"
        if any(part.startswith("checkpoint-") or part == "checkpoints" for part in parts):
            return "checkpoint"
        if "tmp" in parts or "incoming" in parts or path.suffix in (".part", ".whl"):
            return "temporary"
        if path.suffix in (".safetensors", ".bin") and "cache" in parts:
            return "model"
        if "datasets" in parts:
            return "dataset"
        if "reports" in parts or "artifacts" in parts or "output" in parts:
            return "result"
        return "other"

    def find_candidate(self, identifier):
        roots, errors = self.roots()
        saved = self.root / "catalog.v1.json"
        if saved.exists():
            for row in governance_row(saved)["historicalEnvironments"]:
                if row["id"] != identifier:
                    continue
                namespace, run, directory = map(pathlib.Path, (row["namespaceRoot"], row["runRoot"], row["directory"]))
                if not any(root["confirmed"] and pathlib.Path(root["directory"]) == namespace for root in roots) or run != namespace / "runs" / row["sourceExperimentId"] or not directory.is_relative_to(source_training_workspace(self.owner, run)):
                    raise RuntimeError("Historical environment candidate escaped its registered storage root")
                current = self.candidate(run, directory, namespace)
                if current and current["id"] == identifier:
                    return current
                raise RuntimeError("Historical environment candidate identity changed")
        for root in roots:
            if not root["confirmed"]:
                continue
            namespace = pathlib.Path(root["directory"])
            for run in (namespace / "runs").glob("*"):
                if not run.is_dir() or run.is_symlink() or run.name == self.experiment or not (run / ".aspera-owner.json").exists():
                    continue
                for candidate in (run / "workspace/pyenv", run / "workspace/env/python", run / "workspace/.venv", run / "workspace/venv"):
                    if not candidate.exists():
                        continue
                    row = self.candidate(run, candidate, namespace)
                    if row and row["id"] == identifier:
                        return row
        raise RuntimeError("Historical environment candidate is absent or its identity changed: " + identifier)

    def verify_borrowed(self, candidate, request):
        directory = pathlib.Path(candidate["directory"])
        run = pathlib.Path(candidate["runRoot"])
        released_hash = self.source_released(candidate["sourceExperimentId"], run)
        executable = pathlib.Path(candidate["python"]).resolve(strict=True)
        if not (executable.is_relative_to(directory) or executable.is_relative_to("/usr") or executable.is_relative_to("/opt/python")):
            raise RuntimeError("Historical interpreter symlink escapes approved interpreter locations")
        rows, links = [], []
        interpreter_identity = governance_identity(executable)
        interpreter = {"path": str(executable), "hash": file_hash(executable), "size": interpreter_identity[2],
            "mtimeNs": interpreter_identity[3], "ctimeNs": interpreter_identity[4]}
        if governance_identity(executable) != interpreter_identity:
            raise RuntimeError("Historical interpreter changed during verification")
        if re.search(r"(?im)^include-system-site-packages\s*=\s*true\s*$", (directory / "pyvenv.cfg").read_text()):
            raise RuntimeError("Historical environment mixes unowned system site-packages")
        for base, dirs, names in os.walk(directory, followlinks=False):
            dirs[:] = sorted(dirs)
            for name in sorted(dirs + names):
                path = pathlib.Path(base) / name
                if path.is_symlink():
                    resolved = path.resolve(strict=True)
                    links.append({"path": path.relative_to(directory).as_posix(), "target": str(resolved)})
                    if path == pathlib.Path(candidate["python"]) or path.parent == directory / "bin" and name.startswith("python"):
                        if resolved != executable:
                            raise RuntimeError("Historical interpreter aliases differ")
                        continue
                    if not resolved.is_relative_to(directory):
                        raise RuntimeError("Historical package symlink escapes its environment: " + str(path))
                if not path.is_file() or path.is_symlink():
                    continue
                relative_name = path.relative_to(directory).as_posix()
                if path.suffix in (".pth", ".egg-link"):
                    for line in path.read_text().splitlines():
                        line = line.strip()
                        if line and not line.startswith("#"):
                            if line.startswith("import "):
                                if name not in ("distutils-precedence.pth", "_virtualenv.pth"):
                                    raise RuntimeError("Executable historical .pth requires explicit review: " + relative_name)
                            elif not (path.parent / line).resolve().is_relative_to(directory):
                                raise RuntimeError("Historical editable dependency escapes its environment: " + relative_name)
                identity = governance_identity(path)
                checksum = file_hash(path)
                if governance_identity(path) != identity:
                    raise RuntimeError("Historical environment changed during verification: " + relative_name)
                rows.append({"path": relative_name, "hash": checksum, "size": identity[2], "mtimeNs": identity[3], "ctimeNs": identity[4]})
                if len(rows) > self.policy["snapshotFileLimit"]:
                    raise RuntimeError("Historical environment snapshot exceeds configured file limit")
        known_hashes = {str(directory / row["path"]): row["hash"] for row in rows}
        for record in directory.glob("lib/python*/site-packages/*.dist-info/RECORD"):
            for name, checksum, size in csv.reader(io.StringIO(record.read_text())):
                if not checksum:
                    continue
                target = (record.parent.parent / name).resolve()
                if not target.is_relative_to(directory) or not target.is_file():
                    raise RuntimeError("Historical distribution RECORD is incomplete or escapes its environment: " + name)
                algorithm, expected = checksum.split("=", 1)
                if algorithm != "sha256":
                    raise RuntimeError("Historical distribution RECORD uses an unsupported digest: " + algorithm)
                checksum_hex = known_hashes.get(str(target)) or file_hash(target)
                actual = base64.urlsafe_b64encode(bytes.fromhex(checksum_hex)).rstrip(b"=").decode()
                if actual != expected or size and target.stat().st_size != int(size):
                    raise RuntimeError("Historical distribution content differs from its RECORD: " + name)
        probe = r'''
import importlib,importlib.metadata,json,pathlib,site,sys,sysconfig
from packaging.requirements import Requirement
requirements=json.loads(sys.argv[1]); modules=json.loads(sys.argv[2]); need_cuda=sys.argv[3]=='1'
prefix=pathlib.Path(sys.prefix).resolve()
standard=[pathlib.Path(sysconfig.get_path(name)).resolve() for name in ('stdlib','platstdlib')]
version=str(sys.version_info.major)+str(sys.version_info.minor)
archive=pathlib.Path(sys.base_prefix)/'lib'/('python'+version+'.zip')
for entry in sys.path:
    path=pathlib.Path(entry).resolve()
    if path.is_relative_to(prefix): continue
    if any(name in path.parts for name in ('site-packages','dist-packages')):
        raise RuntimeError('Historical interpreter loads unowned package directory: '+str(path))
    if path!=archive and not any(path.is_relative_to(root) for root in standard):
        raise RuntimeError('Historical interpreter loads an unauthorized module directory: '+str(path))
for text in requirements:
    r=Requirement(text)
    if r.url: raise RuntimeError('Historical reuse does not accept unverified direct URLs')
    if r.marker and not r.marker.evaluate(): continue
    version=importlib.metadata.version(r.name)
    if version not in r.specifier: raise RuntimeError(str(r)+' differs from installed '+version)
for dist in importlib.metadata.distributions():
    for text in dist.requires or []:
        r=Requirement(text)
        if r.marker and not r.marker.evaluate({'extra':''}): continue
        version=importlib.metadata.version(r.name)
        if version not in r.specifier: raise RuntimeError(str(r)+' differs from installed '+version)
for name in modules: importlib.import_module(name)
cuda=False
try: importlib.metadata.version('torch'); has_torch=True
except importlib.metadata.PackageNotFoundError: has_torch=False
if need_cuda or has_torch and sys.argv[4]=='1':
    import torch
    if not torch.cuda.is_available(): raise RuntimeError('Historical environment CUDA is unavailable')
    x=torch.ones(1,device='cuda'); y=(x+x).cpu().item(); torch.cuda.synchronize()
    if y!=2: raise RuntimeError('Historical CUDA computation failed')
    cuda=True
print(json.dumps({'prefix':sys.prefix,'pythonVersion':sys.version.split()[0],'pythonAbi':sysconfig.get_config_var('SOABI'),'userSite':site.ENABLE_USER_SITE,'cuda':cuda}))
'''
        readonly = [directory] + ([] if executable.is_relative_to(directory) else [executable])
        work = self.owner.workspace / "tmp" / ("environment-" + request["operationId"])
        argv = self.owner.sandbox([candidate["python"], "-I", "-B", "-c", probe, json.dumps(request["requirements"]),
            json.dumps(request["modules"]), "1" if request["requireCuda"] else "0", "1" if self.config.get("devicePaths") else "0"], writable=[work], readonly=readonly, environment=directory)
        result = subprocess.run(argv, capture_output=True, text=True, timeout=self.policy["verificationTimeoutMs"] / 1000,
            env={"PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"})
        if result.returncode:
            raise RuntimeError("Historical environment verification failed: " + result.stderr[-16384:])
        facts = json.loads(result.stdout)
        if facts["prefix"] != str(directory) or facts["userSite"]:
            raise RuntimeError("Historical interpreter prefix or user-site isolation differs")
        if governance_identity(executable) != interpreter_identity or any(str((directory / row["path"]).resolve(strict=True)) != row["target"] for row in links):
            raise RuntimeError("Historical interpreter or package links changed during verification")
        if self.source_released(candidate["sourceExperimentId"], run) != released_hash:
            raise RuntimeError("Original experiment state changed during verification")
        for row in rows:
            identity = governance_identity(directory / row["path"])
            if identity[2:] != [row["size"], row["mtimeNs"], row["ctimeNs"]]:
                raise RuntimeError("Historical environment changed while imports were verified: " + row["path"])
        value = {"version": 1, "experimentId": self.experiment, "serverId": self.server, "deploymentId": self.config["deploymentId"],
            "environmentId": request["environmentId"], "operationId": request["operationId"], "candidateId": candidate["id"],
            "mode": "borrowed-readonly", "sourceExperimentId": candidate["sourceExperimentId"], "sourceRunRoot": str(run),
            "directory": str(directory), "python": candidate["python"], "pythonVersion": facts["pythonVersion"], "pythonAbi": facts["pythonAbi"],
            "sourceHash": digest([rows, links, interpreter]), "files": rows, "links": links, "interpreter": interpreter,
            "volume": {key: self.mount(directory)[key] for key in ("directory", "filesystem", "source")},
            "requirements": request["requirements"], "modules": request["modules"],
            "cuda": facts["cuda"], "verified": True, "checkedAt": now(), "readonlyPaths": [str(p) for p in readonly],
            "lease": str(self.root / "environment-leases" / (self.experiment + "-" + request["environmentId"] + ".json"))}
        return value

    def borrowing(self, request):
        lock = self.control / "state/controller-admission.lock"
        reject_links(lock); lock.parent.mkdir(parents=True, exist_ok=True)
        with open(lock, "a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return self.borrowing_owned(request)

    def borrowing_owned(self, request):
        saved = self.bindings / (request["environmentId"] + ".json")
        if request["action"] == "make-writable" and saved.exists():
            raise RuntimeError("Borrowed historical environments are immutable; prepare an independent managed generation")
        if saved.exists():
            original = governance_row(saved)
            if request["action"] == "install":
                raise RuntimeError("Borrowed environment cannot be modified in place; retain its lease and request an independent environment")
            candidate = self.find_candidate(original["candidateId"])
            request = {**request, "requirements": sorted(set(original["requirements"] + request["requirements"]))}
        elif request.get("reuseCandidateId"):
            candidate = self.find_candidate(request["reuseCandidateId"])
        elif request["action"] in ("create", "install") and request["environmentId"] == "training":
            catalog = self.catalog()
            scan_deadline = time.monotonic() + self.policy["verificationTimeoutMs"] / 1000
            while catalog.get("cursor") and time.monotonic() < scan_deadline:
                catalog = self.catalog(cursor=catalog["cursor"])
            if not catalog["complete"]:
                raise RuntimeError("Historical inventory is incomplete; continue its bounded scan before installing another environment: " + "; ".join(catalog["diagnostics"][:8]))
            candidates = catalog["historicalEnvironments"]
            if not candidates:
                return None
            errors = []
            for row in candidates:
                try:
                    value = self.verify_borrowed(self.find_candidate(row["id"]), request)
                    break
                except (RuntimeError, OSError, subprocess.SubprocessError, ValueError) as error:
                    errors.append(row["id"] + ": " + str(error))
            else:
                save(self.run / "environment-borrowing-diagnostics-v1" / (request["operationId"] + ".json"),
                    {"version": 1, "checkedAt": now(), "diagnostics": errors})
                if request["action"] == "create":
                    raise RuntimeError("Historical environment reuse did not verify. Inspect differences before an explicit independent install: " + "; ".join(errors))
                return None
            candidate = None
        else:
            return None
        if candidate is not None:
            value = self.verify_borrowed(candidate, request)
        # Persist the lease before publishing a usable binding; interrupted publication holds the source.
        save(pathlib.Path(value["lease"]), value)
        save(saved, value)
        return value

    def validate_borrowings(self):
        values = []
        for path in self.bindings.glob("*.json"):
            value = governance_row(path)
            if value["serverId"] != self.server or value["experimentId"] != self.experiment or value["deploymentId"] != self.config["deploymentId"]:
                raise RuntimeError("Borrowed environment belongs to another allocation")
            if governance_row(pathlib.Path(value["lease"])) != value:
                raise RuntimeError("Borrowed environment lease differs from its publication")
            if {key: self.mount(value["directory"])[key] for key in ("directory", "filesystem", "source")} != value["volume"]:
                raise RuntimeError("Borrowed environment storage volume changed")
            observed = governance_identity(pathlib.Path(value["interpreter"]["path"]))
            if observed[2:] != [value["interpreter"]["size"], value["interpreter"]["mtimeNs"], value["interpreter"]["ctimeNs"]]:
                raise RuntimeError("Borrowed interpreter changed")
            for row in value["links"]:
                if str((pathlib.Path(value["directory"]) / relative(row["path"])).resolve(strict=True)) != row["target"]:
                    raise RuntimeError("Borrowed environment link changed: " + row["path"])
            for row in value["files"]:
                item = pathlib.Path(value["directory"]) / relative(row["path"])
                reject_links(item)
                identity = governance_identity(item)
                if identity[2:] != [row["size"], row["mtimeNs"], row["ctimeNs"]]:
                    raise RuntimeError("Borrowed environment changed; program reverification required: " + row["path"])
            values.append(value)
        return values

    def asset_root(self):
        roots, errors = self.roots()
        choices = [pathlib.Path(row["directory"]) for row in roots if row["confirmed"]
            and self.mount(row["directory"])["directory"] != "/"]
        if not choices:
            raise RuntimeError("No confirmed data-volume storage root; inspect storage and select writable persistent data storage")
        selected = self.namespace if self.namespace in choices else sorted(choices)[0]
        if self.mount(selected)["readonly"]:
            raise RuntimeError("Selected material data volume is read-only for the login account")
        return selected / "assets-v1"

    def import_installation_cache(self, facts):
        """Import verified same-volume store objects without expanding package payloads."""
        roots, diagnostics = self.roots()
        imported, count = [], 0
        for root in roots:
            store = pathlib.Path(root["directory"]) / "packages-v1"
            if not root["confirmed"] or store == self.owner.store or not (store / "owner.v1.json").exists():
                continue
            if governance_row(store / "owner.v1.json") != {"version": 1, "serverId": self.server}:
                diagnostics.append(str(store) + ": server ownership differs")
                continue
            source_volume, target_volume = self.mount(store), self.mount(self.owner.store)
            if any(source_volume[key] != target_volume[key] for key in ("directory", "source", "filesystem")):
                diagnostics.append(str(store) + ": cross-volume wheel import retained at source; use whole-environment read-only borrowing or an explicit installation budget")
                continue
            try:
                with open(store / "lock", "r") as handle:
                    fcntl.flock(handle, fcntl.LOCK_SH | fcntl.LOCK_NB)
                    for path in sorted((store / "materials").glob("*/record.v1.json")):
                        count += 1
                        if count > self.policy["materialFileLimit"]:
                            raise RuntimeError("Historical installation cache scan is incomplete at its configured limit")
                        record = governance_row(path)
                        if record.get("serverId") != self.server or record.get("hash") != path.parent.name:
                            raise RuntimeError("Historical installation material ownership differs")
                        wheel = path.parent / relative(record["filename"])
                        if self.owner.wheel(wheel)["hash"] != record["hash"]:
                            diagnostics.append(str(wheel) + ": material digest differs")
                            continue
                        probe_root = self.owner.store / (".import-link-" + uuid.uuid4().hex)
                        probe_root.mkdir(mode=0o700)
                        probe = probe_root / relative(record["filename"])
                        try:
                            os.link(wheel, probe)
                            self.owner.retain_material(probe, record["source"], immutable=True)
                        except OSError as error:
                            diagnostics.append(str(wheel) + ": hard-link import unavailable: " + str(error))
                            continue
                        finally:
                            probe.unlink(missing_ok=True)
                            probe_root.rmdir()
                    for path in sorted((store / "objects").glob("*/record.v1.json")):
                        record = governance_row(path)
                        if record.get("version") != 1 or record.get("id") != path.parent.name or not re.fullmatch(r"[a-f0-9]{64}", record["id"]) or record.get("pythonAbi") != facts["abi"]:
                            continue
                        target = self.owner.objects / record["id"]
                        if target.exists():
                            continue
                        material = next((row for row in self.owner.material_records() if row["hash"] == record["wheelHash"] and row["source"] == record["source"]), None)
                        if material is None:
                            continue
                        try:
                            self.verify_package_record(record, path.parent)
                        except (RuntimeError, OSError, ValueError, zipfile.BadZipFile) as error:
                            diagnostics.append(str(path.parent) + ": payload cannot be reused; verified wheel retained: " + str(error))
                            continue
                        incoming = self.owner.store / (".cache-import-" + uuid.uuid4().hex)
                        incoming.mkdir(mode=0o700)
                        try:
                            for name, checksum in record["hashes"].items():
                                source = path.parent / "payload" / relative(name)
                                reject_links(source)
                                if file_hash(source) != checksum:
                                    raise RuntimeError("Historical shared package digest differs: " + name)
                                destination = incoming / "payload" / relative(name)
                                destination.parent.mkdir(parents=True, exist_ok=True)
                                os.link(source, destination)
                            os.link(self.owner.materials / material["hash"] / material["filename"], incoming / relative(record["wheel"]))
                            save(incoming / "record.v1.json", record)
                            self.owner.objects.mkdir(parents=True, exist_ok=True)
                            os.rename(incoming, target)
                            imported.append(record["id"])
                        except OSError as error:
                            diagnostics.append(str(path.parent) + ": package links unavailable; verified wheel retained: " + str(error))
                        finally:
                            if incoming.exists():
                                remove_private(incoming, self.owner.store)
            except OSError as error:
                diagnostics.append(str(store) + ": active or unavailable store: " + str(error))
        operation = getattr(self.owner, "current_operation", None)
        if operation:
            save(operation / "cache-import.v1.json", {"version": 1, "experimentId": self.experiment, "serverId": self.server,
                "operationId": operation.name, "checkedAt": now(), "packages": imported, "diagnostics": diagnostics})
        return imported

    def verify_package_record(self, record, directory):
        wheel = directory / relative(record["wheel"])
        info = self.owner.wheel(wheel)
        if info["hash"] != record["wheelHash"] or info["name"] != record["name"] or info["version"] != record["versionString"] or info["tags"] != record["tags"]:
            raise RuntimeError("Historical package identity differs from its verified wheel")
        expected = {}
        with zipfile.ZipFile(wheel) as archive:
            for item in archive.infolist():
                name = item.filename
                if name.endswith("/") or name.startswith(info["distInfo"] + "/"):
                    continue
                if ".data/" in name:
                    section = name.split(".data/", 1)[1]
                    if not section.startswith(("purelib/", "platlib/")):
                        continue
                    name = section.split("/", 1)[1]
                checksum = hashlib.sha256()
                with archive.open(item.filename) as stream:
                    for chunk in iter(lambda: stream.read(self.policy["transferChunkBytes"]), b""):
                        checksum.update(chunk)
                expected[relative(name)] = checksum.hexdigest()
        content = digest(sorted(expected.items()))
        if expected != record["hashes"] or set(expected) != set(record["files"]) or record["contentHash"] != content or record["id"] != digest([info["hash"], record["source"], record["pythonAbi"], info["tags"], content]):
            raise RuntimeError("Historical payload metadata differs from canonical wheel content")

    def material(self, identifier):
        path = self.root / "materials" / (identifier + ".json")
        row = governance_row(path)
        if row["id"] != identifier or row["serverId"] != self.server:
            raise RuntimeError("Material identity differs from its server catalog")
        source = row.get("historicalSource")
        roots, _ = self.roots()
        if source:
            run = pathlib.Path(source["runRoot"])
            marker = governance_row(run / ".aspera-owner.json")
            if marker != {"version": 1, "serverId": self.server, "experimentId": source["sourceExperimentId"]} or source["directory"] != row["directory"]:
                raise RuntimeError("Historical material source ownership differs")
            if not pathlib.Path(row["directory"]).is_relative_to(run / "workspace") or not any(root["confirmed"] and run.parent.parent == pathlib.Path(root["directory"]) for root in roots):
                raise RuntimeError("Historical material escaped the registered source workspace")
        elif not any(root["confirmed"] and pathlib.Path(row["directory"]) == pathlib.Path(root["directory"]) / "assets-v1" / ("datasets" if row["kind"] == "dataset" else "models") / identifier for root in roots):
            raise RuntimeError("Material path differs from its confirmed data volume")
        return row

    def historical_material(self, files):
        progress = self.root / "scan.v1.json"
        if not progress.exists():
            self.catalog()
        scanned = governance_row(progress)
        if scanned.get("todo") or not scanned.get("materialFilesComplete", True):
            raise RuntimeError("Historical material discovery is incomplete; continue the account-side scan before downloading another copy")
        first = files[0]
        for item in scanned.get("materialFiles", []):
            path = pathlib.Path(item["path"])
            suffix = pathlib.PurePosixPath(first["path"])
            if item["sourceExperimentId"] == self.experiment or item["bytes"] != first["bytes"] or tuple(path.parts[-len(suffix.parts):]) != suffix.parts:
                continue
            directory = path
            for _ in suffix.parts:
                directory = directory.parent
            run = pathlib.Path(item["runRoot"])
            try:
                before = self.source_released(item["sourceExperimentId"], run)
                observed = []
                for row in files:
                    target = directory / relative(row["path"])
                    reject_links(target)
                    if not target.is_file() or not self.file_valid(target, row):
                        break
                    identity = governance_identity(target)
                    observed.append({**row, "mtimeNs": identity[3], "ctimeNs": identity[4]})
                if len(observed) == len(files) and self.source_released(item["sourceExperimentId"], run) == before:
                    return {"source": {"sourceExperimentId": item["sourceExperimentId"], "runRoot": str(run), "directory": str(directory)}, "files": observed}
            except (OSError, RuntimeError, ValueError):
                # Unconfirmed or mutable sources cannot replace the canonical material request.
                continue
        return None

    def url(self, value):
        parsed = urllib.parse.urlparse(value)
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.hostname not in self.policy["materialHosts"]:
            raise RuntimeError("Material source is outside configured HTTPS providers: " + str(parsed.hostname))
        return value

    def metadata(self, url):
        with urllib.request.urlopen(self.url(url), timeout=self.policy["networkReadTimeoutMs"] / 1000) as response:
            value = response.read(self.policy["metadataBytes"] + 1)
            if len(value) > self.policy["metadataBytes"]:
                raise RuntimeError("Provider metadata exceeds configured size limit")
            return json.loads(value)

    def inspect_material(self, request, canonical=None):
        revision = request["revision"]
        if not re.fullmatch(r"[a-f0-9]{40}", revision):
            raise RuntimeError("An immutable 40-character provider revision is required")
        repository = request["repository"]
        if not re.fullmatch(r"[\w.-]+/[\w.-]+", repository):
            raise RuntimeError("Material repository identity is invalid")
        kind = request["kind"]
        if request["provider"] != "huggingface":
            raise RuntimeError("ModelScope immutable commit attestation is unavailable; import the canonical Hugging Face manifest and use ModelScope only as a digest-checked transport")
        prefix = "datasets/" if kind == "dataset" else ""
        metadata_path = self.run / "material-metadata-v1" / (digest(request) + ".json")
        if canonical is None and metadata_path.exists():
            saved = governance_row(metadata_path)
            if saved.get("materialId"):
                canonical = governance_row(self.root / "canonical-manifests" / (saved["materialId"] + ".json"))["document"]
            else:
                return {"state": "metadata-pending", "requestId": digest(request), "detail": saved["detail"]}
        try:
            document = canonical if canonical is not None else self.metadata("https://huggingface.co/api/" + ("datasets/" if kind == "dataset" else "models/")
                + repository + "/revision/" + revision + "?blobs=true")
        except (OSError, urllib.error.URLError, TimeoutError) as error:
            save(metadata_path, {"version": 1, "experimentId": self.experiment, "serverId": self.server, "request": request,
                "state": "pending", "checkedAt": now(), "detail": "Canonical metadata is unreachable on the node; the local Host may obtain the same fixed revision: " + str(error)})
            return {"state": "metadata-pending", "requestId": digest(request), "detail": "Waiting for canonical fixed-revision metadata; no model payload was downloaded"}
        if document.get("sha") != revision or document.get("id", document.get("modelId")) != repository:
            raise RuntimeError("Canonical provider did not attest the requested repository and fixed revision")
        wanted = request.get("files")
        files = []
        for entry in document.get("siblings", []):
            name = relative(entry["rfilename"])
            if wanted is not None and name not in wanted:
                continue
            lfs = entry.get("lfs")
            checksum = (lfs.get("sha256") or lfs.get("oid", "").removeprefix("sha256:")) if lfs else entry.get("blobId", "")
            size = lfs.get("size") if lfs else entry.get("size")
            algorithm = "sha256" if lfs else "git-sha1"
            if not isinstance(size, int) or isinstance(size, bool) or size < 0 or not re.fullmatch("[a-f0-9]{" + ("64" if lfs else "40") + "}", checksum):
                raise RuntimeError("Canonical file lacks a complete size and digest: " + name)
            base = request.get("mirror") or "https://huggingface.co"
            self.url(base)
            host = urllib.parse.urlparse(base).hostname
            url = base.rstrip("/") + "/" + prefix + repository + "/resolve/" + revision + "/" + urllib.parse.quote(name, safe="/")
            if host == "modelscope.cn":
                url = base.rstrip("/") + "/api/v1/models/" + repository + "/repo?Revision=master&FilePath=" + urllib.parse.quote(name, safe="")
            files.append({"path": name, "bytes": size, "hash": checksum, "algorithm": algorithm, "url": url})
        if not files or wanted is not None and set(wanted) != {row["path"] for row in files}:
            raise RuntimeError("Fixed revision file selection is incomplete or empty")
        if len(files) > self.policy["materialFileLimit"]:
            raise RuntimeError("Material manifest exceeds configured file count")
        files.sort(key=lambda row: row["path"])
        identifier = digest({"kind": kind, "repository": repository, "revision": revision,
            "files": [{key: value for key, value in row.items() if key != "url"} for row in files]})
        directory = self.asset_root() / ("datasets" if kind == "dataset" else "models") / identifier
        original_path = self.root / "materials" / (identifier + ".json")
        original = self.material(identifier) if original_path.exists() else None
        if original is not None:
            directory = pathlib.Path(original["directory"])
        ready = original and original["state"] == "ready"
        verified, retained = 0, 0
        for row in files:
            path = directory / relative(row["path"])
            retained_file = directory.parent / (".partial-" + identifier) / relative(row["path"])
            partial = directory.parent / (".partial-" + identifier) / (row["path"] + ".part")
            if not path.exists() and retained_file.is_file():
                path = retained_file
            complete_partial = partial.exists() and partial.stat().st_size == row["bytes"]
            if not path.exists() and complete_partial:
                path = partial
            proof = next((entry for entry in (original or {}).get("files", []) if entry["path"] == row["path"] and entry["hash"] == row["hash"]), None)
            if path.is_file() and (self.file_unchanged(path, proof) or self.file_valid(path, row)):
                verified += row["bytes"]
                identity = governance_identity(path); row.update(mtimeNs=identity[3], ctimeNs=identity[4])
            elif self.file_object(row) is not None:
                verified += row["bytes"]
            elif ready:
                ready = False
            elif partial.exists() and partial.stat().st_size < row["bytes"]:
                reject_links(partial); retained += partial.stat().st_size
        total = sum(row["bytes"] for row in files)
        result = {"version": 1, "id": identifier, "serverId": self.server, "kind": kind, "provider": "huggingface",
            "repository": repository, "revision": revision, "files": files, "directory": str(directory),
            "totalBytes": total, "missingBytes": total - verified - retained, "verifiedBytes": verified, "retainedPartialBytes": retained,
            "checkedAt": now(), "state": "ready" if ready else "inspected"}
        result["volume"] = {key: self.mount(directory)[key] for key in ("directory", "filesystem", "source")}
        if original and original.get("historicalSource"):
            result["historicalSource"] = original["historicalSource"]
        elif verified != total:
            historical = self.historical_material(files)
            if historical:
                result.update(directory=historical["source"]["directory"], historicalSource=historical["source"], files=historical["files"],
                    missingBytes=0, verifiedBytes=total, detail="Verified historical files require a read-only source lease before execution")
                result["volume"] = {key: self.mount(historical["source"]["directory"])[key] for key in ("directory", "filesystem", "source")}
        save(self.root / "canonical-manifests" / (identifier + ".json"), {"version": 1, "request": request, "document": document})
        save(original_path, result)
        save(metadata_path, {"version": 1, "experimentId": self.experiment, "serverId": self.server, "request": request,
            "state": "resolved", "materialId": identifier, "checkedAt": now()})
        return result

    def pending_metadata(self):
        result = []
        for path in (self.run / "material-metadata-v1").glob("*.json"):
            row = governance_row(path)
            if row["experimentId"] != self.experiment or row["serverId"] != self.server:
                raise RuntimeError("Material metadata request belongs to another experiment")
            if row["state"] == "pending":
                result.append({"requestId": path.stem, "request": row["request"]})
        return result

    def metadata_error(self, identifier, detail):
        if not re.fullmatch(r"[a-f0-9]{64}", identifier):
            raise RuntimeError("Canonical request identity is invalid")
        path = self.run / "material-metadata-v1" / (identifier + ".json")
        value = governance_row(path)
        if value["experimentId"] != self.experiment or value["serverId"] != self.server or digest(value["request"]) != identifier:
            raise RuntimeError("Canonical metadata request belongs to another experiment")
        if value["state"] == "pending":
            value.update(detail=detail, checkedAt=now())
            save(path, value)
        return {"recorded": True}

    def file_valid(self, path, row):
        reject_links(path)
        if not path.is_file() or path.stat().st_size != row["bytes"]:
            return False
        value = hashlib.new("sha256" if row["algorithm"] == "sha256" else "sha1")
        if row["algorithm"] == "git-sha1":
            value.update(("blob " + str(row["bytes"]) + "\0").encode())
        before = governance_identity(path)
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(self.policy["transferChunkBytes"]), b""):
                value.update(chunk)
        return value.hexdigest() == row["hash"] and governance_identity(path) == before

    def file_object(self, row):
        path = self.root / "file-objects" / (digest([row["algorithm"], row["hash"], row["bytes"]]) + ".json")
        if not path.exists():
            return None
        value = governance_row(path)
        if value["version"] != 1 or value["serverId"] != self.server or any(value[key] != row[key] for key in ("algorithm", "hash", "bytes")):
            raise RuntimeError("Shared file object identity differs")
        origin = self.material(value["materialId"])
        if origin.get("historicalSource"):
            return None
        expected = pathlib.Path(origin["directory"]) / relative(value["relativePath"])
        retained = pathlib.Path(origin["directory"]).parent / (".partial-" + origin["id"]) / relative(value["relativePath"])
        candidate = pathlib.Path(value["path"])
        if candidate not in (expected, retained) or not any(item["hash"] == row["hash"] and item["algorithm"] == row["algorithm"] and item["bytes"] == row["bytes"] and item["path"] == value["relativePath"] for item in origin["files"]):
            raise RuntimeError("Shared file object escaped its canonical material")
        if not candidate.exists():
            return None
        return candidate if self.file_unchanged(candidate, value) else None

    def retain_file_object(self, material, row, path):
        if material.get("historicalSource"):
            return
        identity = governance_identity(path)
        value = {"version": 1, "serverId": self.server, "materialId": material["id"], "path": str(path), "relativePath": row["path"],
            "algorithm": row["algorithm"], "hash": row["hash"], "bytes": row["bytes"], "mtimeNs": identity[3], "ctimeNs": identity[4]}
        save(self.root / "file-objects" / (digest([row["algorithm"], row["hash"], row["bytes"]]) + ".json"), value)

    @staticmethod
    def file_unchanged(path, row):
        if not row or "mtimeNs" not in row or "ctimeNs" not in row:
            return False
        reject_links(path)
        identity = governance_identity(path)
        return identity[2:] == [row["bytes"], row["mtimeNs"], row["ctimeNs"]]

    def content_reservations(self, identifiers):
        result = {}
        for identifier in identifiers:
            material = self.material(identifier)
            directory = pathlib.Path(material["directory"])
            for row in material["files"]:
                key = digest([row["algorithm"], row["hash"], row["bytes"]])
                needed = row["bytes"]
                for path in (directory / relative(row["path"]), directory.parent / (".partial-" + identifier) / relative(row["path"])):
                    if path.exists() and self.file_unchanged(path, row):
                        needed = 0
                if self.file_object(row) is not None:
                    needed = 0
                partial = directory.parent / (".partial-" + identifier) / (row["path"] + ".part")
                if needed and partial.exists():
                    reject_links(partial)
                    needed -= min(needed, partial.stat().st_size)
                previous = result.get(key)
                value = {"id": key, "remainingBytes": needed, "directory": material["volume"]["directory"]}
                if previous is None or needed > previous["remainingBytes"]:
                    result[key] = value
        return list(result.values())

    def content_ids(self, identifiers):
        result = set()
        for identifier in identifiers:
            if identifier not in self._content_keys:
                self._content_keys[identifier] = {digest([row["algorithm"], row["hash"], row["bytes"]]) for row in self.material(identifier)["files"]}
            result.update(self._content_keys[identifier])
        return result

    def assess(self, request):
        signature = digest(request)
        previous = self.run / "storage-plans-v1" / (request["operationId"] + ".json")
        if previous.exists() and governance_row(previous)["requestHash"] != signature:
            raise RuntimeError("Storage assessment operation is bound to different requirements")
        budgets = {}
        def volume(path):
            mount = self.mount(path)
            key = capacity_identity(self, path)["device"]
            if key not in budgets:
                usage = shutil.disk_usage(existing_directory(path))
                held = self.peer_held(mount["directory"], request["materialIds"])
                budgets[key] = {**capacity_identity(self, path), "capacityBytes": usage.total, "availableBytes": usage.free, "reservedBytes": held, "requiredBytes": 0,
                    "missingBytes": 0, "environmentBytes": 0, "outputBytes": 0, "checkpointBytes": 0,
                    "safetyBytes": reserve_bytes(self, path)}
            if mount["readonly"]:
                raise RuntimeError("Budget target is read-only for the server account: " + str(path))
            return budgets[key]
        current = volume(pathlib.Path(self.owner.placement.get("workspaceRoot", str(self.owner.workspace))))
        observed = self.output_footprint()
        baseline_path = self.run / "storage-output-baseline.v1.json"
        if not baseline_path.exists():
            save(baseline_path, {"version": 1, "experimentId": self.experiment, "serverId": self.server, **observed})
        baseline = governance_row(baseline_path)
        if baseline["experimentId"] != self.experiment or baseline["serverId"] != self.server:
            raise RuntimeError("Output capacity baseline belongs to another experiment")
        current["outputBytes"] = max(0, request["outputBytes"] - max(0, observed["result"] - baseline["result"]))
        current["checkpointBytes"] = max(0, request["checkpointBytes"] - max(0, observed["checkpoint"] - baseline["checkpoint"]))
        env = self.owner.environment(request["environmentId"])
        borrowed = self.bindings / (request["environmentId"] + ".json")
        satisfied = env and env["state"] == "ready" and set(request["requirements"]).issubset(env["requirements"])
        if borrowed.exists():
            value = governance_row(borrowed)
            self.validate_borrowings()
            satisfied = set(request["requirements"]).issubset(value["requirements"])
        estimate = 0 if satisfied or not request["requirements"] else None
        if estimate is None and request.get("allowEnvironmentFallback") and not self.config.get("action", "").startswith("history-"):
            loan = self.borrowing({**request, "action": "create", "modules": [], "requireCuda": False})
            if loan is not None:
                estimate = 0
        if estimate is None:
            for path in self.owner.operations.glob("*/reuse-plan.v1.json"):
                row = governance_row(path)
                if row.get("requirementsHash") == digest(request["requirements"]) and row.get("estimatedPeakBytes", 0) > 0:
                    estimate = row["estimatedPeakBytes"]
        if estimate is None and request.get("environmentEstimate"):
            estimate = request["environmentEstimate"]["peakBytes"]
        environment_volume = volume(self.owner.workspace)
        environment_volume["environmentBytes"] = estimate
        for identifier in request["materialIds"]:
            material = self.material(identifier)
            if material["missingBytes"] == 0:
                continue
            target = pathlib.Path(material["directory"])
            while not target.exists():
                target = target.parent
            volume(target)
        for item in self.content_reservations(request["materialIds"]):
            if item["remainingBytes"]:
                volume(item["directory"])["missingBytes"] += item["remainingBytes"]
        factor = self.policy.get("peakSafetyFactor", 1)
        def finalize(row):
            row["newPeakBytes"] = None if row["environmentBytes"] is None else math.ceil(sum(row[key] for key in ("environmentBytes", "missingBytes", "outputBytes", "checkpointBytes")) * factor)
            row["requiredBytes"] = None if row["newPeakBytes"] is None else row["newPeakBytes"] + row["safetyBytes"]
            row["shortfallBytes"] = None if row["requiredBytes"] is None else max(0, row["requiredBytes"] + row["reservedBytes"] - row["availableBytes"])
        for row in budgets.values():
            finalize(row)
        fallback_assessment = None
        if request.get("allowEnvironmentFallback") and estimate and environment_volume["shortfallBytes"] \
                and not self.config.get("action", "").startswith("history-") \
                and not is_system_storage(self, self.owner.workspace) \
                and not (self.run / "storage-arrangement.v1.json").exists():
            system = volume(self.control)
            previous_estimate = system["environmentBytes"]
            environment_volume["environmentBytes"] = 0
            system["environmentBytes"] = estimate
            for row in budgets.values():
                finalize(row)
            fallback_assessment = {"systemShortfallBytes": system["shortfallBytes"], "remainingDataShortfallBytes": environment_volume["shortfallBytes"], "applied": False}
            if all(row["shortfallBytes"] == 0 for row in budgets.values()):
                reason = "Verified reuse and declared estimates do not fit data storage; the system filesystem fits the remaining training environment peak and reserve"
                install_environment_arrangement(self, math.ceil(estimate * factor), reason)
                fallback_assessment["applied"] = True
            else:
                environment_volume["environmentBytes"] = estimate
                system["environmentBytes"] = previous_estimate
                for row in budgets.values():
                    finalize(row)
        pending = False
        sufficient = True
        for row in budgets.values():
            pending |= row["requiredBytes"] is None
            sufficient &= row["requiredBytes"] is not None and row["availableBytes"] >= row["requiredBytes"] + row["reservedBytes"]
        state = "requirements-pending" if pending else "ready" if sufficient else "insufficient"
        result = {"version": 1, "formatVersion": "0.1.0", "peakSafetyFactor": factor, "experimentId": self.experiment, "serverId": self.server, "operationId": request["operationId"],
            "requestHash": signature, "checkedAt": now(), "state": state, "environmentId": request["environmentId"],
            "declaredOutputBytes": request["outputBytes"], "declaredCheckpointBytes": request["checkpointBytes"],
            "requirements": request["requirements"], "materialIds": request["materialIds"], "volumes": list(budgets.values()),
            "detail": "Capacity verified per mounted volume" if state == "ready" else "Resolve or reuse the environment before final capacity acceptance" if pending
                else "Insufficient capacity on a target volume; inspect owned historical cleanup candidates before installing or downloading"}
        for key in ("environmentEstimate", "allowEnvironmentFallback"):
            if key in request:
                result[key] = request[key]
        if fallback_assessment is not None:
            result["fallbackAssessment"] = fallback_assessment
        save(previous, result)
        save(self.run / "storage-plan.v1.json", result)
        if state == "ready":
            self.save_reservation("plan", result)
        return result

    def output_footprint(self):
        result, seen, count = {"result": 0, "checkpoint": 0}, set(), 0
        deadline = time.monotonic() + self.policy["scanTimeoutMs"] / 1000
        workspace = pathlib.Path(self.owner.placement.get("workspaceRoot", str(self.owner.workspace)))
        if not workspace.exists():
            return result
        for base, dirs, names in os.walk(workspace, followlinks=False):
            dirs[:] = [name for name in dirs if name not in ("env", "venv", ".venv", "pyenv", "site-packages", "node_modules", "tmp", "cache", ".cache", "models", "datasets", "data") and not (pathlib.Path(base) / name).is_symlink()]
            for name in names:
                count += 1
                if count > self.policy["scanEntryLimit"] or time.monotonic() > deadline:
                    raise RuntimeError("Output capacity measurement is incomplete; continue account-side storage investigation before reserving more space")
                path = pathlib.Path(base) / name
                if path.is_symlink():
                    continue
                category = self.category(path, workspace)
                if category not in result:
                    continue
                value = path.stat(); identity = (value.st_dev, value.st_ino)
                if identity not in seen:
                    result[category] += getattr(value, "st_blocks", (value.st_size + 511) // 512) * 512
                    seen.add(identity)
        return result

    def save_reservation(self, operation, plan, material_id=None):
        values = []
        materials = self.content_reservations(plan["materialIds"])
        for row in plan["volumes"]:
            pending = [{"id": item["id"], "remainingBytes": item["remainingBytes"]} for item in materials if capacity_identity(self, item["directory"])["device"] == row.get("device", capacity_identity(self, row["directory"])["device"])]
            raw = row["outputBytes"] + row["checkpointBytes"] + (row["environmentBytes"] or 0) + sum(item["remainingBytes"] for item in pending)
            base = math.ceil(raw * self.policy.get("peakSafetyFactor", 1)) - sum(item["remainingBytes"] for item in pending)
            values.append({"directory": row["directory"], "experimentId": self.experiment,
                "remainingBytes": base + sum(item["remainingBytes"] for item in pending), "baseBytes": base, "materials": pending})
        save(self.root / "reservations" / (self.experiment + "-" + operation + ".json"),
            {"version": 1, "serverId": self.server, "experimentId": self.experiment, "operationId": operation, "materialId": material_id, "volumes": values})

    def reservations(self):
        result = []
        for path in (self.root / "reservations").glob("*.json"):
            value = governance_row(path)
            if value["serverId"] != self.server:
                raise RuntimeError("Capacity reservation belongs to another server")
            result.extend(value["volumes"])
        return result

    def peer_held(self, directory, requested=()):
        bases, materials = {}, {}
        requested = self.content_ids(requested)
        for row in self.reservations():
            if capacity_identity(self, row["directory"])["device"] != capacity_identity(self, directory)["device"]:
                continue
            if row["experimentId"] != self.experiment:
                bases[row["experimentId"]] = max(bases.get(row["experimentId"], 0), row.get("baseBytes", row["remainingBytes"]))
            for item in row.get("materials", []):
                if item["id"] not in requested:
                    materials[item["id"]] = max(materials.get(item["id"], 0), item["remainingBytes"])
        return sum(bases.values()) + sum(materials.values())

    def reserve_environment(self, needed):
        mount = self.mount(self.owner.workspace)
        held = self.peer_held(mount["directory"])
        extras = 0
        plan_path = self.run / "storage-plan.v1.json"
        if plan_path.exists():
            plan = governance_row(plan_path)
            for row in plan["volumes"]:
                if row.get("device", capacity_identity(self, row["directory"])["device"]) == capacity_identity(self, self.owner.workspace)["device"]:
                    extras += row["outputBytes"] + row["checkpointBytes"]
            extras += sum(self.material(identifier)["missingBytes"] for identifier in plan["materialIds"]
                if capacity_identity(self, self.material(identifier)["volume"]["directory"])["device"] == capacity_identity(self, self.owner.workspace)["device"])
        safety = reserve_bytes(self, self.owner.workspace)
        needed = math.ceil(needed * self.policy.get("peakSafetyFactor", 1))
        free = shutil.disk_usage(self.owner.workspace).free
        if free < held + needed + extras + safety:
            raise RuntimeError(f"Installation peak and declared model/output budget need {needed + extras} bytes; {free} free, {held} held by other operations, {safety} safety")
        operation = getattr(self.owner, "current_operation", None)
        if operation is not None:
            path = self.root / "reservations" / (self.experiment + "-environment-" + operation.name + ".json")
            old = governance_row(path)["volumes"][0]["remainingBytes"] if path.exists() else 0
            save(path, {"version": 1, "serverId": self.server, "experimentId": self.experiment,
                "volumes": [{"directory": mount["directory"], "experimentId": self.experiment, "remainingBytes": max(old, needed + extras)}]})

    def reserve_command(self, command):
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", command):
            raise RuntimeError("Command capacity identity is invalid")
        path = self.run / "storage-plan.v1.json"
        if not path.exists():
            return {"reserved": False, "detail": "No training storage assessment has been submitted"}
        saved = governance_row(path)
        request = {key: saved[key] for key in ("operationId", "materialIds", "environmentId", "requirements")}
        request.update({key: saved[key] for key in ("environmentEstimate", "allowEnvironmentFallback") if key in saved})
        request.update(outputBytes=saved.get("declaredOutputBytes", sum(row["outputBytes"] for row in saved["volumes"])), checkpointBytes=saved.get("declaredCheckpointBytes", sum(row["checkpointBytes"] for row in saved["volumes"])))
        plan = self.assess(request)
        if plan["state"] != "ready":
            raise RuntimeError("Training command capacity is not verified: " + plan["detail"])
        for identifier in plan["materialIds"]:
            if not (self.material_bindings / (identifier + ".json")).exists() or self.material(identifier)["state"] != "ready":
                raise RuntimeError("Declared model/data material is not published for this experiment: " + identifier)
        save(self.root / "reservations" / (self.experiment + "-command-" + command + ".json"),
            {"version": 1, "serverId": self.server, "experimentId": self.experiment,
                "volumes": [{"directory": row["directory"], "experimentId": self.experiment, "remainingBytes": row["requiredBytes"] - row["safetyBytes"]} for row in plan["volumes"]]})
        return {"reserved": True}

    def settle_capacity(self, command, launch_failure=False):
        self.owner.assert_exited(command, launch_failure)
        candidates = [self.root / "reservations" / (self.experiment + "-command-" + command + ".json")]
        if command.startswith("environment-"):
            candidates.append(self.root / "reservations" / (self.experiment + "-environment-" + command[len("environment-"):] + ".json"))
        for path in candidates:
            path.unlink(missing_ok=True)
        return {"released": True}

    def reserve(self, operation, material, budget_id):
        plan = governance_row(self.run / "storage-plans-v1" / (budget_id + ".json"))
        if plan["experimentId"] != self.experiment or plan["serverId"] != self.server or material["id"] not in plan["materialIds"]:
            raise RuntimeError("Material acquisition is not bound to this experiment's capacity plan")
        request = {"operationId": plan["operationId"], "materialIds": plan["materialIds"], "environmentId": plan["environmentId"],
            "requirements": plan["requirements"], "outputBytes": plan.get("declaredOutputBytes", sum(row["outputBytes"] for row in plan["volumes"])),
            "checkpointBytes": plan.get("declaredCheckpointBytes", sum(row["checkpointBytes"] for row in plan["volumes"]))}
        request.update({key: plan[key] for key in ("environmentEstimate", "allowEnvironmentFallback") if key in plan})
        checked = self.assess(request)
        if checked["state"] != "ready":
            raise RuntimeError("Capacity plan is not ready: " + checked["detail"])
        self.save_reservation(operation, checked, material["id"])

    def download_capacity(self, operation, material, consumed, needed, file=None):
        with self.locked():
            mount = self.mount(material["directory"])
            safety = reserve_bytes(self, material["directory"])
            held = self.peer_held(mount["directory"], [material["id"]])
            target = pathlib.Path(material["directory"]).parent
            if shutil.disk_usage(target).free < needed + held + safety:
                raise RuntimeError("Download would consume space retained for other operations or the safety margin")
            keys = self.content_ids([material["id"]])
            key = digest([file["algorithm"], file["hash"], file["bytes"]]) if file else None
            for path in (self.root / "reservations").glob("*.json"):
                saved = governance_row(path)
                for volume in saved["volumes"]:
                    for item in volume.get("materials", []):
                        if key == item["id"]:
                            item["remainingBytes"] = max(0, file["bytes"] - consumed)
                        elif key is None and material["state"] == "ready" and item["id"] in keys:
                            item["remainingBytes"] = 0
                    volume["remainingBytes"] = volume.get("baseBytes", 0) + sum(item["remainingBytes"] for item in volume.get("materials", []))
                save(path, saved)

    def material_operation(self, operation):
        path = self.run / "material-operations-v1" / operation / "receipt.v1.json"
        value = governance_row(path)
        if value["experimentId"] != self.experiment or value["serverId"] != self.server or value["operationId"] != operation:
            raise RuntimeError("Material operation belongs to a different experiment or node")
        return value

    @staticmethod
    def process_identity():
        return {"version": 1, "pid": os.getpid(), "hostBootId": pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "startTime": pathlib.Path("/proc/self/stat").read_text().split(") ", 1)[1].split()[19]}

    def register_material(self, request):
        operation = request["operationId"]
        folder = self.run / "material-operations-v1" / operation
        original = folder / "request.v1.json"
        signature = digest({key: value for key, value in request.items() if key != "action"})
        if original.exists():
            saved_request = governance_row(original)
            if saved_request["requestHash"] != signature or request["action"] != "recover" and saved_request["request"]["action"] != request["action"]:
                raise RuntimeError("Material operation identity is bound to different content")
            value = self.material_operation(operation)
            if request["action"] == "recover" and value["state"] == "blocked":
                self.owner.assert_exited(value.get("commandId", "material-" + operation), value.get("processState") == "not-started")
                save(folder / ("receipt-" + str(value["updatedAt"]) + "-" + uuid.uuid4().hex + ".v1.json"), value)
                value.update(state="requested", commandId=self.config["materialCommandId"], exitConfirmed=False, admissionReleased=False,
                    processState="unknown", updatedAt=now())
                save(folder / "receipt.v1.json", value)
            return value
        if request["action"] == "recover":
            raise RuntimeError("Original material request is missing; recovery cannot submit a new acquisition")
        value = {"version": 1, "experimentId": self.experiment, "serverId": self.server, "operationId": operation,
            "action": request["action"],
            "materialId": request["materialId"], "requestHash": signature, "commandId": self.config.get("materialCommandId", "material-" + operation),
            "state": "requested", "stage": "checking", "startedAt": now(), "deadline": self.config.get("deadline", now() + self.policy["materialTimeoutMs"]),
            "updatedAt": now(), "downloadedBytes": 0, "reusedBytes": 0, "exitConfirmed": False, "admissionReleased": False}
        save(original, {"version": 1, "requestHash": signature, "request": request})
        save(folder / "receipt.v1.json", value)
        return value

    def prepare_material(self, request):
        operation = request["operationId"]
        folder = self.run / "material-operations-v1" / operation
        receipt = folder / "receipt.v1.json"
        original = folder / "request.v1.json"
        signature = digest({key: value for key, value in request.items() if key != "action"})
        if original.exists():
            saved = governance_row(original)
            if saved["requestHash"] != signature or request["action"] != "recover" and saved["request"]["action"] != request["action"]:
                raise RuntimeError("Material operation identity is bound to different content")
            mode = saved["request"]["action"]
            previous = self.material_operation(operation)
            if previous["state"] == "completed":
                return previous
            if previous["state"] != "requested" and request["action"] != "recover":
                raise RuntimeError("Recover the original material operation before another acquisition")
            if previous["state"] != "requested":
                self.owner.assert_exited(previous.get("commandId", "material-" + operation), self.config.get("launchFailureConfirmed", False))
                save(folder / ("receipt-" + str(previous["updatedAt"]) + "-" + uuid.uuid4().hex + ".v1.json"), previous)
            deadline = previous["deadline"]
        else:
            previous = self.register_material(request)
            deadline = previous["deadline"]
            mode = request["action"]
        material = self.material(request["materialId"])
        canonical = governance_row(self.root / "canonical-manifests" / (material["id"] + ".json"))
        material = self.inspect_material(canonical["request"], canonical["document"])
        with self.locked():
            self.reserve(operation, material, request["budgetId"])
        if material.get("historicalSource"):
            source = material["historicalSource"]
            admission = self.control / "state/controller-admission.lock"
            reject_links(admission)
            with self.locked(), open(admission, "a") as handle:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.source_released(source["sourceExperimentId"], pathlib.Path(source["runRoot"]))
                if not all(self.file_unchanged(pathlib.Path(material["directory"]) / row["path"], row) for row in material["files"]):
                    raise RuntimeError("Historical material changed after inspection; refresh the canonical verification and budget")
                save(self.root / "material-source-leases" / (material["id"] + ".json"),
                    {"version": 1, "serverId": self.server, "materialId": material["id"], **source})
                material.update(state="ready", checkedAt=now())
                self.publish_material(material)
                value = {**previous, "state": "completed", "stage": "waiting-exit", "updatedAt": now(), "exitConfirmed": True, "material": material,
                    "commandId": self.config.get("materialCommandId", "material-" + operation), "reusedBytes": material["totalBytes"]}
                save(receipt, value)
                return value
        root = pathlib.Path(material["directory"])
        partial = root.parent / (".partial-" + material["id"])
        reject_links(partial)
        partial.mkdir(parents=True, mode=0o700, exist_ok=True)
        # One process owns each content identity, independently of experiment and operation IDs.
        lock_path = self.root / "material-locks" / material["id"]
        lock_path.parent.mkdir(mode=0o700, exist_ok=True)
        save(receipt, {**previous, "state": "running", "stage": "waiting-transfer", "updatedAt": now()})
        with contextlib.ExitStack() as resources, open(lock_path, "a") as handle:
            while True:
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if now() >= deadline:
                        raise TimeoutError("Original material budget expired while waiting for its content owner")
                    time.sleep(self.owner.policy["operationPollIntervalMs"] / 1000)
            material = self.material(request["materialId"])
            resources.enter_context(self.content_locks(material["files"], deadline))
            if material["missingBytes"] > 0:
                resources.enter_context(self.transfer_slot(deadline))
            value = {**previous, "commandId": self.config.get("materialCommandId", "material-" + operation),
                "state": "running", "stage": "reusing", "processState": "running", "updatedAt": now(), "reusedBytes": 0, "exitConfirmed": False, "admissionReleased": False}
            save(receipt, value)
            material.update(state="downloading" if material["missingBytes"] else material["state"], checkedAt=now())
            save(self.root / "materials" / (material["id"] + ".json"), material)
            save(folder / "process.v1.json", self.process_identity())
            try:
                for row in material["files"]:
                    if now() >= deadline:
                        raise TimeoutError("Original material download budget expired")
                    path = (root if root.exists() else partial) / relative(row["path"])
                    if path.is_file() and (self.file_unchanged(path, row) if mode != "verify" and material["state"] == "ready" else self.file_valid(path, row)):
                        value["reusedBytes"] += row["bytes"]
                        continue
                    if root.exists():
                        raise RuntimeError("Published material content changed; retain evidence and request verification")
                    if mode == "verify":
                        raise RuntimeError("Material verification found a missing or damaged file: " + row["path"])
                    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
                    shared = self.file_object(row)
                    if shared is not None:
                        try:
                            os.link(shared, path)
                        except OSError as link_error:
                            try:
                                with open(shared, "rb") as incoming, open(path, "xb") as outgoing:
                                    fcntl.ioctl(outgoing.fileno(), 0x40049409, incoming.fileno())
                            except OSError as clone_error:
                                path.unlink(missing_ok=True)
                                with self.locked():
                                    self.download_capacity(operation, material, value["downloadedBytes"], row["bytes"])
                                    reason = "Independent verified material copy: " + str(link_error) + "; " + str(clone_error)
                                    save(folder / "copy-plan.v1.json", {"version": 1, "experimentId": self.experiment, "serverId": self.server,
                                        "operationId": operation, "bytes": row["bytes"], "reason": reason, "checkedAt": now()})
                                    shutil.copyfile(shared, path)
                                    value["copiedBytes"] = value.get("copiedBytes", 0) + row["bytes"]
                                    value.setdefault("copyReasons", []).append(reason)
                        if not self.file_valid(path, row):
                            raise RuntimeError("Shared material changed during file publication")
                        value["reusedBytes"] += row["bytes"]
                        self.retain_file_object(material, row, path)
                        continue
                    part = path.with_name(path.name + ".part")
                    reject_links(part)
                    offset = part.stat().st_size if part.exists() else 0
                    if offset > row["bytes"]:
                        raise RuntimeError("Retained partial download exceeds its canonical file size")
                    if offset == row["bytes"] and self.file_valid(part, row):
                        os.replace(part, path); value["reusedBytes"] += row["bytes"]
                        continue
                    if offset == row["bytes"]:
                        os.rename(part, part.with_name(part.name + ".invalid-" + uuid.uuid4().hex))
                        offset = 0
                    headers = {"Range": "bytes=" + str(offset) + "-"} if offset else {}
                    url = self.url(row["url"])
                    value.update(stage="downloading", updatedAt=now()); save(receipt, value)
                    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=self.policy["networkReadTimeoutMs"] / 1000) as response:
                        resumed = offset and response.status == 206 and response.headers.get("Content-Range", "").startswith("bytes " + str(offset) + "-")
                        if response.status == 206 and not resumed:
                            raise RuntimeError("Download Content-Range differs from the retained file offset")
                        with open(part, "ab" if resumed else "wb") as output:
                            written = offset if resumed else 0
                            while True:
                                if now() >= deadline:
                                    raise TimeoutError("Original material download budget expired")
                                chunk = response.read(self.policy["transferChunkBytes"])
                                if not chunk:
                                    break
                                if written + len(chunk) > row["bytes"]:
                                    raise RuntimeError("Provider sent more bytes than the canonical file size")
                                self.download_capacity(operation, material, written, len(chunk), row)
                                output.write(chunk); written += len(chunk); value["downloadedBytes"] += len(chunk)
                                output.flush()
                                if now() - value["updatedAt"] >= self.owner.policy["operationPollIntervalMs"]:
                                    value["updatedAt"] = now(); save(receipt, value)
                            os.fsync(output.fileno())
                    value.update(stage="verifying", updatedAt=now()); save(receipt, value)
                    if not self.file_valid(part, row):
                        raise RuntimeError("Downloaded file differs from the fixed revision size or digest: " + row["path"])
                    os.replace(part, path)
                    self.retain_file_object(material, row, path)
                    value["updatedAt"] = now(); save(receipt, value)
                if not root.exists():
                    value.update(stage="publishing", updatedAt=now()); save(receipt, value)
                    os.rename(partial, root)
                material.update(state="ready", missingBytes=0, verifiedBytes=material["totalBytes"], checkedAt=now())
                for row in material["files"]:
                    identity = governance_identity(root / row["path"])
                    row.update(mtimeNs=identity[3], ctimeNs=identity[4])
                self.publish_material(material)
                self.download_capacity(operation, {**material, "missingBytes": 0}, 0, 0)
                value.update(state="completed", stage="waiting-exit", updatedAt=now(), exitConfirmed=True, material=material)
            except (Exception, KeyboardInterrupt) as error:
                value.update(state="blocked", stage="blocked", updatedAt=now(), detail=str(error), exitConfirmed=True)
                material.update(state="blocked", detail=str(error), checkedAt=now())
                save(self.root / "materials" / (material["id"] + ".json"), material)
            save(receipt, value)
            return value

    def publish_material(self, material):
        save(self.root / "materials" / (material["id"] + ".json"), material)
        publication = self.root / "material-publications" / (material["id"] + ".json")
        if not publication.exists():
            save(publication, material)
        else:
            old = governance_row(publication)
            fingerprint = lambda rows: [{key: row[key] for key in ("path", "bytes", "hash", "algorithm", "mtimeNs")} for row in rows]
            if fingerprint(old["files"]) != fingerprint(material["files"]) or old["directory"] != material["directory"]:
                raise RuntimeError("Material publication identity changed; existing bindings require independent reverification")
        reference = {"version": 1, "experimentId": self.experiment, "serverId": self.server, "materialId": material["id"],
            "directory": material["directory"], "manifestHash": file_hash(publication), "readonly": True, "checkedAt": now()}
        save(self.root / "material-references" / (self.experiment + "-" + material["id"] + ".json"), reference)
        save(self.material_bindings / (material["id"] + ".json"), reference)
        for row in material["files"]:
            self.retain_file_object(material, row, pathlib.Path(material["directory"]) / relative(row["path"]))

    @contextlib.contextmanager
    def content_locks(self, files, deadline):
        root = self.root / "content-locks"
        root.mkdir(mode=0o700, exist_ok=True)
        shards = sorted({int(digest([row["algorithm"], row["hash"], row["bytes"]]), 16) % self.policy["materialLockShards"] for row in files})
        with contextlib.ExitStack() as stack:
            for index in shards:
                handle = stack.enter_context(open(root / str(index), "a"))
                while True:
                    try:
                        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        if now() >= deadline:
                            raise TimeoutError("Original material budget expired waiting for a shared content owner")
                        time.sleep(self.owner.policy["operationPollIntervalMs"] / 1000)
            yield

    @contextlib.contextmanager
    def transfer_slot(self, deadline):
        root = self.root / "transfer-slots"
        root.mkdir(mode=0o700, exist_ok=True)
        with contextlib.ExitStack() as resources:
            handles = [resources.enter_context(open(root / str(index), "a")) for index in range(self.policy["maxConcurrentTransfers"])]
            selected = None
            while selected is None:
                for handle in handles:
                    try:
                        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        selected = handle
                        break
                    except BlockingIOError:
                        continue
                if selected is None:
                    if now() >= deadline:
                        raise TimeoutError("Original material budget expired waiting for a server transfer slot")
                    time.sleep(self.owner.policy["operationPollIntervalMs"] / 1000)
            try:
                yield
            finally:
                fcntl.flock(selected, fcntl.LOCK_UN)

    def settle_material(self, operation):
        value = self.material_operation(operation)
        runtime = self.run / "material-operations-v1" / operation / "runtime.v1.json"
        if runtime.exists() and governance_row(runtime).get("stopReason"):
            value["stopReason"] = governance_row(runtime)["stopReason"]
        self.owner.assert_exited(value.get("commandId", "material-" + operation), self.config.get("launchFailureConfirmed", False))
        value.update(exitConfirmed=True, admissionReleased=True, updatedAt=now(),
            processState="not-started" if self.config.get("notStarted") else "exited", exitCode=self.config.get("exitCode"))
        if value["state"] in ("requested", "running", "unknown"):
            value.update(state="blocked", detail="Original material process exited without a complete result; recover the same operation")
        value["stage"] = "completed" if value["state"] == "completed" else "blocked"
        save(self.run / "material-operations-v1" / operation / "receipt.v1.json", value)
        save(self.run / "material-operations-v1" / operation / "runtime.v1.json", value)
        (self.root / "reservations" / (self.experiment + "-" + operation + ".json")).unlink(missing_ok=True)
        return value

    def stop_material(self, operation, reason):
        if reason not in ("timeout", "cancelled", "controller-stopping"):
            raise RuntimeError("Material stop reason is invalid")
        value = self.material_operation(operation)
        if not value.get("stopReason"):
            value.update(stopReason=reason, updatedAt=now())
            save(self.run / "material-operations-v1" / operation / "receipt.v1.json", value)
            save(self.run / "material-operations-v1" / operation / "runtime.v1.json", value)
        return value

    def release_capacity(self):
        allocation = self.control / "state/node-home/storages/aspera_node/allocations" / (self.experiment + ".json")
        if not allocation.exists() or governance_row(allocation).get("released") is not True:
            raise RuntimeError("Node allocation release must be durable before capacity reservations are released")
        for path in (self.root / "reservations").glob("*.json"):
            if governance_row(path).get("experimentId") == self.experiment:
                path.unlink()
        return {"released": True}

    def historical_cleanup(self):
        roots, errors = self.roots()
        rows = self.duplicate_materials(roots)
        for root in roots:
            if not root["confirmed"]:
                continue
            namespace = pathlib.Path(root["directory"])
            for run in (namespace / "runs").glob("*"):
                if not run.is_dir() or run.is_symlink() or run.name == self.experiment:
                    continue
                try:
                    if governance_row(run / ".aspera-owner.json") != {"version": 1, "experimentId": run.name, "serverId": self.server}:
                        continue
                    self.source_released(run.name, run)
                    for receipt_path in (run / "environment-operations-v1").glob("*/receipt.v1.json"):
                        receipt = governance_row(receipt_path)
                        operation = receipt_path.parent.name
                        if receipt.get("operationId") != operation or receipt.get("experimentId") != run.name or receipt.get("serverId") != self.server:
                            raise RuntimeError("Historical installation receipt ownership differs")
                        work = run / "workspace/tmp" / ("environment-" + operation)
                        if receipt.get("exitConfirmed") is not True or receipt.get("state") not in ("completed", "blocked") or not work.exists() or (work / "previous").exists():
                            continue
                        self.protect_path(work)
                        identifier = digest([self.server, run.name, operation, governance_identity(work), digest(receipt)])
                        rows.append({"id": "history-" + identifier, "kind": "historical-temporary", "bytes": self.reclaimable(work),
                            "reason": "Confirmed exited historical installation private residue", "sourceExperimentId": run.name,
                            "path": str(work), "runRoot": str(run), "receipt": str(receipt_path), "identity": governance_identity(work)})
                except (OSError, RuntimeError, ValueError, KeyError):
                    # Missing release or ownership proof keeps that historical directory out of deletion candidates.
                    continue
        return rows

    @staticmethod
    def reclaimable(directory):
        identities = {}
        for path in pathlib.Path(directory).rglob("*"):
            if path.is_symlink() or not path.is_file():
                continue
            value = path.stat()
            key = (value.st_dev, value.st_ino)
            row = identities.setdefault(key, {"count": 0, "links": value.st_nlink, "bytes": value.st_blocks * 512})
            row["count"] += 1
        return sum(row["bytes"] for row in identities.values() if row["count"] == row["links"])

    def duplicate_materials(self, roots):
        groups, count = {}, 0
        for root in roots:
            store = pathlib.Path(root["directory"]) / "packages-v1"
            if not root["confirmed"] or not (store / "owner.v1.json").exists():
                continue
            if governance_row(store / "owner.v1.json") != {"version": 1, "serverId": self.server}:
                continue
            try:
                already_locked = store == getattr(self.owner, "store", None) and self.config.get("action") in ("inspect", "preview", "cleanup", "prepare", "recover") and not getattr(self.owner, "inspection_busy", False)
                with contextlib.nullcontext() if already_locked else open(store / "lock", "r") as handle:
                    if handle is not None:
                        fcntl.flock(handle, fcntl.LOCK_SH | fcntl.LOCK_NB)
                    held = set()
                    for reference in (store / "material-references").glob("*.json"):
                        value = governance_row(reference)
                        if value.get("serverId") != self.server:
                            raise RuntimeError("Installation material reference belongs to another server")
                        held.update(value["hashes"])
                    objects = {}
                    for record in (store / "objects").glob("*/record.v1.json"):
                        value = governance_row(record); objects[value["id"]] = value["wheelHash"]
                    for reference in (store / "references").glob("*.json"):
                        value = governance_row(reference)
                        if value.get("serverId") != self.server:
                            raise RuntimeError("Environment reference belongs to another server")
                        held.update(objects.get(identifier, "unknown") for identifier in value["packages"])
                    for record in sorted((store / "materials").glob("*/record.v1.json")):
                        count += 1
                        if count > self.policy["materialFileLimit"]:
                            return []
                        value = governance_row(record)
                        if value.get("version") != 1 or value.get("serverId") != self.server or value.get("hash") != record.parent.name:
                            raise RuntimeError("Duplicate material ownership differs")
                        path = record.parent / relative(value["filename"])
                        reject_links(path)
                        if not path.is_file() or file_hash(path) != value["hash"]:
                            continue
                        self.owner.wheel(path)
                        groups.setdefault(value["hash"], []).append({"path": str(path), "folder": str(record.parent), "store": str(store),
                            "identity": governance_identity(path), "held": value["hash"] in held or path.stat().st_nlink > 1})
            except (OSError, RuntimeError, ValueError):
                # An active or unreadable store never supplies deletion candidates.
                continue
        result = []
        for checksum, copies in groups.items():
            copies.sort(key=lambda row: (not row["held"], row["store"] != str(self.namespace / "packages-v1"), row["path"]))
            for candidate in copies[1:]:
                if candidate["held"]:
                    continue
                retained = copies[0]
                identifier = digest([checksum, candidate, retained])
                result.append({"id": "duplicate-" + identifier, "kind": "historical-material", "bytes": allocated(pathlib.Path(candidate["folder"])),
                    "reason": "Duplicate verified wheel; retained copy: " + retained["path"], "path": candidate["folder"],
                    "store": candidate["store"], "identity": candidate["identity"], "retained": retained["path"], "retainedStore": retained["store"], "hash": checksum})
        return result

    def clean_historical(self, identifier, expected):
        candidate = next((row for row in self.historical_cleanup() if row["id"] == identifier), None)
        if candidate is None or candidate != expected:
            raise RuntimeError("Historical cleanup candidate changed; refresh its preview")
        if candidate["kind"] == "historical-material":
            retained = pathlib.Path(candidate["retained"])
            with contextlib.ExitStack() as stack:
                for store in sorted({candidate["store"], candidate["retainedStore"]}):
                    if pathlib.Path(store) == getattr(self.owner, "store", None) and self.config.get("action") == "cleanup":
                        continue
                    handle = stack.enter_context(open(pathlib.Path(store) / "lock", "r"))
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if not retained.is_file() or file_hash(retained) != candidate["hash"]:
                    raise RuntimeError("The retained duplicate wheel changed; preserve the selected copy")
                remove_private(pathlib.Path(candidate["path"]), pathlib.Path(candidate["store"]))
            return
        run = pathlib.Path(candidate["runRoot"])
        self.protect_path(candidate["path"])
        remove_private(pathlib.Path(candidate["path"]), run / "workspace")

    def history_preview(self):
        rows = self.historical_cleanup()
        return {"serverId": self.server, "checkedAt": now(), "fingerprint": digest(rows), "eligible": True,
            "candidates": [{key: value for key, value in row.items() if key in ("id", "kind", "bytes", "reason", "sourceExperimentId")} for row in rows]}

    def history_cleanup(self, request):
        operation = request["operationId"]
        path = self.root / "historical-cleanups" / (operation + ".json")
        signature = digest(request)
        if path.exists():
            previous = governance_row(path)
            if previous["requestHash"] != signature:
                raise RuntimeError("Historical cleanup operation is bound to a different selection")
            if previous.get("result"):
                return previous["result"]
            identity = previous["process"]
            current_boot = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()
            process = pathlib.Path("/proc") / str(identity["pid"]) / "stat"
            if current_boot == identity["hostBootId"] and process.exists() and process.read_text().rsplit(")", 1)[1].split()[19] == identity["startTime"]:
                raise RuntimeError("Original historical cleanup process is still present; wait for its receipt")
            complete = all(not pathlib.Path(row["path"]).exists() for row in previous["candidates"])
            result = {"serverId": self.server, "state": "completed" if complete else "blocked", "reclaimedBytes": 0, "checkedAt": now(),
                "detail": "Original cleanup exit confirmed; reclaimed space was not measured. Remaining candidates require a fresh preview."}
            save(path, {**previous, "result": result})
            return result
        preview = self.historical_cleanup()
        selected = request["candidateIds"]
        if digest(preview) != request["fingerprint"] or not selected or not set(selected).issubset({row["id"] for row in preview}):
            raise RuntimeError("Historical cleanup references or selection changed; refresh its preview")
        rows = [row for row in preview if row["id"] in selected]
        journal = {"version": 1, "experimentId": self.experiment, "serverId": self.server, "requestHash": signature,
            "candidates": rows, "process": self.process_identity(), "startedAt": now()}
        save(path, journal)
        measured = {}
        for row in rows:
            mount = self.mount(row["path"])
            measured.setdefault(mount["directory"], shutil.disk_usage(row["path"]).free)
        try:
            for row in rows:
                self.clean_historical(row["id"], row)
            result = {"serverId": self.server, "state": "completed", "reclaimedBytes": sum(max(0, shutil.disk_usage(path).free - before) for path, before in measured.items()), "checkedAt": now()}
        except (Exception, KeyboardInterrupt) as error:
            result = {"serverId": self.server, "state": "blocked", "reclaimedBytes": sum(max(0, shutil.disk_usage(path).free - before) for path, before in measured.items()),
                "checkedAt": now(), "detail": str(error)}
        save(path, {**journal, "result": result})
        return result

    def release(self):
        if self.run.exists() or (self.namespace / (".cleanup-" + self.experiment)).exists():
            raise RuntimeError("Storage references require confirmed remote environment deletion")
        for folder in ("environment-leases", "material-references"):
            for path in (self.root / folder).glob("*.json"):
                row = governance_row(path)
                if row.get("serverId") != self.server:
                    raise RuntimeError("Storage reference belongs to another server")
                if row.get("experimentId") == self.experiment:
                    path.unlink()
        for path in (self.root / "reservations").glob("*.json"):
            if governance_row(path).get("experimentId") == self.experiment:
                path.unlink()
