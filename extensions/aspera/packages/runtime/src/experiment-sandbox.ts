/** Linux confinement shared by preparation probes and managed experiment commands. */
import { posix } from 'node:path'

/** Program-owned directories and device grants for one experiment sandbox. */
export interface ExperimentSandboxSpec {
  readonly backendPath: string
  readonly workspaceRoot: string
  readonly devicePaths: readonly string[]
  readonly hiddenPaths: readonly string[]
}

/**
 * Build the mandatory namespace and filesystem isolation arguments.
 * @returns fresh arguments usable by shell-only inspection before installation.
 */
export function experimentIsolationArgs(): string[] {
  return ['--ro-bind', '/', '/', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    '--die-with-parent', '--new-session', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp']
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
  for (const path of roots.filter(path => !roots.some(parent => path !== parent && path.startsWith(parent + '/')))) argv.push('--tmpfs', path)
  for (const [name, value] of Object.entries({ XDG_CACHE_HOME: posix.join(workspace, 'cache'), HF_HOME: posix.join(workspace, 'cache', 'huggingface'),
    PIP_CACHE_DIR: posix.join(workspace, 'cache', 'pip'), UV_CACHE_DIR: posix.join(workspace, 'cache', 'uv'),
    TORCH_HOME: posix.join(workspace, 'cache', 'torch'), UV_PROJECT_ENVIRONMENT: posix.join(workspace, 'env'),
    CONDA_PKGS_DIRS: posix.join(workspace, 'cache', 'conda'), CONDA_ENVS_PATH: posix.join(workspace, 'envs'), TMPDIR: posix.join(workspace, 'tmp') })) argv.push('--setenv', name, value)
  argv.push('--bind', workspace, workspace, '--chdir', workspace, '--', ...command)
  return argv
}
