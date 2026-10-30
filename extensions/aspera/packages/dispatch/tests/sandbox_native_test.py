"""Private native build materials retain archive paths, fixed hashes and readonly inspection."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

if os.name == 'posix':
    spec = importlib.util.spec_from_file_location('sandbox_native', Path(__file__).parents[1] / 'scripts/build-sandbox-native.py')
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)


@unittest.skipUnless(os.name == 'posix', 'Native builder uses Linux ownership and flock')
class NativeMaterialsTests(unittest.TestCase):
    def test_relative_license_links_are_copied_inside_private_source(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); archive = root / 'source.tar.xz'
            with tarfile.open(archive, 'w:xz') as output:
                item = tarfile.TarInfo('source/COPYING'); data = b'license'; item.size = len(data)
                output.addfile(item, io.BytesIO(data))
                link = tarfile.TarInfo('source/LICENSE'); link.type = tarfile.SYMTYPE; link.linkname = 'COPYING'; output.addfile(link)
            native.native_extract(archive, root / 'expanded', 1024)
            self.assertEqual((root / 'expanded/source/LICENSE').read_bytes(), data)
            self.assertFalse((root / 'expanded/source/LICENSE').is_symlink())

    def test_source_links_and_wheel_entries_cannot_escape_the_private_directory(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); archive = root / 'source.tar.xz'
            with tarfile.open(archive, 'w:xz') as output:
                link = tarfile.TarInfo('source/LICENSE'); link.type = tarfile.SYMTYPE; link.linkname = '../../outside'; output.addfile(link)
            with self.assertRaisesRegex(RuntimeError, 'escapes'):
                native.native_extract(archive, root / 'source', 1024)
            wheel = root / 'tool.whl'
            with zipfile.ZipFile(wheel, 'w') as output: output.writestr('../outside', b'rejected')
            with self.assertRaisesRegex(RuntimeError, 'escapes'):
                native.native_extract(wheel, root / 'wheel', 1024)
            self.assertFalse((root / 'outside').exists())

    def test_changed_cache_is_retained_and_cannot_be_used_or_overwritten(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); digest = hashlib.sha256(b'expected').hexdigest()
            cache = root / 'tools/source-materials/fixture/1'; cache.mkdir(parents=True)
            path = cache / (digest + '.whl'); path.write_bytes(b'changed')
            request = {'name': 'fixture', 'version': '1', 'bytes': 8, 'sha256': digest, 'url': 'https://example.invalid/tool.whl'}
            with patch.object(native.urllib.request, 'urlopen', side_effect=AssertionError('No replacement download')):
                with self.assertRaisesRegex(RuntimeError, 'fixed digest'):
                    native.native_source(root, request, 'tool.whl', 1024, 1000)
            self.assertEqual(path.read_bytes(), b'changed')

    def test_size_limit_rejects_expansion_without_exposing_outside_files(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name); wheel = root / 'tool.whl'
            with zipfile.ZipFile(wheel, 'w') as output: output.writestr('package/file', b'large' * 100)
            with self.assertRaisesRegex(RuntimeError, 'byte limit'):
                native.native_extract(wheel, root / 'expanded', 64)


if __name__ == '__main__': unittest.main()
