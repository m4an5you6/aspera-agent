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
