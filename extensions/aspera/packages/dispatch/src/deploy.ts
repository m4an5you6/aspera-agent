/** Prepare immutable remote sources and validate bwrap plus allocated CUDA devices. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceSnapshot } from './snapshot.ts'
import { copy, remote, request, shellQuote } from './transport.ts'
import type { Target } from './transport.ts'

/** Trusted deployment configuration shared by the dispatch tools. */
export interface DeploymentConfig extends Target {
  readonly remoteRoot: string
  readonly localRepo: string
  readonly dataRoots: readonly string[]
  readonly allowedSystemPackages: readonly string[]
  readonly agentCredentialRefs: readonly string[]
  readonly tokenRef: string
  /** Interval for observing remote control process transitions. */
  readonly controlPollIntervalMs: number
}

/** Probe result attached to one deployed version. */
export interface PreparedEnvironment {
  readonly state: 'ready'
  readonly deploymentId: string
  readonly preparationId: string
  readonly backend: 'bwrap'
  readonly backendPath: string
  readonly sandboxWriteProbe: 'passed'
  readonly cudaProbe: 'passed'
  readonly devicePaths: readonly string[]
  readonly hiddenPaths: readonly string[]
  readonly workspaceRoot: string
}

function paths(config: DeploymentConfig, digest: string) {
  const root = config.remoteRoot
  return {
    root, release: `${root}/releases/${digest}`, archive: `${root}/incoming/${digest}.tar`,
    workspace: `${root}/workspace`, outside: `${root}/probe-outside`,
    tokenFile: `${root}/secrets/receiver.token`, modelCredentials: `${root}/secrets/model-${digest}.yaml`, state: `${root}/state`,
    logs: `${root}/logs`, tools: `${root}/tools`,
  }
}

/**
 * Install a content-checked source release without replacing active processes.
 * @param config - fixed deployment target.
 * @param snapshot - content-addressed source archive.
 * @param signal - preparation cancellation.
 * @param password - selected SSH credential.
 */
export async function installSource(config: DeploymentConfig, snapshot: SourceSnapshot, signal?: AbortSignal,
  password?: string): Promise<void> {
  const p = paths(config, snapshot.digest)
  await remote(config, `umask 077; mkdir -p ${[`${p.root}/incoming`, `${p.root}/releases`, p.workspace, p.outside, `${p.root}/secrets`, p.state, p.logs, p.tools].map(shellQuote).join(' ')}; chmod 700 ${[p.root, `${p.root}/incoming`, `${p.root}/releases`, p.workspace, p.outside, `${p.root}/secrets`, p.state, p.logs, p.tools].map(shellQuote).join(' ')}`, signal, password)
  await copy(config, snapshot.archive, p.archive, signal, password)
  const script = `set -eu
test "$(sha256sum ${shellQuote(p.archive)} | cut -d ' ' -f 1)" = ${shellQuote(snapshot.archiveHash)}
if [ -e ${shellQuote(p.release)} ] && [ ! -f ${shellQuote(p.release + '/.ready')} ]; then
  echo 'existing release directory is incomplete' >&2; exit 1
fi
if [ ! -f ${shellQuote(p.release + '/.ready')} ]; then
  stage=${shellQuote(p.release + '.building-' + randomUUID())}
  mkdir -p "$stage"
  trap 'rm -rf -- "$stage"' EXIT
  tar -xf ${shellQuote(p.archive)} -C "$stage"
  cd "$stage"
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install --frozen-lockfile --prod
  elif command -v corepack >/dev/null 2>&1; then
    corepack pnpm install --frozen-lockfile --prod
  else
    echo 'pnpm and corepack are unavailable' >&2; exit 1
  fi
  test -f node_modules/@deepseek-ai/dsh/lib/bin.js
  touch .ready
  if [ ! -e ${shellQuote(p.release)} ]; then mv "$stage" ${shellQuote(p.release)}; fi
fi`
  await remote(config, script, signal, password)
}

/**
 * Verify sandbox confinement and allocated CUDA devices for an installed release.
 * @param config - fixed deployment target.
 * @param digest - installed release digest.
 * @param signal - probe cancellation.
 * @param password - selected SSH credential.
 * @returns verified CUDA and sandbox facts.
 */
