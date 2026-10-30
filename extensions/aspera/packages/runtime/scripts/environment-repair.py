"""Allocation-owned repair proposals and confirmed environment-reference removal."""


class EnvironmentSourceError(RuntimeError):
    def __init__(self, detail, facts, probes):
        super().__init__(detail)
        self.facts, self.probes = facts, probes


def verify_distribution_records(directory, site, hashes=None, private_files=(), sizes_only=False):
    """Check installed distributions without accepting an edited RECORD as a repair."""
    known = hashes or {}
    allowed = {str(site / name) for name in private_files}
    for record in site.glob("*.dist-info/RECORD"):
        reject_links(record)
        for name, checksum, size in csv.reader(io.StringIO(record.read_text())):
            if not checksum:
                continue
            target = (site / name).resolve()
            if not target.is_relative_to(directory) or not target.is_file():
                raise RuntimeError("Distribution RECORD is incomplete or escapes its environment: " + name)
            if str(target) in allowed:
                continue
            reject_links(target)
            if size and target.stat().st_size != int(size):
                raise EnvironmentSourceError("Distribution content differs from its RECORD: " + name,
                    {"code": "content-mismatch", "path": name, "package": record.parent.name[:-10].rsplit("-", 1)[0],
                        "expectedHash": checksum, "expectedBytes": int(size), "actualBytes": target.stat().st_size}, [str(target), str(record)])
            if sizes_only:
                continue
            algorithm, expected = checksum.split("=", 1)
            if algorithm != "sha256":
                raise RuntimeError("Distribution RECORD uses an unsupported digest: " + algorithm)
            actual = base64.urlsafe_b64encode(bytes.fromhex(known.get(str(target)) or file_hash(target))).rstrip(b"=").decode()
            if actual != expected or size and target.stat().st_size != int(size):
                raise EnvironmentSourceError("Distribution content differs from its RECORD: " + name,
                    {"code": "content-mismatch", "path": name, "package": record.parent.name[:-10].rsplit("-", 1)[0],
                        "expectedHash": checksum, "actualHash": "sha256=" + actual,
                        **({"expectedBytes": int(size)} if size else {}), "actualBytes": target.stat().st_size},
                    [str(target), str(record)])


