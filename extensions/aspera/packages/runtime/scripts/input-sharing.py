"""Retain bytes and paths while compacting confirmed immutable input and release resources."""


class InputSharing:
    def __init__(self, owner):
        self.owner = owner
        self.diagnostics = []
        self.objects = owner.store / "input-objects-v1"
        self.receipts = owner.run / "input-sharing-v1"
        self.kind = "input-duplicate"
        self.reason = "Preserve paths and bytes of identical authenticated wheel inputs from released experiments using same-mount hardlinks; no environment/model/log deletion"

    @staticmethod
    def identity(fd, path):
        value = os.fstat(fd)
        return [fd_identity(fd, path, "input-sharing")[0], value.st_dev, value.st_ino, value.st_size,
            str(value.st_mtime_ns), stat.S_IMODE(value.st_mode), value.st_uid, value.st_gid,
            value.st_blocks * 512]

    def snapshot(self, path):
        reject_links(path)
        with contextlib.ExitStack() as descriptors:
            namespace = os.open(self.owner.namespace, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
            descriptors.callback(os.close, namespace)
            parent = os.open(path.parent, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
            descriptors.callback(os.close, parent)
            descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
            descriptors.callback(os.close, descriptor)
            observed = self.identity(descriptor, path)
            mount = fd_identity(namespace, self.owner.namespace, "input-sharing-root")[0]
            if not stat.S_ISREG(os.fstat(descriptor).st_mode) or observed[0] != mount or fd_identity(parent, path.parent, "input-sharing-parent")[0] != mount:
                raise RuntimeError("Input snapshot is not a regular file on its owned mount")
            birth = os.fstat(descriptor).st_ctime_ns
            key = (*observed, birth, os.fstat(descriptor).st_nlink)
            batch = getattr(self, "_snapshot_hashes", None)
            checksum = batch.get(key) if batch is not None else None
            if checksum is None:
                hasher = hashlib.sha256()
                with os.fdopen(os.dup(descriptor), "rb") as stream:
                    for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
                        hasher.update(block)
                checksum = hasher.hexdigest()
            named = os.stat(path, follow_symlinks=False)
            if observed != self.identity(descriptor, path) or os.fstat(descriptor).st_ctime_ns != birth \
                    or (named.st_dev, named.st_ino) != tuple(observed[1:3]):
                raise RuntimeError("Input snapshot changed while it was inspected")
            if batch is not None:
                batch[key] = checksum
            return {"path": str(path), "identity": observed, "sha256": checksum, "links": os.fstat(descriptor).st_nlink}

    def discover(self):
        self._snapshot_hashes = {}
        try:
            return self.discover_sources()
        finally:
            del self._snapshot_hashes

    def discover_sources(self):
        owner = self.owner
        proofs = {}
        for path in (owner.run / "input-verifications-v1").glob("*.json"):
            value = load(path)
            name = value.get("name", "")
            if value.get("version") != 1 or value.get("experimentId") != owner.id or value.get("serverId") != owner.server \
                    or pathlib.Path(name).name != name or not name.endswith(".whl") or not re.fullmatch(r"[a-f0-9]{64}", value.get("sha256", "")) \
                    or path.name != hashlib.sha256(name.encode()).hexdigest() + ".json":
                continue
            proofs[name] = value["sha256"]
        groups, count = {}, 0
        governance = storage_governance(owner)
        for run in sorted((owner.namespace / "runs").iterdir()):
            if run == owner.run or not re.fullmatch(r"[a-f0-9-]{36}", run.name):
                continue
            count += 1
            if count > owner.policy["legacyRunLimit"]:
                self.diagnostics.append("Input snapshot scan reached its configured run limit; unscanned snapshots are excluded")
                break
            try:
                reject_links(run)
                if load(run / ".aspera-owner.json") != {"version": 1, "experimentId": run.name, "serverId": owner.server}:
                    continue
                released = governance.source_released(run.name, run)
            except (OSError, RuntimeError, ValueError, KeyError):
                continue
            for folder in (run / "inputs", run / "workspace/inputs"):
                for name, checksum in proofs.items():
                    path = folder / name
                    try:
                        governance.protect_path(path)
                        value = self.snapshot(path)
                        if value["sha256"] != checksum:
                            continue
                        value.update(experimentId=run.name, runRoot=str(run), release=released)
                        identity = value["identity"]
                        key = digest([checksum, identity[0], identity[1], identity[5:8]])
                        groups.setdefault(key, []).append(value)
                    except (OSError, RuntimeError, ValueError):
                        # Active, unreadable, changed or cross-mount inputs remain independent snapshots.
                        continue
        return self.group_candidates(groups)

    def group_candidates(self, groups):
        rows = []
        for key, files in groups.items():
            files.sort(key=lambda value: value["path"])
            by_inode = {}
            for value in files:
                identity = tuple(value["identity"][1:3])
                by_inode[identity] = by_inode.get(identity, 0) + 1
            # Unknown external aliases cannot be treated as reclaimed allocation.
            files = [value for value in files if value["links"] == by_inode[tuple(value["identity"][1:3])]]
            unique = {(value["identity"][1], value["identity"][2]): value for value in files}
            if not unique:
                continue
            anchor = self.objects / (key + ".bin")
            existing = None
            if anchor.exists():
                observed = self.snapshot(anchor)
                if observed["sha256"] != files[0]["sha256"] or observed["identity"][0:2] != files[0]["identity"][0:2] \
                        or observed["identity"][5:8] != files[0]["identity"][5:8]:
                    raise RuntimeError("Retained shared anchor changed; preserve every original path")
                existing = {name: observed[name] for name in ("path", "identity", "sha256")}
            if len(unique) < 2 and existing is None:
                continue
            size = sum(value["identity"][8] for value in list(unique.values())[0 if existing else 1:])
            rows.append({"id": self.kind + "-" + digest([key, files, existing]), "kind": self.kind, "bytes": size, "reason": self.reason,
                "key": key, "sha256": files[0]["sha256"], "files": files, "existingAnchor": existing})
        return rows

    def confirm_source(self, value, governance):
        if governance.source_released(value["experimentId"], pathlib.Path(value["runRoot"])) != value["release"]:
            raise RuntimeError("Original input release changed before compaction")

    def compact(self, identifier):
        row = next((value for value in self.discover() if value["id"] == identifier), None)
        if row is None:
            raise RuntimeError("Released input snapshots changed; request a new preview")
        governance = storage_governance(self.owner)
        with governance.locked():
            self.compact_selected(identifier, row, governance)

    def compact_selected(self, identifier, row, governance):
        reject_links(self.objects)
        self.objects.mkdir(mode=0o700, exist_ok=True)
        receipt = self.receipts / (identifier + ".json")
        anchor = self.objects / (row["key"] + ".bin")
        record = {"version": 1, "experimentId": self.owner.id, "serverId": self.owner.server, "candidateId": identifier,
            "state": "prepared", "sha256": row["sha256"], "anchor": str(anchor), "sources": row["files"], "replaced": [], "updatedAt": now()}
        save(receipt, record)
        try:
            for value in row["files"]:
                if self.snapshot(pathlib.Path(value["path"])) != {key: value[key] for key in ("path", "identity", "sha256", "links")}:
                    raise RuntimeError("Input snapshot changed before compaction")
                self.confirm_source(value, governance)
            first = pathlib.Path(row["files"][0]["path"])
            if not anchor.exists():
                os.link(first, anchor, follow_symlinks=False)
                descriptor = os.open(self.objects, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            canonical = self.snapshot(anchor)
            if canonical["sha256"] != row["sha256"] or canonical["identity"][0:2] != row["files"][0]["identity"][0:2] \
                    or canonical["identity"][5:8] != row["files"][0]["identity"][5:8]:
                raise RuntimeError("Shared input anchor differs from its authenticated bytes or permissions")
            for value in row["files"]:
                path = pathlib.Path(value["path"])
                governance.protect_path(path)
                self.confirm_source(value, governance)
                observed = self.snapshot(path)
                if observed["identity"] != value["identity"] or observed["sha256"] != value["sha256"]:
                    raise RuntimeError("Input changed during compaction")
                if observed["identity"][1:3] == canonical["identity"][1:3]:
                    continue
                parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                temporary = ".aspera-input-link-" + uuid.uuid4().hex
                try:
                    original_parent = os.fstat(parent)
                    os.link(anchor, temporary, dst_dir_fd=parent, follow_symlinks=False)
                    linked = os.stat(temporary, dir_fd=parent, follow_symlinks=False)
                    current = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
                    actual_parent = os.stat(path.parent, follow_symlinks=False)
                    if (actual_parent.st_dev, actual_parent.st_ino) != (original_parent.st_dev, original_parent.st_ino) \
                            or (linked.st_dev, linked.st_ino) != tuple(canonical["identity"][1:3]) \
                            or [current.st_dev, current.st_ino, current.st_size, str(current.st_mtime_ns)] != value["identity"][1:5]:
                        raise RuntimeError("Input or parent changed before atomic replacement")
                    os.replace(temporary, path.name, src_dir_fd=parent, dst_dir_fd=parent)
                    os.fsync(parent)
                finally:
                    try:
                        os.unlink(temporary, dir_fd=parent)
                    except FileNotFoundError:
                        # Atomic replacement consumed this operation's temporary link.
                        pass
                    finally:
                        os.close(parent)
                record["replaced"].append(value["path"])
                record.update(updatedAt=now())
                save(receipt, record)
            record.update(state="completed", updatedAt=now())
            save(receipt, record)
        except (OSError, RuntimeError, ValueError) as error:
            record.update(state="blocked", detail=str(error), updatedAt=now())
            save(receipt, record)
            raise


def input_sharing(owner):
    if "InputSharing" not in globals():
        source = pathlib.Path(__file__).with_name("input-sharing.py")
        exec(compile(source.read_text(), str(source), "exec"), globals())
    return InputSharing(owner)


class ReleasedAssets(InputSharing):
    def __init__(self, owner):
        super().__init__(owner)
        self.objects = owner.store / "release-asset-objects-v1"
        self.receipts = owner.run / "release-asset-sharing-v1"
        self.kind = "release-asset-duplicate"
        self.reason = "Same-content immutable LibreOffice/terminal resources from idle sealed releases; all release paths, bytes and permission identities retained through hardlinks"

    def users(self):
        root = self.owner.namespace / "releases"
        pattern = re.compile(re.escape(str(root)) + r"/([a-f0-9]{64})(?:/|$)")
        result = set()
        for process in pathlib.Path("/proc").iterdir():
            if not process.name.isdigit() or int(process.name) == os.getpid():
                continue
            try:
                values = [(process / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace"),
                    (process / "maps").read_text(errors="replace")]
                for name in ("cwd", "exe"):
                    try:
                        values.append(os.readlink(process / name))
                    except FileNotFoundError:
                        # A reaped or zombie process may have no cwd/executable link.
                        continue
                for entry in (process / "fd").iterdir():
                    try:
                        values.append(os.readlink(entry))
                    except FileNotFoundError:
                        # The process closed this descriptor during the read-only inspection.
                        continue
                for value in values:
                    result.update(str(root / match[1]) for match in pattern.finditer(value))
            except (FileNotFoundError, ProcessLookupError):
                continue
            except PermissionError as error:
                raise RuntimeError("Cannot confirm sealed release process/descriptor inactivity") from error
        return result

    def release_identity(self, release, active):
        reject_links(release)
        if not re.fullmatch(r"[a-f0-9]{64}", release.name) or release.name == self.owner.config["deploymentId"] \
                or str(release) in active or pathlib.Path(str(release) + ".installing").exists():
            raise RuntimeError("Release is selected, active or still installing")
        marker = load(release / "aspera-release.json")
        if marker.get("version") != 1 or marker.get("deploymentId") != release.name or load(release / "package.json").get("name") != "aspera-installed-release":
            raise RuntimeError("Sealed release ownership differs")
        ready = self.snapshot(release / ".ready")
        value = release.stat()
        return digest([value.st_dev, value.st_ino, marker, ready["sha256"], file_hash(release / "package.json")])

    def discover_sources(self):
        root = self.owner.namespace / "releases"
        if not root.is_dir():
            return []
        reject_links(root)
        try:
            active = self.users()
        except RuntimeError as error:
            self.diagnostics.append(str(error))
            return []
        groups = {}
        governance = storage_governance(self.owner)
        for index, release in enumerate(sorted(root.iterdir())):
            if index >= self.owner.policy["legacyRunLimit"]:
                self.diagnostics.append("Release asset scan reached its configured release limit; unscanned assets remain retained")
                break
            try:
                proof = self.release_identity(release, active)
            except (OSError, RuntimeError, ValueError):
                continue
            patterns = ["node_modules/.pnpm/@deepseek-ai+libreoffice-kit-wasm@*/node_modules/@deepseek-ai/libreoffice-kit-wasm/assets/soffice.wasm",
                "node_modules/.pnpm/@deepseek-ai+libreoffice-kit-wasm@*/node_modules/@deepseek-ai/libreoffice-kit-wasm/assets/soffice.data",
                "node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/*/*.pdb"]
            for pattern in patterns:
                for path in release.glob(pattern):
                    try:
                        governance.protect_path(path)
                        value = self.snapshot(path)
                        value.update(releaseRoot=str(release), release=proof)
                        identity = value["identity"]
                        key = digest([value["sha256"], identity[0], identity[1], identity[5:8]])
                        groups.setdefault(key, []).append(value)
                    except (OSError, RuntimeError, ValueError):
                        # Unconfirmed or externally linked release payloads are never promoted to shared anchors.
                        continue
        return self.group_candidates(groups)

    def confirm_source(self, value, governance):
        governance.protect_path(pathlib.Path(value["path"]))
        if self.release_identity(pathlib.Path(value["releaseRoot"]), self.users()) != value["release"]:
            raise RuntimeError("Sealed release identity or inactivity changed before compaction")


def release_assets(owner):
    input_sharing(owner)
    return ReleasedAssets(owner)
