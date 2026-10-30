"""Rebuild explicitly selected input-wheel metadata without changing executable payloads."""


class WheelMetadataRepair:
    def __init__(self, owner):
        self.owner = owner
        self.records = owner.store / "wheel-derivations-v1"

    def submitted(self, requirement):
        if "@" not in requirement:
            return None
        match = re.fullmatch(r"\s*([A-Za-z0-9][A-Za-z0-9_.-]*)\s*@\s*(file:\S+)\s*", requirement)
        if not match:
            raise RuntimeError("Only authenticated submitted wheel files can establish a direct-source reuse identity; use 'name @ file:///...whl' without a simultaneous ==version constraint. The authenticated wheel metadata fixes its version.")
        name, address = match.groups()
        url = urllib.parse.urlparse(address)
        if url.scheme != "file" or url.netloc or url.query or url.fragment:
            raise RuntimeError("Submitted wheel URL must name a local file without URL credentials or options")
        path = pathlib.Path(urllib.parse.unquote(url.path))
        reject_links(path)
        inputs = pathlib.Path(self.owner.placement["workspaceRoot"]) / "inputs"
        if path.parent != inputs or path.suffix != ".whl":
            raise RuntimeError("Direct-source wheel is outside the current submitted input directory")
        proof = load(self.owner.run / "input-verifications-v1" / (hashlib.sha256(path.name.encode()).hexdigest() + ".json"))
        if any(proof.get(key) != value for key, value in (("version", 1), ("experimentId", self.owner.id),
                ("serverId", self.owner.server), ("name", path.name))):
            raise RuntimeError("Submitted wheel proof belongs to another experiment or node")
        if file_hash(path) != proof["sha256"]:
            raise RuntimeError("Submitted wheel differs from its authenticated input digest")
        return name, path, proof["sha256"]

    def inspect(self, requested, path):
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)) or len(names) > self.owner.policy["maxPackageFiles"]:
                raise RuntimeError("Input wheel has duplicate or excessive entries")
            if sum(item.file_size for item in archive.infolist()) > self.owner.expanded_limit:
                raise RuntimeError("Input wheel exceeds its expanded byte budget")
            for item in archive.infolist():
                relative(item.filename.rstrip("/"))
                if stat.S_ISLNK(item.external_attr >> 16):
                    raise RuntimeError("Input wheel contains a symbolic link")
            metadata = [name for name in names if re.fullmatch(r"[^/]+\.dist-info/METADATA", name)]
            if len(metadata) != 1:
                raise RuntimeError("Input wheel distribution metadata is ambiguous")
            prefix = metadata[0].rsplit("/", 1)[0]
            info = email.message_from_bytes(archive.read(metadata[0]))
            if package_name(info["Name"]) != package_name(requested):
                raise RuntimeError("Submitted wheel package name differs from its requested dependency")
            parts = path.name[:-4].split("-")
            if len(parts) not in (5, 6) or package_name(parts[0]) != package_name(requested) or parts[1] != info["Version"]:
                raise RuntimeError("Submitted wheel filename differs from its distribution identity")
            tag = "-".join(parts[-3:])
            if not re.fullmatch(r"[A-Za-z0-9_.]+-[A-Za-z0-9_.]+-[A-Za-z0-9_.]+", tag):
                raise RuntimeError("Submitted wheel filename tags are invalid")
            mismatch, payload = [], {}
            rows = list(csv.reader(io.StringIO(archive.read(prefix + "/RECORD").decode())))
            indexed = set()
            for row in rows:
                if len(row) != 3:
                    raise RuntimeError("Submitted wheel RECORD row is invalid")
                name, checksum, size = row
                if name in indexed or name not in names:
                    raise RuntimeError("Submitted wheel RECORD entries differ")
                indexed.add(name)
                if not checksum:
                    if name != prefix + "/RECORD":
                        raise RuntimeError("Submitted wheel entry lacks a content digest")
                    continue
                algorithm, expected = checksum.split("=", 1)
                if algorithm not in ("sha256", "sha384", "sha512"):
                    raise RuntimeError("Submitted wheel uses an unsupported digest")
                value = hashlib.new(algorithm); length = 0
                with archive.open(name) as stream:
                    for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
                        value.update(block); length += len(block)
                if base64.urlsafe_b64encode(value.digest()).rstrip(b"=").decode() != expected or size != str(length):
                    mismatch.append(name)
                if name not in (prefix + "/RECORD", prefix + "/WHEEL"):
                    payload[name] = [length, self.entry_hash(archive, name)]
            if indexed != {name for name in names if not name.endswith("/")}:
                raise RuntimeError("Submitted wheel includes unindexed files")
            if any(name != prefix + "/top_level.txt" for name in mismatch):
                raise RuntimeError("Executable or dependency metadata differs from its RECORD; metadata rebuilding is refused")
            wheel = email.message_from_bytes(archive.read(prefix + "/WHEEL"))
            expand = lambda value: {"-".join((python, abi, platform)) for python in value.split("-")[0].split(".")
                for abi in value.split("-")[1].split(".") for platform in value.split("-")[2].split(".")}
            declared = wheel.get_all("Tag", [])
            if any(not re.fullmatch(r"[A-Za-z0-9_.]+-[A-Za-z0-9_.]+-[A-Za-z0-9_.]+", value) for value in declared):
                raise RuntimeError("Submitted wheel declares invalid compatibility tags")
            return {"name": info["Name"], "version": info["Version"], "prefix": prefix, "tag": tag,
                "mismatches": mismatch, "tagMismatch": set().union(*(expand(value) for value in declared)) != expand(tag), "payload": payload}

    @staticmethod
    def entry_hash(archive, name):
        value = hashlib.sha256()
        with archive.open(name) as stream:
            for block in iter(lambda: stream.read(8 * 1024 * 1024), b""):
                value.update(block)
        return value.hexdigest()

    def retained(self, checksum):
        path = self.records / (checksum + ".json")
        if not path.exists():
            return None
        proof = load(path)
        if proof.get("version") != 1 or proof.get("serverId") != self.owner.server or proof.get("originalSHA256") != checksum:
            raise RuntimeError("Wheel derivation belongs to another original input or server")
        wheel = self.owner.materials / proof["derivedSHA256"] / relative(proof["filename"])
        if file_hash(wheel) != proof["derivedSHA256"]:
            raise RuntimeError("Retained metadata derivation changed")
        self.owner.wheel(wheel)
        return wheel, proof

    def resolve(self, requirement, allow=False, stage=None, work=None):
        selected = self.submitted(requirement)
        if selected is None:
            return None
        requested, original, checksum = selected
        info = self.inspect(requested, original)
        broken = info["mismatches"] or info["tagMismatch"]
        retained = self.retained(checksum) if broken else None
        if broken and retained is None:
            if not allow:
                raise EnvironmentSourceError("Authenticated input wheel needs an explicit metadata rebuild: " + original.name
                    + "; select its repairPlanId with repairWheelMetadata=true. The original and every code/library byte remain unchanged; target imports still require verification.",
                    {"code": "content-mismatch", "package": info["name"], "path": original.name}, [])
            if stage is None or work is None:
                raise RuntimeError("Metadata rebuilding requires an isolated installer and operation directory")
            retained = self.derive(original, checksum, info, stage, work)
        if retained is not None:
            if retained[1].get("payload") != info["payload"]:
                raise RuntimeError("Retained derivation does not preserve the authenticated original payload")
            with zipfile.ZipFile(retained[0]) as archive:
                expected = set(info["payload"]) | {info["prefix"] + "/WHEEL", info["prefix"] + "/RECORD"}
                if {name for name in archive.namelist() if not name.endswith("/")} != expected:
                    raise RuntimeError("Retained derivation changed the original entry set")
                for name, identity in info["payload"].items():
                    if [archive.getinfo(name).file_size, self.entry_hash(archive, name)] != identity:
                        raise RuntimeError("Retained derivation changed original code or library content")
            return retained[0], info
        self.owner.wheel(original)
        return original, info

    def derive(self, original, checksum, info, stage, work):
        build = "1asperameta" + checksum[:16]
        filename = info["name"].replace("-", "_") + "-" + info["version"] + "-" + build + "-" + info["tag"] + ".whl"
        output = work / filename
        self.owner.free(original.stat().st_size)
        prefix = info["prefix"]
        with zipfile.ZipFile(original) as source, zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as target:
            metadata = email.message_from_bytes(source.read(prefix + "/WHEEL"))
            del metadata["Tag"]
            if "Build" in metadata:
                del metadata["Build"]
            metadata["Tag"], metadata["Build"] = info["tag"], build
            recorded = []
            for item in source.infolist():
                if item.is_dir() or item.filename == prefix + "/RECORD":
                    continue
                if item.filename == prefix + "/WHEEL":
                    target.writestr(copy.copy(item), metadata.as_bytes())
                else:
                    with source.open(item) as incoming, target.open(copy.copy(item), "w") as outgoing:
                        shutil.copyfileobj(incoming, outgoing, 8 * 1024 * 1024)
        with zipfile.ZipFile(output) as archive:
            for item in archive.infolist():
                recorded.append([item.filename, "sha256=" + base64.urlsafe_b64encode(bytes.fromhex(self.entry_hash(archive, item.filename))).rstrip(b"=").decode(), str(item.file_size)])
        recorded.append([prefix + "/RECORD", "", ""])
        text = io.StringIO(); csv.writer(text).writerows(recorded)
        with zipfile.ZipFile(output, "a") as target:
            target.writestr(prefix + "/RECORD", text.getvalue())
        if file_hash(original) != checksum:
            raise RuntimeError("Original wheel changed during metadata reconstruction")
        derived = self.owner.wheel(output)
        with zipfile.ZipFile(output) as archive:
            for name, identity in info["payload"].items():
                if [archive.getinfo(name).file_size, self.entry_hash(archive, name)] != identity:
                    raise RuntimeError("Metadata derivation changed original code or library content")
        compatible = self.owner.installation_names([output], stage, work)[derived["hash"]]
        if "error" in compatible:
            raise RuntimeError("Derived metadata does not establish target wheel compatibility: " + compatible["error"])
        path, _ = self.owner.retain_material(output, "metadata-repair-sha256:" + checksum)
        proof = {"version": 1, "serverId": self.owner.server, "originalSHA256": checksum, "derivedSHA256": derived["hash"],
            "filename": filename, "changedEntries": [prefix + "/WHEEL", prefix + "/RECORD"], "payload": info["payload"], "checkedAt": now()}
        save(self.records / (checksum + ".json"), proof)
        save(self.owner.current_operation / "wheel-derivations.v1.json", {"version": 1, "experimentId": self.owner.id,
            "serverId": self.owner.server, "operationId": self.owner.current_operation.name, "derivations": [proof]})
        return path, proof

    def check(self, request):
        for requirement in request["requirements"]:
            self.resolve(requirement)

    def install_requirements(self, requirements, stage, work):
        resolved = []
        self.owner.input_wheel_paths = []
        for requirement in requirements:
            value = self.resolve(requirement, getattr(self.owner, "repair_wheel_metadata", False), stage, work)
            if value is not None:
                self.owner.input_wheel_paths.append(value[0])
            resolved.append(requirement if value is None else value[1]["name"] + " @ " + value[0].as_uri())
        return resolved

    def borrowed_requirements(self, requirements, directory):
        resolved = []
        for requirement in requirements:
            value = self.resolve(requirement)
            if value is None:
                resolved.append(requirement)
                continue
            wheel, info = value
            with zipfile.ZipFile(wheel) as archive:
                for name in archive.namelist():
                    if name.endswith("/") or name in (info["prefix"] + "/RECORD",):
                        continue
                    if ".data/" in name:
                        raise RuntimeError("Direct-source borrowing with generated wheel data entries requires private installation")
                    choices = list(directory.glob("lib/python*/site-packages/" + name))
                    if len(choices) != 1:
                        raise RuntimeError("Historical environment lacks submitted wheel file: " + name)
                    reject_links(choices[0])
                    if file_hash(choices[0]) != self.entry_hash(archive, name):
                        raise RuntimeError("Historical environment differs from authenticated submitted wheel: " + name)
            resolved.append(info["name"] + "==" + info["version"])
        return resolved
