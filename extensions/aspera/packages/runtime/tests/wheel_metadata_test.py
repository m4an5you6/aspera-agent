"""Explicit metadata rebuilding keeps authenticated originals and every executable byte intact."""
import importlib.util
import pathlib
import unittest
import uuid
import zipfile
from unittest.mock import patch

fixture = importlib.util.spec_from_file_location("wheel_fixture", pathlib.Path(__file__).with_name("managed_environment_test.py"))
module = importlib.util.module_from_spec(fixture)
fixture.loader.exec_module(module)
managed = module.module


class WheelMetadataCase(unittest.TestCase):
    setUp = module.EnvironmentCase.setUp
    environment = module.EnvironmentCase.environment
    package = module.EnvironmentCase.package

    def source(self, broken=False, damaged=False, tag=False):
        folder = self.workspace / "inputs"
        folder.mkdir(exist_ok=True)
        path = folder / "tiny_fixture-1.0-py3-none-any.whl"
        entries = module.wheel(path, extra={"tiny_fixture-1.0.dist-info/top_level.txt": b"tiny_fixture\n"})
        if broken:
            entries["tiny_fixture-1.0.dist-info/top_level.txt"] = b"different_metadata\n"
        if damaged:
            entries["tiny_fixture/__init__.py"] = b"changed_code = True\n"
        if tag:
            entries["tiny_fixture-1.0.dist-info/WHEEL"] = entries["tiny_fixture-1.0.dist-info/WHEEL"].replace(b"py3-none-any", b"cp36-cp36m-linux_x86_64")
            # A tag mismatch is tested alongside the stale metadata entry; other digest mismatches stay forbidden.
            rows = entries["tiny_fixture-1.0.dist-info/RECORD"].decode().splitlines()
            import base64, hashlib
            body = entries["tiny_fixture-1.0.dist-info/WHEEL"]
            rows = [line if not line.startswith("tiny_fixture-1.0.dist-info/WHEEL,") else "tiny_fixture-1.0.dist-info/WHEEL,sha256="
                + base64.urlsafe_b64encode(hashlib.sha256(body).digest()).rstrip(b"=").decode() + "," + str(len(body)) for line in rows]
            entries["tiny_fixture-1.0.dist-info/RECORD"] = ("\n".join(rows) + "\n").encode()
        with zipfile.ZipFile(path, "w") as archive:
            for name, body in entries.items():
                archive.writestr(name, body)
        checksum = managed.file_hash(path)
        managed.save(self.run / "input-verifications-v1" / (managed.hashlib.sha256(path.name.encode()).hexdigest() + ".json"),
            {"version": 1, "experimentId": self.id, "serverId": self.server, "name": path.name, "sha256": checksum, "checkedAt": 1})
        return path, "tiny-fixture @ " + path.as_uri(), entries

    def operation(self):
        work = self.workspace / "tmp" / ("environment-" + str(uuid.uuid4()))
        work.mkdir(parents=True)
        self.owner.current_operation = self.owner.operations / work.name[12:]
        self.owner.current_operation.mkdir(parents=True)
        return work

    def test_trusted_input_requires_original_hash_and_refuses_foreign_or_changed_files(self):
        path, requirement, _ = self.source()
        service = managed.wheel_metadata(self.owner)
        self.assertEqual(service.resolve(requirement)[0], path)
        path.write_bytes(b"changed")
        with self.assertRaisesRegex(RuntimeError, "authenticated input digest"):
            service.resolve(requirement)
        with self.assertRaisesRegex(RuntimeError, "outside"):
            service.resolve("tiny-fixture @ " + (self.root / path.name).as_uri())
        with self.assertRaisesRegex(RuntimeError, "Only authenticated"):
            service.resolve("tiny-fixture @ https://example.invalid/package.whl")

    def test_metadata_rebuild_is_opt_in_and_preserves_code_originals_and_material_identity(self):
        path, requirement, entries = self.source(broken=True, tag=True)
        original = path.read_bytes()
        service = managed.wheel_metadata(self.owner)
        with self.assertRaisesRegex(RuntimeError, "repairWheelMetadata=true"):
            service.resolve(requirement)
        work = self.operation()
        with patch.object(self.owner, "installation_names", side_effect=lambda paths, *_: {managed.file_hash(paths[0]): {"filename": paths[0].name}}):
            derived, info = service.resolve(requirement, True, work, work)
        self.assertEqual(path.read_bytes(), original)
        verified = self.owner.wheel(derived)
        self.assertTrue(verified["build"].startswith("1asperameta"))
        self.assertEqual(verified["tags"], ["py3-none-any"])
        with zipfile.ZipFile(derived) as archive:
            for name, body in entries.items():
                if name not in (info["prefix"] + "/WHEEL", info["prefix"] + "/RECORD"):
                    self.assertEqual(archive.read(name), body)
        self.assertEqual(service.resolve(requirement)[0], derived)
        self.assertTrue((self.owner.current_operation / "wheel-derivations.v1.json").is_file())

    def test_executable_mismatch_and_incompatible_derived_tags_are_never_accepted(self):
        _, requirement, _ = self.source(broken=True, damaged=True)
        service = managed.wheel_metadata(self.owner)
        with self.assertRaisesRegex(RuntimeError, "Executable"):
            service.resolve(requirement, True, self.workspace, self.workspace)
        _, requirement, _ = self.source(broken=True)
        work = self.operation()
        with patch.object(self.owner, "installation_names", side_effect=lambda paths, *_: {managed.file_hash(paths[0]): {"error": "ABI mismatch"}}):
            with self.assertRaisesRegex(RuntimeError, "target wheel compatibility"):
                service.resolve(requirement, True, work, work)
        self.assertFalse(list(service.records.glob("*.json")))

    def test_direct_input_borrowing_compares_actual_files_instead_of_matching_only_package_versions(self):
        _, requirement, _ = self.source()
        environment, site = self.environment()
        (site / "tiny_fixture-1.0.dist-info/top_level.txt").write_bytes(b"tiny_fixture\n")
        service = managed.wheel_metadata(self.owner)
        self.assertEqual(service.borrowed_requirements([requirement], pathlib.Path(environment["directory"])), ["tiny-fixture==1.0"])
        (site / "tiny_fixture/__init__.py").write_bytes(b"same_version_wrong_source=True\n")
        with self.assertRaisesRegex(RuntimeError, "differs from authenticated"):
            service.borrowed_requirements([requirement], pathlib.Path(environment["directory"]))

    def test_compressed_filename_tags_match_the_complete_declared_tag_set(self):
        path, _, entries = self.source()
        path.unlink()
        path = path.with_name("tiny_fixture-1.0-py2.py3-none-any.whl")
        entries["tiny_fixture-1.0.dist-info/WHEEL"] = entries["tiny_fixture-1.0.dist-info/WHEEL"].replace(
            b"Tag: py3-none-any", b"Tag: py2-none-any\nTag: py3-none-any")
        import base64, hashlib, csv, io
        rows = [[name, "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(body).digest()).rstrip(b"=").decode(), str(len(body))]
            for name, body in entries.items() if not name.endswith("/RECORD")]
        rows.append(["tiny_fixture-1.0.dist-info/RECORD", "", ""])
        record = io.StringIO(); csv.writer(record).writerows(rows)
        entries["tiny_fixture-1.0.dist-info/RECORD"] = record.getvalue().encode()
        with zipfile.ZipFile(path, "w") as archive:
            for name, body in entries.items():
                archive.writestr(name, body)
        self.assertFalse(managed.wheel_metadata(self.owner).inspect("tiny-fixture", path)["tagMismatch"])


if __name__ == "__main__":
    unittest.main()
