"""Build a fixed native sandbox in private account directories without package installation."""
import base64
import fcntl
import hashlib
import io
import json
import os
import pathlib
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import urllib.request
import zipfile


def native_hash(path):
    checksum = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(65536), b''):
            checksum.update(chunk)
    return checksum.hexdigest()


def native_private(path):
    path = pathlib.Path(path)
    if any(parent.is_symlink() for parent in (path, *path.parents)):
        raise RuntimeError('Native tool directory contains a symlink: ' + str(path))
    if not path.exists():
        native_private(path.parent)
        path.mkdir(mode=0o700)
    value = path.stat()
    if not stat.S_ISDIR(value.st_mode) or value.st_uid != os.geteuid() or value.st_mode & 0o022:
        raise RuntimeError('Native tool directory is not account-owned and private: ' + str(path))


def native_saved(path, value):
    path = pathlib.Path(path)
    temporary = path.with_name(path.name + '.incoming-' + str(os.getpid()))
    with temporary.open('x') as stream:
        json.dump(value, stream, sort_keys=True); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, path)


def native_source(control, item, filename, budget, timeout_ms):
    directory = control / 'tools/source-materials' / item.get('name', 'bubblewrap') / item['version']
    native_private(directory)
    path = directory / (item['sha256'] + pathlib.Path(filename).suffix if filename.endswith('.whl') else item['sha256'] + '.tar.xz')
    if path.exists():
        if path.is_symlink() or not path.is_file() or native_hash(path) != item['sha256']:
            raise RuntimeError('Native build cache differs from its fixed digest: ' + str(path))
        return path
    if item['bytes'] > budget:
        raise RuntimeError('Native build source exceeds the configured byte limit')
    temporary = path.with_name(path.name + '.download-' + str(os.getpid()))
    try:
        with urllib.request.urlopen(item['url'], timeout=timeout_ms / 1000) as response, temporary.open('xb') as stream:
            count = 0
            while True:
                chunk = response.read(65536)
                if not chunk: break
                count += len(chunk)
                if count > item['bytes']:
                    raise RuntimeError('Native build download exceeds its fixed size')
                stream.write(chunk)
            stream.flush(); os.fsync(stream.fileno())
        if count != item['bytes'] or native_hash(temporary) != item['sha256']:
            raise RuntimeError('Native build download differs from its fixed size or SHA-256')
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return path


def native_extract(path, directory, limit):
    total = 0
    native_private(directory)
    if path.suffix == '.whl':
        with zipfile.ZipFile(path) as archive:
            entries = [(item.filename, item.is_dir(), stat.S_ISLNK(item.external_attr >> 16), item.file_size, item) for item in archive.infolist()]
            for name, is_directory, link, size, item in entries:
                target = directory / name
                if link or pathlib.PurePosixPath(name).is_absolute() or '..' in pathlib.PurePosixPath(name).parts or '\\' in name:
                    raise RuntimeError('Native tool archive escapes its private directory')
                total += size
                if total > limit: raise RuntimeError('Expanded native tool exceeds its byte limit')
                if is_directory:
                    native_private(target); continue
                native_private(target.parent)
                with archive.open(item) as source, target.open('xb') as output: shutil.copyfileobj(source, output)
    else:
        with tarfile.open(path) as archive:
            links = []
            for item in archive.getmembers():
                name = pathlib.PurePosixPath(item.name)
                if name.is_absolute() or '..' in name.parts or item.islnk() or not (item.isfile() or item.isdir() or item.issym()):
                    raise RuntimeError('Native source archive escapes its private directory')
                if item.issym():
                    links.append(item); continue
                total += item.size
                if total > limit: raise RuntimeError('Expanded native source exceeds its byte limit')
                target = directory / item.name
                if item.isdir(): native_private(target); continue
                native_private(target.parent)
                with archive.extractfile(item) as source, target.open('xb') as output: shutil.copyfileobj(source, output)
                if item.mode & 0o111: target.chmod(0o700)
            for item in links:
                target = directory / item.name
                source = (target.parent / item.linkname).resolve()
                if pathlib.PurePosixPath(item.linkname).is_absolute() or not source.is_relative_to(directory.resolve()) or not source.is_file() or source.is_symlink():
                    raise RuntimeError('Native source link escapes its private directory')
                total += source.stat().st_size
                if total > limit: raise RuntimeError('Expanded native source exceeds its byte limit')
                native_private(target.parent)
                with source.open('rb') as original, target.open('xb') as output: shutil.copyfileobj(original, output)