export async function validateEnvironment(
  config: DeploymentConfig, digest: string, signal?: AbortSignal, password?: string,
): Promise<PreparedEnvironment> {
  const p = paths(config, digest)
  const script = `set -eu
workspace=${shellQuote(p.workspace)}
outside=${shellQuote(p.outside)}
tools=${shellQuote(p.tools)}
bwrap_bin=$(command -v bwrap || true)
if [ -z "$bwrap_bin" ] || ! "$bwrap_bin" --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true >/dev/null 2>&1; then
  test ${shellQuote(config.allowedSystemPackages.includes('bubblewrap') ? 'yes' : 'no')} = yes || { echo 'bubblewrap unavailable and not allowed by deployment configuration' >&2; exit 1; }
  command -v apt-get >/dev/null && command -v dpkg-deb >/dev/null || { echo 'bubblewrap unavailable and apt extraction unsupported' >&2; exit 1; }
  mkdir -p "$tools"
  cd "$tools"
  apt-get download bubblewrap
  for deb in bubblewrap_*.deb; do test -f "$deb" || exit 1; dpkg-deb -x "$deb" "$tools"; done
  bwrap_bin="$tools/usr/bin/bwrap"
fi
"$bwrap_bin" --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true
devices=''
gpu_count=0
private_paths=${shellQuote(p.root + '/secrets,' + p.state)}
if [ -d "$HOME/.ssh" ]; then private_paths="$private_paths,$HOME/.ssh"; fi
for dev in /dev/nvidia[0-9]* /dev/nvidiactl /dev/nvidia-uvm /dev/nvidia-uvm-tools /dev/nvidia-modeset /dev/nvidia-caps/nvidia-cap*; do
  if [ -c "$dev" ]; then
    case "$dev" in /dev/nvidia[0-9]*) gpu_count=$((gpu_count + 1));; esac
    if [ -z "$devices" ]; then devices="$dev"; else devices="$devices,$dev"; fi
  fi
done
test "$gpu_count" -ge 1 || { echo 'no allocated NVIDIA character device' >&2; exit 1; }
set -- --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent --tmpfs /tmp --bind "$workspace" "$workspace"
old_ifs="$IFS"; IFS=,
for dev in $devices; do set -- "$@" --dev-bind "$dev" "$dev"; done
for path in $private_paths; do set -- "$@" --tmpfs "$path"; done
IFS="$old_ifs"
secret_probe=${shellQuote(p.root + '/secrets/probe-private')}
printf 'private' > "$secret_probe"
trap 'rm -f -- "$secret_probe"' EXIT
"$bwrap_bin" "$@" -- node ${shellQuote(p.release + '/node_modules/@aspera/runtime/scripts/probe-sandbox.mjs')} "$workspace" "$outside"
"$bwrap_bin" "$@" -- test ! -e "$secret_probe"
"$bwrap_bin" "$@" -- nvidia-smi -L
"$bwrap_bin" "$@" -- python3 ${shellQuote(p.release + '/node_modules/@aspera/runtime/scripts/probe-gpu.py')}
printf 'DSH_DEVICES=%s\\nDSH_BWRAP=%s\\nDSH_HIDDEN=%s\\n' "$devices" "$bwrap_bin" "$private_paths"`
  const output = await remote(config, script, signal, password)
  const match = /^DSH_DEVICES=(.+)$/m.exec(output)
  const backend = /^DSH_BWRAP=(.+)$/m.exec(output)
  const hidden = /^DSH_HIDDEN=(.+)$/m.exec(output)
  if (match?.[1] === undefined || backend?.[1] === undefined || hidden?.[1] === undefined) {
    throw new Error('remote sandbox/GPU probe did not report its backend and granted devices')
  }
  return {
    state: 'ready', deploymentId: digest, preparationId: digest, backend: 'bwrap',
    backendPath: backend[1], devicePaths: match[1].split(','), hiddenPaths: hidden[1].split(','), workspaceRoot: p.workspace,
    sandboxWriteProbe: 'passed', cudaProbe: 'passed',
  }
}

/**
 * Atomically install private runtime settings through the selected SSH login.
 * @param config - fixed deployment target.
 * @param destination - owner-only remote file path.
 * @param content - private file contents.
 * @param signal - transfer cancellation.
 * @param password - selected SSH credential.
 */
export async function installPrivateFile(
  config: DeploymentConfig, destination: string, content: string, signal?: AbortSignal, password?: string,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-experiment-secret-'))
  const local = join(directory, 'value')
  const incoming = `${destination}.incoming-${randomUUID()}`
  try {
    writeFileSync(local, content, { mode: 0o600 })
    await copy(config, local, incoming, signal, password)
    await remote(config, `umask 077; chmod 600 ${shellQuote(incoming)}; mv -f -- ${shellQuote(incoming)} ${shellQuote(destination)}`, signal, password)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
