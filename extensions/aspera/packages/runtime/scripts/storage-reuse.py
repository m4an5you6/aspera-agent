"""Resumable, account-owned discovery and read-only source verification."""


class StorageReuse:
    def __init__(self, governance):
        self.g = governance
        self.owner = governance.owner

    def directory(self, kind, operation):
        return self.g.run / "reuse-verifications-v1" / kind / operation

    @contextlib.contextmanager
    def mount_page(self):
        g = self.g
        table = pathlib.Path("/proc/self/mountinfo")
        if not table.exists() or hasattr(g, "_scan_mount_table"):
            yield
            return
        original = table.read_text()
        g._scan_mount_table = original
        try:
            yield
            if table.read_text() != original:
                raise RuntimeError("Mount topology changed during historical discovery; verify the current storage identity")
        finally:
            del g._scan_mount_table
            if hasattr(g, "_scan_mount_entries"):
                del g._scan_mount_entries

    def discover(self, kind, operation, deadline, material=None):
        with self.mount_page():
            return self.discover_page(kind, operation, deadline, material)

    @contextlib.contextmanager
    def verification_page(self):
        """Reuse registration observations within one verification and reject changes before publishing."""
        g = self.g
        if hasattr(g, "_reuse_registration_roots"):
            yield
            return
        with self.mount_page():
            roots, errors = g.roots()
            g._reuse_registration_roots = roots
            try:
                yield
            finally:
                del g._reuse_registration_roots
            if g.roots() != (roots, errors):
                raise RuntimeError("Storage registration changed during historical verification; retain the source and inspect again")

    def discover_page(self, kind, operation, deadline, material=None):
        g = self.g
        folder = self.directory(kind, operation)
        path = folder / "discovery.v1.json"
        roots, errors = g.roots()
        fingerprint = digest([[row["directory"], row.get("registrationId"), row["confirmed"],
            g.mount(row["directory"]) if row["confirmed"] else None] for row in roots])
        if path.exists():
            state = governance_row(path)
            if any(state.get(key) != expected for key, expected in (("experimentId", g.experiment), ("serverId", g.server), ("operationId", operation), ("kind", kind))):
                raise RuntimeError("Historical discovery belongs to another operation or allocation")
            if state["deadline"] != deadline:
                raise RuntimeError("Historical discovery cannot extend its original verification deadline")
            if state["fingerprint"] != fingerprint:
                raise RuntimeError("Discovery storage identity changed; retain the old operation and verify the current registration")
        else:
            state = {"version": 1, "experimentId": g.experiment, "serverId": g.server, "operationId": operation,
                "kind": kind, "fingerprint": fingerprint, "deadline": deadline, "todo": [], "candidates": [],
                "entriesScanned": 0, "diagnostics": errors, "complete": False, "checkedAt": now()}
            # Original owned roots remain discoverable after the local experiment row is deleted.
            for root in roots:
                if root["confirmed"]:
                    state["todo"].append({"path": str(pathlib.Path(root["directory"]) / "runs"),
                        "root": root["directory"], "runs": True, "offset": 0})
            hints = []
            for saved in sorted(g.root.glob("catalog*.v1.json")):
                catalog = governance_row(saved)
                hints.extend(catalog.get("materialCandidates" if kind == "material" else "historicalEnvironments", []))
            for hint in hints:
                directory = pathlib.Path(hint["directory"])
                root = next((row for row in roots if row["confirmed"] and directory.is_relative_to(row["directory"])), None)
                if root is not None and directory.exists():
                    state["todo"].append({"path": str(directory), "root": root["directory"], "offset": 0})
            if kind == "environment":
                for root in roots:
                    if root["confirmed"]:
                        state["todo"].append({"path": str(pathlib.Path(root["directory"]) / "runs"),
                            "root": root["directory"], "runs": True, "registered": True, "offset": 0})
        save(path, state)
        end = min(deadline, now() + g.policy["scanTimeoutMs"])
        remaining = g.policy["scanEntryLimit"]
        checkpoint_at = time.monotonic()
        candidate_count = len(state["candidates"])
        while state["todo"] and remaining > 0 and now() < end:
            frame = state["todo"].pop()
            directory = pathlib.Path(frame["path"])
            try:
                if ".." in directory.parts:
                    raise RuntimeError("Historical discovery path escapes its owned workspace")
                reject_links(directory)
                if not directory.exists():
                    continue
                root = next(row for row in roots if row["directory"] == frame["root"] and row["confirmed"])
                if g.mount(directory)["mountId"] != g.mount(root["directory"])["mountId"]:
                    raise RuntimeError("Nested mount excluded from historical discovery")
                identity = governance_identity(directory)
                if frame.get("offset") and frame["identity"] != identity:
                    raise RuntimeError("Directory changed during resumable source discovery")
                if not frame.get("runs"):
                    relative_name = directory.relative_to(root["directory"]).parts
                    if len(relative_name) < 3 or relative_name[0] != "runs" or relative_name[2] != "workspace":
                        raise RuntimeError("Historical discovery escaped an owned workspace")
                    run = pathlib.Path(root["directory"]) / "runs" / relative_name[1]
                    if governance_row(run / ".aspera-owner.json") != {"version": 1, "serverId": g.server, "experimentId": run.name}:
                        raise RuntimeError("Historical discovery ownership differs")
                    if (directory / "pyvenv.cfg").is_file():
                        if kind == "environment":
                            candidate = g.candidate(run, directory, pathlib.Path(root["directory"]))
                            if candidate and candidate["id"] not in {row["id"] for row in state["candidates"]}:
                                state["candidates"].append(candidate)
                        save(path, state)
                        continue
                    if kind == "material" and material and any((directory / relative(row["path"])).exists() for row in material["files"]):
                        candidate = g.material_candidate(directory, root)
                        if candidate and candidate["id"] not in {row["id"] for row in state["candidates"]}:
                            state["candidates"].append(candidate)
                with os.scandir(directory) as entries:
                    offset = frame.get("offset", 0)
                    for index, entry in enumerate(entries):
                        if index < offset:
                            continue
                        if remaining <= 0 or now() >= end:
                            state["todo"].insert(0, {**frame, "offset": index, "identity": identity})
                            break
                        remaining -= 1
                        state["entriesScanned"] += 1
                        if entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
                            continue
                        if frame.get("runs"):
                            if entry.name == g.experiment:
                                continue
                            run = pathlib.Path(entry.path)
                            marker = run / ".aspera-owner.json"
                            if not marker.exists():
                                continue
                            if governance_row(marker) != {"version": 1, "serverId": g.server, "experimentId": run.name}:
                                raise RuntimeError("Historical run ownership differs: " + str(run))
                            if frame.get("registered"):
                                workspace = source_training_workspace(self.owner, run)
                                manifest_offset = frame.get("manifestOffset", 0) if index == offset else 0
                                for manifest_index, manifest in enumerate(sorted((run / "environments-v1").glob("*.json"))):
                                    if manifest_index < manifest_offset:
                                        continue
                                    if remaining <= 0 or now() >= end:
                                        state["todo"].append({**frame, "offset": index, "manifestOffset": manifest_index, "identity": identity})
                                        state.update(checkedAt=now(), complete=False)
                                        save(path, state)
                                        return state
                                    remaining -= 1
                                    state["entriesScanned"] += 1
                                    try:
                                        reject_links(manifest)
                                        saved = governance_row(manifest)
                                        if saved.get("version") != 1 or saved.get("serverId") != g.server or saved.get("experimentId") != run.name \
                                                or manifest.name != str(saved.get("environmentId")) + ".json" or saved.get("state") != "ready" \
                                                or saved.get("verification", {}).get("verified") is not True:
                                            continue
                                        environment = pathlib.Path(saved["directory"])
                                        if not environment.is_relative_to(workspace) or environment == workspace or saved.get("python") != str(environment / "bin/python"):
                                            raise RuntimeError("Registered historical environment differs from its owned training workspace")
                                        if g.mount(environment)["mountId"] != g.mount(workspace)["mountId"]:
                                            raise RuntimeError("Nested mount excluded from registered historical environment discovery")
                                        candidate = g.candidate(run, environment, pathlib.Path(root["directory"]))
                                        if candidate and candidate["id"] not in {row["id"] for row in state["candidates"]}:
                                            state["candidates"].append(candidate)
                                    except (OSError, RuntimeError, ValueError, KeyError) as error:
                                        state["diagnostics"].append(str(manifest) + ": " + str(error))
                                continue
                            target = run / "workspace"
                        else:
                            if entry.name in ("node_modules", ".git", "site-packages", "__pycache__", "logs", "reports", "tmp", ".aspera-installations") or entry.name.startswith("checkpoint-"):
                                continue
                            target = pathlib.Path(entry.path)
                        state["todo"].append({"path": str(target), "root": root["directory"], "offset": 0})
            except (OSError, RuntimeError, ValueError) as error:
                state["diagnostics"].append(str(directory) + ": " + str(error))
            state.update(checkedAt=now(), complete=not state["todo"] and not state["diagnostics"])
            if len(state["candidates"]) > candidate_count:
                save(path, state)
                break
            if time.monotonic() - checkpoint_at >= self.owner.policy["operationPollIntervalMs"] / 1000:
                save(path, state)
                checkpoint_at = time.monotonic()
        state.update(checkedAt=now(), complete=not state["todo"] and not state["diagnostics"])
        save(path, state)
        return state

    def hash_file(self, path, deadline):
        g = self.g
        identity = governance_identity(path)
        registration = g.registration_id(path)
        key = digest([str(path), identity, registration])
        proof = g.root / "reuse-file-proofs-v1" / (key + ".json")
        if proof.exists():
            value = governance_row(proof)
            if value["serverId"] == g.server and value["identity"] == identity and value["registrationId"] == registration and value["path"] == str(path):
                return value["hash"]
        checksum = hashlib.sha256()
        with open(path, "rb") as stream:
            while True:
                if now() >= deadline:
                    raise TimeoutError("Original historical environment verification budget expired")
                chunk = stream.read(g.policy["transferChunkBytes"])
                if not chunk:
                    break
                checksum.update(chunk)
        if governance_identity(path) != identity:
            raise RuntimeError("Historical file changed during verification: " + str(path))
        result = checksum.hexdigest()
        save(proof, {"version": 1, "serverId": g.server, "path": str(path), "identity": identity,
            "registrationId": registration, "hash": result, "checkedAt": now()})
        return result

    def cache_files(self, material):
        directory = pathlib.Path(material["directory"])
        roots = []
        for parent in (directory, *directory.parents):
            if parent.name == "snapshots" and parent.parent.name.startswith(("models--", "datasets--")):
                roots.append(parent.parent)
            if parent.name in ("modelscope", "hub") and "modelscope" in parent.parts:
                roots.append(parent)
        result = {}
        for row in material["files"]:
            path = directory / relative(row["path"])
            if not path.is_symlink():
                continue
            target = path.resolve(strict=True)
            if not roots or not any(target.is_relative_to(root) for root in roots):
                raise RuntimeError("Historical cache link escapes its authorized repository cache: " + row["path"])
            reject_links(target)
            if self.g.mount(target)["mountId"] != self.g.mount(directory)["mountId"]:
                raise RuntimeError("Nested mount rejected for historical cache content")
            result[row["path"]] = str(target)
        return result

    def borrow_environment(self, request):
        g = self.g
        if not request["requirements"] and request.get("reuseCandidateId") is None and not (g.bindings / (request["environmentId"] + ".json")).exists():
            return None
        folder = self.directory("environment", request["operationId"])
        context = folder / "request.v1.json"
        signature = digest(request)
        if context.exists():
            original = governance_row(context)
            if original["requestHash"] != signature or original.get("experimentId") != g.experiment or original.get("serverId") != g.server or original.get("operationId") != request["operationId"]:
                raise RuntimeError("Historical environment verification request changed")
            deadline = original["deadline"]
        else:
            deadline = now() + g.policy["verificationTimeoutMs"]
            save(context, {"version": 1, "experimentId": g.experiment, "serverId": g.server,
                "operationId": request["operationId"], "requestHash": signature, "deadline": deadline})
        g._reuse_deadline = deadline
        binding = g.bindings / (request["environmentId"] + ".json")
        chosen = folder / "selection.v1.json"
        candidate_id = request.get("reuseCandidateId")
        if binding.exists():
            original = governance_row(binding)
            candidate_id = original["candidateId"]
            request = {**request, "requirements": sorted(set(original["requirements"] + request["requirements"]))}
            if request["action"] in ("install", "make-writable"):
                raise RuntimeError("Borrowed historical environment is immutable; retain its original binding")
        if chosen.exists():
            selected = governance_row(chosen)
            if selected.get("experimentId") != g.experiment or selected.get("serverId") != g.server or selected.get("operationId") != request["operationId"]:
                raise RuntimeError("Environment selection belongs to another operation or allocation")
            if candidate_id and candidate_id != selected["candidateId"]:
                raise RuntimeError("Environment source differs from its saved selection")
            candidate_id = selected["candidateId"]
        elif request["action"] not in ("create", "install", "verify-reuse") and candidate_id is None:
            return None
        tried, diagnostics = set(), []
        while now() < deadline:
            if candidate_id:
                candidates = [g.find_candidate(candidate_id)]
                complete = True
            else:
                discovery = self.discover("environment", request["operationId"], deadline)
                candidates = sorted(discovery["candidates"], key=lambda row: row["id"])
                complete = discovery["complete"]
                diagnostics = list(dict.fromkeys(diagnostics + discovery["diagnostics"]))
                if hasattr(self.owner, "plan_stage"):
                    self.owner.plan_stage("checking-reuse")
            for candidate in candidates:
                if candidate["id"] in tried:
                    continue
                tried.add(candidate["id"])
                try:
                    self.hold_source("environment", request["operationId"], candidate)
                    cached = None if request.get("recheckSource") else environment_repair(self.owner).cached_failure(candidate)
                    if cached is not None:
                        raise cached
                    value = g.verify_borrowed(candidate, request)
                except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
                    environment_repair(self.owner).diagnose(request, error, candidate)
                    diagnostics.append(candidate["id"] + ": " + str(error))
                    if candidate_id:
                        raise
                    continue
                with g.locked():
                    g.find_candidate(candidate["id"])
                    g.source_released(candidate["sourceExperimentId"], pathlib.Path(candidate["runRoot"]))
                    save(chosen, {"version": 1, "experimentId": g.experiment, "serverId": g.server,
                        "operationId": request["operationId"], "candidateId": candidate["id"], "checkedAt": now(), "additionalBytes": 0})
                    if request["action"] != "verify-reuse":
                        save(pathlib.Path(value["lease"]), value)
                        save(binding, value)
                return value
            save(folder / "progress.v1.json", {"version": 1, "experimentId": g.experiment, "serverId": g.server,
                "operationId": request["operationId"], "state": "discovering" if not complete else "blocked" if diagnostics else "missing",
                "deadline": deadline, "checkedAt": now(), "diagnostics": diagnostics, "complete": complete})
            if complete:
                if diagnostics:
                    raise RuntimeError("Historical environment candidates failed verification: " + "; ".join(diagnostics))
                return None
            if not discovery["todo"]:
                raise RuntimeError("Historical environment discovery remains incomplete: " + "; ".join(diagnostics))
        raise TimeoutError("Original historical environment verification budget expired; preserve discovery and recover its exit")

    def hold_source(self, kind, operation, candidate):
        g = self.g
        admission = g.control / "state/controller-admission.lock"
        reject_links(admission)
        admission.parent.mkdir(parents=True, exist_ok=True)
        with g.locked(), open(admission, "a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            g.source_released(candidate["sourceExperimentId"], pathlib.Path(candidate["runRoot"]))
            source = {key: candidate[key] for key in ("sourceExperimentId", "runRoot", "directory")}
            g.retain_material_source(digest([kind, operation, candidate["id"]]), source)

    def assessment_request(self, request):
        g = self.g
        value = copy.deepcopy(request)
        key = digest([g.config.get("evidenceContext", {}), request["environmentId"]])
        path = g.run / "storage-reuse-requirements-v1" / (key + ".json")
        previous = governance_row(path) if path.exists() else {"requirements": [], "materialIds": []}
        unresolved = []
        modern = g.config.get("storagePreflightVersion") == 2
        registered = set(previous["requirements"])
        if modern:
            # Trial declarations are not the published dependency set; environment installation owns it.
            environment = self.owner.environment(request["environmentId"])
            registered = set(environment["requirements"]) if environment is not None else set()
            binding_path = g.bindings / (request["environmentId"] + ".json")
            if binding_path.exists():
                binding = governance_row(binding_path)
                g.environment_satisfies({"environmentId": request["environmentId"], "requirements": binding["requirements"]})
                registered.update(binding["requirements"])
        missing = sorted(registered - set(request["requirements"]))
        if missing:
            unresolved.append("Registered environment requirements are omitted: " + ", ".join(missing)
                + "; retain them or use the environment installation tool to change the registered dependency set" if modern
                else "Previously registered environment requirements are omitted; retain the approved dependency set")
        if not set(previous["materialIds"]).issubset(request["materialIds"]):
            unresolved.append("Previously registered fixed materials are omitted; retain the complete capacity requirement set")
        if not modern and (request["outputBytes"] < previous.get("outputBytes", 0) or request["checkpointBytes"] < previous.get("checkpointBytes", 0)):
            unresolved.append("Registered output or checkpoint reserves cannot be reduced without a new approved plan")
        save(path, {"version": 1, "experimentId": g.experiment, "serverId": g.server,
            "requirements": sorted(registered if modern else registered | set(request["requirements"])),
            "materialIds": sorted(set(previous["materialIds"] + request["materialIds"])),
            "outputBytes": request["outputBytes"] if modern else max(previous.get("outputBytes", 0), request["outputBytes"]),
            "checkpointBytes": request["checkpointBytes"] if modern else max(previous.get("checkpointBytes", 0), request["checkpointBytes"]), "checkedAt": now()})
        choices = {row["materialId"]: row for row in value.get("materialSources", [])}
        for identifier in request["materialIds"]:
            if identifier in choices:
                continue
            selected = []
            for folder in (g.run / "material-operations-v1").glob("*"):
                receipt = folder / "receipt.v1.json"
                if not receipt.exists():
                    continue
                row = governance_row(receipt)
                verified_partial = row.get("verificationComplete") is True and row.get("material", {}).get("unknownBytes", 0) == 0
                if row["materialId"] != identifier or row.get("action") != "verify" or not (row.get("state") == "completed" or row.get("state") == "blocked" and verified_partial) or not row.get("exitConfirmed") or not row.get("admissionReleased"):
                    continue
                selected.append(row)
            selected.sort(key=lambda row: (-row["updatedAt"], row["operationId"]))
            for row in selected:
                choice = {"materialId": identifier, "verificationOperationId": row["operationId"],
                    "mode": "copy" if row.get("material", {}).get("cacheFiles") or row.get("state") != "completed" or row.get("materialReady") is False else "readonly"}
                try:
                    g.resolve_material_sources({**value, "materialSources": [choice]})
                except (OSError, RuntimeError, ValueError):
                    continue
                choices[identifier] = choice
                break
            if identifier not in choices:
                unresolved.append(identifier + ": historical reuse discovery and canonical source verification are pending")
        if choices:
            value["materialSources"] = [choices[key] for key in sorted(choices)]
        g._reuse_unresolved = unresolved
        return value

    def choose_material(self, material, folder, value, deadline):
        g = self.g
        selection = folder / "selection.v1.json"
        if selection.exists():
            record = governance_row(selection)
            if record["experimentId"] != g.experiment or record["serverId"] != g.server or record["materialId"] != material["id"] or record["operationId"] != value["operationId"]:
                raise RuntimeError("Reuse selection belongs to another material or allocation")
            return self.commit_material_selection(folder, value, record)
        tried, best, best_results = set(), None, None
        diagnostics = []
        views = [(0, "default-assets", material)]
        publication = g.run / "material-publications-0.1.2" / (material["id"] + ".json")
        if publication.exists():
            views.insert(0, (-1, "current-binding", g.material(material["id"])))
        discovery = None
        while now() < deadline:
            for _, identifier, candidate in sorted(views, key=lambda item: (item[0], item[1])):
                if identifier in tried:
                    continue
                tried.add(identifier)
                candidate_folder = folder / "candidates" / identifier
                probe = {**value, "stage": "verifying", "detail": "Verifying historical reuse source " + identifier}
                try:
                    source = candidate.get("historicalSource")
                    if source:
                        self.hold_source("material", value["operationId"], {**source, "id": identifier})
                    g._reuse_progress = folder / "receipt.v1.json"
                    verified = g.verify_material_files(copy.deepcopy(candidate), candidate_folder, probe, deadline)
                    score = (verified["totalBytes"] - verified["verifiedBytes"], identifier)
                    if best is None or score < best[0]:
                        best = (score, verified)
                        best_results = probe["fileResults"]
                    if score[0] == 0:
                        break
                except (OSError, RuntimeError, ValueError) as error:
                    diagnostics.append(identifier + ": " + str(error))
                finally:
                    g._reuse_progress = None
            if best is not None and best[0][0] == 0:
                break
            discovery = self.discover("material", value["operationId"], deadline, material)
            value.update(stage="discovering", updatedAt=now(), detail="Discovering owned historical sources",
                reuse={"state": "discovering", "entriesScanned": discovery["entriesScanned"], "complete": discovery["complete"],
                    "diagnostics": diagnostics + discovery["diagnostics"]})
            save(folder / "receipt.v1.json", value)
            views = []
            for row in discovery["candidates"]:
                if row["id"] in tried:
                    continue
                try:
                    rank = 1 if material["repository"].split("/")[-1] in row["directory"] else 2
                    views.append((rank, row["id"], g.candidate_material(material, row["id"])))
                except (OSError, RuntimeError, ValueError) as error:
                    tried.add(row["id"])
                    diagnostics.append(row["id"] + ": " + str(error))
            if not views and discovery["complete"]:
                break
            if not views and not discovery["todo"]:
                raise RuntimeError("Historical material discovery is incomplete: " + "; ".join(discovery["diagnostics"]))
        if best is None or best[0][0] and (discovery is None or not discovery["complete"]):
            raise TimeoutError("Historical material reuse remains unverified; recover discovery before downloading another copy")
        selected = best[1]
        record = {"version": 1, "experimentId": g.experiment, "serverId": g.server, "operationId": value["operationId"],
            "materialId": material["id"], "material": selected, "checkedAt": now(), "additionalBytes": best[0][0],
            "reason": "Equivalent verified source with minimum additional storage", "diagnostics": diagnostics,
            "fileResults": best_results}
        save(selection, record)
        return self.commit_material_selection(folder, value, record)

    def commit_material_selection(self, folder, value, record):
        g = self.g
        selected = g.validate_material(copy.deepcopy(record["material"]))
        value.update(fileResults=record["fileResults"], verifiedBytes=selected["verifiedBytes"],
            verificationComplete=all(row["state"] not in ("unverified", "unreadable") for row in record["fileResults"]),
            verifiedFiles=sum(row["state"] == "verified" for row in record["fileResults"]),
            reuse={"state": "verified" if record["additionalBytes"] == 0 else "missing", "candidateId": selected.get("reuseCandidateId"),
                "additionalBytes": record["additionalBytes"], "complete": True, "diagnostics": record["diagnostics"]})
        source = {"version": 1, "formatVersion": "0.1.2", "experimentId": g.experiment, "serverId": g.server,
            "operationId": value["operationId"], "material": selected}
        save(folder / "source-0.1.2.json", source)
        value["sourceHash"] = digest(source)
        save(folder / "receipt.v1.json", value)
        return selected


def storage_reuse(governance):
    return StorageReuse(governance)
