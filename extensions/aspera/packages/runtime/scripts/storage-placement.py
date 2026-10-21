"""Purpose-specific environment placement; the original data workspace stays fixed."""
import math


def existing_directory(path):
    path = pathlib.Path(path)
    reject_links(path)
    while not path.exists():
        path = path.parent
    if not path.is_dir():
        raise RuntimeError("Storage ancestor is not a directory")
    return path


def capacity_identity(governance, path):
    mount = governance.mount(path)
    return {key: mount[key] for key in ("directory", "filesystem", "source")} | {
        "device": str(existing_directory(path).stat().st_dev)}


def is_system_storage(governance, path):
    return existing_directory(path).stat().st_dev == pathlib.Path("/").stat().st_dev


def reserve_bytes(governance, path):
    if "systemReserveBytes" not in governance.policy:
        return max(governance.owner.policy["minimumFreeBytes"], governance.owner.placement["minimumFreeBytes"])
    usage = shutil.disk_usage(existing_directory(path))
    system = is_system_storage(governance, path)
    prefix = "system" if system else "data"
    defaults = {"systemReserveBytes": 5 * 1024 ** 3, "systemReserveRatio": .10,
        "dataReserveBytes": 2 * 1024 ** 3, "dataReserveRatio": .05}
    return max(governance.owner.policy["minimumFreeBytes"], governance.owner.placement["minimumFreeBytes"],
        governance.policy.get(prefix + "ReserveBytes", defaults[prefix + "ReserveBytes"]),
        math.ceil(usage.total * governance.policy.get(prefix + "ReserveRatio", defaults[prefix + "ReserveRatio"])))


def environment_arrangement(owner):
    path = owner.run / "storage-arrangement.v1.json"
    if not path.exists():
        return None
    value = load(path)
    namespace = owner.control / "training-storage-v1"
    workspace = namespace / "runs" / owner.id / "workspace"
    if value.get("version") != 1 or value.get("formatVersion") != "0.1.0" or value.get("experimentId") != owner.id \
            or value.get("serverId") != owner.server or value.get("controlRoot") != str(owner.control) \
            or value.get("dataWorkspace") != owner.placement["workspaceRoot"] \
            or value.get("environmentNamespace") != str(namespace) or value.get("environmentWorkspace") != str(workspace):
        raise RuntimeError("Training environment placement differs from its experiment")
    reject_links(workspace)
    governance = storage_governance(owner)
    if capacity_identity(governance, workspace) != value["volume"] or governance.mount(workspace)["readonly"]:
        raise RuntimeError("Training environment filesystem changed or became read-only")
    for directory, marker in [(namespace, {"version": 1, "serverId": owner.server, "kind": "storage"}),
            (workspace.parent, {"version": 1, "serverId": owner.server, "experimentId": owner.id})]:
        if load(directory / ".aspera-owner.json") != marker:
            raise RuntimeError("Training environment root ownership changed")
    return value


def source_training_workspace(owner, run):
    if not (run / "storage-arrangement.v1.json").exists():
        return run / "workspace"
    source = copy.copy(owner)
    source.id, source.run = run.name, run
    source.placement = {**owner.placement, "workspaceRoot": str(run / "workspace")}
    if hasattr(source, "_storage_governance"):
        del source._storage_governance
    value = environment_arrangement(source)
    return pathlib.Path(value["environmentWorkspace"])


def apply_environment_arrangement(owner):
    value = environment_arrangement(owner)
    if value is None:
        return
    owner.workspace = pathlib.Path(value["environmentWorkspace"])
    owner.store = pathlib.Path(value["environmentNamespace"]) / "packages-v1"
    owner.objects = owner.store / "objects"
    owner.references = owner.store / "references"
    owner.materials = owner.store / "materials"
    owner.resolutions = owner.store / "resolutions"
    owner.material_references = owner.store / "material-references"


def owned_training_directory(path, marker):
    reject_links(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = path / ".aspera-owner.json"
    if target.exists():
        if load(target) != marker:
            raise RuntimeError("Training storage directory belongs to another owner")
    else:
        if list(path.iterdir()):
            raise RuntimeError("Training storage directory is nonempty and unowned")
        with open(target, "x") as stream:
            stream.write(json.dumps(marker, separators=(",", ":"))); stream.flush(); os.fsync(stream.fileno())


def install_environment_arrangement(governance, peak, reason):
    lock = governance.control / "state/controller-admission.lock"
    reject_links(lock)
    lock.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(lock, "a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return install_environment_arrangement_owned(governance, peak, reason)


def install_environment_arrangement_owned(governance, peak, reason):
    owner = governance.owner
    if owner.config.get("action", "").startswith("history-"):
        raise RuntimeError("Environment fallback requires the saved experiment workspace")
    if list(owner.manifests.glob("*.json")) or list(owner.operations.glob("*/receipt.v1.json")) or list((owner.run / "environment-requests-v1").glob("*.json")):
        raise RuntimeError("Environment installation already has a fixed location; automatic relocation is unavailable")
    if list((owner.workspace / "env").glob("*")) or list((owner.workspace / "tmp").glob("environment-*")):
        raise RuntimeError("Existing training files must retain their original location")
    old = environment_arrangement(owner)
    if old is not None:
        return old
    namespace = owner.control / "training-storage-v1"
    workspace = namespace / "runs" / owner.id / "workspace"
    if not is_system_storage(governance, workspace):
        raise RuntimeError("Configured control root is not on the system filesystem")
    owned_training_directory(namespace, {"version": 1, "serverId": owner.server, "kind": "storage"})
    owned_training_directory(workspace.parent, {"version": 1, "serverId": owner.server, "experimentId": owner.id})
    workspace.mkdir(mode=0o700, exist_ok=True)
    save(workspace.parent / "source-run.v1.json", {"version": 1, "serverId": owner.server, "experimentId": owner.id, "runRoot": str(owner.run)})
    for name in ("tmp", "env", "cache"):
        path = workspace / name; reject_links(path); path.mkdir(mode=0o700, exist_ok=True)
    volume = capacity_identity(governance, workspace)
    stamp = now()
    value = {"version": 1, "formatVersion": "0.1.0", "experimentId": owner.id, "serverId": owner.server,
        "controlRoot": str(owner.control), "dataWorkspace": owner.placement["workspaceRoot"],
        "environmentWorkspace": str(workspace), "environmentNamespace": str(namespace),
        "appliedAt": stamp, "eventId": digest([owner.id, owner.server, str(workspace)]), "reason": reason,
        "estimatedPeakBytes": peak, "volume": volume,
        "history": [{"time": stamp, "action": "system-fallback", "reason": reason}]}
    save(owner.run / "storage-arrangement.v1.json", value)
    save(owner.control / "state/storage-roots" / digest(str(namespace)) / ".aspera-owner.json",
        {"version": 1, "serverId": owner.server, "namespaceRoot": str(namespace)})
    apply_environment_arrangement(owner)
    return value
