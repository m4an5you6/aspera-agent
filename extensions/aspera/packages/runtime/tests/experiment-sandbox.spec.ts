/** Namespace and device confinement stays identical across preparation and execution. */
import { expect, it } from 'vitest'
import { experimentIsolationArgs, experimentSandboxArgv } from '../src/experiment-sandbox.ts'

const spec = { backendPath: '/usr/bin/bwrap', workspaceRoot: '/data/.aspera/node/runs/run/workspace',
  devicePaths: ['/dev/nvidia3', '/dev/nvidiactl'], hiddenPaths: ['/control/state', '/control', '/data/.aspera/node', '/control'] }

it('keeps every required namespace for both shell inspection and complete commands', () => {
  const inspection = experimentIsolationArgs()
  const actual = experimentSandboxArgv(spec, ['bash', '-c', 'true'])
  for (const flag of ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--new-session', '--die-with-parent']) {
    expect(inspection).toContain(flag); expect(actual).toContain(flag)
  }
  expect(actual.slice(1, inspection.length + 1)).toEqual(inspection)
  expect(actual.slice(actual.indexOf('--cap-drop'), actual.indexOf('--cap-drop') + 2)).toEqual(['--cap-drop', 'ALL'])
  expect(actual.slice(-4)).toEqual(['--', 'bash', '-c', 'true'])
})

it('exposes only the supplied device grants and preserves masked parent directories', () => {
  const argv = experimentSandboxArgv(spec, ['true'])
  const devices = argv.flatMap((arg, index) => arg === '--dev-bind' ? [argv[index + 1]] : [])
  expect(devices).toEqual(spec.devicePaths)
  expect(argv).not.toContain('/dev/nvidia0')
  const masked = argv.flatMap((arg, index) => arg === '--tmpfs' ? [argv[index + 1]] : [])
  expect(masked).toEqual(['/tmp', '/control', '/data/.aspera/node'])
  expect(argv.slice(argv.indexOf('--bind'), argv.indexOf('--bind') + 3)).toEqual(['--bind', spec.workspaceRoot, spec.workspaceRoot])
  expect(argv.slice(argv.indexOf('--chdir'), argv.indexOf('--chdir') + 2)).toEqual(['--chdir', spec.workspaceRoot])
})

it('clears ambient credentials and uses POSIX cache paths on every construction host', () => {
  const argv = experimentSandboxArgv(spec, ['true'])
  expect(argv).toContain('--clearenv')
  expect(argv.slice(argv.indexOf('HOME'), argv.indexOf('HOME') + 2)).toEqual(['HOME', spec.workspaceRoot])
  expect(argv.slice(argv.indexOf('HF_HOME'), argv.indexOf('HF_HOME') + 2)).toEqual(['HF_HOME', spec.workspaceRoot + '/cache/huggingface'])
  expect(argv.slice(argv.indexOf('TMPDIR'), argv.indexOf('TMPDIR') + 2)).toEqual(['TMPDIR', spec.workspaceRoot + '/tmp'])
})

it('mounts managed packages read-only and permits only individually detached files to be writable', () => {
  const directory = spec.workspaceRoot + '/env/python'
  const file = directory + '/lib/python3.12/site-packages/example.py'
  const argv = experimentSandboxArgv({ ...spec, environment: { readonlyPaths: [directory], writablePaths: [file], python: directory + '/bin/python' } }, ['true'])
  expect(argv).toContain('PYTHONNOUSERSITE'); expect(argv).toContain('PIP_REQUIRE_VIRTUALENV')
  expect(argv).toContain(directory + '/bin:/usr/local/bin:/usr/bin:/bin')
  const mounts = argv.flatMap((arg, index) => arg === '--bind' || arg === '--ro-bind' ? [[arg, argv[index + 1], argv[index + 2]]] : [])
  expect(mounts.slice(-3)).toEqual([['--bind', spec.workspaceRoot, spec.workspaceRoot], ['--ro-bind', directory, directory], ['--bind', file, file]])
  expect(argv).toContain('--unshare-user'); expect(argv).toContain('--cap-drop')
})

it('defaults registered model and dataset commands to offline loading without changing deployment probes', () => {
  const argv = experimentSandboxArgv({ ...spec, offlineMaterials: true }, ['true'])
  for (const name of ['HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_DATASETS_OFFLINE']) {
    expect(argv.slice(argv.indexOf(name) - 1, argv.indexOf(name) + 2)).toEqual(['--setenv', name, '1'])
    expect(experimentSandboxArgv(spec, ['true'])).not.toContain(name)
  }
})
