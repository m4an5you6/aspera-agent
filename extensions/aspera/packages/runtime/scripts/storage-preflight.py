"""Read-only environment evidence and separately approved retention policies."""


class StoragePreflight:
    def __init__(self, governance):
        self.g = governance
        self.owner = governance.owner
        self.root = governance.run / "storage-preflight-v2"

    def enabled(self):
        return self.g.config.get("storagePreflightVersion") == 2

    @contextlib.contextmanager
    def locked(self):
        reject_links(self.root)
        self.root.mkdir(parents=True, mode=0o700, exist_ok=True)
        with open(self.root / "policy.lock", "a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def policy(self):
        path = self.root / "policy-current.v1.json"
        if not path.exists():
            return None
        value = governance_row(path)
        if value["experimentId"] != self.g.experiment or value["serverId"] != self.g.server or value["state"] != "approved":
            raise RuntimeError("Approved storage policy ownership differs")
        context = self.g.config.get("evidenceContext")
        if context and value["planRevision"] != context["planRevision"]:
            raise RuntimeError("Storage policy belongs to another approved plan")
        return value

    def propose(self, request):
        context = self.g.config.get("evidenceContext")
        if not context or context["planRevision"] < 1:
            raise RuntimeError("Storage policy requires an approved plan identity")
        identifier = request["operationId"]
        path = self.root / "proposals" / (identifier + ".json")
        signature = digest([request, context["planRevision"]])
        if path.exists():
            previous = governance_row(path)
            if previous["requestHash"] != signature:
                raise RuntimeError("Storage proposal identity is bound to another request")
            return previous
        current = self.policy()
        revision = current["revision"] if current else 0
        if request["expectedRevision"] != revision:
            raise RuntimeError("Storage policy revision conflict; read the current policy")
        value = {"version": 1, "experimentId": self.g.experiment, "serverId": self.g.server,
            "proposalId": identifier, "planRevision": context["planRevision"], "expectedRevision": revision,
            "revision": revision, "policy": request["policy"], "reason": request["reason"],
            "requestHash": signature, "state": "pending", "createdAt": now(), "updatedAt": now()}
        save(path, value)
        return value

    def decide(self, request):
        path = self.root / "proposals" / (request["proposalId"] + ".json")
        value = governance_row(path)
        if value["experimentId"] != self.g.experiment or value["serverId"] != self.g.server:
            raise RuntimeError("Storage proposal belongs to another allocation")
        target = "approved" if request["approve"] else "rejected"
        if value["state"] != "pending":
            if value["state"] != target or request["expectedRevision"] != value["expectedRevision"]:
                raise RuntimeError("Storage proposal already has another decision")
            if target == "approved":
                current = self.policy()
                if current is None or current["revision"] == value["expectedRevision"]:
                    save(self.root / "policy-current.v1.json", value)
            return value
        current = self.policy()
        revision = current["revision"] if current else 0
        if request["expectedRevision"] != revision or value["expectedRevision"] != revision:
            raise RuntimeError("Storage policy approval conflict; read the current policy")
        value.update(state=target, revision=revision + 1 if request["approve"] else revision, updatedAt=now())
        # The decision is durable before the current pointer; a repeated decision repairs the pointer below.
        save(path, value)
        if request["approve"]:
            save(self.root / "policy-current.v1.json", value)
        return value

    def observations(self):
        if self.policy() is None and self.g.config.get("approvedStoragePolicy") is not None:
            with self.locked():
                self.approved_plan_policy()
        return {"current": self.policy(), "proposals": [governance_row(path) for path in sorted((self.root / "proposals").glob("*.json"))]}

    def approved_plan_policy(self):
        proposed = self.g.config.get("approvedStoragePolicy")
        if self.policy() is not None or proposed is None:
            return
        operation = str(uuid.uuid5(uuid.NAMESPACE_URL, self.g.experiment + ":storage-policy:" + digest(proposed)))
        self.propose({"operationId": operation, "expectedRevision": 0, "policy": proposed,
            "reason": "Retention strategy from the approved experiment plan"})
        self.decide({"proposalId": operation, "expectedRevision": 0, "approve": True})

    def assessment(self, request):
        value = copy.deepcopy(request)
        value.setdefault("mode", "preview")
        declared = value.get("materialRequirements")
        if declared is not None:
            value["materialIds"] = sorted(set(value["materialIds"]) | {row["materialId"] for row in declared["materials"] if row.get("materialId")})
            if declared["complete"]:
                value.setdefault("assessmentScope", "experiment")
        unresolved = []
        if value["mode"] == "preview":
            return value, unresolved
        with self.locked():
            self.approved_plan_policy()
        current = self.policy()
        if current is None:
            unresolved.append("No approved storage retention policy; propose a policy or use the approved plan strategy")
        elif value.get("policyRevision", current["revision"]) != current["revision"]:
            unresolved.append("Storage budget does not select the current approved policy revision")
        else:
            value["policyRevision"] = current["revision"]
            policy = current["policy"]
            if value["outputBytes"] < policy["outputMinimumBytes"] or value["checkpointBytes"] < policy["checkpointMinimumBytes"]:
                unresolved.append("Budget is below an approved explicit storage minimum; request a policy revision")
        if request["requirements"] and not self.g.environment_satisfies(request):
            candidates = [governance_row(path) for path in (self.root / "environments").glob("*.json")]
            settled = [row for row in candidates if row["preflight"]["environmentId"] == request["environmentId"]
                and row["preflight"]["status"] != "unknown" and set(request["requirements"]).issubset(row["preflight"]["requirements"])
                and row.get("context") == self.g.config.get("evidenceContext") and row.get("deploymentId") == self.g.config["deploymentId"]]
            if not settled:
                unresolved.append("Environment reuse remains unverified; request action=verify-reuse before committing a whole-install estimate")
        return value, unresolved

    def preflight_environment(self, request, work):
        owner, g = self.owner, self.g
        value = {"version": 1, "experimentId": g.experiment, "serverId": g.server, "operationId": request["operationId"],
            "environmentId": request["environmentId"], "requirements": request["requirements"], "checkedAt": now(),
            "status": "unknown", "additionalBytes": None, "detail": "Environment source remains unverified"}
        proof = {"request": request, "context": g.config.get("evidenceContext"), "deploymentId": g.config["deploymentId"]}
        environment = owner.environment(request["environmentId"])
        try:
            if any("@" in value for value in request["requirements"]):
                wheel_metadata(owner).check(request)
            if environment is not None:
                owner.verify(environment, request, work)
                proof["environmentHash"] = digest(environment)
                value.update(status="reusable", additionalBytes=0, sourceHash=digest(environment), detail="Current environment verified without publication")
            else:
                borrowed = g.borrowing(request)
                if borrowed is None:
                    value.update(status="incompatible", detail="No compatible historical environment found; inspect alternatives before installing")
                else:
                    proof["source"] = borrowed
                    value.update(status="reusable", additionalBytes=0, candidateId=borrowed["candidateId"], sourceHash=borrowed["sourceHash"],
                        detail="Historical environment verified read-only; borrow publication and final capacity admission are still required")
        except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
            diagnostics, _ = environment_repair(owner).observations()
            diagnostics = [row for row in diagnostics if row["operationId"] == request["operationId"]]
            uncertain = isinstance(error, (OSError, TimeoutError, subprocess.TimeoutExpired))
            if not diagnostics and not uncertain and (environment is not None or isinstance(error, EnvironmentSourceError)):
                diagnostics = [environment_repair(owner).diagnose(request, error)]
            value.update(status="unknown" if uncertain else "repair-required" if diagnostics else "incompatible", detail=str(error))
            if diagnostics:
                proof["repairPlans"] = [environment_repair(owner).propose(request, diagnostics)]
        save(self.root / "environments" / (request["operationId"] + ".json"), {"preflight": value, **proof})
        return value, proof.get("repairPlans", [])

    def environment_estimate(self, request):
        rows = [governance_row(path) for path in (self.root / "environments").glob("*.json")]
        rows.sort(key=lambda row: row["preflight"]["checkedAt"], reverse=True)
        for row in rows:
            value = row["preflight"]
            if value["experimentId"] != self.g.experiment or value["serverId"] != self.g.server:
                raise RuntimeError("Environment preflight belongs to another allocation")
            if value["environmentId"] != request["environmentId"] or value["status"] != "reusable" or not set(request["requirements"]).issubset(value["requirements"]):
                continue
            if row["context"] != self.g.config.get("evidenceContext") or row["deploymentId"] != self.g.config["deploymentId"]:
                continue
            source = row.get("source")
            if source is None:
                if digest(self.owner.environment(request["environmentId"])) != row.get("environmentHash"):
                    continue
            else:
                self.g.check_registration(source, source["directory"])
                self.g.find_candidate(source["candidateId"])
                self.g.source_released(source["sourceExperimentId"], pathlib.Path(source["sourceRunRoot"]))
                self.g.validate_borrowed_content(source)
            return 0
        return None

    def borrow_verified_source(self, request):
        rows = [governance_row(path) for path in (self.root / "environments").glob("*.json")]
        rows.sort(key=lambda row: row["preflight"]["checkedAt"], reverse=True)
        for row in rows:
            value, original = row["preflight"], row["request"]
            source = row.get("source")
            if source is None or value["status"] != "reusable" or value["environmentId"] != request["environmentId"]:
                continue
            if row.get("context") != self.g.config.get("evidenceContext") or row["deploymentId"] != self.g.config["deploymentId"]:
                continue
            if not set(request["requirements"]).issubset(original["requirements"]) or not set(request["modules"]).issubset(original["modules"]) or request["requireCuda"] and not original["requireCuda"]:
                continue
            if request.get("reuseCandidateId") and request["reuseCandidateId"] != source["candidateId"]:
                continue
            with self.g.locked():
                self.g.check_registration(source, source["directory"])
                self.g.find_candidate(source["candidateId"])
                self.g.source_released(source["sourceExperimentId"], pathlib.Path(source["sourceRunRoot"]))
                self.g.validate_borrowed_content(source)
                published = {**source, "operationId": request["operationId"]}
                save(pathlib.Path(source["lease"]), published)
                save(self.g.bindings / (request["environmentId"] + ".json"), published)
                return published
        return None


def storage_preflight(governance):
    return StoragePreflight(governance)
