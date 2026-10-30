"""Account-owned controller recovery fences, occupancy evidence and atomic profile publication."""
import fcntl
import hashlib
import json
import os
import pathlib
import re
import socket
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
import time
import signal
import select

TERMINAL = {"completed", "blocked", "failed", "cancelled", "interrupted"}
STOPPED_SERVICES = {"failed", "interrupted", "stopped"}
STARTED = {"starting", "running", "serving", "cancelling", "planning", "waiting-reply"}


def private_path(path, root):
    path = pathlib.Path(path)
    path.relative_to(root)
    for part in [path, *path.parents]:
        if part == root.parent:
            break
        if part.is_symlink():
            raise RuntimeError("Recovery path is a symbolic link: " + str(part))
        if part.exists() and (part.stat().st_uid != os.geteuid() or part.stat().st_mode & 0o022):
            raise RuntimeError("Recovery path has another owner or unsafe write permissions: " + str(part))
    return path


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix=".incoming-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream); stream.write("\n"); stream.flush(); os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def records(home, unit, tables):
    """Read declared JSON storage records, preserving their original version stamps."""
    base = home / "storages"
    result = []
    for table in tables:
        folder = private_path(base / unit / table, home)
        if not folder.exists():
            continue
        for file in sorted(folder.iterdir()):
            private_path(file, home)
            if not file.is_file() or file.suffix != ".json":
                raise RuntimeError("Unknown controller storage entry: " + str(file))
            raw = file.read_bytes(); data = json.loads(raw)
            if data.get("version") not in [1, 2, 3, 4] or not isinstance(data.get("record"), dict):
                raise RuntimeError("Unsupported controller storage record: " + str(file))
            row = data["record"]
            experiment = row.get("experimentId") if unit == "aspera_node" else row.get("submission", {}).get("experimentId")
            if not isinstance(experiment, str) or str(uuid.UUID(experiment)) != experiment:
                raise RuntimeError("Controller storage has no experiment identity: " + str(file))
            if not isinstance(row.get("released" if unit == "aspera_node" else "resourcesReleased"), bool):
                raise RuntimeError("Controller storage has no confirmed release field: " + str(file))
            if table in ["allocations", "experiments"] and file.stem != experiment:
                raise RuntimeError("Controller record key belongs to another experiment")
            if table == "commands" and (not isinstance(row.get("commandId"), str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", row["commandId"])
                                        or file.stem != experiment + "_" + row["commandId"]):
                raise RuntimeError("Controller command key differs from its owned command")
            result.append({"path": file, "digest": hashlib.sha256(raw).hexdigest(), "document": data,
                           "table": table, "row": data["record"], "key": file.stem})
    legacy = private_path(base / (unit + ".json"), home)
    if legacy.exists() and not result:
        data = json.loads(legacy.read_text())
        if data.get("unit", {}).get("name") != unit or data["unit"].get("version") not in [1, 2, 3, 4]:
            raise RuntimeError("Unsupported legacy controller storage: " + str(legacy))
        if any(data.get("tables", {}).get(table) for table in tables):
            raise RuntimeError("Legacy controller storage requires its original release to reconcile: " + str(legacy))
    return result


def listening(port, timeout):
    with socket.socket() as client:
        client.settimeout(timeout)
        code = client.connect_ex(("127.0.0.1", port))
    if code not in (0, 111):
        raise RuntimeError("Cannot confirm control port state: " + str(code))
    return code == 0


def service_listening(row, timeout):
    ports = [row["port"]]
    if row.get("external") is not None:
        ports.append(row["external"]["port"])
    return any(listening(port, timeout) for port in set(ports))


def processes(root):
    """An unreadable process prevents claiming account-level quiescence."""
    owned = []; unknown = []
    run_roots = [str(root / "runs")]
    markers = root / "state/storage-roots"
    if markers.exists():
        for marker in markers.iterdir():
            identity = json.loads(private_path(marker / ".aspera-owner.json", root).read_text())
            run_roots.append(str(pathlib.Path(identity["namespaceRoot"]) / "runs"))
    for proc in pathlib.Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            values = dict(item.split(b"=", 1) for item in (proc / "environ").read_bytes().split(b"\0") if b"=" in item)
            cwd = os.readlink(proc / "cwd")
            if values.get(b"DSH_CLUSTER_ROOT", b"").decode() == str(root) or any(cwd.startswith(path + "/") for path in run_roots):
                owned.append({"pid": int(proc.name), "role": values.get(b"DSH_EXPERIMENT_ROLE", b"").decode(),
                              "start": (proc / "stat").read_text().rsplit(")", 1)[1].split()[19]})
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError:
            unknown.append(int(proc.name))
    return owned, unknown


def interruption_receipt(request, row):
    submission = row["submission"]
    experiment = submission["experimentId"]
    server = submission.get("coordinator", {"id": request["serverId"], "remoteRoot": request["root"]})
    if server.get("id") != request["serverId"] or server.get("remoteRoot") != request["root"]:
        raise RuntimeError("Interrupted task coordinator belongs to another server")
    run = run_path(server, experiment)
    receipt_path = private_path(run / "interruption.v1.json", run)
    if receipt_path.exists():
        receipt = json.loads(receipt_path.read_text())
        if receipt.get("version") != 1 or receipt.get("experimentId") != experiment or receipt.get("submissionHash") != row.get("payloadHash") \
                or {node["serverId"] for node in receipt.get("nodes", [])} != {node["server"]["id"] for node in submission["nodes"]}:
            raise RuntimeError("Existing interruption receipt belongs to another submission")
        return receipt_path, {**receipt, "phase": "released", "updatedAt": row["updatedAt"], "result": row,
                              "nodes": [{**node, "phase": "released", "agentsExited": True, "commandsReleased": True, "servicesReleased": True,
                                         "updatedAt": row["updatedAt"]} for node in receipt["nodes"]]}
    now = row["updatedAt"]
    value = {"version": 1, "experimentId": experiment, "operationId": request["operationId"],
             "submissionHash": row["payloadHash"], "reason": "controller-recovery", "stopRequested": False,
             "phase": "released", "startedAt": now, "updatedAt": now, "result": row,
             "nodes": [{"serverId": node["server"]["id"], "name": node["server"].get("name", node["server"]["id"]),
                        "phase": "released", "agentsExited": True, "commandsReleased": True, "servicesReleased": True,
                        "updatedAt": now} for node in submission["nodes"]]}
    return receipt_path, value


def run_path(server, experiment):
    """Directory markers bind original run paths independently of PID or controller health."""
    placement = server.get("storagePlacement")
    namespace = pathlib.Path(server["remoteRoot"] if placement is None else placement["namespaceRoot"])
    run = namespace / "runs" / experiment
    if placement is not None and (placement["serverId"] != server["id"] or placement["experimentId"] != experiment
                                  or placement["controlRoot"] != server["remoteRoot"] or placement["runRoot"] != str(run)):
        raise RuntimeError("Original experiment directory assignment differs")
    private_path(run, namespace)
    marker = private_path(run / ".aspera-owner.json", namespace)
    if not marker.exists():
        raise RuntimeError("Original experiment directory ownership is unavailable")
    owner = json.loads(marker.read_text())
    if owner.get("version") != 1 or owner.get("experimentId") != experiment or owner.get("serverId") != server["id"]:
        raise RuntimeError("Original experiment directory belongs to another task")
    return run


def saved_outcome(row):
    """A worker receipt is authoritative only with its original run and Session identity."""
    if row["state"] in TERMINAL:
        return None
    submission = row["submission"]
    run = run_path(submission["coordinator"], submission["experimentId"])
    for name, started_name, session_key in [("outcome.json", "started.json", "sessionId"),
                                            ("planning-outcome.json", "planning-started.json", "planningSessionId")]:
        path = private_path(run / name, run)
        if not path.exists():
            continue
        value = json.loads(path.read_text())
        if value.get("state") not in ["completed", "failed", "blocked", "serving"] or ("detail" in value and not isinstance(value["detail"], str)):
            raise RuntimeError("Original worker outcome is not parseable")
        started = json.loads(private_path(run / started_name, run).read_text())
        if not isinstance(row.get(session_key), str) or started.get("sessionId") != row[session_key]:
            raise RuntimeError("Original worker outcome has no matching Session identity")
        if value["state"] in ["blocked", "failed"] or name == "outcome.json" and value["state"] == "completed":
            return value
    return None


def inspect(request):
    root = private_path(pathlib.Path(request["root"]), pathlib.Path(request["root"]))
    role = request["role"]
    boot = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    owned, unknown = processes(root)
    pidfile = private_path(root / "state" / (role + ".pid"), root)
    pid = pidfile.read_text().strip() if pidfile.exists() else None
    alive = pid is not None and pid.isdigit() and (pathlib.Path("/proc") / pid).exists()
    node = records(root / "state/node-home", "aspera_node", ["allocations", "commands", "services"])
    queue = records(root / "state/coordinator-home", "aspera_queue", ["experiments"])
    blockers = []; changes = []
    for candidate in ["node", "coordinator"]:
        if (root / "state" / (candidate + ".launch")).exists():
            blockers.append({"kind": "launch", "reason": "A controller startup is still in progress or unconfirmed"})
    gate = root / "state/controller-recovery.json"
    if gate.exists() and json.loads(gate.read_text()).get("operationId") != request.get("operationId"):
        blockers.append({"kind": "maintenance", "reason": "Another recovery owns controller admission"})
    fences = private_path(root / "state/interruption-fences", root)
    if fences.exists():
        for fence in sorted(fences.iterdir()):
            saved = json.loads(private_path(fence, root).read_text())
            blockers.append({"kind": "interruption", "id": saved.get("experimentId"),
                             "reason": "Experiment interruption must confirm release before controller startup"})
    commands = {entry["key"]: entry for entry in node if entry["table"] == "commands"}
    released_commands = {}
    for entry in commands.values():
        row = entry["row"]
        released_commands.setdefault(row.get("experimentId"), []).append(row.get("released") is True)
        if row.get("released") is not True:
            blockers.append({"kind": "command", "id": entry["key"], "reason": "Original command exit is not confirmed"})
    for entry in node:
        row = entry["row"]
        if entry["table"] == "services" and service_listening(row, request["timeoutSeconds"]):
            blockers.append({"kind": "service", "id": entry["key"], "reason": "Original service or gateway listener exit is not confirmed"})
            continue
        if entry["table"] == "commands" or row.get("released") is True:
            continue
        experiment = row.get("experimentId")
        if entry["table"] == "services":
            command = commands.get(str(experiment) + "_" + str(row.get("commandId")))
            if command is None or command["row"].get("released") is not True:
                blockers.append({"kind": "service", "id": entry["key"], "reason": "Service command or listener exit is not confirmed"})
                continue
            updated = {**row, "released": True}
            if row.get("state") not in STOPPED_SERVICES:
                updated.update(state="interrupted", detail="Controller recovery confirmed the original service exited.")
            changes.append((entry, updated))
        elif entry["table"] == "allocations":
            original = next((item for item in request.get("allowedSubmissions", []) if item["submission"]["experimentId"] == experiment), None)
            scope = request.get("allowedServerIds", [request["serverId"]])
            if original is None or experiment not in request.get("allowedExperimentIds", []):
                missing = [] if original is None else [node["server"].get("name", node["server"]["id"]) for node in original["submission"]["nodes"] if node["server"]["id"] not in scope]
                reason = "Original task identity is not verified; request program-owned recovery of its fixed submission" if original is None else \
                    "Original task is outside preparation authorization; use server task recovery to verify every original node. Unconfirmed nodes: " + json.dumps(missing)
                blockers.append({"kind": "experiment", "id": experiment, "reason": reason})
                continue
            original_nodes = original["submission"]["nodes"]
            local_queue = next((item for item in queue if item["row"]["submission"]["experimentId"] == experiment), None)
            if len(original_nodes) != 1 or local_queue is None or original["submission"]["coordinator"]["remoteRoot"] != str(root):
                blockers.append({"kind": "experiment", "id": experiment, "reason": "All original nodes and the original coordinator must confirm release together"})
                continue
            if local_queue["row"]["submission"] != original["submission"] or local_queue["row"].get("payloadHash") != original["payloadHash"]:
                blockers.append({"kind": "experiment", "id": experiment, "reason": "Original local submission differs from the controller ledger"})
                continue
            if not all(released_commands.get(experiment, [])):
                blockers.append({"kind": "allocation", "id": entry["key"], "reason": "Allocation still has unconfirmed commands"})
                continue
            changes.append((entry, {**row, "released": True, "releasing": False}))
    for entry in queue:
        row = entry["row"]
        experiment = row.get("submission", {}).get("experimentId")
        if row.get("state") in TERMINAL and row.get("resourcesReleased") is True and all(item.get("released") is True for item in row.get("services", [])):
            continue
        local = row.get("submission", {}).get("nodes", [])
        allocations = [item for item in node if item["table"] == "allocations" and item["row"].get("experimentId") == experiment]
        settled = {str(item["path"]): updated for item, updated in changes}
        local_services = {item["key"]: settled.get(str(item["path"]), item["row"]) for item in node if item["table"] == "services"}
        task_services = []
        for service in row.get("services", []):
            observed = local_services.get(service.get("id"))
            updated = service
            if service.get("released") is not True and observed is not None and observed.get("experimentId") == experiment and observed.get("released") is True:
                updated = {**service, "released": True}
                if service.get("state") not in STOPPED_SERVICES:
                    updated["state"] = "interrupted"
            task_services.append(updated)
        controllers_exited = not any((root / "state" / (candidate + ".pid")).exists()
                                     and (root / "state" / (candidate + ".pid")).read_text().strip().isdigit()
                                     and (pathlib.Path("/proc") / (root / "state" / (candidate + ".pid")).read_text().strip()).exists()
                                     for candidate in ["node", "coordinator"])
        authorized = request.get("allowedExperimentIds", [])
        servers = request.get("allowedServerIds", [request["serverId"]])
        orphan = row.get("state") in STARTED and experiment in authorized and controllers_exited and not owned and not unknown \
                 and all(item.get("server", {}).get("id") in servers for item in local)
        if orphan or row.get("state") in TERMINAL:
            original = next((item for item in request.get("allowedSubmissions", []) if item["submission"]["experimentId"] == experiment), None)
            if experiment not in authorized or original is None or original["submission"] != row["submission"] or original["payloadHash"] != row.get("payloadHash"):
                blockers.append({"kind": "experiment", "id": experiment, "reason": "Original local submission identity differs or is unavailable"})
                continue
        if local and allocations and any(item["row"].get("deploymentId") != row["submission"].get("deploymentId")
                                         or item["row"].get("node") not in local for item in allocations):
            blockers.append({"kind": "experiment", "id": experiment, "reason": "Original node allocation differs from its fixed submission"})
            continue
        if (row.get("state") in TERMINAL or orphan) and local and all(item.get("server", {}).get("remoteRoot") == str(root) for item in local) and allocations \
                and all(item["server"]["id"] in servers for item in local) \
                and {item["row"].get("node", {}).get("server", {}).get("id") for item in allocations} == {item["server"]["id"] for item in local} \
                and all(settled.get(str(item["path"]), item["row"]).get("released") is True for item in allocations) \
                and all(item.get("released") is True for item in task_services):
            updated = {**row, "resourcesReleased": True, "services": task_services,
                       "revision": row["revision"] + 1, "updatedAt": int(time.time() * 1000)}
            if orphan:
                original_outcome = saved_outcome(row)
                updated.update(original_outcome or {"state": "interrupted", "detail": "The controller exited; all original task processes, commands and services were confirmed stopped."})
                if "questions" in row:
                    updated["questions"] = [{**question, "state": "expired"} if question.get("state") == "open" else question for question in row["questions"]]
            changes.append((entry, updated))
            continue
        reason = "Original task release or terminal outcome is not confirmed"
        if row.get("state") in ["queued", "awaiting-approval", "preparing"]:
            reason = "Pending experiment " + row.get("submission", {}).get("name", experiment) + " requires an explicit user interruption"
        elif any(item.get("server", {}).get("id") not in servers for item in local):
            reason = "Original experiment " + row.get("submission", {}).get("name", experiment) + " has unconfirmed nodes outside preparation authorization: " \
                     + json.dumps([item["server"].get("name", item["server"]["id"]) for item in local if item["server"]["id"] not in servers]) + "; open its detail page and interrupt it manually"
        blockers.append({"kind": "experiment", "id": experiment, "reason": reason})
    home = root / "state" / (role + "-home")
    identity = private_path(home / "profiles/aspera-worker/aspera-release.json", root)
    binding = json.loads(identity.read_text()).get("release") if identity.exists() else None
    active = [item for item in owned if item["role"] in [role, "agent", "planner", ""]]
    if unknown:
        blockers.append({"kind": "process", "reason": "Process ownership is not fully readable"})
    if active or alive:
        state = "active"
    elif listening(request["port"], request["timeoutSeconds"]) or blockers:
        state = "occupied"
    else:
        state = "offline"
    digest = hashlib.sha256(json.dumps({"boot": boot, "pid": pid, "owned": owned,
                                      "records": [(str(entry["path"]), entry["digest"]) for entry in node + queue]}, sort_keys=True).encode()).hexdigest()
    public = {"version": 1, "state": state, "root": str(root), "role": role, "home": str(home), "hostBootId": boot,
              "digest": digest, "savedPid": pid, "releaseBinding": binding, "processes": owned, "blockers": blockers,
              "records": [{"kind": item["table"], "id": item["key"], "released": item["row"].get("released", item["row"].get("resourcesReleased"))} for item in node + queue],
              "converged": [{"kind": entry["table"], "id": entry["key"],
                             "experimentId": entry["row"].get("experimentId", entry["row"].get("submission", {}).get("experimentId"))} for entry, _ in changes]}
    return public, changes


def endpoint(request, role, path, body=None):
    root = pathlib.Path(request["root"])
    token = (root / "secrets" / (role + ".token")).read_text().strip()
    port = request["basePort"] + (1 if role == "coordinator" else 0)
    headers = {"authorization": "Bearer " + token, "content-type": "application/json"}
    call = urllib.request.Request("http://127.0.0.1:" + str(port) + path,
                                  data=None if body is None else json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(call, timeout=request["timeoutSeconds"]) as response:
        return json.loads(response.read())


def task_processes(root, experiment, run, deployment):
    """Match durable experiment identities; workspace-only matches cannot authorize signals."""
    known = []; ambiguous = []; unreadable = []; descendants = {}
    for proc in pathlib.Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            fields = (proc / "stat").read_text().rsplit(")", 1)[1].split()
            env = dict(item.split(b"=", 1) for item in (proc / "environ").read_bytes().split(b"\0") if b"=" in item)
            cwd = os.readlink(proc / "cwd")
            pid = int(proc.name); start = fields[19]
            descendants[pid] = {"pid": pid, "start": start, "parent": int(fields[1])}
            owned = env.get(b"DSH_CLUSTER_ROOT", b"").decode() == str(root) and env.get(b"DSH_CLUSTER_EXPERIMENT", b"").decode() == experiment
            if owned:
                argv = (proc / "cmdline").read_bytes().split(b"\0")
                role = env.get(b"DSH_EXPERIMENT_ROLE", b"").decode()
                if env.get(b"DSH_EXPERIMENT_DEPLOYMENT_ID", b"").decode() != deployment or role not in ["agent", "planner"] \
                        or b"--profile" not in argv or not argv[argv.index(b"--profile") + 1].startswith(b"aspera-worker"):
                    ambiguous.append(pid)
                else:
                    known.append({"pid": pid, "start": start, "role": role})
            elif cwd == str(run) or cwd.startswith(str(run) + "/"):
                ambiguous.append(pid)
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError:
            unreadable.append(int(proc.name))
    owned_pids = {item["pid"] for item in known}
    previous = set()
    while previous != owned_pids:
        previous = set(owned_pids)
        owned_pids.update(pid for pid, item in descendants.items() if item["parent"] in owned_pids)
    for pid in owned_pids:
        if not any(item["pid"] == pid for item in known):
            known.append({**descendants[pid], "role": "agent-child"})
    ambiguous = [pid for pid in ambiguous if pid not in owned_pids]
    return known, ambiguous, unreadable


def stop_known_processes(items, timeout):
    """pidfds and start ticks bind signals to the processes inspected in this attempt."""
    if items and (not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal")):
        raise RuntimeError("This Linux Python lacks pidfd stopping; use the original authenticated node API or a compatible Python. No PID-only stop was attempted.")
    handles = []
    try:
        for item in items:
            base = pathlib.Path("/proc") / str(item["pid"])
            try:
                fd = os.pidfd_open(item["pid"])
            except ProcessLookupError:
                continue
            handles.append(fd)
            try:
                start = (base / "stat").read_text().rsplit(")", 1)[1].split()[19]
            except (FileNotFoundError, ProcessLookupError):
                continue
            if start != item["start"]:
                raise RuntimeError("Experiment process identity changed before stopping")
            try:
                signal.pidfd_send_signal(fd, signal.SIGTERM)
            except ProcessLookupError:
                continue
        remaining = list(handles)
        deadline = time.monotonic() + timeout
        while remaining and time.monotonic() < deadline:
            exited = select.select(remaining, [], [], max(0, deadline - time.monotonic()))[0]
            remaining = [fd for fd in remaining if fd not in exited]
        for fd in remaining:
            signal.pidfd_send_signal(fd, signal.SIGKILL)
        if remaining and len(select.select(remaining, [], [], timeout)[0]) != len(remaining):
            raise RuntimeError("Experiment process exit remains unconfirmed")
    finally:
        for fd in handles:
            os.close(fd)


def command_processes(commands, run, server_id, deployment, root, boot):
    known = []; ready = {}; errors = []; identities = []
    for entry in commands:
        row = entry["row"]
        if row.get("released") is True:
            ready[entry["key"]] = True
            continue
        identity = private_path(run / "process-identities" / (row["commandId"] + ".v1.json"), run)
        if not identity.exists():
            errors.append("Original command " + row["commandId"] + " has no durable process identity")
            ready[entry["key"]] = False
            continue
        raw = identity.read_bytes(); value = json.loads(raw)
        identities.append((str(identity), hashlib.sha256(raw).hexdigest()))
        if value.get("version") != 1 or value.get("experimentId") != row["experimentId"] or value.get("serverId") != server_id \
                or value.get("commandId") != row["commandId"] or value.get("pid") != value.get("group") \
                or not isinstance(value.get("pid"), int) or value["pid"] <= 0 or not isinstance(value.get("start"), str) \
                or not value["start"].isdigit() or not isinstance(value.get("hostBootId"), str) \
                or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", value["hostBootId"]) \
                or value.get("deploymentId") != deployment or value.get("controlRoot") != str(root):
            errors.append("Command process-group identity is unavailable or belongs to another command")
            ready[entry["key"]] = False
            continue
        members = []; leader_confirmed = False
        if value["hostBootId"] == boot:
            for proc in pathlib.Path("/proc").iterdir():
                if not proc.name.isdigit():
                    continue
                try:
                    fields = (proc / "stat").read_text().rsplit(")", 1)[1].split()
                    if int(fields[2]) == value["group"]:
                        if int(proc.name) == value["pid"] and fields[19] != value["start"]:
                            raise RuntimeError("Command PID was reused; its original range is not confirmable")
                        if int(proc.name) == value["pid"]:
                            leader_confirmed = True
                        if fields[0] != "Z":
                            members.append({"pid": int(proc.name), "start": fields[19], "role": "command"})
                except (FileNotFoundError, ProcessLookupError):
                    continue
        if members and not leader_confirmed:
            errors.append("Original command leader exited; remaining group ownership requires its original authenticated API")
            ready[entry["key"]] = False
            continue
        known.extend(members); ready[entry["key"]] = not members
    return known, ready, errors, identities


def interrupt(request):
    root = pathlib.Path(request["root"]); submission = request["submission"]
    experiment = str(uuid.UUID(submission["experimentId"]))
    operation = str(uuid.UUID(request["status"]["operationId"]))
    server = request["server"]
    if server["id"] != request["serverId"] or server["remoteRoot"] != str(root) or not any(item["server"] == server for item in submission["nodes"]):
        raise RuntimeError("Interruption server differs from the original submission")
    run = run_path(server, experiment)
    if request["status"]["experimentId"] != experiment or {node["serverId"] for node in request["status"]["nodes"]} != {node["server"]["id"] for node in submission["nodes"]}:
        raise RuntimeError("Interruption receipt omits an original node")
    node = [entry for entry in records(root / "state/node-home", "aspera_node", ["allocations", "commands", "services"])
            if entry["row"].get("experimentId") == experiment]
    queue = [entry for entry in records(root / "state/coordinator-home", "aspera_queue", ["experiments"])
             if entry["row"].get("submission", {}).get("experimentId") == experiment]
    coordinator = submission["coordinator"]["id"] == server["id"]
    if coordinator:
        if len(queue) != 1 or queue[0]["row"].get("submission") != submission or queue[0]["row"].get("payloadHash") != request["status"]["submissionHash"]:
            raise RuntimeError("Original coordinator submission or ledger record is missing")
    for entry in node:
        if entry["table"] == "allocations" and (entry["row"].get("node") not in submission["nodes"] or entry["row"].get("node", {}).get("server") != server or entry["row"].get("deploymentId") != submission["deploymentId"]):
            raise RuntimeError("Node allocation belongs to another original release or directory")
    boot = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    agents, ambiguous, unreadable = task_processes(root, experiment, run, submission["deploymentId"])
    commands = [entry for entry in node if entry["table"] == "commands"]
    services = [entry for entry in node if entry["table"] == "services"]
    command_members, ready_commands, identity_errors, identities = command_processes(commands, run, server["id"], submission["deploymentId"], root, boot)
    ambiguous = [pid for pid in ambiguous if not any(item["pid"] == pid for item in command_members)]
    blockers = list(identity_errors)
    if ambiguous or unreadable:
        blockers.append("Process ownership is not fully confirmable; original-release process identities are missing")
    command_released = all(entry["row"].get("released") is True for entry in commands)
    commands_ready = all(ready_commands.values())
    service_listeners = {entry["key"]: service_listening(entry["row"], request["timeoutSeconds"]) for entry in services}
    service_released = all(entry["row"].get("released") is True and not service_listeners[entry["key"]] for entry in services)
    services_ready = all(ready_commands.get(experiment + "_" + entry["row"].get("commandId", ""), False)
                         and not service_listeners[entry["key"]] for entry in services)
    if not commands_ready:
        blockers.append("Original command processes have not exited")
    if not services_ready:
        blockers.append("Original inference-service command or listener exit is unconfirmed")
    digest = hashlib.sha256(json.dumps({"boot": boot, "records": [(str(entry["path"]), entry["digest"]) for entry in node + queue],
                                       "agents": agents, "commands": command_members, "ambiguous": ambiguous, "unreadable": unreadable,
                                       "identities": identities, "readyCommands": ready_commands, "serviceListeners": service_listeners,
                                       "blockers": blockers}, sort_keys=True).encode()).hexdigest()
    facts = {"serverId": server["id"], "agentsExited": not agents and not ambiguous and not unreadable,
             "commandsReleased": command_released, "servicesReleased": service_released, "digest": digest,
             "commandsReady": commands_ready, "servicesReady": services_ready,
             "blockers": blockers, "hostBootId": boot, "agents": agents, "commands": command_members}
    if coordinator:
        facts["state"] = queue[0]["row"]["state"]
        controllers, unidentified = processes(root)
        facts["coordinatorExited"] = not unidentified and not any(item["role"] == "coordinator" for item in controllers)
    journal_path = private_path(run / "interruption.v1.json", run)
    if journal_path.exists():
        receipt = json.loads(journal_path.read_text())
        if receipt.get("experimentId") != experiment or receipt.get("submissionHash") != request["status"]["submissionHash"]:
            raise RuntimeError("Original interruption receipt has another submission")
        if receipt.get("operationId") == operation:
            facts["receipt"] = receipt
    if request["mode"] == "interrupt-inspect":
        return facts
    if coordinator and not request["status"]["stopRequested"] and facts["state"] not in TERMINAL:
        if facts["state"] not in STARTED:
            raise RuntimeError("Pending task requires an explicit user interruption")
        if not facts["coordinatorExited"]:
            raise RuntimeError("Automatic task settlement requires an exited original coordinator or a confirmed terminal result")
    lock = private_path(root / "state/controller-admission.lock", root)
    fence = private_path(root / "state/interruption-fences" / (experiment + ".json"), root)
    journal = private_path(run / "interruption.v1.json", run)
    with open(lock, "a") as handle:
        os.chmod(lock, 0o600); fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fresh = interrupt({**request, "mode": "interrupt-inspect"})
        if fresh["digest"] != digest:
            raise RuntimeError("Experiment observations changed before admission lock")
        if fence.exists():
            previous = json.loads(fence.read_text())
            if previous.get("operationId") != operation or previous.get("submissionHash") != request["status"]["submissionHash"]:
                raise RuntimeError("Another interruption owns this experiment")
        if request["mode"] == "interrupt-fence":
            atomic(fence, {"version": 1, "operationId": operation, "experimentId": experiment,
                           "submissionHash": request["status"]["submissionHash"], "hostBootId": boot})
            atomic(journal, request["status"])
            return facts
        if request["mode"] == "interrupt-unfence" and not fence.exists() and journal.exists():
            saved = json.loads(journal.read_text())
            if saved.get("phase") == "released" and saved.get("operationId") == operation and saved.get("submissionHash") == request["status"]["submissionHash"]:
                return {"released": True}
        if not fence.exists():
            raise RuntimeError("Interruption admission fence is missing")
        if request.get("expectedDigest") != digest:
            raise RuntimeError("Experiment state changed; recheck its original processes and records")
        if request["mode"] == "interrupt-stop":
            if not request["status"]["stopRequested"]:
                raise RuntimeError("Automatic reconciliation cannot stop an active experiment")
            if ambiguous or unreadable:
                raise RuntimeError("Experiment process identities cannot authorize stopping")
            if identity_errors:
                raise RuntimeError("Original command identities cannot authorize stopping: " + json.dumps(identity_errors))
            stop_known_processes(agents + command_members, request["cleanupSeconds"])
            return {"stopped": True, "operationId": operation}
        if blockers or agents:
            raise RuntimeError("Experiment release remains unconfirmed: " + json.dumps(facts))
        if request["mode"] == "interrupt-settle":
            node_pid = root / "state/node.pid"
            node_alive = node_pid.exists() and node_pid.read_text().strip().isdigit() and (pathlib.Path("/proc") / node_pid.read_text().strip()).exists()
            for entry in node:
                if entry["table"] == "commands" and entry["row"].get("released") is not True:
                    if node_alive:
                        raise RuntimeError("Online node commands must be settled through the original authenticated API")
                    row = entry["row"]
                    patch = {"released": True}
                    if row["state"] in ["starting", "running"]:
                        patch.update(state="failed", detail="The original command range exited during interruption; no exit code was recorded.")
                    atomic(entry["path"], {**entry["document"], "record": {**row, **patch}})
                if entry["table"] == "services" and entry["row"].get("released") is not True:
                    if node_alive:
                        raise RuntimeError("Online node services must be settled through the original authenticated API")
                    row = entry["row"]; patch = {"released": True}
                    if row["state"] not in STOPPED_SERVICES:
                        patch["state"] = "stopped" if request["status"]["stopRequested"] else "interrupted"
                    if "external" in row:
                        patch["external"] = {**row["external"], "state": "stopped", "checkedAt": int(time.time() * 1000)}
                    atomic(entry["path"], {**entry["document"], "record": {**row, **patch}})
                if entry["table"] == "allocations" and entry["row"].get("released") is not True:
                    if node_alive:
                        raise RuntimeError("Online node release must be confirmed through its original authenticated API")
                    atomic(entry["path"], {**entry["document"], "record": {**entry["row"], "released": True, "releasing": False}})
            atomic(journal, request["status"])
            return {**facts, "released": True}
        if request["mode"] == "interrupt-publish":
            if request["status"]["phase"] != "released" or any(item["phase"] != "released" for item in request["status"]["nodes"]):
                raise RuntimeError("Interruption completion omits a released node")
            atomic(journal, request["status"])
            return {"released": True}
        if request["mode"] == "interrupt-complete":
            if not coordinator or any(item["phase"] != "released" for item in request["status"]["nodes"]):
                raise RuntimeError("Every original node must confirm release before closing the experiment")
            pidfile = root / "state/coordinator.pid"
            if (pidfile.exists() and pidfile.read_text().strip().isdigit() and (pathlib.Path("/proc") / pidfile.read_text().strip()).exists()) \
                    or listening(request["basePort"] + 1, request["timeoutSeconds"]):
                raise RuntimeError("An online coordinator must close its ledger through the original API")
            entry = queue[0]; row = entry["row"]
            if not request["status"]["stopRequested"] and row["state"] not in STARTED and row["state"] not in TERMINAL:
                raise RuntimeError("Queued and awaiting-approval experiments require an explicit user interruption")
            original_outcome = saved_outcome(row)
            state = row["state"] if row["state"] in TERMINAL else original_outcome["state"] if original_outcome is not None else "cancelled" if request["status"]["stopRequested"] else "interrupted"
            settled_services = []
            for item in row.get("services", []):
                updated_service = {**item, "released": True}
                if item["state"] not in STOPPED_SERVICES:
                    updated_service["state"] = "stopped" if request["status"]["stopRequested"] else "interrupted"
                if "external" in item:
                    updated_service["external"] = {**item["external"], "state": "stopped", "checkedAt": int(time.time() * 1000)}
                settled_services.append(updated_service)
            questions = [{**item, "state": "expired"} if item["state"] == "open" else item for item in row.get("questions", [])]
            unchanged = row["state"] in TERMINAL and row["resourcesReleased"] is True and settled_services == row.get("services", []) and questions == row.get("questions", [])
            updated = dict(row) if unchanged else {**row, "state": state, "resourcesReleased": True, "revision": row["revision"] + 1,
                       "updatedAt": int(time.time() * 1000), "services": settled_services}
            if row["state"] not in TERMINAL:
                updated.update(original_outcome or {"detail": "The user interrupted the experiment; all original resources were confirmed released." if request["status"]["stopRequested"] else "The controller exited; all original task resources were confirmed released."})
            if "questions" in row:
                updated["questions"] = questions
            finished = {**request["status"], "phase": "released", "updatedAt": updated["updatedAt"], "result": updated}
            atomic(journal, finished)
            atomic(entry["path"], {**entry["document"], "record": updated})
            return {"record": updated, "status": finished}
        if request["mode"] == "interrupt-unfence":
            if json.loads(journal.read_text()).get("phase") != "released":
                raise RuntimeError("Interruption release receipt is still incomplete")
            fence.unlink()
            return {"released": True}
        raise RuntimeError("Unknown interruption operation")


def discover(request):
    """Read only selected original submissions and cross-check their local node allocations."""
    root = pathlib.Path(request["root"])
    selected = {str(uuid.UUID(value)) for value in request["experimentIds"]}
    node = records(root / "state/node-home", "aspera_node", ["allocations"])
    queue = records(root / "state/coordinator-home", "aspera_queue", ["experiments"])
    found = []
    for entry in queue:
        row = entry["row"]; submission = row["submission"]
        if submission["experimentId"] not in selected:
            continue
        coordinator = submission.get("coordinator", {})
        if submission.get("protocol") != 4 or coordinator.get("id") != request["serverId"] or coordinator.get("remoteRoot") != str(root):
            raise RuntimeError("Original submission belongs to another coordinator")
        peers = [peer for peer in submission.get("nodes", []) if peer.get("server") == coordinator]
        allocations = [item["row"] for item in node if item["row"].get("experimentId") == submission["experimentId"]]
        if len(peers) != 1 or len(allocations) != 1 or allocations[0].get("node") != peers[0] \
                or allocations[0].get("deploymentId") != submission.get("deploymentId"):
            raise RuntimeError("Original submission and coordinator-node allocation identity differ")
        found.append(row)
    return {"records": found}


def run(request):
    role = request["role"]
    if role not in ["node", "coordinator"]:
        raise RuntimeError("Unknown controller role")
    root = pathlib.Path(request["root"])
    owner = json.loads(private_path(root / ".aspera-owner.json", root).read_text())
    if owner != {"version": 1, "serverId": request["serverId"], "kind": "control"}:
        raise RuntimeError("Control directory identity differs from the selected server")
    if request["mode"] == "discover":
        return discover(request)
    if request["mode"].startswith("interrupt-"):
        return interrupt(request)
    if request["mode"] == "inspect":
        return inspect(request)[0]
    operation = str(uuid.UUID(request["operationId"]))
    directory = private_path(pathlib.Path(request["directory"]), pathlib.Path(request["runRoot"]))
    if directory != pathlib.Path(request["runRoot"]) / "controller-repairs" / role / operation:
        raise RuntimeError("Recovery receipt belongs to another operation")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    gate = private_path(root / "state/controller-recovery.json", root)
    lock = private_path(root / "state/controller-admission.lock", root)
    with open(lock, "a") as handle:
        os.chmod(lock, 0o600); fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if request["mode"] == "begin":
            resume = None
            if gate.exists():
                saved = json.loads(gate.read_text())
                if saved.get("operationId") != operation or saved.get("directory") != str(directory):
                    raise RuntimeError("Another recovery owns controller admission")
                if saved.get("hostBootId") != pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip():
                    raise RuntimeError("Host boot changed during recovery")
                if saved.get("phase") == "fenced":
                    return saved
                if saved.get("phase") != "fencing":
                    raise RuntimeError("Unknown recovery phase")
                resume = saved
            value, changes = inspect(request)
            if value["state"] != "offline" or (resume is None and value["digest"] != request["expectedDigest"]):
                raise RuntimeError("Controller state changed or release is unconfirmed: " + json.dumps(value))
            other = "node" if role == "coordinator" else "coordinator"
            fenced = None
            if listening(request["basePort"] + (1 if other == "coordinator" else 0), request["timeoutSeconds"]):
                health = endpoint(request, other, "/aspera/v1/health")
                status = health["controller"]
                if "controller-maintenance-v1" not in health.get("features", []) or status.get("root") != str(root) or status.get("role") != other:
                    raise RuntimeError("The online counterpart cannot safely pause admission")
                fenced = {"role": other, "bootId": status["bootId"], "policyDigest": status["policyDigest"], "operationId": operation}
                if resume is not None and resume.get("counterpart") != fenced:
                    raise RuntimeError("Counterpart identity changed during admission fencing")
            saved_fence = {"version": 1, "operationId": operation, "directory": str(directory), "phase": "fencing", "counterpart": fenced,
                           "hostBootId": value["hostBootId"], "interruptions": [] if resume is None else resume.get("interruptions", [])}
            atomic(gate, saved_fence)
            if fenced is not None:
                endpoint(request, other, "/aspera/v1/" + ("node/" if other == "node" else "") + "maintenance-begin", {key: fenced[key] for key in ["bootId", "policyDigest", "operationId"]})
            value, changes = inspect(request)
            if value["state"] != "offline":
                raise RuntimeError("Controller occupancy changed after fencing")
            interruptions = list(saved_fence["interruptions"])
            for entry, row in changes:
                if hashlib.sha256(entry["path"].read_bytes()).hexdigest() != entry["digest"]:
                    raise RuntimeError("Controller storage changed during recovery")
                if entry["table"] == "experiments":
                    receipt_path, interruption = interruption_receipt(request, row)
                    atomic(receipt_path, interruption)
                    interruptions.append(interruption)
                    atomic(gate, {**saved_fence, "interruptions": interruptions})
                atomic(entry["path"], {**entry["document"], "record": row})
            receipt = {"version": 1, "operationId": operation, "directory": str(directory), "phase": "fenced", "counterpart": fenced,
                       "hostBootId": value["hostBootId"], "role": role, "release": request["release"], "converged": value["converged"], "interruptions": interruptions}
            atomic(gate, receipt); atomic(directory / "offline.json", receipt)
            return receipt
        if request["mode"] == "complete" and not gate.exists():
            finished = json.loads((directory / "recovery.json").read_text())
            if finished.get("operationId") != operation or finished.get("directory") != str(directory) or finished.get("phase") != "completed":
                raise RuntimeError("Recovery completion is unconfirmed")
            return {"completed": True, "operationId": operation}
        saved = json.loads(gate.read_text())
        if saved.get("operationId") != operation or saved.get("directory") != str(directory) or saved.get("phase") != "fenced":
            raise RuntimeError("Recovery fence is unconfirmed or has another owner")
        if saved.get("hostBootId") != pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip():
            raise RuntimeError("Host boot changed before recovery completion")
        if request["mode"] == "complete":
            if saved.get("counterpart"):
                other = saved["counterpart"]
                endpoint(request, other["role"], "/aspera/v1/" + ("node/" if other["role"] == "node" else "") + "maintenance-cancel", {key: other[key] for key in ["bootId", "policyDigest", "operationId"]})
            atomic(directory / "recovery.json", {**saved, "phase": "completed"})
            gate.unlink()
            return {"completed": True, "operationId": operation}
        raise RuntimeError("Unknown recovery operation")


if __name__ == "__main__":
    try:
        print(json.dumps(run(json.loads(sys.argv[1]))))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
