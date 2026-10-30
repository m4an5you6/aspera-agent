/** Linux confinement shared by preparation probes and managed experiment commands. */
import { posix } from 'node:path'

/** Program-owned directories and device grants for one experiment sandbox. */
export interface ExperimentSandboxSpec {
  readonly backendPath: string
  readonly workspaceRoot: string
  readonly devicePaths: readonly string[]
  readonly hiddenPaths: readonly string[]
  readonly offlineMaterials?: boolean
  readonly diagnosticTemporaryBytes?: number
  readonly protectedPaths?: readonly string[]
  readonly environment?: { readonlyPaths: readonly string[]; writablePaths: readonly string[]; hiddenPaths?: readonly string[]; python?: string }
}

/**
 * Build the mandatory namespace and filesystem isolation arguments.
 * @returns fresh arguments usable by shell-only inspection before installation.
 */
export function experimentIsolationArgs(): string[] {
  return ['--ro-bind', '/', '/', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp']
}

/**
 * Build the complete launch used for both deterministic probes and actual commands.
 * @param spec - resolved control directories, workspace and authorized devices.
 * @param command - executable and arguments inside confinement.
 * @returns bubblewrap argv with a cleared environment and experiment-local caches.
 */
export function experimentSandboxArgv(spec: ExperimentSandboxSpec, command: readonly string[]): string[] {
  const workspace = spec.workspaceRoot
  const argv = [spec.backendPath, ...experimentIsolationArgs(), '--clearenv', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
    '--setenv', 'HOME', workspace, '--setenv', 'PYTHONUNBUFFERED', '1']
  for (const path of spec.devicePaths) argv.push('--dev-bind', path, path)
  const roots = [...new Set(spec.hiddenPaths)].sort((a, b) => a.length - b.length)
  const hiddenRoots = roots.filter(path => !roots.some(parent => path !== parent && path.startsWith(parent + '/')))
  for (const path of hiddenRoots) argv.push('--tmpfs', path)
  if (spec.diagnosticTemporaryBytes !== undefined) {
    argv.push('--size', String(spec.diagnosticTemporaryBytes), '--tmpfs', '/tmp', '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp',
      '--setenv', 'XDG_CACHE_HOME', '/tmp', '--setenv', 'PYTHONDONTWRITEBYTECODE', '1')
  }
  for (const [name, value] of Object.entries({ XDG_CACHE_HOME: posix.join(workspace, 'cache'), HF_HOME: posix.join(workspace, 'cache', 'huggingface'),
    PIP_CACHE_DIR: posix.join(workspace, 'cache', 'pip'), UV_CACHE_DIR: posix.join(workspace, 'cache', 'uv'),
    TORCH_HOME: posix.join(workspace, 'cache', 'torch'), UV_PROJECT_ENVIRONMENT: posix.join(workspace, 'env'),
    CONDA_PKGS_DIRS: posix.join(workspace, 'cache', 'conda'), CONDA_ENVS_PATH: posix.join(workspace, 'envs'), TMPDIR: '/tmp/aspera' })) argv.push('--setenv', name, spec.diagnosticTemporaryBytes === undefined ? value : '/tmp')
  argv.push(spec.diagnosticTemporaryBytes === undefined ? '--bind' : '--ro-bind', workspace, workspace)
  // Local socket addresses stay short while temporary contents remain on the workspace disk.
  if (spec.diagnosticTemporaryBytes === undefined) argv.push('--dir', posix.join(workspace, 'tmp'), '--symlink', posix.join(workspace, 'tmp'), '/tmp/aspera')
  if (spec.offlineMaterials) for (const name of ['HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_DATASETS_OFFLINE']) argv.push('--setenv', name, '1')
  if (spec.environment !== undefined) {
    for (const path of spec.environment.hiddenPaths ?? []) argv.push('--tmpfs', path)
    for (const path of spec.environment.readonlyPaths) argv.push('--ro-bind', path, path)
    for (const path of spec.environment.writablePaths) argv.push(spec.diagnosticTemporaryBytes === undefined ? '--bind' : '--ro-bind', path, path)
    argv.push('--setenv', 'PYTHONNOUSERSITE', '1', '--setenv', 'PIP_REQUIRE_VIRTUALENV', '1', '--setenv', 'PYTHONDONTWRITEBYTECODE', '1')
    if (spec.environment.python !== undefined) {
      const directory = posix.dirname(posix.dirname(spec.environment.python))
      argv.push('--setenv', 'VIRTUAL_ENV', directory, '--setenv', 'PATH', posix.join(directory, 'bin') + ':/usr/local/bin:/usr/bin:/bin')
    }
  }
  for (const path of spec.protectedPaths ?? []) argv.push('--ro-bind', path, path)
  for (const path of spec.environment?.hiddenPaths ?? []) argv.push('--remount-ro', path)
  if (spec.diagnosticTemporaryBytes !== undefined) {
    for (const path of hiddenRoots) argv.push('--remount-ro', path)
    argv.push('--remount-ro', '/dev')
  }
  argv.push('--chdir', workspace, '--', ...command)
  return argv
}