def native_worker(request):
    control = pathlib.Path(request['controlRoot'])
    recipe = request['nativeRecipe']
    if platform.machine() != recipe['architecture'] or recipe['version'] != 1:
        raise RuntimeError('The fixed native build recipe does not support this architecture')
    root = pathlib.Path(request['nativeBuildDirectory'])
    native_private(root)
    environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(root), 'TMPDIR': str(root), 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'}
    def run(argv):
        value = subprocess.run(argv, cwd=root, env=environment, capture_output=True, text=True)
        if value.stdout: print(value.stdout, file=sys.stderr, end='')
        if value.stderr: print(value.stderr, file=sys.stderr, end='')
        if value.returncode: raise RuntimeError('Native build command failed (' + str(value.returncode) + '): ' + str(argv[0]))
        return value.stdout.strip()
    compiler = shutil.which('cc', path=environment['PATH'])
    if compiler is None: raise RuntimeError('A C compiler is required for the private native sandbox build')
    library = pathlib.Path(run([compiler, '-print-file-name=libcap.so.2'])).resolve()
    if not library.is_file() or library.read_bytes()[:4] != b'\x7fELF':
        raise RuntimeError('The account libcap.so.2 runtime is unavailable')
    library_hash = native_hash(library)
    library_version = re.search(r'libcap\.so\.(\d+(?:\.\d+)+)$', library.name)
    if library_version is None: raise RuntimeError('The account libcap runtime version cannot be confirmed')
    header = root / 'include/sys/capability.h'
    native_private(header.parent)
    system_header = pathlib.Path('/usr/include/sys/capability.h')
    header_evidence = {'source': str(system_header)}
    if system_header.is_file():
        header.write_bytes(system_header.read_bytes())
    else:
        metadata = run(['apt-cache', 'show', 'libcap-dev'])
        stanza = metadata.strip().split('\n\n')[0]
        fields = dict(re.findall(r'^([A-Za-z0-9-]+): (.*)$', stanza, re.M))
        if fields.get('Package') != 'libcap-dev' or fields.get('Architecture') != 'amd64' or not re.fullmatch('[a-f0-9]{64}', fields.get('SHA256', '')):
            raise RuntimeError('Signed package metadata does not identify libcap-dev for this platform')
        if int(fields['Size']) > request['nativeBuildBytes']: raise RuntimeError('Native header package exceeds the build limit')
        run(['apt-get', 'download', 'libcap-dev=' + fields['Version']])
        packages = list(root.glob('*.deb'))
        if len(packages) != 1 or native_hash(packages[0]) != fields['SHA256']:
            raise RuntimeError('Private libcap-dev download differs from signed package metadata')
        payload = subprocess.run(['dpkg-deb', '--fsys-tarfile', str(packages[0])], cwd=root, env=environment, capture_output=True, check=True).stdout
        with tarfile.open(fileobj=io.BytesIO(payload), mode='r:') as archive:
            member = next(item for item in archive if item.name.removeprefix('./') == 'usr/include/sys/capability.h')
            if not member.isfile() or member.size > request['nativeBuildBytes']: raise RuntimeError('Native header is not a bounded regular file')
            header.write_bytes(archive.extractfile(member).read())
        header_evidence = {'package': 'libcap-dev', 'version': fields['Version'], 'sha256': fields['SHA256']}
    tools = root / 'build-tools'
    native_private(tools)
    programs = {}
    for item in recipe['tools']:
        wheel = native_source(control, item, item['filename'], request['nativeBuildBytes'], request['probeTimeoutMs'])
        native_extract(wheel, tools, request['nativeBuildBytes'])
        if 'executable' in item:
            executable = tools / item['executable']
            if executable.read_bytes()[:4] != b'\x7fELF': raise RuntimeError('Native build tool is not an ELF executable')
            executable.chmod(0o700)
            programs[item['name']] = str(executable)
    environment['PATH'] = str(pathlib.Path(programs['ninja']).parent) + ':' + environment['PATH']
    environment.update(PKG_CONFIG=programs['pkgconf'], PKG_CONFIG_LIBDIR=str(root / 'pkgconfig'), PKG_CONFIG_PATH='', CC=compiler)
    native_private(root / 'pkgconfig')
    (root / 'pkgconfig/libcap.pc').write_text('Name: libcap\nDescription: account runtime and verified private headers\nVersion: ' + library_version.group(1) + '\nLibs: ' + str(library) + '\nCflags: -I' + str(root / 'include') + '\n')
    source = native_source(control, recipe['bubblewrap'], 'source.tar.xz', request['nativeBuildBytes'], request['probeTimeoutMs'])
    native_extract(source, root / 'source', request['nativeBuildBytes'])
    install = control / 'tools/sandbox-native/versions' / request['nativeBuildKey']
    native_private(install.parent)
    if install.exists(): raise RuntimeError('An unpublished native generation already exists; inspect its original operation')
    meson = [request['python'], '-I', '-B', '-c', 'import sys;sys.path.insert(0,' + repr(str(tools)) + ');from mesonbuild.mesonmain import main;sys.exit(main())']
    run(meson + ['setup', str(root / 'build'), str(root / 'source' / ('bubblewrap-' + recipe['bubblewrap']['version'])), '--prefix', str(install), '--buildtype=release', '--strip', '-Dman=disabled', '-Dtests=false', '-Dselinux=disabled', '-Dbash_completion=disabled', '-Dzsh_completion=disabled'])
    run([programs['ninja'], '-C', str(root / 'build')])
    run(meson + ['install', '-C', str(root / 'build'), '--no-rebuild'])
    binary = install / 'bin/bwrap'
    if binary.is_symlink() or not binary.is_file() or binary.stat().st_mode & 0o6000:
        raise RuntimeError('Native sandbox is not an ordinary non-setuid executable')
    if run([str(binary), '--version']) != 'bubblewrap ' + recipe['bubblewrap']['version'] or '--size' not in run([str(binary), '--help']):
        raise RuntimeError('Built sandbox does not provide the fixed version and bounded tmpfs option')
    if native_hash(library) != library_hash: raise RuntimeError('Account libcap runtime changed during compilation')
    result = {'version': 1, 'path': str(binary), 'digest': native_hash(binary), 'recipeHash': request['nativeRecipeHash'],
        'sourceVersion': recipe['bubblewrap']['version'], 'library': str(library), 'libraryHash': library_hash,
        'header': header_evidence, 'operationDirectory': request['nativeBuildDirectory']}
    native_saved(root / 'candidate.v1.json', result)
    return result


