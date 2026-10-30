"""Account-scoped storage inventories, released environment loans and pinned material acquisition.

The managed-environment helper loads this module into its own namespace so SSH reads
and node operations share the same ownership checks and durable implementation.
"""
import urllib.request
import urllib.parse
import urllib.error
import socket
import contextlib
import copy


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
        self._material_views = {}
        self._copy_sources = {}
        self._legacy_material_operation = False

    def reuse_enabled(self):
        return self.config.get("reuseVerificationVersion") == 1

    def bind_context(self, kind, identifier):
        context = self.config.get("evidenceContext")
        if context is None:
            return
        path = self.run / "operation-contexts-0.1.1" / kind / (identifier + ".json")
        record = {"version": 1, "formatVersion": "0.1.1", "experimentId": self.experiment, "serverId": self.server, **context}
        if path.exists() and governance_row(path) != record:
            raise RuntimeError("Operation belongs to a different plan or Session")
        save(path, record)

    def requirement_evidence(self, reference):
        kind, identifier = reference["kind"], reference["id"]
        if reference["serverId"] != self.server or kind not in ("storage-plan", "material-request", "material-operation"):
            raise RuntimeError("Requirement evidence belongs to another node or operation kind")
        if not re.fullmatch(r"[a-f0-9]{64}" if kind == "material-request" else r"[a-f0-9-]{36}", identifier):
            raise RuntimeError("Invalid requirement evidence identity")
        context = governance_row(self.run / "operation-contexts-0.1.1" / kind / (identifier + ".json"))
        if context["experimentId"] != self.experiment or context["serverId"] != self.server or self.config.get("evidenceContext") != {key: context[key] for key in ("sessionId", "planRevision")}:
            raise RuntimeError("Requirement evidence belongs to a different experiment, plan or Session")
        if kind == "storage-plan":
            row = governance_row(self.run / "storage-plans-v1" / (identifier + ".json"))
            current_path = self.run / "storage-plan.v1.json"
            if self.reuse_enabled() and current_path.exists():
                current = governance_row(current_path)
                same_policy = current.get("policyRevision") is not None and current.get("policyRevision") == row.get("policyRevision")
                retained_budget = same_policy or current.get("declaredOutputBytes", 0) >= row.get("declaredOutputBytes", 0) and current.get("declaredCheckpointBytes", 0) >= row.get("declaredCheckpointBytes", 0)
                if current["operationId"] != identifier and current["state"] == "ready" and current.get("reuse", {}).get("complete") and set(row["requirements"]).issubset(current["requirements"]) and set(row["materialIds"]).issubset(current["materialIds"]) and retained_budget:
                    return None
            if row["state"] != "insufficient":
                return None
            if row.get("mode") == "preview" or row.get("capacityBasis") == "estimated":
                return None
            detail = "Measured capacity is insufficient for the " + row.get("coverage", {}).get("scope", "declared") + " scope: " + "; ".join(
                volume["directory"] + " shortfall=" + str(volume.get("shortfallBytes", max(0, volume["requiredBytes"] + volume["reservedBytes"] - volume["availableBytes"]))) + " bytes"
                for volume in row["volumes"] if volume["requiredBytes"] is not None and volume["requiredBytes"] + volume["reservedBytes"] > volume["availableBytes"])
        elif kind == "material-request":
            row = governance_row(self.run / "material-metadata-v1" / (identifier + ".json"))
            if row["state"] != "pending" or not row.get("lastNodeError"):
                return None
            detail = "The node canonical metadata request failed for " + row["request"]["repository"] + "@" + row["request"]["revision"] + ": " + row["lastNodeError"] + ". Other sources and historical reuse are not disproved."
        else:
            row = self.material_operation(identifier)
            if row["state"] != "blocked":
                return None
            detail = "Managed material operation " + identifier + " failed: " + row.get("detail", "No verified result")
        if row.get("experimentId") != self.experiment or row.get("serverId") != self.server:
            raise RuntimeError("Requirement observation ownership differs")
        return {**context, "reference": reference, "requestHash": row.get("requestHash", digest(row.get("request", row))),
            "checkedAt": now(), "detail": detail}

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
            observation = {}
            try:
                reject_links(candidate)
                marker = governance_row(candidate / ".aspera-owner.json")
                if marker.get("serverId") != self.server or marker.get("kind") not in ("storage", "control"):
                    raise RuntimeError("Storage root ownership cannot be confirmed")
                value = candidate.stat()
                registry_path = self.control / "state/storage-governance-v1/root-identities" / (digest(str(candidate)) + ".json")
                identity = {key: self.mount(candidate)[key] for key in ("directory", "filesystem", "source")}
                snapshot = self.root_snapshot(candidate)
                registration = self.root_registration(candidate)
                observation = {"observationId": digest([self.server, str(candidate), snapshot, registration]), "observedMount": identity}
                if registration:
                    observation["registrationId"] = registration["registrationId"]
                    observation["previousMount"] = {key: registration["snapshot"]["mount"][key] for key in identity}
                    if registration["snapshot"] != snapshot:
                        raise RuntimeError("Registered storage changed; verify the current observation before using historical content")
                elif registry_path.exists() and governance_row(registry_path) != identity:
                    observation["previousMount"] = governance_row(registry_path)
                    raise RuntimeError("Storage volume identity changed; explicit preparation verification is required")
                if str(candidate) == self.owner.placement["namespaceRoot"] and "candidate" in self.owner.placement:
                    original_mount = self.owner.placement["candidate"]["mount"]
                    if original_mount["source"] != identity["source"] or original_mount["filesystem"] != identity["filesystem"]:
                        raise RuntimeError("Actual storage volume differs from the saved submission")
                result[str(candidate)] = {"id": digest([self.server, str(candidate), value.st_dev, value.st_ino, observation.get("registrationId")]),
                    "directory": str(candidate), "confirmed": True, **observation}
            except (OSError, RuntimeError, KeyError, ValueError) as error:
                errors.append(str(candidate) + ": " + str(error))
                result[str(candidate)] = {"id": digest([self.server, str(candidate)]), "directory": str(candidate),
                    "confirmed": False, "detail": str(error), **observation}
        return list(result.values()), errors

    def root_snapshot(self, directory):
        reject_links(directory)
        value = pathlib.Path(directory).stat()
        return {"mount": self.mount(directory), "device": str(value.st_dev), "inode": str(value.st_ino)}

    def write_evidence(self, request, policy):
        """Publish bounded immutable evidence through directory descriptors, never a shell command."""
        operation = str(uuid.UUID(request["operationId"]))
        name = relative(request["path"])
        if not re.fullmatch(r"(?:configs|reports|artifacts/diagnostics)/[a-zA-Z0-9_./-]+", name):
            raise RuntimeError("Evidence must use configs, reports or artifacts/diagnostics")
        if request["format"] == "json":
            json.loads(request["content"])
        data = request["content"].encode("utf-8")
        if len(data) > policy["evidenceFileBytes"]:
            raise RuntimeError("Evidence file exceeds its byte limit")
        folder = self.run / "diagnostic-evidence-0.1.3"
        journal = folder / (operation + ".json")
        sha = hashlib.sha256(data).hexdigest()
        request_hash = digest(request)
        if journal.exists():
            old = governance_row(journal)
            if old["experimentId"] != self.experiment or old["serverId"] != self.server or old["requestHash"] != request_hash:
                raise RuntimeError("Evidence operation is bound to different content")
        retained = {}
        for path in folder.glob("*.json"):
            row = governance_row(path)
            if row["experimentId"] != self.experiment or row["serverId"] != self.server:
                raise RuntimeError("Evidence receipt owner differs")
            retained[row["path"]] = max(retained.get(row["path"], 0), row["bytes"])
        retained[name] = max(retained.get(name, 0), len(data))
        if sum(retained.values()) > policy["evidenceTotalBytes"]:
            raise RuntimeError("Experiment evidence byte limit exhausted")
        record = {"version": 1, "formatVersion": "0.1.3", "experimentId": self.experiment, "serverId": self.server,
            "operationId": operation, "path": name, "requestHash": request_hash, "sha256": sha, "bytes": len(data), "state": "requested", "checkedAt": now()}
        save(journal, record)
        root = self.run / "workspace"
        reject_links(root)
        descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        temporary = ".aspera-evidence-" + digest(name)
        try:
            parts = name.split("/")
            for part in parts[:-1]:
                try:
                    os.mkdir(part, 0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
                os.close(descriptor); descriptor = child
            try:
                source = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
            except FileNotFoundError:
                source = None
            if source is not None:
                with os.fdopen(source, "rb") as stream:
                    if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode) or stream.read(policy["evidenceFileBytes"] + 1) != data:
                        raise RuntimeError("Existing evidence differs; choose a new path")
            else:
                try:
                    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
                except FileExistsError:
                    fd = os.open(temporary, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
                    with os.fdopen(fd, "rb") as stream:
                        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode) or stream.read(policy["evidenceFileBytes"] + 1) != data:
                            raise RuntimeError("Interrupted evidence differs; retain it for inspection")
                else:
                    with os.fdopen(fd, "wb") as stream:
                        stream.write(data); stream.flush(); os.fsync(stream.fileno())
                os.link(temporary, parts[-1], src_dir_fd=descriptor, dst_dir_fd=descriptor, follow_symlinks=False)
                os.unlink(temporary, dir_fd=descriptor); os.fsync(descriptor)
        finally:
            # An interrupted private temporary remains attributable to the original operation.
            os.close(descriptor)
        record.update(state="written", checkedAt=now()); save(journal, record)
        return record

    def root_registration(self, directory):
        path = self.root / "registrations-0.1.3/current" / (digest(str(directory)) + ".json")
        if not path.exists():
            return None
        value = governance_row(path)
        if value.get("version") != 1 or value.get("formatVersion") != "0.1.3" \
                or not re.fullmatch(r"[a-f0-9]{64}", value.get("registrationId", "")) \
                or not isinstance(value.get("snapshot"), dict):
            raise RuntimeError("Unsupported or incomplete storage registration")
        if value.get("serverId") != self.server or value.get("directory") != str(directory):
            raise RuntimeError("Storage registration owner differs")
        return value

    def registration_id(self, path):
        target = pathlib.Path(path)
        roots = getattr(self, "_reuse_registration_roots", None)
        if roots is None:
            roots, _ = self.roots()
        matches = [root for root in roots if target == pathlib.Path(root["directory"]) or target.is_relative_to(root["directory"])]
        if not matches:
            return None
        root = max(matches, key=lambda row: len(row["directory"]))
        if not root["confirmed"]:
            raise RuntimeError("Storage registration is not confirmed: " + root.get("detail", root["directory"]))
        return root.get("registrationId")

    def check_registration(self, record, path):
        if record.get("registrationId") != self.registration_id(path):
            raise RuntimeError("Source verification belongs to a previous storage registration; discover and verify the current source")

    def bind_registration(self, record, path):
        registration = self.registration_id(path)
        if registration is None:
            record.pop("registrationId", None)
        else:
            record["registrationId"] = registration
        return record

    def registration_writers(self, directory, snapshot):
        """Copied allocation state never authorizes killing a current process or releasing its owner."""
        folder = self.control / "state/node-home/storages/aspera_node/allocations"
        for path in folder.glob("*.json"):
            row = governance_row(path)
            placement = row.get("node", {}).get("server", {}).get("storagePlacement", {})
            if row.get("released") is True or placement.get("namespaceRoot") != str(directory):
                continue
            old = placement.get("candidate", {}).get("mount", {})
            actual = snapshot["mount"]
            run = pathlib.Path(placement["runRoot"])
            reject_links(run)
            if run != directory / "runs" / row["experimentId"]:
                raise RuntimeError("Storage writer directory differs from its owner")
            evidence = list((run / "process-identities").glob("*.json")) + list((run / "agent-identities").glob("*.json"))
            if not evidence:
                if row["experimentId"] == self.experiment and old.get("source") == actual["source"] and old.get("filesystem") == actual["filesystem"]:
                    continue
                raise RuntimeError("Prior storage writer exit is unconfirmed for experiment " + row["experimentId"])
            boot = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()
            for source in evidence:
                process = governance_row(source)
                if process.get("experimentId") != row["experimentId"] or process.get("serverId") != self.server:
                    raise RuntimeError("Prior storage process ownership differs")
                if process.get("hostBootId") != boot:
                    continue
                current_agent = source.parent.name == "agent-identities" and row["experimentId"] == self.experiment \
                    and old.get("source") == actual["source"] and old.get("filesystem") == actual["filesystem"]
                if current_agent:
                    continue
                for status in pathlib.Path("/proc").glob("[0-9]*/stat"):
                    try:
                        fields = status.read_text().rsplit(")", 1)[1].split()
                    except FileNotFoundError:
                        continue
                    if fields[0] != "Z" and (int(fields[2]) == process["group"] or int(status.parent.name) == process["pid"] and fields[19] == process["start"]):
                        raise RuntimeError("Prior storage writer is still running for experiment " + row["experimentId"])

    def verify_root(self, request):
        """Journal an observed root before committing its new registration under process admission."""
        operation = str(uuid.UUID(request["operationId"]))
        for field in ("rootId", "observationId"):
            if not re.fullmatch(r"[a-f0-9]{64}", request[field]):
                raise RuntimeError("Invalid storage observation reference")
        operation_path = self.root / "registrations-0.1.3/operations" / (operation + ".json")
        lock = self.control / "state/controller-admission.lock"
        reject_links(lock); lock.parent.mkdir(parents=True, exist_ok=True)
        with open(lock, "a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.locked():
                previous = governance_row(operation_path) if operation_path.exists() else None
                if previous and (previous["request"] != request or previous["experimentId"] != self.experiment):
                    raise RuntimeError("Storage operation is bound to another request or experiment")
                if previous:
                    directory = pathlib.Path(previous["directory"])
                    if self.root_snapshot(directory) != previous["snapshot"]:
                        raise RuntimeError("Storage observation changed; inspect again before a new verification")
                    current = self.root_registration(directory)
                    if current != previous["previousRegistration"] and (not current or current["registrationId"] != previous["registrationId"]):
                        raise RuntimeError("Another storage registration was committed; inspect again")
                    record = previous
                else:
                    roots, _ = self.roots()
                    selected = next((row for row in roots if row["id"] == request["rootId"]), None)
                    if selected is None or selected.get("observationId") != request["observationId"]:
                        raise RuntimeError("Storage observation is missing or stale; inspect this node again")
                    directory = pathlib.Path(selected["directory"])
                    snapshot = self.root_snapshot(directory)
                    legacy = self.root / "root-identities" / (digest(str(directory)) + ".json")
                    current = self.root_registration(directory)
                    record = {"version": 1, "formatVersion": "0.1.3", "serverId": self.server, "experimentId": self.experiment,
                        "operationId": operation, "request": request, "directory": str(directory), "snapshot": snapshot,
                        "previousRegistration": current, "legacyObservation": governance_row(legacy) if legacy.exists() else None,
                        "registrationId": current["registrationId"] if current and current["snapshot"] == snapshot else digest([self.server, str(directory), operation, snapshot]),
                        "state": "requested", "startedAt": now(), "checkedAt": now()}
                    save(operation_path, record)
                marker = governance_row(directory / ".aspera-owner.json")
                if marker.get("serverId") != self.server or marker.get("kind") not in ("storage", "control"):
                    raise RuntimeError("Storage root ownership cannot be confirmed")
                if not self.config.get("action", "").startswith("history-") and str(directory) == self.owner.placement["namespaceRoot"]:
                    original = self.owner.placement.get("candidate", {}).get("mount")
                    if original and any(original[key] != record["snapshot"]["mount"][key] for key in ("source", "filesystem")):
                        raise RuntimeError("Current storage differs from the experiment's fixed placement")
                if record["snapshot"]["mount"]["readonly"] or not os.access(directory, os.W_OK | os.X_OK):
                    raise RuntimeError("Storage is not writable for the login account")
                if current and current["registrationId"] == record["registrationId"]:
                    record.update(state="verified", checkedAt=now()); save(operation_path, record); return record
                self.registration_writers(directory, record["snapshot"])
                descriptor, probe = tempfile.mkstemp(prefix=".aspera-storage-check-", dir=directory)
                try:
                    with os.fdopen(descriptor, "wb") as stream:
                        stream.write(b"1"); stream.flush(); os.fsync(stream.fileno())
                finally:
                    os.unlink(probe)
                if self.root_snapshot(directory) != record["snapshot"]:
                    raise RuntimeError("Storage changed during verification")
                registration = {key: record[key] for key in ("version", "formatVersion", "serverId", "directory", "registrationId", "snapshot")}
                registration.update(operationId=operation, checkedAt=now())
                save(self.root / "registrations-0.1.3/history" / (record["registrationId"] + ".json"), registration)
                save(self.root / "registrations-0.1.3/current" / (digest(str(directory)) + ".json"), registration)
                record.update(state="verified", checkedAt=now()); save(operation_path, record)
                return record

    def mount(self, path):
        """Read current mount identity; saved mount IDs never authorize a later operation."""
        target = str(pathlib.Path(path).absolute())
        choices = []
        table = getattr(self, "_scan_mount_table", None)
        if table is None:
            table = pathlib.Path("/proc/self/mountinfo").read_text()
        entries = getattr(self, "_scan_mount_entries", None)
        if entries is None:
            entries = []
            for line in table.splitlines():
                left, right = line.split(" - ", 1)
                fields, tail = left.split(), right.split()
                mount = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), fields[4])
                entries.append({"mountId": int(fields[0]), "directory": mount,
                    "filesystem": tail[0], "source": tail[1], "readonly": "ro" in fields[5].split(",")})
            if hasattr(self, "_scan_mount_table"):
                self._scan_mount_entries = entries
        for entry in entries:
            mount = entry["directory"]
            if target == mount or target.startswith(mount.rstrip("/") + "/"):
                choices.append((len(mount), entry))
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

    def readonly_consumer_groups(self, source_experiment, roots):
        """Recognize this allocation's owned ordinary commands with disjoint writable roots."""
        if source_experiment == self.experiment:
            return {}
        table = self.control / "state/node-home/storages/aspera_node"
        allocation = table / "allocations" / (self.experiment + ".json")
        if not allocation.exists():
            return {}
        current = governance_row(allocation)
        server = current.get("node", {}).get("server", {})
        placement = server.get("storagePlacement", {})
        if current.get("experimentId") != self.experiment or current.get("deploymentId") != self.config["deploymentId"] \
                or current.get("released") is not False or current.get("releasing") or server.get("id") != self.server \
                or placement.get("runRoot") != str(self.run) or placement.get("workspaceRoot") != self.owner.placement.get("workspaceRoot"):
            return {}
        marker = governance_row(self.run / ".aspera-owner.json")
        if marker != {"version": 1, "serverId": self.server, "experimentId": self.experiment}:
            raise RuntimeError("Readonly consumer experiment ownership changed")
        writable = [self.run.resolve(), self.owner.workspace.resolve(), pathlib.Path(placement["workspaceRoot"]).resolve()]
        protected = [pathlib.Path(root).resolve() for root in roots]
        if any(left.is_relative_to(right) or right.is_relative_to(left) for left in writable for right in protected):
            return {}
        commands = {row.get("commandId"): row for path in (table / "commands").glob("*.json")
            if (row := governance_row(path)).get("experimentId") == self.experiment
            and row.get("state") == "running" and row.get("released") is False}
        boot = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        result = {}
        for path in (self.run / "process-identities").glob("*.v1.json"):
            identity = governance_row(path)
            pid = identity.get("pid")
            if identity.get("version") != 1 or identity.get("experimentId") != self.experiment or identity.get("serverId") != self.server \
                    or identity.get("deploymentId") != self.config["deploymentId"] or identity.get("controlRoot") != str(self.control) \
                    or identity.get("environmentOperation") or identity.get("cacheCleanup") or identity.get("hostBootId") != boot \
                    or type(pid) is not int or pid <= 1 or identity.get("group") != pid \
                    or path.name != identity.get("commandId", "") + ".v1.json" or identity.get("commandId") not in commands:
                continue
            try:
                fields = (pathlib.Path("/proc") / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()
            except FileNotFoundError:
                continue
            if fields[0] != "Z" and fields[19] == identity.get("start") and int(fields[2]) == pid:
                result[pid] = identity
        return result

    @staticmethod
    def readonly_consumer_process(entry, groups):
        """Verify a live recorded ancestor even when a sandbox child creates a new session."""
        try:
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
            birth = fields[19]
            pid, seen = int(entry.name), set()
            while pid > 1 and pid not in seen:
                seen.add(pid)
                identity = groups.get(pid)
                if identity is not None:
                    leader = (entry.parent / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()
                    member = (entry / "stat").read_text().rsplit(")", 1)[1].split()
                    return leader[0] != "Z" and leader[19] == identity["start"] and int(leader[2]) == identity["group"] \
                        and member[19] == birth and int(birth) >= int(identity["start"])
                parent = int(fields[1])
                if parent <= 1:
                    return False
                ancestor = (entry.parent / str(parent) / "stat").read_text().rsplit(")", 1)[1].split()
                if int(ancestor[19]) > int(fields[19]):
                    return False
                pid, fields = parent, ancestor
            return False
        except FileNotFoundError:
            return False

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
        roots = [str(run), str(source_training_workspace(self.owner, run))]
        consumers = self.readonly_consumer_groups(experiment, roots)
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
            if any(root in command or cwd == root or cwd.startswith(root + "/") for root in roots):
                if self.readonly_consumer_process(entry, consumers):
                    continue
                raise RuntimeError("A process still uses the original experiment: " + entry.name + " (source experiment " + experiment + ")")
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
        def observations():
            result = []
            for name in ("environment-leases", "material-source-leases"):
                for record in sorted((self.root / name).glob("*.json")):
                    reject_links(record)
                    result.append((str(record), governance_identity(record)))
            return result
        snapshot = observations()
        cached = getattr(self, "_protected_path_sources", None)
        if cached is None or cached[0] != snapshot:
            sources = []
            for record, _identity in snapshot:
                row = governance_row(pathlib.Path(record))
                if row.get("serverId") != self.server:
                    raise RuntimeError("Historical source protection belongs to another server")
                sources.append(row["directory"])
            if observations() != snapshot:
                raise RuntimeError("Historical source protection changed while it was inspected")
            self._protected_path_sources = (snapshot, sources)
        else:
            sources = cached[1]
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
        identifier = digest([self.server, run.name, str(directory), governance_identity(directory), self.registration_id(directory)])
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

    def scan_scope(self, scope, roots):
        confirmed = [row for row in roots if row["confirmed"]]
        if scope["kind"] == "account":
            return [[row["directory"], row["directory"]] for row in confirmed]
        if scope["kind"] == "experiment":
            identifier = str(uuid.UUID(scope["experimentId"]))
            targets = [(pathlib.Path(row["directory"]) / "runs" / identifier / "workspace", row) for row in confirmed]
        elif scope["kind"] == "directory":
            root = next((row for row in confirmed if row["id"] == scope["rootId"]), None)
            if root is None:
                raise RuntimeError("Storage scope root is not confirmed on this node")
            targets = [(pathlib.Path(root["directory"]) / relative(scope["relativePath"]), root)]
        else:
            raise RuntimeError("Unsupported storage discovery scope")
        result = []
        for target, root in targets:
            reject_links(target)
            if not target.exists():
                continue
            parts = target.relative_to(root["directory"]).parts
            if len(parts) < 3 or parts[0] != "runs" or parts[2] != "workspace":
                raise RuntimeError("Targeted material discovery requires an owned experiment workspace")
            run = pathlib.Path(root["directory"]) / "runs" / parts[1]
            if governance_row(run / ".aspera-owner.json") != {"version": 1, "serverId": self.server, "experimentId": parts[1]}:
                raise RuntimeError("Targeted discovery source owner differs")
            result.append([str(target), root["directory"]])
        if not result:
            raise RuntimeError("No owned workspace exists in the selected scope; other scopes remain unexamined")
        return result

    def material_candidate(self, directory, root):
        directory = pathlib.Path(directory)
        reject_links(directory)
        parts = directory.relative_to(root["directory"]).parts
        if len(parts) < 3 or parts[0] != "runs" or parts[2] != "workspace":
            return None
        run = pathlib.Path(root["directory"]) / "runs" / parts[1]
        if governance_row(run / ".aspera-owner.json") != {"version": 1, "serverId": self.server, "experimentId": parts[1]}:
            raise RuntimeError("Material candidate belongs to another source")
        identity, mount = governance_identity(directory), self.mount(directory)
        identifier = digest([self.server, str(directory), identity[:2], mount, self.registration_id(directory)])
        value = {"id": identifier, "serverId": self.server, "sourceExperimentId": run.name, "runRoot": str(run),
            "directory": str(directory), "rootId": root["id"], "checkedAt": now(),
            "detail": "Discovered owned directory; canonical content and source release are not yet verified"}
        save(self.root / "material-candidates-0.1.1" / (identifier + ".json"),
            {"version": 1, "formatVersion": "0.1.1", "candidate": value, "identity": identity[:2], "mount": mount})
        return value

    def find_material_candidate(self, identifier):
        if not re.fullmatch(r"[a-f0-9]{64}", identifier):
            raise RuntimeError("Invalid material candidate identity")
        saved = governance_row(self.root / "material-candidates-0.1.1" / (identifier + ".json"))
        value = saved["candidate"]
        roots, _ = self.roots()
        root = next((row for row in roots if row["id"] == value["rootId"] and row["confirmed"]), None)
        if root is None or value["serverId"] != self.server:
            raise RuntimeError("Material candidate root or node identity changed")
        self.scan_scope({"kind": "directory", "rootId": root["id"],
            "relativePath": pathlib.Path(value["directory"]).relative_to(root["directory"]).as_posix()}, roots)
        if governance_identity(value["directory"])[:2] != saved["identity"] or self.mount(value["directory"]) != saved["mount"]:
            raise RuntimeError("Material candidate directory or mount identity changed")
        return value

    def catalog(self, refresh=False, cursor=None, scope=None):
        scope = scope or {"kind": "account"}
        key = "" if scope["kind"] == "account" else "-" + digest([self.server, scope])
        saved_path = self.root / ("catalog" + key + ".v1.json")
        progress = self.root / ("scan" + key + ".v1.json")
        roots, errors = self.roots()
        if not refresh and not cursor and saved_path.exists():
            saved = governance_row(saved_path)
            if saved["roots"] == roots:
                return saved
        fingerprint = digest([self.server, scope, roots, [self.mount(row["directory"]) for row in roots if row["confirmed"]]])
        for row in roots:
            if row["confirmed"] and not row.get("registrationId"):
                observation = self.mount(row["directory"])
                save(self.root / "root-identities" / (digest(row["directory"]) + ".json"),
                    {key: observation[key] for key in ("directory", "filesystem", "source")})
        if cursor:
            if not progress.exists():
                raise RuntimeError("Storage scan cursor belongs to another scope or is missing")
            state = governance_row(progress)
            if state["cursor"] != cursor or state["fingerprint"] != fingerprint:
                raise RuntimeError("Storage scan cursor is stale; restart the inventory")
        else:
            state = {"version": 1, "cursor": str(uuid.uuid4()), "fingerprint": fingerprint, "seen": [], "volumes": {},
                "todo": self.scan_scope(scope, roots), "entriesScanned": 0,
                "historicalEnvironments": [], "materialCandidates": [], "materialFiles": [], "materialFilesComplete": True, "diagnostics": errors}
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
        state["seen"] = list(seen)
        save(progress, state)
        checkpoint_at = time.monotonic()
        while state["todo"] and state["entriesScanned"] < limit and time.monotonic() < deadline:
            frame = state["todo"].pop()
            name, root = frame[:2]
            offset = frame[2] if len(frame) > 2 else 0
            path = pathlib.Path(name)
            try:
                info = path.lstat()
                if offset and governance_identity(path) != frame[3]:
                    raise RuntimeError("Directory changed during paged enumeration; restart this scope")
                if not offset:
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
                        consumed = offset
                        for index, entry in enumerate(entries):
                            if index < offset:
                                continue
                            if len(children) >= self.policy["scanEntryLimit"] or time.monotonic() >= deadline:
                                state["todo"].insert(0, [name, root, consumed, governance_identity(path)])
                                break
                            children.append(entry.path)
                            consumed += 1
                    state["todo"].extend([child, root] for child in sorted(children, reverse=True))
                elif stat.S_ISREG(info.st_mode):
                    if path.suffix == ".safetensors" or path.suffix == ".bin" and path.name.startswith(("model", "pytorch")):
                        source_root = next(row for row in roots if row["directory"] == root)
                        candidate = self.material_candidate(path.parent, source_root)
                        if candidate and not any(row["id"] == candidate["id"] for row in state.setdefault("materialCandidates", [])):
                            state["materialCandidates"].append(candidate)
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
            if time.monotonic() - checkpoint_at >= self.owner.policy["operationPollIntervalMs"] / 1000:
                state["seen"] = list(seen)
                save(progress, state)
                checkpoint_at = time.monotonic()
        if hasattr(self, "_scan_mount_table"):
            if mount_file.read_text() != self._scan_mount_table:
                state["diagnostics"].append("Mount topology changed during account-side inventory; refresh before using candidates")
            del self._scan_mount_table
            if hasattr(self, "_scan_mount_entries"):
                del self._scan_mount_entries
        volumes = []
        for volume in state["volumes"].values():
            usage = shutil.disk_usage(volume["directory"])
            categories = list(volume["categories"].values())
            measured = sum(row["allocatedBytes"] for row in categories)
            volumes.append({**volume, "categories": categories, "capacityBytes": usage.total, "availableBytes": usage.free,
                "measuredBytes": measured, "unattributedBytes": max(0, usage.total - usage.free - measured)})
        result = {"version": 1, "formatVersion": "0.1.1", "scope": scope, "materialCandidates": state.get("materialCandidates", []),
            "serverId": self.server, "checkedAt": now(), "complete": not state["todo"] and not state["diagnostics"],
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
        observations = sorted(self.root.glob("catalog*.v1.json"))
        observations.extend(self.run.glob("reuse-verifications-v1/environment/*/discovery.v1.json"))
        for saved in observations:
            observation = governance_row(saved)
            for row in observation.get("historicalEnvironments", observation.get("candidates", [])):
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

    def environment_satisfies(self, request):
        """Use the same published environment evidence for preflight admission and byte estimates."""
        current = self.owner.environment(request["environmentId"])
        satisfied = current and current["state"] == "ready" and set(request["requirements"]).issubset(current["requirements"])
        path = self.bindings / (request["environmentId"] + ".json")
        if path.exists():
            value = governance_row(path)
            if self.reuse_enabled():
                self.check_registration(value, value["directory"])
                self.find_candidate(value["candidateId"])
                lease = governance_row(pathlib.Path(value["lease"]))
                if lease != value or value.get("verified") is not True or value.get("serverId") != self.server or value.get("experimentId") != self.experiment:
                    raise RuntimeError("Historical environment capacity proof ownership or retained lease changed")
                self.source_released(value["sourceExperimentId"], pathlib.Path(value["sourceRunRoot"]))
                self.validate_borrowed_content(value)
            else:
                self.validate_borrowings()
            satisfied = set(request["requirements"]).issubset(value["requirements"])
        return bool(satisfied)

    def verify_borrowed_dependencies(self, candidate, request, work):
        """Check actual metadata and requested constraints with the fixed program-owned uv."""
        directory = pathlib.Path(candidate["directory"])
        requirements = request["requirements"]
        if any("\r" in value or "\n" in value for value in requirements):
            raise RuntimeError("Historical reuse requires single-line dependency constraints")
        if any("@" in value for value in requirements):
            requirements = wheel_metadata(self.owner).borrowed_requirements(requirements, directory)
        work.mkdir(parents=True, mode=0o700, exist_ok=True)
        metadata = sorted(directory.glob("lib/python*/site-packages/*.dist-info/METADATA"))
        overlay = None
        if requirements:
            if not metadata:
                raise RuntimeError("Historical environment has no distributions satisfying the requested dependencies")
            anchor = metadata[0]
            reject_links(anchor)
            document = email.message_from_bytes(anchor.read_bytes())
            for requirement in requirements:
                document["Requires-Dist"] = requirement
            overlay = work / "historical-check.metadata"
            reject_links(overlay)
            overlay.write_bytes(document.as_bytes())
        uv = self.config["uvPath"]
        commands = [[uv, "--version"], [uv, "pip", "check", "--python", candidate["python"], "--offline", "--no-cache", "--no-config"]]
        for index, command in enumerate(commands):
            argv = self.owner.sandbox(command, writable=[work], readonly=[directory], environment=directory)
            if index and overlay is not None:
                separator = len(argv) - len(command) - 1
                if argv[separator] != "--":
                    raise RuntimeError("Historical dependency verifier sandbox command separator differs")
                # The source metadata is replaced only in this read-only verification namespace.
                argv[separator:separator] = ["--ro-bind", str(overlay), str(anchor)]
            remaining = (getattr(self, "_reuse_deadline", now() + self.policy["verificationTimeoutMs"]) - now()) / 1000
            if remaining <= 0:
                raise TimeoutError("Original historical environment verification budget expired")
            result = subprocess.run(argv, capture_output=True, text=True, timeout=remaining,
                env={"PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"})
            if result.returncode:
                raise RuntimeError("Historical dependency verification failed: " + result.stderr[-16384:])
            if not index:
                version = result.stdout.strip().split()
                if len(version) < 2 or version[1] != self.owner.policy["uvVersion"]:
                    raise RuntimeError("Historical dependency verification requires the configured fixed uv version")

    def check_borrowed_distribution_presence(self, directory, requirements):
        """Reject absent unconditional pins using metadata only; all surviving sources still require full verification."""
        normalize = lambda name: re.sub(r"[-_.]+", "-", name).lower()
        pinned = {}
        for requirement in requirements:
            match = re.fullmatch(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*==\s*[A-Za-z0-9.!+_*~-]+\s*", requirement)
            if match:
                pinned[normalize(match[1])] = requirement
        if not pinned:
            return
        sites = list(directory.glob("lib/python*/site-packages"))
        installed = set()
        for site in sites:
            reject_links(site)
            if any(site.glob("*.egg*")) or any(path.name not in ("distutils-precedence.pth", "_virtualenv.pth") for path in site.glob("*.pth")):
                return
            for info in site.glob("*.dist-info"):
                metadata = info / "METADATA"
                reject_links(metadata)
                if not metadata.is_file() or metadata.stat().st_size > self.policy["metadataBytes"]:
                    return
                value = email.message_from_bytes(metadata.read_bytes())
                if not value.get("Name") or not value.get("Version"):
                    return
                installed.add(normalize(value["Name"]))
        missing = [pinned[name] for name in sorted(pinned.keys() - installed)] if sites else []
        if missing:
            raise RuntimeError("Historical environment is missing requested distributions: " + ", ".join(missing))

    def verify_borrowed(self, candidate, request):
        if self.reuse_enabled():
            with storage_reuse(self).verification_page():
                return self.verify_borrowed_source(candidate, request)
        return self.verify_borrowed_source(candidate, request)

    def verify_borrowed_source(self, candidate, request):
        for requirement in request["requirements"]:
            if "\r" in requirement or "\n" in requirement:
                raise RuntimeError("Historical reuse requires single-line dependency constraints")
        directory = pathlib.Path(candidate["directory"])
        requirements = wheel_metadata(self.owner).borrowed_requirements(request["requirements"], directory) if any("@" in value for value in request["requirements"]) else request["requirements"]
        checked_request = {**request, "requirements": requirements}
        run = pathlib.Path(candidate["runRoot"])
        released_hash = self.source_released(candidate["sourceExperimentId"], run)
        self.check_borrowed_distribution_presence(directory, requirements)
        executable = pathlib.Path(candidate["python"]).resolve(strict=True)
        if not (executable.is_relative_to(directory) or executable.is_relative_to("/usr") or executable.is_relative_to("/opt/python")):
            raise RuntimeError("Historical interpreter symlink escapes approved interpreter locations")
        rows, links = [], []
        interpreter_identity = governance_identity(executable)
        hash_source = lambda path: storage_reuse(self).hash_file(path, self._reuse_deadline) if self.reuse_enabled() and hasattr(self, "_reuse_deadline") else file_hash(path)
        interpreter = {"path": str(executable), "hash": hash_source(executable), "size": interpreter_identity[2],
            "mtimeNs": interpreter_identity[3], "ctimeNs": interpreter_identity[4]}
        if governance_identity(executable) != interpreter_identity:
            raise RuntimeError("Historical interpreter changed during verification")
        if re.search(r"(?im)^include-system-site-packages\s*=\s*true\s*$", (directory / "pyvenv.cfg").read_text()):
            raise RuntimeError("Historical environment mixes unowned system site-packages")
        for site in directory.glob("lib/python*/site-packages"):
            verify_distribution_records(directory, site, sizes_only=True)
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
                checked_hash = hash_source(path)
                if governance_identity(path) != identity:
                    raise RuntimeError("Historical environment changed during verification: " + relative_name)
                rows.append({"path": relative_name, "hash": checked_hash, "size": identity[2], "mtimeNs": identity[3], "ctimeNs": identity[4]})
                if len(rows) > self.policy["snapshotFileLimit"]:
                    raise RuntimeError("Historical environment snapshot exceeds configured file limit")
        known_hashes = {str(directory / row["path"]): row["hash"] for row in rows}
        for site in directory.glob("lib/python*/site-packages"):
            verify_distribution_records(directory, site, known_hashes)
        work = self.owner.workspace / "tmp" / ("environment-" + request["operationId"])
        self.verify_borrowed_dependencies(candidate, checked_request, work)
        probe = r'''
import importlib,importlib.metadata,json,pathlib,site,sys,sysconfig
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
        argv = self.owner.sandbox([candidate["python"], "-I", "-B", "-c", probe, json.dumps(requirements),
            json.dumps(request["modules"]), "1" if request["requireCuda"] else "0", "1" if self.config.get("devicePaths") else "0"], writable=[work], readonly=readonly, environment=directory)
        remaining = (getattr(self, "_reuse_deadline", now() + self.policy["verificationTimeoutMs"]) - now()) / 1000
        if remaining <= 0:
            raise TimeoutError("Original historical environment verification budget expired")
        result = subprocess.run(argv, capture_output=True, text=True, timeout=remaining,
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
        self.bind_registration(value, directory)
        return value

    def borrowing(self, request):
        if self.config.get("storagePreflightVersion") == 2 and request["action"] in ("create", "verify") and not request.get("recheckSource"):
            verified = storage_preflight(self).borrow_verified_source(request)
            if verified is not None:
                return verified
        if self.reuse_enabled():
            return storage_reuse(self).borrow_environment(request)
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

    def borrowing_observations(self):
        values = []
        for path in self.bindings.glob("*.json"):
            value = governance_row(path)
            if value["experimentId"] != self.experiment or value["serverId"] != self.server or value["deploymentId"] != self.config["deploymentId"]:
                raise RuntimeError("Borrowing observation belongs to another allocation")
            if governance_row(pathlib.Path(value["lease"])) != value:
                raise RuntimeError("Borrowing observation lease differs")
            values.append(value)
        return values

    def validate_borrowings(self):
        values = []
        for path in self.bindings.glob("*.json"):
            value = governance_row(path)
            self.check_registration(value, value["directory"])
            if value["serverId"] != self.server or value["experimentId"] != self.experiment or value["deploymentId"] != self.config["deploymentId"]:
                raise RuntimeError("Borrowed environment belongs to another allocation")
            if governance_row(pathlib.Path(value["lease"])) != value:
                raise RuntimeError("Borrowed environment lease differs from its publication")
            if {key: self.mount(value["directory"])[key] for key in ("directory", "filesystem", "source")} != value["volume"]:
                raise RuntimeError("Borrowed environment storage volume changed")
            self.validate_borrowed_content(value)
            values.append(value)
        return values

    def validate_borrowed_content(self, value):
        directory = pathlib.Path(value["directory"])
        observed_names = set()
        for base, dirs, names in os.walk(directory, followlinks=False):
            for name in dirs + names:
                path = pathlib.Path(base) / name
                if path.is_file() or path.is_symlink():
                    observed_names.add(path.relative_to(directory).as_posix())
        expected_names = {row["path"] for row in value["files"] + value["links"]}
        if observed_names != expected_names:
            raise RuntimeError("Borrowed environment file list changed; repeat readonly verification")
        for row in value["links"]:
            if str((directory / relative(row["path"])).resolve(strict=True)) != row["target"]:
                raise RuntimeError("Borrowed environment link changed: " + row["path"])
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

    def material(self, identifier, default=False, legacy=False):
        if not default and not legacy and identifier in self._material_views:
            return self.validate_material(copy.deepcopy(self._material_views[identifier]))
        publication = self.run / "material-publications-0.1.2" / (identifier + ".json")
        path = self.root / "materials-0.1.2" / (identifier + ".json")
        if not default and not legacy and publication.exists():
            path = publication
        elif legacy or not path.exists():
            path = self.root / "materials" / (identifier + ".json")
        row = governance_row(path)
        if row["id"] != identifier or row["serverId"] != self.server:
            raise RuntimeError("Material identity differs from its server catalog")
        if default and not legacy and not self._legacy_material_operation and (row.get("historicalSource")
                or row.get("registrationId") != self.registration_id(row["directory"])):
            directory = self.asset_root() / ("datasets" if row["kind"] == "dataset" else "models") / identifier
            row.pop("historicalSource", None); row.pop("reuseCandidateId", None)
            row.update(formatVersion="0.1.2", directory=str(directory), verifiedBytes=0, missingBytes=0, unknownBytes=row["totalBytes"],
                retainedPartialBytes=0, state="inspected", detail="Default assets are unverified; the legacy historical selection is not adopted")
            row["volume"] = {key: self.mount(directory)[key] for key in ("directory", "filesystem", "source")}
            self.bind_registration(row, directory)
            for file in row["files"]:
                file.pop("mtimeNs", None); file.pop("ctimeNs", None)
        return self.validate_material(row)

    def validate_material(self, row):
        """Validate the recorded source without changing another operation's observation."""
        self.check_registration(row, row["directory"])
        identifier = row["id"]
        reject_links(pathlib.Path(row["directory"]))
        source = row.get("historicalSource")
        if source and row.get("reuseCandidateId"):
            candidate = self.find_material_candidate(row["reuseCandidateId"])
            if candidate["directory"] != row["directory"] or candidate["sourceExperimentId"] != source["sourceExperimentId"]:
                raise RuntimeError("Material source differs from its bound candidate")
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
        observed_mount = self.mount(row["directory"])
        if any(observed_mount[key] != row["volume"][key] for key in ("directory", "filesystem", "source")):
            raise RuntimeError("Material filesystem identity changed")
        if row["verifiedBytes"] and (source or row["state"] == "ready"):
            verified = 0
            for file in row["files"]:
                try:
                    if self.file_unchanged(self.material_file_path(row, file), file):
                        verified += file["bytes"]
                except OSError:
                    continue
            if verified != row["verifiedBytes"]:
                save(self.root / "material-invalidations-0.1.1" / (identifier + "-" + str(now()) + ".json"),
                    {"version": 1, "formatVersion": "0.1.1", "serverId": self.server, "materialId": identifier,
                        "checkedAt": now(), "previousVerifiedBytes": row["verifiedBytes"], "verifiedBytes": verified})
                row.update(verifiedBytes=verified, unknownBytes=row["totalBytes"] - verified - row["missingBytes"], state="inspected", checkedAt=now(),
                    detail="Previously verified source changed; verify again before budgeting reuse")
        return row

    def candidate_material(self, material, candidate_id):
        candidate = self.find_material_candidate(candidate_id)
        self.source_released(candidate["sourceExperimentId"], pathlib.Path(candidate["runRoot"]))
        result = copy.deepcopy(material)
        result.update(formatVersion="0.1.2", directory=candidate["directory"], reuseCandidateId=candidate_id,
            historicalSource={key: candidate[key] for key in ("sourceExperimentId", "runRoot", "directory")},
            verifiedBytes=0, missingBytes=0, unknownBytes=material["totalBytes"], retainedPartialBytes=0, state="inspected",
            detail="Selected historical source is unverified; its bytes are not confirmed download requirements")
        result["volume"] = {key: self.mount(candidate["directory"])[key] for key in ("directory", "filesystem", "source")}
        self.bind_registration(result, candidate["directory"])
        for row in result["files"]:
            row.pop("mtimeNs", None); row.pop("ctimeNs", None)
        if self.reuse_enabled():
            links = storage_reuse(self).cache_files(result)
            if links:
                result["cacheFiles"] = links
        return self.validate_material(result)

    def material_file_path(self, material, row):
        path = pathlib.Path(material["directory"]) / relative(row["path"])
        if row["path"] in material.get("cacheFiles", {}):
            current = storage_reuse(self).cache_files(material)
            if current != material["cacheFiles"]:
                raise RuntimeError("Historical cache links changed after source selection")
            return pathlib.Path(current[row["path"]])
        return path

    def historical_material(self, files, candidate_id=None):
        if candidate_id:
            candidate = self.find_material_candidate(candidate_id)
            self.source_released(candidate["sourceExperimentId"], pathlib.Path(candidate["runRoot"]))
            return {"source": {key: candidate[key] for key in ("sourceExperimentId", "runRoot", "directory")}, "files": files}
        progress = self.root / "scan.v1.json"
        if not progress.exists():
            return None
        scanned = governance_row(progress)
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
                    if not target.is_file() or target.stat().st_size != row["bytes"]:
                        break
                    observed.append(row)
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
        program = """import sys,urllib.request
with urllib.request.urlopen(sys.argv[1],timeout=float(sys.argv[3])) as response:
    data=response.read(int(sys.argv[2])+1)
    if len(data)>int(sys.argv[2]): raise RuntimeError('Provider metadata exceeds configured size limit')
    sys.stdout.buffer.write(data)
"""
        timeout = self.policy["metadataProbeTimeoutMs"] / 1000
        environment = {key: value for key, value in os.environ.items() if not re.search(r"KEY|SECRET|TOKEN|PASSWORD", key, re.I)}
        try:
            result = subprocess.run([sys.executable, "-I", "-c", program, self.url(url), str(self.policy["metadataBytes"]), str(timeout)],
                capture_output=True, timeout=timeout, env=environment)
        except subprocess.TimeoutExpired as error:
            raise TimeoutError("Node canonical metadata probe exceeded its original " + str(self.policy["metadataProbeTimeoutMs"]) + " ms deadline") from error
        if result.returncode != 0:
            raise OSError("Node canonical metadata request failed: " + result.stderr.decode(errors="replace")[-4096:])
        return json.loads(result.stdout)

    @staticmethod
    def metadata_request_id(request):
        identity = {key: request[key] for key in ("kind", "provider", "repository", "revision")}
        if "files" in request:
            identity["files"] = sorted(set(request["files"]))
        return digest(identity)

    def inspect_material(self, request, canonical=None):
        revision = request["revision"]
        if not re.fullmatch(r"[a-f0-9]{40}", revision):
            raise RuntimeError("An immutable 40-character provider revision is required")
        repository = request["repository"]
        if not re.fullmatch(r"[\w.-]+/[\w.-]+", repository):
            raise RuntimeError("Material repository identity is invalid")
        kind = request["kind"]
        if request["provider"] == "modelscope" and kind != "dataset":
            raise RuntimeError("ModelScope model immutable commit attestation is unavailable; official Git inspection supports datasets and model mirrors require a canonical Hugging Face manifest")
        prefix = "datasets/" if kind == "dataset" else ""
        identifier = self.metadata_request_id(request)
        metadata_path = self.run / "material-metadata-v1" / (identifier + ".json")
        legacy_path = self.run / "material-metadata-v1" / (digest(request) + ".json")
        if not metadata_path.exists() and legacy_path.exists():
            metadata_path, identifier = legacy_path, legacy_path.stem
        self.bind_context("material-request", identifier)
        saved = governance_row(metadata_path) if metadata_path.exists() else None
        if saved and saved["request"] != request:
            if self.metadata_request_id(saved["request"]) != self.metadata_request_id(request):
                raise RuntimeError("Canonical request identity differs")
            history = saved.get("sourceHistory", []) + [{"checkedAt": now(), "request": saved["request"], "detail": saved.get("detail", "")}]
            saved.update(request=request, requestId=identifier, sourceHistory=history, checkedAt=now())
            if request.get("metadataSource") in ("host", "auto") or "metadataSource" not in request:
                saved["hostAfter"] = now()
            save(metadata_path, saved)
        if canonical is None and saved is None:
            for cached_path in (self.root / "canonical-manifests").glob("*.json"):
                cached = governance_row(cached_path)
                if all(cached["request"].get(key) == request.get(key) for key in ("kind", "provider", "repository", "revision")):
                    canonical = cached["document"]
                    break
        if canonical is None and metadata_path.exists():
            if saved.get("materialId"):
                canonical = governance_row(self.root / "canonical-manifests" / (saved["materialId"] + ".json"))["document"]
            else:
                state = "metadata-blocked" if saved.get("deadline", now() + 1) <= now() or request.get("metadataSource") in ("node", "cache") else "metadata-pending"
                return {"state": state, "requestId": identifier, "detail": saved["detail"], **({"deadline": saved["deadline"]} if "deadline" in saved else {})}
        if canonical is not None and saved and saved["state"] == "pending" and saved.get("deadline", now() + 1) <= now():
            raise RuntimeError("Original canonical metadata request deadline expired; its history is retained")
        if saved is None:
            saved = {"version": 1, "formatVersion": "0.1.1", "experimentId": self.experiment, "serverId": self.server, "request": request,
                "state": "pending", "requestId": identifier, "checkedAt": now(), "deadline": now() + self.policy["metadataWaitTimeoutMs"],
                "hostAfter": now() + self.policy["metadataProbeTimeoutMs"], "detail": "Canonical metadata request registered before network access"}
            save(metadata_path, saved)
        if canonical is None and (request.get("metadataSource") in ("host", "cache") or request["provider"] == "modelscope"):
            saved.update(hostAfter=now(), detail="Waiting for local Host canonical metadata" if request.get("metadataSource") == "host" else "No trusted metadata is cached for this fixed request")
            if request["provider"] == "modelscope" and request.get("metadataSource") != "cache":
                saved["detail"] = "Waiting for local Host verification of the official ModelScope Git commit and file tree"
                if request.get("metadataSource") == "node":
                    saved["detail"] = "Official ModelScope Git attestation is available through the local Host; request metadataSource=host or auto"
            save(metadata_path, saved)
            return {"state": "metadata-pending" if request.get("metadataSource") not in ("cache", "node") else "metadata-blocked", "requestId": identifier, "detail": saved["detail"], "deadline": saved["deadline"]}
        try:
            document = canonical if canonical is not None else self.metadata("https://huggingface.co/api/" + ("datasets/" if kind == "dataset" else "models/")
                + repository + "/revision/" + revision + "?blobs=true")
        except (OSError, urllib.error.URLError, TimeoutError) as error:
            saved.update(hostAfter=now(), checkedAt=now(), lastNodeError=str(error), detail="Node canonical metadata request failed; only this source attempt is confirmed: " + str(error))
            save(metadata_path, saved)
            return {"state": "metadata-blocked" if request.get("metadataSource") == "node" else "metadata-pending", "requestId": identifier, "detail": saved["detail"], "deadline": saved["deadline"]}
        if document.get("sha") != revision or document.get("id", document.get("modelId")) != repository:
            raise RuntimeError("Canonical provider did not attest the requested repository and fixed revision")
        if request["provider"] == "modelscope" and document.get("source") != {"provider": "modelscope", "method": "git-commit-tree-v1"}:
            raise RuntimeError("ModelScope dataset requires official Git commit and tree attestation, not a mirror revision parameter")
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
            base = request.get("mirror") or ("https://modelscope.cn" if request["provider"] == "modelscope" else "https://huggingface.co")
            self.url(base)
            host = urllib.parse.urlparse(base).hostname
            url = base.rstrip("/") + "/" + prefix + repository + "/resolve/" + revision + "/" + urllib.parse.quote(name, safe="/")
            if host == "modelscope.cn":
                url = base.rstrip("/") + "/api/v1/" + ("datasets/" if kind == "dataset" else "models/") + repository + "/repo?Revision=" + (revision if request["provider"] == "modelscope" else "master") + "&FilePath=" + urllib.parse.quote(name, safe="")
            files.append({"path": name, "bytes": size, "hash": checksum, "algorithm": algorithm, "url": url})
        if not files or wanted is not None and set(wanted) != {row["path"] for row in files}:
            raise RuntimeError("Fixed revision file selection is incomplete or empty")
        if len(files) > self.policy["materialFileLimit"]:
            raise RuntimeError("Material manifest exceeds configured file count")
        files.sort(key=lambda row: row["path"])
        identifier = digest({"kind": kind, "repository": repository, "revision": revision,
            "files": [{key: value for key, value in row.items() if key != "url"} for row in files]})
        directory = self.asset_root() / ("datasets" if kind == "dataset" else "models") / identifier
        original_path = self.root / "materials-0.1.2" / (identifier + ".json")
        original = self.material(identifier, default=True) if original_path.exists() else None
        if original is not None:
            directory = pathlib.Path(original["directory"])
        if original and original.get("registrationId") != self.registration_id(directory):
            original = None
        ready = original and original["state"] == "ready"
        verified, retained, unknown = 0, 0, 0
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
            if path.is_file() and self.file_unchanged(path, proof):
                verified += row["bytes"]
                identity = governance_identity(path); row.update(mtimeNs=identity[3], ctimeNs=identity[4])
            elif self.file_object(row) is not None:
                verified += row["bytes"]
            elif path.exists():
                unknown += row["bytes"]; ready = False
            elif partial.exists() and partial.stat().st_size < row["bytes"]:
                reject_links(partial); retained += partial.stat().st_size
        total = sum(row["bytes"] for row in files)
        result = {"version": 1, "id": identifier, "serverId": self.server, "kind": kind, "provider": "huggingface",
            "repository": repository, "revision": revision, "files": files, "directory": str(directory),
            "totalBytes": total, "missingBytes": total - verified - retained - unknown, "verifiedBytes": verified, "unknownBytes": unknown, "retainedPartialBytes": retained,
            "checkedAt": now(), "state": "ready" if ready else "inspected"}
        result["volume"] = {key: self.mount(directory)[key] for key in ("directory", "filesystem", "source")}
        self.bind_registration(result, directory)
        result["formatVersion"] = "0.1.2"
        result["detail"] = "Observation of the default asset location; other historical candidates are not evaluated"
        canonical_path = self.root / "canonical-manifests" / (identifier + ".json")
        if not canonical_path.exists():
            save(canonical_path, {"version": 1, "request": {key: value for key, value in request.items() if key != "reuseCandidateId"}, "document": document})
        identity = {key: result[key] for key in ("id", "serverId", "kind", "provider", "repository", "revision", "totalBytes")}
        identity.update(version=1, formatVersion="0.1.2", files=[{key: row[key] for key in ("path", "bytes", "hash", "algorithm")} for row in files])
        identity_path = self.root / "material-identities-0.1.2" / (identifier + ".json")
        if identity_path.exists() and governance_row(identity_path) != identity:
            raise RuntimeError("Canonical material identity changed")
        save(identity_path, identity)
        save(original_path, result)
        if request.get("reuseCandidateId"):
            result = self.candidate_material(result, request["reuseCandidateId"])
        save(metadata_path, {**saved, "state": "resolved", "materialId": identifier, "checkedAt": now()})
        return result

    def pending_metadata(self):
        result = []
        for path in (self.run / "material-metadata-v1").glob("*.json"):
            row = governance_row(path)
            if row["experimentId"] != self.experiment or row["serverId"] != self.server:
                raise RuntimeError("Material metadata request belongs to another experiment")
            if row["state"] == "pending" and row.get("hostAfter", 0) <= now() < row.get("deadline", now() + 1) and row["request"].get("metadataSource") not in ("node", "cache"):
                result.append({"requestId": path.stem, "request": row["request"], **({"deadline": row["deadline"]} if "deadline" in row else {})})
        return result

    def metadata_error(self, identifier, detail):
        if not re.fullmatch(r"[a-f0-9]{64}", identifier):
            raise RuntimeError("Canonical request identity is invalid")
        path = self.run / "material-metadata-v1" / (identifier + ".json")
        value = governance_row(path)
        if value["experimentId"] != self.experiment or value["serverId"] != self.server or identifier not in (
                value.get("requestId", self.metadata_request_id(value["request"])), digest(value["request"])):
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

    def verify_material_files(self, material, folder, value, deadline):
        source = material.get("historicalSource")
        released = self.source_released(source["sourceExperimentId"], pathlib.Path(source["runRoot"])) if source else None
        root = pathlib.Path(material["directory"])
        results = [{"path": row["path"], "bytes": row["bytes"], "state": "unverified"} for row in material["files"]]
        value.update(state="running", stage="verifying", processState="running", verifiedFiles=0, verifiedBytes=0, fileResults=results, updatedAt=now())
        save(folder / "process.v1.json", self.process_identity())
        try:
            for row, result in zip(material["files"], results):
                if now() >= deadline:
                    raise TimeoutError("Original material verification budget expired")
                self.validate_material(material)
                path = self.material_file_path(material, row)
                if not path.exists() and not source:
                    retained = root.parent / (".partial-" + material["id"]) / relative(row["path"])
                    path = retained if retained.exists() else retained.with_name(retained.name + ".part")
                    if not path.exists() and self.reuse_enabled():
                        shared = self.file_object(row)
                        if shared is not None:
                            path = shared
                reject_links(path)
                try:
                    identity = governance_identity(path)
                    if not path.is_file() or identity[2] != row["bytes"]:
                        result.update(state="mismatch", detail="File size or type differs from the canonical manifest")
                        continue
                    checkpoint = folder / "verified-files-0.1.2" / (digest(row["path"]) + ".json")
                    shared_checkpoint = self.root / "reuse-material-proofs-v1" / (digest([self.server, str(path), identity,
                        self.registration_id(path), row["hash"], row["algorithm"]]) + ".json")
                    previous = governance_row(checkpoint) if checkpoint.exists() else governance_row(shared_checkpoint) if self.reuse_enabled() and shared_checkpoint.exists() else None
                    if not previous or previous["identity"] != identity or previous["hash"] != row["hash"] or previous["algorithm"] != row["algorithm"] or previous["path"] != str(path):
                        hasher = hashlib.new("sha256" if row["algorithm"] == "sha256" else "sha1")
                        if row["algorithm"] == "git-sha1":
                            hasher.update(("blob " + str(row["bytes"]) + "\0").encode())
                        with open(path, "rb") as handle:
                            while True:
                                if now() >= deadline:
                                    raise TimeoutError("Original material verification budget expired")
                                chunk = handle.read(self.policy["transferChunkBytes"])
                                if not chunk:
                                    break
                                hasher.update(chunk)
                                if now() - value["updatedAt"] >= self.owner.policy["operationPollIntervalMs"]:
                                    value["updatedAt"] = now(); save(folder / "receipt.v1.json", value)
                        if governance_identity(path) != identity:
                            raise RuntimeError("Material source identity changed during verification: " + row["path"])
                        if hasher.hexdigest() != row["hash"]:
                            result.update(state="mismatch", detail="Canonical digest differs")
                            continue
                        proof = {"version": 1, "formatVersion": "0.1.2", "serverId": self.server, "experimentId": self.experiment,
                            "materialId": material["id"], "path": str(path), "identity": identity, "hash": row["hash"], "algorithm": row["algorithm"]}
                        save(checkpoint, proof)
                        if self.reuse_enabled():
                            save(shared_checkpoint, proof)
                    row.update(mtimeNs=identity[3], ctimeNs=identity[4])
                    result["state"] = "verified"
                    value["verifiedFiles"] += 1; value["verifiedBytes"] += row["bytes"]
                except FileNotFoundError:
                    result.update(state="missing", detail="Canonical file is absent at the selected source")
                except PermissionError:
                    result.update(state="unreadable", detail="Selected file cannot be read")
                finally:
                    value["updatedAt"] = now(); save(folder / "receipt.v1.json", value)
                    if getattr(self, "_reuse_progress", None):
                        save(self._reuse_progress, value)
            if source and self.source_released(source["sourceExperimentId"], pathlib.Path(source["runRoot"])) != released:
                raise RuntimeError("Historical source release changed during verification")
        finally:
            material.update(verifiedBytes=value["verifiedBytes"],
                missingBytes=sum(row["bytes"] for row in results if row["state"] in ("missing", "mismatch")),
                unknownBytes=sum(row["bytes"] for row in results if row["state"] in ("unreadable", "unverified")), checkedAt=now())
            value.update(material=material, verificationComplete=all(row["state"] not in ("unreadable", "unverified") for row in results))
            save(folder / "receipt.v1.json", value)
        return material

    def file_object(self, row):
        path = self.root / "file-objects" / (digest([row["algorithm"], row["hash"], row["bytes"]]) + ".json")
        if not path.exists():
            return None
        value = governance_row(path)
        if value["version"] != 1 or value["serverId"] != self.server or any(value[key] != row[key] for key in ("algorithm", "hash", "bytes")):
            raise RuntimeError("Shared file object identity differs")
        if value.get("registrationId") != self.registration_id(value["path"]):
            return None
        origin = self.material(value["materialId"], default=True)
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
        self.bind_registration(value, path)
        save(self.root / "file-objects" / (digest([row["algorithm"], row["hash"], row["bytes"]]) + ".json"), value)

    def file_unchanged(self, path, row):
        if not row or "mtimeNs" not in row or "ctimeNs" not in row:
            return False
        reject_links(path)
        identity = governance_identity(path)
        if identity[2:] == [row["bytes"], row["mtimeNs"], row["ctimeNs"]]:
            return True
        if identity[2:4] != [row["bytes"], row["mtimeNs"]]:
            return False
        proof_path = self.root / "file-objects" / (digest([row["algorithm"], row["hash"], row["bytes"]]) + ".json")
        if not proof_path.exists():
            return False
        proof = governance_row(proof_path)
        if proof.get("registrationId") != self.registration_id(path):
            return False
        if proof["serverId"] != self.server or any(proof[key] != row[key] for key in ("algorithm", "hash", "bytes")):
            raise RuntimeError("Shared material link proof differs from canonical content")
        linked = pathlib.Path(proof["path"])
        reject_links(linked)
        return linked.exists() and governance_identity(linked) == identity and identity[3:] == [proof["mtimeNs"], proof["ctimeNs"]]

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
                shared = self.file_object(row)
                if shared is not None and capacity_identity(self, shared.parent) == capacity_identity(self, directory):
                    needed = 0
                choice = self._copy_sources.get(identifier)
                if choice:
                    proof = next((item for item in choice["files"] if item["path"] == row["path"]), None)
                    source = self.material_file_path(choice["material"], row)
                    if proof and proof["state"] == "verified" and capacity_identity(self, source.parent) == capacity_identity(self, directory):
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

    def material_coverage(self, request):
        scope = request.get("assessmentScope", "declared")
        requirements = request.get("materialRequirements")
        unresolved, covered = [], []
        if requirements is not None:
            record = {"version": 1, "formatVersion": "0.1.1", "experimentId": self.experiment, "serverId": self.server,
                "requirements": requirements, "checkedAt": now()}
            save(self.run / "material-requirements-0.1.1" / (str(requirements["planRevision"]) + "-" + digest(requirements) + ".json"), record)
        if scope == "experiment":
            if not requirements or not requirements["complete"]:
                unresolved.append("The Agent has not registered a complete fixed-material requirement set for the current plan")
            for expected in (requirements or {}).get("materials", []):
                identifier = expected.get("materialId")
                if not identifier or identifier not in request["materialIds"]:
                    unresolved.append(expected["kind"] + ":" + expected["repository"] + "@" + expected["revision"] + ": no bound canonical material")
                    continue
                material = self.material(identifier)
                canonical = governance_row(self.root / "canonical-manifests" / (identifier + ".json"))
                names = {row["path"] for row in material["files"]}
                wanted = set(expected.get("files", [row["rfilename"] for row in canonical["document"]["siblings"]]))
                if any(material[key] != expected[key] for key in ("kind", "repository", "revision")) or names != wanted:
                    unresolved.append(identifier + ": material does not cover the registered fixed file set")
                elif material.get("historicalSource") and material["verifiedBytes"] != material["totalBytes"]:
                    unresolved.append(identifier + ": historical reuse has not passed canonical content verification")
                else:
                    covered.append(identifier)
        else:
            covered = list(request["materialIds"])
            for identifier in request["materialIds"]:
                material = self.material(identifier)
                if material.get("historicalSource") and material["verifiedBytes"] != material["totalBytes"]:
                    unresolved.append(identifier + ": historical reuse is unverified; its full size is not a confirmed additional download requirement")
        return {"scope": scope, "complete": scope == "experiment" and not unresolved,
            "coveredMaterialIds": covered, "unresolved": unresolved,
            **({"planRevision": requirements["planRevision"]} if requirements else {})}

    def resolve_material_sources(self, request):
        result = {}
        for choice in request.get("materialSources", []):
            identifier = choice["materialId"]
            if identifier not in request["materialIds"] or identifier in result:
                raise RuntimeError("Material sources must select one receipt per declared material")
            operation = choice["verificationOperationId"]
            value = self.material_operation(operation)
            if value.get("action") != "verify" or value["materialId"] != identifier or not value["exitConfirmed"]:
                raise RuntimeError("Material source requires an exited verification of the declared material")
            context_path = self.run / "operation-contexts-0.1.1/material-operation" / (operation + ".json")
            if self.config.get("evidenceContext"):
                context = governance_row(context_path)
                if context.get("planRevision") != self.config["evidenceContext"]["planRevision"] or context.get("experimentId") != self.experiment or context.get("serverId") != self.server:
                    raise RuntimeError("Material source verification belongs to another plan, experiment or node")
            if value.get("formatVersion") != "0.1.2" or "material" not in value or "fileResults" not in value:
                raise RuntimeError("Legacy verification has no independent source evidence; verify the explicit candidate")
            original = self.operation_source(self.run / "material-operations-v1" / operation, value)
            material = self.validate_material(copy.deepcopy(value["material"]))
            if material["directory"] != original["directory"] or material["volume"] != original["volume"]:
                raise RuntimeError("Verification result differs from its bound source")
            if material.get("historicalSource"):
                self.source_released(material["historicalSource"]["sourceExperimentId"], pathlib.Path(material["historicalSource"]["runRoot"]))
            files = []
            if len(material["files"]) != len(value["fileResults"]):
                raise RuntimeError("Verification file results do not cover the canonical manifest")
            for row, recorded in zip(material["files"], value["fileResults"]):
                item = dict(recorded)
                if item["path"] != row["path"]:
                    raise RuntimeError("Verification file results differ from the canonical manifest")
                if item["state"] == "verified" and not self.verified_file_current(material, row):
                    item["state"] = "unverified"
                files.append(item)
            material.update(verifiedBytes=sum(row["bytes"] for row in files if row["state"] == "verified"),
                missingBytes=sum(row["bytes"] for row in files if row["state"] in ("missing", "mismatch")),
                unknownBytes=sum(row["bytes"] for row in files if row["state"] in ("unreadable", "unverified")))
            result[identifier] = {**choice, "material": material, "files": files, "sourceHash": value["sourceHash"]}
        return result

    def assess(self, request):
        self._preflight_unresolved = []
        if self.config.get("storagePreflightVersion") == 2:
            request, self._preflight_unresolved = storage_preflight(self).assessment(request)
        if self.reuse_enabled():
            request = storage_reuse(self).assessment_request(request)
        previous_views, previous_copies = self._material_views, self._copy_sources
        choices = self.resolve_material_sources(request)
        self._material_views = {identifier: self.material(identifier, default=True) for identifier in request["materialIds"]}
        self._material_views.update({identifier: value["material"] for identifier, value in choices.items() if value["mode"] == "readonly"})
        self._copy_sources = {identifier: value for identifier, value in choices.items() if value["mode"] == "copy"}
        try:
            return self.assess_sources(request, choices)
        finally:
            self._material_views, self._copy_sources = previous_views, previous_copies

    def assess_sources(self, request, choices):
        self.bind_context("storage-plan", request["operationId"])
        if request.get("materialRequirements") and self.config.get("evidenceContext") and request["materialRequirements"]["planRevision"] != self.config["evidenceContext"]["planRevision"]:
            raise RuntimeError("Material requirement set does not belong to the current approved plan")
        signature = digest(request)
        previous = self.run / "storage-plans-v1" / (request["operationId"] + ".json")
        if previous.exists() and governance_row(previous)["requestHash"] != signature:
            raise RuntimeError("Storage assessment operation is bound to different requirements")
        coverage = self.material_coverage(request)
        coverage["unresolved"].extend(getattr(self, "_preflight_unresolved", []))
        if getattr(self, "_preflight_unresolved", []):
            coverage["complete"] = False
        if self.reuse_enabled() and getattr(self, "_reuse_unresolved", None):
            coverage["unresolved"].extend(self._reuse_unresolved)
            coverage["complete"] = False
        estimates = []
        for identifier in request["materialIds"]:
            choice = choices.get(identifier)
            material = choice["material"] if choice else self.material(identifier)
            unknown = material.get("unknownBytes", 0)
            if unknown or choice and choice["mode"] == "readonly" and material["verifiedBytes"] != material["totalBytes"]:
                coverage["unresolved"].append(identifier + ": selected source is incomplete for " + (choice["mode"] if choice else "default-assets"))
                coverage["complete"] = False
            estimates.append({"materialId": identifier, "mode": choice["mode"] if choice else "default-assets",
                "totalBytes": material["totalBytes"], "verifiedReusableBytes": material["verifiedBytes"],
                "confirmedMissingBytes": material["missingBytes"], "unknownBytes": unknown,
                "newPeakBytes": None if unknown else sum(row["remainingBytes"] for row in self.content_reservations([identifier]))})
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
        satisfied = self.environment_satisfies(request)
        estimate = 0 if satisfied or not request["requirements"] else None
        if estimate is None and self.config.get("storagePreflightVersion") == 2:
            estimate = storage_preflight(self).environment_estimate(request)
        if estimate is None and request.get("allowEnvironmentFallback") and not self.reuse_enabled() and not self.config.get("action", "").startswith("history-"):
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
            if all(row["shortfallBytes"] == 0 for row in budgets.values()) and not (self.config.get("storagePreflightVersion") == 2 and request.get("mode", "preview") == "preview"):
                reason = "Verified reuse and declared estimates do not fit data storage; the system filesystem fits the remaining training environment peak and reserve"
                install_environment_arrangement(self, math.ceil(estimate * factor), reason)
                fallback_assessment["applied"] = True
            else:
                environment_volume["environmentBytes"] = estimate
                system["environmentBytes"] = previous_estimate
                for row in budgets.values():
                    finalize(row)
        pending = bool(coverage["unresolved"])
        sufficient = True
        for row in budgets.values():
            pending |= row["requiredBytes"] is None
            sufficient &= row["requiredBytes"] is not None and row["availableBytes"] >= row["requiredBytes"] + row["reservedBytes"]
        state = "requirements-pending" if pending else "ready" if sufficient else "insufficient"
        result = {"version": 1, "formatVersion": "0.1.2", "coverage": coverage, "materialEstimates": estimates, "peakSafetyFactor": factor, "experimentId": self.experiment, "serverId": self.server, "operationId": request["operationId"],
            "requestHash": signature, "checkedAt": now(), "state": state, "environmentId": request["environmentId"],
            "declaredOutputBytes": request["outputBytes"], "declaredCheckpointBytes": request["checkpointBytes"],
            "requirements": request["requirements"], "materialIds": request["materialIds"], "volumes": list(budgets.values()),
            "detail": ("Capacity verified for the declared scope only; this does not establish whole-experiment material readiness" if coverage["scope"] == "declared" else "Capacity verified for the registered fixed-material requirement set") if state == "ready" else "; ".join(coverage["unresolved"]) or "Resolve or reuse the environment before final capacity acceptance" if pending
                else "Insufficient capacity on a target volume; inspect owned historical cleanup candidates before installing or downloading"}
        for key in ("environmentEstimate", "allowEnvironmentFallback", "assessmentScope", "materialRequirements", "materialSources"):
            if key in request:
                result[key] = request[key]
        if self.reuse_enabled():
            result["reuse"] = {"state": "verified" if not coverage["unresolved"] and estimate is not None else "incomplete",
                "complete": not coverage["unresolved"] and estimate is not None, "checkedAt": now(), "diagnostics": coverage["unresolved"]}
        if fallback_assessment is not None:
            result["fallbackAssessment"] = fallback_assessment
        save(previous, result)
        modern = self.config.get("storagePreflightVersion") == 2
        if modern:
            result["mode"] = request.get("mode", "preview")
            if "policyRevision" in request:
                result["policyRevision"] = request["policyRevision"]
            result["capacityBasis"] = "estimated" if estimate and request.get("environmentEstimate") else "verified" if estimate is not None else "unknown"
            save(previous, result)
        if not modern or request.get("mode", "preview") == "commit":
            save(self.run / "storage-plan.v1.json", result)
        else:
            save(self.run / "storage-trial.v1.json", result)
        if state == "ready" and (not modern or request.get("mode", "preview") == "commit"):
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
        previous_views, previous_copies = self._material_views, self._copy_sources
        choices = self.resolve_material_sources(plan)
        self._material_views = {identifier: self.material(identifier, default=True) for identifier in plan["materialIds"]}
        self._material_views.update({identifier: value["material"] for identifier, value in choices.items() if value["mode"] == "readonly"})
        self._copy_sources = {identifier: value for identifier, value in choices.items() if value["mode"] == "copy"}
        try:
            materials = self.content_reservations(plan["materialIds"])
        finally:
            self._material_views, self._copy_sources = previous_views, previous_copies
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
        if not plan_path.exists() and self.config.get("storagePreflightVersion") == 2:
            plan_path = self.run / "storage-trial.v1.json"
        if plan_path.exists():
            plan = governance_row(plan_path)
            if self.reuse_enabled():
                key = digest([self.config.get("evidenceContext", {}), plan["environmentId"]])
                registered_path = self.run / "storage-reuse-requirements-v1" / (key + ".json")
                if registered_path.exists():
                    registered = governance_row(registered_path)
                    if registered.get("experimentId") != self.experiment or registered.get("serverId") != self.server:
                        raise RuntimeError("Installation material requirements belong to another experiment or node")
                    if not set(registered["materialIds"]).issubset(plan["materialIds"]):
                        raise RuntimeError("Installation budget omits previously registered fixed materials; reassess the complete requirement set")
            for row in plan["volumes"]:
                if row.get("device", capacity_identity(self, row["directory"])["device"]) == capacity_identity(self, self.owner.workspace)["device"]:
                    extras += row["outputBytes"] + row["checkpointBytes"]
            choices = self.resolve_material_sources(plan)
            if any(value["material"].get("unknownBytes", 0) for value in choices.values()):
                raise RuntimeError("Installation material budget requires renewed source verification")
            previous_views, previous_copies = self._material_views, self._copy_sources
            self._material_views = {identifier: self.material(identifier, default=True) for identifier in plan["materialIds"]}
            self._material_views.update({identifier: value["material"] for identifier, value in choices.items() if value["mode"] == "readonly"})
            self._copy_sources = {identifier: value for identifier, value in choices.items() if value["mode"] == "copy"}
            try:
                extras += sum(item["remainingBytes"] for item in self.content_reservations(plan["materialIds"])
                    if capacity_identity(self, item["directory"])["device"] == capacity_identity(self, self.owner.workspace)["device"])
            finally:
                self._material_views, self._copy_sources = previous_views, previous_copies
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

    def admitted_plan(self):
        path = self.run / "storage-plan.v1.json"
        if not path.exists():
            if self.config.get("storagePreflightVersion") == 2 and (self.run / "storage-trial.v1.json").exists():
                raise RuntimeError("Training command requires a committed capacity plan; the saved preview does not authorize execution")
            return None
        saved = governance_row(path)
        request = {key: saved[key] for key in ("operationId", "materialIds", "environmentId", "requirements")}
        request.update({key: saved[key] for key in ("environmentEstimate", "allowEnvironmentFallback", "assessmentScope", "materialRequirements", "materialSources", "mode", "policyRevision") if key in saved})
        request.update(outputBytes=saved.get("declaredOutputBytes", sum(row["outputBytes"] for row in saved["volumes"])), checkpointBytes=saved.get("declaredCheckpointBytes", sum(row["checkpointBytes"] for row in saved["volumes"])))
        plan = self.assess(request)
        if plan["state"] != "ready" or plan.get("coverage", {}).get("complete") is False:
            raise RuntimeError("Training command capacity is not verified: " + plan["detail"])
        for identifier in plan["materialIds"]:
            if not (self.material_bindings / (identifier + ".json")).exists() or self.material(identifier)["state"] != "ready":
                raise RuntimeError("Declared model/data material is not published for this experiment: " + identifier)
        return plan

    def reserve_command(self, command):
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", command):
            raise RuntimeError("Command capacity identity is invalid")
        plan = self.admitted_plan()
        if plan is None:
            return {"reserved": False, "detail": "No training storage assessment has been submitted"}
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
        if self.config.get("storagePreflightVersion") == 2 and plan.get("mode") != "commit":
            raise RuntimeError("Capacity budget is only a preview; commit a budget under the approved policy before acquiring materials")
        if plan["experimentId"] != self.experiment or plan["serverId"] != self.server or material["id"] not in plan["materialIds"]:
            raise RuntimeError("Material acquisition is not bound to this experiment's capacity plan")
        request = {"operationId": plan["operationId"], "materialIds": plan["materialIds"], "environmentId": plan["environmentId"],
            "requirements": plan["requirements"], "outputBytes": plan.get("declaredOutputBytes", sum(row["outputBytes"] for row in plan["volumes"])),
            "checkpointBytes": plan.get("declaredCheckpointBytes", sum(row["checkpointBytes"] for row in plan["volumes"]))}
        request.update({key: plan[key] for key in ("environmentEstimate", "allowEnvironmentFallback", "assessmentScope", "materialRequirements", "materialSources", "mode", "policyRevision") if key in plan})
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
        if value["state"] == "completed" and value.get("action") == "verify":
            if "material" not in value:
                return {**value, "state": "blocked", "detail": "Legacy verification has no recorded source; explicitly verify a candidate before reuse"}
            material = self.validate_material(copy.deepcopy(value["material"]))
            if "verificationStatus" in value:
                results = {row["path"]: row["state"] for row in value.get("fileResults", [])}
                verified_files = [row for row in value["material"]["files"] if results.get(row["path"]) == "verified"]
                if sum(row["bytes"] for row in verified_files) != value["material"]["verifiedBytes"]:
                    return {**value, "state": "blocked", "detail": "Verification receipt lacks matching per-file evidence; repeat readonly verification"}
                changed = [row["path"] for row in verified_files if not self.verified_file_current(material, row)]
                if changed:
                    return {**value, "state": "blocked", "material": material,
                        "detail": "Verified source changed after this operation; original verification history is retained: " + ", ".join(changed)}
                return value
            if value.get("formatVersion") == "0.1.2":
                verified = sum(row["bytes"] for row in material["files"] if self.verified_file_current(material, row))
                material.update(verifiedBytes=verified, unknownBytes=material["totalBytes"] - verified - material["missingBytes"])
            if material["verifiedBytes"] != material["totalBytes"]:
                return {**value, "state": "blocked", "material": material, "detail": "Verified source changed after this operation; original verification history is retained"}
        return value

    def verified_file_current(self, material, row):
        path = self.material_file_path(material, row)
        if not material.get("historicalSource") and not path.exists():
            retained = pathlib.Path(material["directory"]).parent / (".partial-" + material["id"]) / relative(row["path"])
            path = retained if retained.exists() else retained.with_name(retained.name + ".part")
            if not path.exists() and self.reuse_enabled():
                shared = self.file_object(row)
                if shared is not None:
                    path = shared
        try:
            return self.file_unchanged(path, row)
        except (FileNotFoundError, PermissionError):
            return False

    @staticmethod
    def process_identity():
        return {"version": 1, "pid": os.getpid(), "hostBootId": pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "startTime": pathlib.Path("/proc/self/stat").read_text().split(") ", 1)[1].split()[19]}

    def register_material(self, request):
        operation = request["operationId"]
        self.bind_context("material-operation", operation)
        folder = self.run / "material-operations-v1" / operation
        original = folder / "request.v1.json"
        signature = digest({key: value for key, value in request.items() if key != "action"})
        if original.exists():
            saved_request = governance_row(original)
            if saved_request["requestHash"] != signature or request["action"] != "recover" and saved_request["request"]["action"] != request["action"]:
                raise RuntimeError("Material operation identity is bound to different content")
            value = self.material_operation(operation)
            if request["action"] == "recover" and value["state"] == "blocked":
                self.assert_material_exited(operation, value)
                save(folder / ("receipt-" + str(value["updatedAt"]) + "-" + uuid.uuid4().hex + ".v1.json"), value)
                value.update(state="requested", commandId=self.config["materialCommandId"], exitConfirmed=False, admissionReleased=False,
                    processState="unknown", updatedAt=now())
                save(folder / "receipt.v1.json", value)
            return value
        if request["action"] == "recover":
            raise RuntimeError("Original material request is missing; recovery cannot submit a new acquisition")
        self.check_material_duplicate(request)
        material = self.material(request["materialId"], default=True)
        if request["action"] == "verify" and request.get("reuseCandidateId"):
            material = self.candidate_material(material, request["reuseCandidateId"])
        if request["action"] == "acquire":
            plan = governance_row(self.run / "storage-plans-v1" / (request["budgetId"] + ".json"))
            choices = self.resolve_material_sources(plan)
            choice = choices.get(request["materialId"])
            if request.get("reuseCandidateId") and (not choice or choice["material"].get("reuseCandidateId") != request["reuseCandidateId"]):
                raise RuntimeError("Acquisition candidate differs from the source fixed by its capacity plan")
            if choice and choice["mode"] == "readonly":
                material = choice["material"]
        source_record = {"version": 1, "formatVersion": "0.1.2", "experimentId": self.experiment, "serverId": self.server,
            "operationId": operation, "material": material}
        value = {"version": 1, "formatVersion": "0.1.2", "experimentId": self.experiment, "serverId": self.server, "operationId": operation,
            "action": request["action"],
            "materialId": request["materialId"], "requestHash": signature, "commandId": self.config.get("materialCommandId", "material-" + operation),
            "state": "requested", "stage": "checking", "startedAt": now(), "deadline": self.config.get("deadline", now() + self.policy["materialTimeoutMs"]),
            "updatedAt": now(), "downloadedBytes": 0, "reusedBytes": 0, "exitConfirmed": False, "admissionReleased": False,
            "sourceHash": digest(source_record)}
        save(original, {"version": 1, "requestHash": signature, "request": request,
            **({"reuseVerificationVersion": 1} if self.reuse_enabled() and request["action"] == "verify" and not request.get("reuseCandidateId") else {})})
        save(folder / "source-0.1.2.json", source_record)
        save(folder / "receipt.v1.json", value)
        return value

    def check_material_duplicate(self, request):
        for path in (self.run / "material-operations-v1").glob("*/request.v1.json"):
            previous = governance_row(path)["request"]
            if previous["materialId"] != request["materialId"]:
                continue
            value = governance_row(path.parent / "receipt.v1.json")
            context_path = self.run / "operation-contexts-0.1.1/material-operation" / (previous["operationId"] + ".json")
            context = governance_row(context_path) if context_path.exists() else {}
            same_context = {key: context[key] for key in ("sessionId", "planRevision") if key in context} == self.config.get("evidenceContext", {})
            same = same_context and request["action"] == previous["action"] == "verify" and request.get("reuseCandidateId") == previous.get("reuseCandidateId")
            expired_and_released = self.reuse_enabled() and value.get("state") == "blocked" and value.get("exitConfirmed") and value.get("admissionReleased") and value.get("deadline", now() + 1) <= now()
            if same and not expired_and_released:
                raise RuntimeError("Equivalent material verification already exists; read or recover original operation " + previous["operationId"] + "; its deadline is unchanged")
            if not value["exitConfirmed"]:
                self.assert_material_exited(previous["operationId"], value)

    def operation_source(self, folder, value):
        record = governance_row(folder / "source-0.1.2.json")
        if record["experimentId"] != self.experiment or record["serverId"] != self.server or record["operationId"] != value["operationId"] or digest(record) != value["sourceHash"]:
            raise RuntimeError("Material operation source snapshot changed")
        return self.validate_material(copy.deepcopy(record["material"]))

    def assert_material_exited(self, operation, value):
        if not self.config.get("action", "").startswith("history-"):
            return self.owner.assert_exited(value.get("commandId", "material-" + operation), value.get("processState") == "not-started")
        path = self.run / "material-operations-v1" / operation / "process.v1.json"
        if not path.exists():
            if value["state"] != "requested":
                raise RuntimeError("Historical material verifier process exit is unconfirmed")
            return
        process = governance_row(path)
        boot = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        current = pathlib.Path("/proc") / str(process["pid"]) / "stat"
        if boot == process["hostBootId"] and current.exists():
            fields = current.read_text().rsplit(")", 1)[1].split()
            if fields[0] != "Z" and fields[19] == process["startTime"]:
                raise RuntimeError("Original historical material verifier has not exited")

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
                self.assert_material_exited(operation, previous)
                save(folder / ("receipt-" + str(previous["updatedAt"]) + "-" + uuid.uuid4().hex + ".v1.json"), previous)
            deadline = previous["deadline"]
        else:
            previous = self.register_material(request)
            deadline = previous["deadline"]
            mode = request["action"]
        modern = previous.get("formatVersion") == "0.1.2"
        self._legacy_material_operation = not modern
        material = self.operation_source(folder, previous) if modern else self.validate_material(copy.deepcopy(previous["material"])) if "material" in previous else self.material(request["materialId"], legacy=True)
        if not modern and material.get("historicalSource") and "material" not in previous and not request.get("reuseCandidateId"):
            raise RuntimeError("Legacy operation source cannot be confirmed; explicitly verify the historical candidate")
        if not modern and request.get("reuseCandidateId"):
            candidate = self.find_material_candidate(request["reuseCandidateId"])
            if candidate["directory"] != material["directory"] or candidate["sourceExperimentId"] != material.get("historicalSource", {}).get("sourceExperimentId"):
                raise RuntimeError("Material operation candidate differs from its inspected source")
        canonical = governance_row(self.root / "canonical-manifests" / (material["id"] + ".json"))
        if self.reuse_enabled():
            save(folder / "process.v1.json", {**self.process_identity(), "experimentId": self.experiment,
                "serverId": self.server, "operationId": operation})
        automatic = mode == "verify" and governance_row(original).get("reuseVerificationVersion") == 1
        if automatic:
            material = storage_reuse(self).choose_material(material, folder, previous, deadline)
        if not automatic and (mode == "verify" or material.get("historicalSource") and material["verifiedBytes"] != material["totalBytes"]):
            try:
                material = self.verify_material_files(material, folder, previous, deadline)
            except (Exception, KeyboardInterrupt) as error:
                previous.update(state="blocked", stage="blocked", detail=str(error), updatedAt=now(), exitConfirmed=False)
                save(receipt, previous)
                return previous
        if mode == "verify":
            complete = material["verifiedBytes"] == material["totalBytes"]
            modern_preflight = self.config.get("storagePreflightVersion") == 2
            if complete and not material.get("historicalSource"):
                save(self.root / ("materials-0.1.2" if modern else "materials") / (material["id"] + ".json"), material)
            value = {**previous, "state": "completed" if complete or modern_preflight else "blocked", "stage": "waiting-exit", "updatedAt": now(), "exitConfirmed": True,
                "material": material, "reusedBytes": material["verifiedBytes"], "detail": "Canonical content verified read-only; acquisition and publication still require capacity admission" if complete else "Selected source has missing, damaged or unreadable files; inspect fileResults before selecting repair"}
            if modern_preflight:
                unknown = material.get("unknownBytes", 0)
                value.update(verificationStatus="complete" if complete else "unknown" if unknown else "partial" if material["verifiedBytes"] else "none",
                    materialReady=complete, missingDownloadBytes=material["missingBytes"], unknownBytes=unknown,
                    detail="Material investigation finished: " + str(material["verifiedBytes"]) + " bytes verified, " + str(material["missingBytes"]) + " bytes missing or mismatched; choose another source or acquire only missing canonical content")
            save(receipt, value)
            return value
        with self.locked():
            publication = self.run / "material-publications-0.1.2" / (material["id"] + ".json")
            if modern and publication.exists() and governance_row(publication)["directory"] != material["directory"]:
                raise RuntimeError("This experiment already published the material from another source; its binding is retained")
            self.reserve(operation, material, request["budgetId"])
        plan = governance_row(self.run / "storage-plans-v1" / (request["budgetId"] + ".json"))
        source_choice = self.resolve_material_sources(plan).get(material["id"])
        if source_choice:
            source_material = source_choice["material"]
            source = source_material.get("historicalSource")
            if source:
                admission = self.control / "state/controller-admission.lock"
                reject_links(admission)
                with self.locked(), open(admission, "a") as handle:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self.source_released(source["sourceExperimentId"], pathlib.Path(source["runRoot"]))
                    self.retain_material_source(material["id"], source)
        if material.get("historicalSource"):
            source = material["historicalSource"]
            admission = self.control / "state/controller-admission.lock"
            reject_links(admission)
            with self.locked(), open(admission, "a") as handle:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.source_released(source["sourceExperimentId"], pathlib.Path(source["runRoot"]))
                if not all(self.file_unchanged(pathlib.Path(material["directory"]) / row["path"], row) for row in material["files"]):
                    raise RuntimeError("Historical material changed after inspection; refresh the canonical verification and budget")
                self.retain_material_source(material["id"], source)
                material.update(state="ready", checkedAt=now())
                self.publish_material(material, source_choice)
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
            current = self.material(request["materialId"], default=True, legacy=not modern)
            if current["directory"] != material["directory"] or current["volume"] != material["volume"]:
                raise RuntimeError("Default asset location changed after material operation registration")
            # Retained file proofs may advance; the registered source and transport do not change.
            for row in material["files"]:
                proof = next(item for item in current["files"] if item["path"] == row["path"])
                if any(proof[key] != row[key] for key in ("hash", "algorithm", "bytes")):
                    raise RuntimeError("Default material manifest differs from the registered identity")
                row.update({key: proof[key] for key in ("mtimeNs", "ctimeNs") if key in proof})
            material.update({key: current[key] for key in ("state", "verifiedBytes", "missingBytes")})
            resources.enter_context(self.content_locks(material["files"], deadline))
            if material["missingBytes"] > 0:
                resources.enter_context(self.transfer_slot(deadline))
            value = {**previous, "commandId": self.config.get("materialCommandId", "material-" + operation),
                "state": "running", "stage": "reusing", "processState": "running", "updatedAt": now(), "reusedBytes": 0, "exitConfirmed": False, "admissionReleased": False}
            save(receipt, value)
            material.update(state="downloading" if material["missingBytes"] else material["state"], checkedAt=now())
            save(self.root / ("materials-0.1.2" if modern else "materials") / (material["id"] + ".json"), material)
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
                    if source_choice and source_choice["mode"] == "copy":
                        source_row = next(item for item in source_choice["material"]["files"] if item["path"] == row["path"])
                        proof = next(item for item in source_choice["files"] if item["path"] == row["path"])
                        if proof["state"] == "verified":
                            candidate = self.material_file_path(source_choice["material"], row)
                            if not self.file_unchanged(candidate, source_row):
                                raise RuntimeError("Selected copy source changed after capacity assessment: " + row["path"])
                            shared = candidate
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
                self.publish_material(material, source_choice)
                self.download_capacity(operation, {**material, "missingBytes": 0}, 0, 0)
                value.update(state="completed", stage="waiting-exit", updatedAt=now(), exitConfirmed=True, material=material)
            except (Exception, KeyboardInterrupt) as error:
                value.update(state="blocked", stage="blocked", updatedAt=now(), detail=str(error), exitConfirmed=True)
                material.update(state="blocked", detail=str(error), checkedAt=now())
                save(self.root / ("materials-0.1.2" if modern else "materials") / (material["id"] + ".json"), material)
            save(receipt, value)
            return value

    def retain_material_source(self, identifier, source):
        name = ("" if self._legacy_material_operation else self.experiment + "-") + identifier
        path = self.root / "material-source-leases" / (name + ".json")
        value = {"version": 1, "serverId": self.server, "materialId": identifier, **source}
        if path.exists():
            previous = governance_row(path)
            if previous != value:
                if self._legacy_material_operation:
                    raise RuntimeError("Legacy material protection belongs to a different source")
                save(path.with_name(name + "-" + digest(previous) + ".json"), previous)
        save(path, value)

    def publish_material(self, material, source_choice=None):
        legacy = self._legacy_material_operation
        if not legacy:
            material["formatVersion"] = "0.1.2"
        published = {**material, **({} if legacy else {"experimentId": self.experiment})}
        if source_choice:
            published.update(verificationOperationId=source_choice["verificationOperationId"], sourceHash=source_choice["sourceHash"])
        if legacy:
            save(self.root / "materials" / (material["id"] + ".json"), material)
        elif not material.get("historicalSource"):
            save(self.root / "materials-0.1.2" / (material["id"] + ".json"), material)
        publication = (self.root / "material-publications" if legacy else self.run / "material-publications-0.1.2") / (material["id"] + ".json")
        if not publication.exists():
            save(publication, published)
        else:
            old = governance_row(publication)
            fingerprint = lambda rows: [{key: row[key] for key in ("path", "bytes", "hash", "algorithm", "mtimeNs")} for row in rows]
            if fingerprint(old["files"]) != fingerprint(material["files"]) or old["directory"] != material["directory"]:
                raise RuntimeError("Material publication identity changed; existing bindings require independent reverification")
        reference = {"version": 1, **({} if legacy else {"formatVersion": "0.1.2"}), "experimentId": self.experiment, "serverId": self.server, "materialId": material["id"],
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
        deadline = time.monotonic() + self.policy["scanTimeoutMs"] / 1000
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
                        if count > self.policy["materialFileLimit"] or time.monotonic() >= deadline:
                            break
                        value = governance_row(record)
                        if value.get("version") != 1 or value.get("serverId") != self.server or value.get("hash") != record.parent.name:
                            raise RuntimeError("Duplicate material ownership differs")
                        path = record.parent / relative(value["filename"])
                        reject_links(path)
                        if not path.is_file():
                            continue
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
                    "reason": "Duplicate recorded wheel; managed cleanup must verify both copies before deletion. Retained copy: " + retained["path"], "path": candidate["folder"],
                    "store": candidate["store"], "file": candidate["path"], "identity": candidate["identity"], "retained": retained["path"], "retainedStore": retained["store"], "hash": checksum})
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
                original = pathlib.Path(candidate["file"])
                if not original.is_file() or governance_identity(original) != candidate["identity"] or file_hash(original) != candidate["hash"]:
                    raise RuntimeError("The selected duplicate wheel changed; deletion is not authorized")
                self.owner.wheel(retained)
                self.owner.wheel(original)
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
        for path in (self.root / "material-source-leases").glob(self.experiment + "-*.json"):
            row = governance_row(path)
            if row["serverId"] != self.server:
                raise RuntimeError("Material source protection belongs to another server")
            path.unlink()