class EnvironmentRepair:
    def __init__(self, owner):
        self.owner = owner
        self.run = owner.run
        self.plans = self.run / "environment-repair-plans-v1"
        self.diagnostics = self.run / "environment-diagnostics-v1"

    def source_state(self, candidate, probes):
        g = storage_governance(self.owner)
        directory = pathlib.Path(candidate["directory"])
        rows = {}
        for name in probes:
            path = pathlib.Path(name)
            if not path.is_relative_to(directory):
                raise RuntimeError("Repair proof escaped its historical environment")
            reject_links(path)
            rows[name] = governance_identity(path) if path.exists() else None
        return {"candidateId": candidate["id"], "directory": str(directory), "registrationId": g.registration_id(directory),
            "verificationRule": "distribution-record-sha256-v1",
            "volume": {key: g.mount(directory)[key] for key in ("source", "filesystem", "directory")},
            "files": rows}

    def cached_failure(self, candidate):
        path = storage_governance(self.owner).root / "environment-failures-v1" / (candidate["id"] + ".json")
        if not path.exists():
            return None
        row = governance_row(path)
        if row.get("serverId") != self.owner.server or row.get("candidateId") != candidate["id"]:
            raise RuntimeError("Historical failure belongs to another source")
        if self.source_state(candidate, row["sourceState"]["files"]) != row["sourceState"]:
            return None
        return EnvironmentSourceError(row["detail"], row["facts"], list(row["sourceState"]["files"]))

    def diagnose(self, request, error, candidate=None):
        facts = getattr(error, "facts", {})
        code = facts.get("code", "verification-timeout" if isinstance(error, (TimeoutError, subprocess.TimeoutExpired))
            else "unreadable" if isinstance(error, OSError) else "dependency-mismatch" if candidate else "installation-failed")
        state = self.source_state(candidate, getattr(error, "probes", [])) if candidate else {
            "generation": digest(self.owner.environment(request["environmentId"])), "deploymentId": self.owner.config["deploymentId"]}
        row = {"version": 1, "experimentId": self.owner.id, "serverId": self.owner.server,
            "operationId": request["operationId"], "environmentId": request["environmentId"], "code": code,
            "detail": str(error), "sourceFingerprint": digest(state), "checkedAt": now(), **{key: value for key, value in facts.items() if key != "code"}}
        if candidate:
            row["candidateId"] = candidate["id"]
        row["id"] = digest(row)
        save(self.diagnostics / (row["id"] + ".json"), {"diagnostic": row, "sourceState": state})
        if candidate and code == "content-mismatch":
            save(storage_governance(self.owner).root / "environment-failures-v1" / (candidate["id"] + ".json"),
                {"version": 1, "serverId": self.owner.server, "candidateId": candidate["id"], "sourceState": state,
                    "facts": facts, "detail": str(error)})
        return row

    def propose(self, request, diagnostics):
        previous = self.owner.environment(request["environmentId"])
        original = {key: value for key, value in request.items() if key not in ("repairPlanId", "reuseCandidateId")}
        states = [governance_row(self.diagnostics / (row["id"] + ".json"))["sourceState"] for row in diagnostics]
        receipt_path = self.owner.operations / request["operationId"] / "receipt.v1.json"
        request_hash = governance_row(receipt_path)["requestHash"] if receipt_path.exists() else digest(request)
        row = {"version": 1, "experimentId": self.owner.id, "serverId": self.owner.server, "environmentId": request["environmentId"],
            "sourceOperationId": request["operationId"], "requestHash": request_hash, "sourceFingerprint": digest([states, previous]),
            "diagnosticIds": [row["id"] for row in diagnostics], "strategy": "reinstall-affected" if previous else "rebuild-from-materials",
            "requirements": request["requirements"], "modules": request["modules"], "requireCuda": request["requireCuda"],
            "packages": sorted({row["package"] for row in diagnostics if row.get("package")}), "checkedAt": now(),
            "downloadBytes": None, "copyBytes": None, "peakBytes": None,
            "detail": "Select action=repair with this repairPlanId to rebuild the same environment from verified materials. "
                "The old source remains unchanged. For an authenticated input-wheel metadata diagnostic, explicitly select repairWheelMetadata=true to create an independently identified build without changing code/library bytes; compatibility and imports remain mandatory. Material resolution and the complete storage budget determine missing downloads before installation."}
        row["id"] = digest(row)
        save(self.plans / (row["id"] + ".json"), {"plan": row, "request": original, "sourceStates": states, "previous": previous})
        return row

    def resolve(self, request):
        identifier = request.get("repairPlanId", "")
        if not re.fullmatch(r"[a-f0-9]{64}", identifier):
            raise RuntimeError("Repair requires a program-issued repairPlanId")
        saved = governance_row(self.plans / (identifier + ".json"))
        plan = saved["plan"]
        if any(plan.get(key) != value for key, value in (("id", identifier), ("experimentId", self.owner.id),
                ("serverId", self.owner.server), ("environmentId", request["environmentId"]))):
            raise RuntimeError("Repair plan belongs to another experiment, node or environment")
        if request.get("reuseCandidateId") or request.get("files") or request.get("directory") != saved["request"].get("directory"):
            raise RuntimeError("Repair cannot change the source, directory or writable files")
        for key in ("requirements", "modules"):
            if request[key] and sorted(set(request[key])) != sorted(set(plan[key])):
                raise RuntimeError("Repair cannot change approved " + key + "; request an explicit install instead")
        if request["requireCuda"] and not plan["requireCuda"]:
            raise RuntimeError("Repair requirements differ; inspect a new verification request")
        receipt = governance_row(self.owner.operations / plan["sourceOperationId"] / "receipt.v1.json")
        if receipt.get("experimentId") != self.owner.id or receipt.get("serverId") != self.owner.server or receipt.get("requestHash") != plan["requestHash"] or not receipt.get("exitConfirmed"):
            raise RuntimeError("Original repair operation exit is unconfirmed")
        self.owner.assert_exited("environment-" + plan["sourceOperationId"], self.owner.config.get("launchFailureConfirmed", False))
        if self.owner.environment(request["environmentId"]) != saved["previous"]:
            raise RuntimeError("Environment changed since repair planning; inspect the latest operation")
        g = storage_governance(self.owner) if any("candidateId" in state for state in saved["sourceStates"]) else None
        for state in saved["sourceStates"]:
            if "candidateId" not in state:
                continue
            candidate = g.find_candidate(state["candidateId"])
            if self.source_state(candidate, state["files"]) != state:
                raise RuntimeError("Repair source identity changed; reverify the historical candidate")
            g.source_released(candidate["sourceExperimentId"], pathlib.Path(candidate["runRoot"]))
        self.owner.repairing = True
        return {**saved["request"], "action": "repair", "operationId": request["operationId"],
            "repairPlanId": identifier, "requirements": plan["requirements"], "modules": plan["modules"], "requireCuda": plan["requireCuda"],
            **({"repairWheelMetadata": True} if request.get("repairWheelMetadata") else {})}

    def observations(self):
        diagnostics = [governance_row(path)["diagnostic"] for path in sorted(self.diagnostics.glob("*.json"))]
        plans = [governance_row(path)["plan"] for path in sorted(self.plans.glob("*.json"))]
        for row in diagnostics + plans:
            if row["experimentId"] != self.owner.id or row["serverId"] != self.owner.server:
                raise RuntimeError("Environment repair observation belongs to another allocation")
        return diagnostics, plans

    def reference_candidates(self):
        owner = self.owner
        result = []
        for path in owner.references.glob("*.json"):
            reference = governance_row(path)
            directory = pathlib.Path(reference["directory"])
            if directory.exists():
                continue
            identifier = digest([str(path), reference])
            row = {"id": identifier, "sourceExperimentId": reference["experimentId"], "environmentId": reference["environmentId"],
                "eligible": False, "detail": "Environment deletion requires process, storage and original removal evidence", "checkedAt": now()}
            try:
                proof = self.reference_proof(path, reference)
                row.update(eligible=True, evidenceHash=digest(proof), detail="Confirmed removed environment; select this ID to release only its package reference")
            except (OSError, RuntimeError, ValueError, KeyError) as error:
                row["detail"] = str(error)
            result.append(row)
        return result

    def reference_proof(self, path, reference):
        owner = self.owner
        if reference.get("version") != 1 or reference.get("serverId") != owner.server:
            raise RuntimeError("Package reference server ownership differs")
        g = storage_governance(owner)
        run = pathlib.Path(reference["manifest"]).parent.parent
        directory = pathlib.Path(reference["directory"])
        reject_links(run); reject_links(directory); reject_links(path)
        if run.name != reference["experimentId"] or run.parent.name != "runs" or pathlib.Path(reference["manifest"]).parent != run / "environments-v1":
            raise RuntimeError("Missing environment reference escaped its original run")
        if governance_row(run / ".aspera-owner.json") != {"version": 1, "serverId": owner.server, "experimentId": run.name}:
            raise RuntimeError("Deleted environment source ownership differs")
        declared = governance_row(reference["manifest"])
        if any(declared.get(key) != reference.get(key) for key in ("experimentId", "serverId", "environmentId", "directory")):
            raise RuntimeError("Deleted environment manifest and reference differ")
        if not directory.is_relative_to(source_training_workspace(owner, run)) or directory == source_training_workspace(owner, run):
            raise RuntimeError("Deleted environment is outside its registered workspace")
        roots, _ = g.roots()
        root = next((row for row in roots if row["confirmed"] and run.is_relative_to(row["directory"])), None)
        if root is None:
            raise RuntimeError("Original storage registration is missing or changed")
        if g.mount(directory.parent)["mountId"] != g.mount(root["directory"])["mountId"]:
            raise RuntimeError("Deleted environment volume or nested mount identity differs")
        released = g.source_released(run.name, run)
        g.protect_path(directory)
        if directory.exists() or directory.is_symlink():
            raise RuntimeError("Environment still exists; retain its package references")
        for request in (run / "environment-requests-v1").glob("*.json"):
            original = governance_row(request).get("request", {})
            if original.get("environmentId") != reference["environmentId"]:
                continue
            receipt = governance_row(run / "environment-operations-v1" / request.stem / "receipt.v1.json")
            if not receipt.get("exitConfirmed"):
                raise RuntimeError("Original environment operation exit remains unconfirmed")
            journal = run / "environment-operations-v1" / request.stem / "publication.v1.json"
            if journal.exists() and governance_row(journal).get("phase") != "committed":
                recovery = run / "environment-recoveries-v1" / (request.stem + ".json")
                if not recovery.exists() or governance_row(recovery).get("sourceReceiptHash") != digest(receipt):
                    raise RuntimeError("Original environment publication still requires recovery")
        for cleanup in (run / "environment-cleanups-v1").glob("*.json"):
            pending = governance_row(cleanup)
            if pending.get("environmentId") == reference["environmentId"] and pending.get("state") != "completed":
                raise RuntimeError("Original environment cleanup retains package references")
        evidence = []
        for receipt_path in (run / "environment-removals-v1").glob("*.json"):
            receipt = governance_row(receipt_path)
            if receipt.get("serverId") == owner.server and receipt.get("experimentId") == run.name and receipt.get("directory") == str(directory) and receipt.get("generation") == declared["generation"] and receipt.get("state") == "completed":
                evidence.append([str(receipt_path), digest(receipt)])
        manual = pathlib.Path.home() / ".local/state/aspera/manual-cache-cleanup"
        if manual.exists():
            reject_links(manual)
            for receipt_path in manual.glob("*/result.v1.json"):
                receipt = governance_row(receipt_path)
                preview = receipt_path.with_name("preview.v1.json")
                if receipt.get("state") != "complete" or not preview.exists():
                    continue
                original = governance_row(preview)
                if original.get("serverId") != owner.server or pathlib.Path(original.get("base", "")) != run.parent.parent:
                    continue
                targets = original.get("targets", original.get("candidates", []))
                for target in targets:
                    target_path = target.get("path") or target.get("directory")
                    removed = [row for row in receipt.get("removedTargets", []) if row.get("path") == str(directory) and row.get("id") == target.get("id")]
                    if target_path == str(directory) and removed and target.get("runId") == run.name \
                            and original.get("mountId") is not None and target.get("mountId") == original["mountId"]:
                        evidence.append([str(receipt_path), digest(receipt), digest(original), target])
        if not evidence:
            raise RuntimeError("Original deletion receipt is missing; do not infer deletion from an absent directory")
        return {"referenceHash": digest(reference), "manifestHash": digest(declared), "releaseHash": released,
            "registrationId": root.get("registrationId"), "volume": g.mount(directory.parent), "evidence": evidence,
            "parentIdentity": governance_identity(directory.parent)}

    def release_references(self, identifiers):
        g = storage_governance(self.owner)
        released = []
        admission = g.control / "state/controller-admission.lock"
        reject_links(admission); admission.parent.mkdir(parents=True, exist_ok=True)
        with g.locked(), open(admission, "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for identifier in identifiers:
                if not re.fullmatch(r"[a-f0-9]{64}", identifier):
                    raise RuntimeError("Invalid reference repair identity")
                receipt_path = g.root / "environment-reference-releases-v1" / (identifier + ".json")
                if receipt_path.exists():
                    confirmed = governance_row(receipt_path)
                    if confirmed.get("serverId") != self.owner.server or confirmed.get("experimentId") != self.owner.id or not re.fullmatch(r"[a-f0-9]{64}\.json", confirmed.get("referenceFile", "")):
                        raise RuntimeError("Reference release receipt ownership differs")
                    path = self.owner.references / confirmed["referenceFile"]
                    if path.exists():
                        reference = governance_row(path)
                        if digest(reference) != confirmed["referenceHash"]:
                            raise RuntimeError("Released reference changed after confirmation")
                        proof = self.reference_proof(path, reference)
                        if proof["manifestHash"] != confirmed["proof"]["manifestHash"]:
                            raise RuntimeError("Removed environment generation changed after confirmation")
                        path.unlink(); sync_directory(path.parent)
                    save(self.run / "environment-reference-releases-v1" / (identifier + ".json"), confirmed)
                    released.append(identifier)
                    continue
                found = [(path, governance_row(path)) for path in self.owner.references.glob("*.json")]
                selected = next(((path, row) for path, row in found if digest([str(path), row]) == identifier), None)
                if selected is None:
                    raise RuntimeError("Reference repair selection changed; refresh the cleanup preview")
                path, reference = selected
                proof = self.reference_proof(path, reference)
                confirmation = {"version": 1, "serverId": self.owner.server, "experimentId": self.owner.id,
                    "sourceExperimentId": reference["experimentId"], "environmentId": reference["environmentId"],
                    "id": identifier, "referenceFile": path.name, "referenceHash": digest(reference), "proof": proof, "checkedAt": now()}
                save(receipt_path, confirmation)
                save(self.run / "environment-reference-releases-v1" / (identifier + ".json"), confirmation)
                path.unlink(); sync_directory(path.parent)
                released.append(identifier)
        return released