def ensure_native_sandbox(request, native, result):
    if 'nativeRecipe' not in request: return native
    help_result = subprocess.run([native['bwrap']['path'], '--help'], capture_output=True, text=True, timeout=request['probeTimeoutMs'] / 1000)
    if help_result.returncode == 0 and '--size' in help_result.stdout: return native
    recipe_hash = hashlib.sha256(json.dumps(request['nativeRecipe'], sort_keys=True).encode()).hexdigest()
    root = pathlib.Path(request['controlRoot']) / 'tools/sandbox-native'
    index = root / (recipe_hash + '.v1.json')
    if index.is_symlink() or any(parent.is_symlink() for parent in index.parents):
        raise RuntimeError('Private native sandbox index escapes its account directory')
    if index.is_file():
        saved = json.loads(index.read_text())
        binary = pathlib.Path(saved['path'])
        if saved.get('version') != 1 or saved.get('recipeHash') != recipe_hash or not binary.is_relative_to(root / 'versions') or binary.is_symlink() or not binary.is_file() or native_hash(binary) != saved['digest'] or native_hash(saved['library']) != saved['libraryHash']:
            raise RuntimeError('Published private native sandbox or its account library changed')
        result['nativeBuild'] = {'version': saved['sourceVersion'], 'state': 'configured', 'receipt': str(index)}
        return {**native, 'bwrap': {'path': saved['path'], 'digest': saved['digest']}}
    result['nativeBuild'] = {'version': request['nativeRecipe']['bubblewrap']['version'], 'state': 'available'}
    if request['mode'] == 'inspect':
        result.update(state='available', requiresPlatformAction=False, reason='The native bubblewrap lacks --size. The dedicated repair can build a fixed compatible binary in private directories without changing OS packages, old controllers or training dependencies.')
        return None
    if request['maxAttempts'] == 0: raise RuntimeError('Native sandbox repair is disabled by deployment policy')
    own_control_root(request)
    native_private(root)
    operation = os.environ.get('ASPERA_PREPARATION_COMMAND_DIRECTORY')
    if not operation: raise RuntimeError('Native sandbox build requires a supervised preparation command')
    command = pathlib.Path(operation)
    key = hashlib.sha256(str(command).encode()).hexdigest()
    build = root / 'builds' / key
    native_private(build)
    if shutil.disk_usage(root).free < request['nativeBuildBytes'] + request['minimumFreeBytes']:
        raise RuntimeError('Private native sandbox build exceeds the available account-tool budget')
    with open(root / 'build.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        attempt_path = root / ('attempts-' + request['experimentId'] + '.v1.json')
        attempts = json.loads(attempt_path.read_text()) if attempt_path.exists() else []
        previous = next((row for row in attempts if row['operation'] == operation), None)
        if previous is not None: raise RuntimeError('Recover the original native sandbox build before requesting another attempt')
        for row in attempts:
            if row['state'] == 'building':
                exited = pathlib.Path(row['operation']) / 'exited'
                if not exited.is_file() or not re.fullmatch(r'\d+\s*', exited.read_text()):
                    raise RuntimeError('Previous native sandbox build exit is unconfirmed: ' + row['operation'])
                row.update(state='recovered-exit', exitConfirmed=True)
        if len(attempts) >= request['maxAttempts']: raise RuntimeError('Native sandbox repair attempt limit reached')
        attempt = {'operation': operation, 'state': 'building', 'recipeHash': recipe_hash, 'exitConfirmed': False}
        attempts.append(attempt); native_saved(attempt_path, attempts)
        worker = build / 'worker.py'
        worker.write_text(NATIVE_BUILDER_SOURCE + '\nif __name__=="__main__":\n print(json.dumps(native_worker(json.loads(sys.argv[1]))))\n')
        options = {**request, 'nativeRecipeHash': recipe_hash, 'nativeBuildKey': recipe_hash + '-' + key[:16], 'nativeBuildDirectory': str(build)}
        probe = {**request, 'probeTimeoutMs': request['nativeBuildTimeoutMs']}
        try:
            code, stdout, stderr = run_probe([request['python'], '-B', str(worker), json.dumps(options)], probe)
            if stderr: print(stderr, file=sys.stderr, end='')
            attempt.update(exitConfirmed=True, exitCode=code)
            if code != 0: raise RuntimeError('Private native sandbox build failed: ' + stderr[-12000:])
            value = json.loads(stdout)
            if value['recipeHash'] != recipe_hash or native_hash(value['path']) != value['digest']:
                raise RuntimeError('Native sandbox build result identity differs')
            native_saved(index, value)
            attempt['state'] = 'configured'; native_saved(attempt_path, attempts)
            result['nativeBuild'] = {'version': value['sourceVersion'], 'state': 'configured', 'receipt': str(index)}
            return {**native, 'bwrap': {'path': value['path'], 'digest': value['digest']}}
        except BaseException as error:
            if hasattr(error, 'confirmed'):
                attempt.update(exitConfirmed=error.confirmed, exitCode=error.code)
            attempt.update(state='failed' if attempt['exitConfirmed'] else 'building', detail=str(error))
            native_saved(attempt_path, attempts)
            result['nativeBuild'] = {'version': request['nativeRecipe']['bubblewrap']['version'],
                'state': 'failed' if attempt['exitConfirmed'] else 'unknown', 'receipt': str(attempt_path),
                'exitConfirmed': attempt['exitConfirmed'], 'exitCode': attempt.get('exitCode'), 'detail': str(error)}
            raise
