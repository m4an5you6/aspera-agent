"""Preview account-owned package-manager caches and delegate eviction to their fixed managers."""


class ManagerCaches:
    def __init__(self, owner):
        self.owner = owner
        self.diagnostics = []

    def project_reference(self, path, target):
        relative = target.relative_to(path)
        if path != self.owner.namespace / "cache/pnpm" or len(relative.parts) != 3 or not re.fullmatch(r"v\d+", relative.parts[0]) or relative.parts[1] != "projects":
            return False
        if not re.fullmatch(r"[a-f0-9]{32}", relative.name):
            return False
        destination = pathlib.Path(os.path.abspath(target.parent / os.readlink(target)))
        releases = self.owner.namespace / "releases"
        return destination.parent == releases and re.fullmatch(r"[a-f0-9]{64}(?:\.building-v1)?", destination.name) is not None

    def snapshot(self, path):
        reject_links(path)
        rows = []
        fd = os.open(path, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            mount = fd_identity(fd, path, "cache-root")[0]
        finally:
            os.close(fd)
        for base, directories, names in os.walk(path, followlinks=False):
            if len(rows) + len(names) + len(directories) > self.owner.policy["maxPackageFiles"]:
                raise RuntimeError("Manager cache inspection exceeded its configured file budget")
            for name in directories + names:
                target = pathlib.Path(base) / name
                fd = os.open(target, os.O_PATH | os.O_NOFOLLOW)
                try:
                    observed = fd_identity(fd, target, "cache-entry")
                    if observed[0] != mount:
                        raise RuntimeError("Manager cache includes another mount")
                    value = os.fstat(fd)
                    if stat.S_ISLNK(value.st_mode) and not self.project_reference(path, target) and not target.resolve(strict=True).is_relative_to(path):
                        raise RuntimeError("Manager cache link escapes its cache directory")
                    rows.append([str(target.relative_to(path)), value.st_dev, value.st_ino, value.st_size,
                        str(value.st_mtime_ns), str(value.st_ctime_ns), value.st_nlink,
                        os.readlink(target) if stat.S_ISLNK(value.st_mode) else None])
                finally:
                    os.close(fd)
        root = path.stat()
        return digest([root.st_dev, root.st_ino, str(root.st_mtime_ns), str(root.st_ctime_ns), sorted(rows)]), storage_governance(self.owner).reclaimable(path)

    def idle(self, path):
        for process in pathlib.Path("/proc").iterdir():
            if not process.name.isdigit() or int(process.name) == os.getpid():
                continue
            try:
                args = (process / "cmdline").read_bytes().replace(b"\0", b" ")
                cwd = str((process / "cwd").resolve(strict=True))
            except (FileNotFoundError, ProcessLookupError):
                continue
            if str(path).encode() in args or cwd == str(path) or cwd.startswith(str(path) + "/"):
                raise RuntimeError("A process still uses this package-manager cache")
        storage_governance(self.owner).protect_path(path)

    def discover(self):
        owner = self.owner
        selected = []
        pnpm = owner.namespace / "cache/pnpm"
        executable = shutil.which("pnpm")
        if pnpm.is_dir() and executable:
            manifest = load(pathlib.Path(owner.placement["releaseRoot"]) / "package.json")
            expected = manifest.get("packageManager", "")
            result = subprocess.run([executable, "--version"], capture_output=True, text=True,
                env={"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "CI": "1"}, timeout=owner.policy["readTimeoutMs"] / 1000)
            if result.returncode == 0 and expected == "pnpm@" + result.stdout.strip():
                selected.append(("pnpm", pnpm, executable))
        tests = owner.namespace / "tests"
        if tests.is_dir() and not tests.is_symlink():
            for test in tests.iterdir():
                if not test.is_dir() or test.is_symlink():
                    continue
                for cache in test.iterdir():
                    marker = cache / "CACHEDIR.TAG"
                    if cache.is_dir() and not cache.is_symlink() and marker.is_file() and not marker.is_symlink():
                        names = {entry.name for entry in cache.iterdir()}
                        known = all(name in ("CACHEDIR.TAG", ".gitignore", ".lock") or re.fullmatch(
                            r"(?:archive|wheels|sdists|simple|interpreter|environments|git|builds|flat-index)-v\d+", name) for name in names)
                        if known and marker.read_bytes().startswith(b"Signature: 8a477f597d28d172789f06886806bc55"):
                            selected.append(("uv", cache, owner.config["uvPath"]))
        result = []
        for manager, path, executable in selected:
            try:
                self.idle(path)
                snapshot, size = self.snapshot(path)
                identity = digest([owner.server, manager, str(path), snapshot])
                result.append({"id": "manager-cache-" + identity, "kind": "manager-cache", "bytes": size,
                    "reason": "Explicit manager eviction of an idle Aspera " + manager + " cache; environments, verified wheels, model/data and logs remain intact: " + str(path),
                    "manager": manager, "path": str(path), "executable": executable, "snapshot": snapshot})
            except (OSError, RuntimeError) as error:
                # Unconfirmed ownership, topology or activity never supplies a cache-eviction candidate.
                self.diagnostics.append(str(path) + ': ' + str(error))
        return result

    def clean(self, identifier):
        row = next((value for value in self.discover() if value["id"] == identifier), None)
        if row is None:
            raise RuntimeError("Package-manager cache changed; request a new preview")
        path = pathlib.Path(row["path"])
        self.idle(path)
        if self.snapshot(path)[0] != row["snapshot"]:
            raise RuntimeError("Package-manager cache changed before eviction")
        command = [row["executable"], "store", "prune", "--store-dir", str(path)] if row["manager"] == "pnpm" else [
            row["executable"], "cache", "clean", "--cache-dir", str(path)]
        work = self.owner.run / "cache-maintenance-v1"
        work.mkdir(mode=0o700, exist_ok=True)
        result = subprocess.run(command, capture_output=True, text=True, cwd=work,
            env={"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "CI": "1"}, timeout=self.owner.policy["timeoutMs"] / 1000)
        save(work / (identifier + ".json"), {"version": 1, "experimentId": self.owner.id, "serverId": self.owner.server,
            "manager": row["manager"], "candidateId": identifier, "exitCode": result.returncode,
            "stdout": result.stdout[-16384:], "stderr": result.stderr[-16384:], "checkedAt": now()})
        if result.returncode:
            raise RuntimeError("Package-manager eviction failed: " + result.stderr[-4096:])


def manager_caches(owner):
    if "ManagerCaches" not in globals():
        source = pathlib.Path(__file__).with_name("manager-cache.py")
        exec(compile(source.read_text(), str(source), "exec"), globals())
    return ManagerCaches(owner)
