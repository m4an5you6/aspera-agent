"""Seed synthetic small history and import original read-only source evidence into an isolated controller."""
import base64
import csv
import hashlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import uuid
import zipfile

request = json.loads(sys.argv[1])
root, control = pathlib.Path(request["root"]), pathlib.Path(request["control"])
assert root.parent == pathlib.Path("/root/gpufree-data") and root.name.startswith("aspera-storage-preflight-")
config = request["managed"]
scripts = pathlib.Path(__file__).parents[2] / "packages/runtime/scripts"
scope = {"__name__": "isolated_seed", "__file__": str(scripts / "managed-environment.py")}
exec(compile((scripts / "managed-environment.py").read_text(), "managed-environment.py", "exec"), scope)
owner = scope["Environments"](config)
owner.owner()
g = scope["storage_governance"](owner)
save = scope["save"]
sid = owner.server
source_control = pathlib.Path(request["sourceControl"])
source_id = "32289b60-dfeb-460a-870b-7d72a5ad2ffb"
for table, home, domain in [("allocations", "node-home", "aspera_node"), ("experiments", "coordinator-home", "aspera_queue")]:
    original = source_control / "state" / home / "storages" / domain / table / (source_id + ".json")
    if original.exists():
        value = json.loads(original.read_text())
        row = value.get("record", value)
        assert row.get("released", row.get("resourcesReleased", False)) is True
        target = control / "state" / home / "storages" / domain / table / original.name
        if not target.exists():
            save(target, value)
for location in [pathlib.Path("/root/.aspera") / sid, pathlib.Path("/root/gpufree-data/.aspera") / sid]:
    if location.is_dir():
        save(control / "state/storage-roots" / scope["digest"](str(location)) / ".aspera-owner.json", {"namespaceRoot": str(location)})

if request["case"] != "historical-source":
    wheel = root / "tiny_fixture-1.0-py3-none-any.whl"
    if not wheel.exists():
        entries = {"tiny_fixture/__init__.py": b"value = 'storage-preflight-ok'\n", "tiny_fixture/payload.bin": b"x" * (2 * 1024 ** 2),
            "tiny_fixture-1.0.dist-info/METADATA": b"Metadata-Version: 2.1\nName: tiny-fixture\nVersion: 1.0\n",
            "tiny_fixture-1.0.dist-info/WHEEL": b"Wheel-Version: 1.0\nGenerator: aspera-fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
            "tiny_fixture-1.0.dist-info/top_level.txt": b"tiny_fixture_mod\n"}
        record = io.StringIO()
        writer = csv.writer(record)
        for name, data in entries.items():
            writer.writerow([name, "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode(), len(data)])
        writer.writerow(["tiny_fixture-1.0.dist-info/RECORD", "", ""])
        entries["tiny_fixture-1.0.dist-info/RECORD"] = record.getvalue().encode()
        with zipfile.ZipFile(wheel, "w") as archive:
            for name, data in entries.items():
                archive.writestr(name, data)
    with owner.locked(write=True):
        owner.retain_material(wheel)
    historical = owner.namespace / "runs" / str(uuid.uuid5(uuid.NAMESPACE_URL, str(root) + ":tiny-history"))
    environment = historical / "workspace/pyenv"
    if not environment.exists():
        subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(environment)], check=True, capture_output=True)
        subprocess.run([config["uvPath"], "pip", "install", "--python", str(environment / "bin/python"), "--no-index", "--no-deps", str(wheel)], check=True, capture_output=True)
        top = next(environment.glob("lib/python*/site-packages/tiny_fixture-1.0.dist-info/top_level.txt"))
        top.write_bytes(b"broken\n")
        save(historical / ".aspera-owner.json", {"version": 1, "experimentId": historical.name, "serverId": sid})
        node = json.loads(json.dumps(request["submission"]["nodes"][0]))
        placement = node["server"]["storagePlacement"]
        placement.update(experimentId=historical.name, runRoot=str(historical), workspaceRoot=str(historical / "workspace"))
        source_submission = {**request["submission"], "experimentId": historical.name, "nodes": [node], "coordinator": node["server"]}
        # Initial synthetic history has no processes; real test outcomes are never rewritten here.
        save(control / "state/node-home/storages/aspera_node/allocations" / (historical.name + ".json"), {"record": {
            "experimentId": historical.name, "deploymentId": request["submission"]["deploymentId"], "node": node, "protocol": 4,
            "released": True, "releasing": False, "bootId": "synthetic-never-started"}})
        save(control / "state/coordinator-home/storages/aspera_queue/experiments" / (historical.name + ".json"), {"version": 4, "record": {
            "submission": source_submission, "payloadHash": scope["digest"](source_submission), "sequence": 1, "revision": 1,
            "state": "completed", "resourcesReleased": True, "updatedAt": scope["now"](), "handover": "本机派发完成，远端实验已接管",
            "executions": [], "services": []}})
    candidate = g.candidate(historical, environment, owner.namespace)
    canonical_root = source_control / "state/storage-governance-v1/canonical-manifests"
    canonical = next(json.loads(path.read_text()) for path in canonical_root.glob("*.json")
        if json.loads(path.read_text())["request"].get("repository") == "Qwen/Qwen3.5-9B")
    material = g.inspect_material({"kind": "model", "provider": "huggingface", "repository": "Qwen/Qwen3.5-9B",
        "revision": "c202236235762e1c871ad0ccb60c8ee5ba337b9a", "files": ["chat_template.jinja", "config.json"],
        "mirror": "https://modelscope.cn", "metadataSource": "cache"}, canonical["document"])
    save(owner.workspace / "env/storage-fixture.json", {"environmentCandidate": candidate["id"], "requirements": ["tiny-fixture==1.0"],
        "modules": ["tiny_fixture"], "materialId": material["id"], "materialFiles": ["chat_template.jinja", "config.json"],
        "scope": "Auxiliary-file verification only; not a complete 9B model or training acceptance"})
    check = owner.workspace / "scripts/check_env.py"
    check.parent.mkdir(parents=True, exist_ok=True)
    check.write_text("import tiny_fixture\nprint(tiny_fixture.value)\n")
print(json.dumps({"seeded": True, "case": request["case"], "existingExperimentsModified": False}))
