/** Prepare immutable remote sources and validate bwrap plus allocated CUDA devices. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { experimentHealthSchema } from '@deepseek-ai/dsh-experiment-worker'
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

async function installSource(config: DeploymentConfig, snapshot: SourceSnapshot, signal?: AbortSignal): Promise<void> {
  const p = paths(config, snapshot.digest)
  await remote(config, `umask 077; mkdir -p ${[`${p.root}/incoming`, `${p.root}/releases`, p.workspace, p.outside, `${p.root}/secrets`, p.state, p.logs, p.tools].map(shellQuote).join(' ')}; chmod 700 ${[p.root, `${p.root}/incoming`, `${p.root}/releases`, p.workspace, p.outside, `${p.root}/secrets`, p.state, p.logs, p.tools].map(shellQuote).join(' ')}`, signal)
  await copy(config, snapshot.archive, p.archive, signal)
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
    pnpm install --frozen-lockfile
    pnpm run build
  elif command -v corepack >/dev/null 2>&1; then
    corepack pnpm install --frozen-lockfile
    corepack pnpm run build
  else
    echo 'pnpm and corepack are unavailable' >&2; exit 1
  fi
  test -f apps/cli/lib/bin.js
  touch .ready
  if [ ! -e ${shellQuote(p.release)} ]; then mv "$stage" ${shellQuote(p.release)}; fi
fi`
  await remote(config, script, signal)
}

async function validateEnvironment(config: DeploymentConfig, digest: string, signal?: AbortSignal): Promise<PreparedEnvironment> {
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
"$bwrap_bin" "$@" -- node ${shellQuote(p.release + '/packages/workflow/experiment-worker/scripts/probe-sandbox.mjs')} "$workspace" "$outside"
"$bwrap_bin" "$@" -- test ! -e "$secret_probe"
"$bwrap_bin" "$@" -- nvidia-smi -L
"$bwrap_bin" "$@" -- python3 ${shellQuote(p.release + '/packages/workflow/experiment-worker/scripts/probe-gpu.py')}
printf 'DSH_DEVICES=%s\\nDSH_BWRAP=%s\\nDSH_HIDDEN=%s\\n' "$devices" "$bwrap_bin" "$private_paths"`
  const output = await remote(config, script, signal)
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

async function installPrivateFile(config: DeploymentConfig, destination: string, content: string, signal?: AbortSignal): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-experiment-secret-'))
  const local = join(directory, 'value')
  const incoming = `${destination}.incoming-${randomUUID()}`
  try {
    writeFileSync(local, content, { mode: 0o600 })
    await copy(config, local, incoming, signal)
    await remote(config, `umask 077; chmod 600 ${shellQuote(incoming)}; mv -f -- ${shellQuote(incoming)} ${shellQuote(destination)}`, signal)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

async function launch(config: DeploymentConfig, prepared: PreparedEnvironment, signal?: AbortSignal): Promise<void> {
  const p = paths(config, prepared.deploymentId)
  const script = `set -eu
pidfile=${shellQuote(p.state + '/worker.pid')}
if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
  test "$(cat ${shellQuote(p.state + '/worker.deployment')})" = ${shellQuote(prepared.deploymentId)} || { echo 'different worker is active' >&2; exit 1; }
  exit 0
fi
cd ${shellQuote(p.workspace)}
export HOME=${shellQuote(p.workspace)}
export XDG_CACHE_HOME=${shellQuote(p.workspace + '/.cache')}
export HF_HOME=${shellQuote(p.workspace + '/.cache/huggingface')}
export TORCH_HOME=${shellQuote(p.workspace + '/.cache/torch')}
export PIP_CACHE_DIR=${shellQuote(p.workspace + '/.cache/pip')}
export DSH_HOME=${shellQuote(p.state + '/home')}
export DSH_EXPERIMENT_WORKSPACE=${shellQuote(p.workspace)}
export DSH_EXPERIMENT_TOKEN_FILE=${shellQuote(p.tokenFile)}
export DSH_EXPERIMENT_MODEL_CREDENTIAL_FILE=${shellQuote(p.modelCredentials)}
export DSH_EXPERIMENT_LOG_FILE=${shellQuote(p.logs + '/worker-' + prepared.deploymentId + '.log')}
export DSH_EXPERIMENT_DEPLOYMENT_ID=${shellQuote(prepared.deploymentId)}
export DSH_EXPERIMENT_DEVICES=${shellQuote(prepared.devicePaths.join(','))}
export DSH_EXPERIMENT_BWRAP=${shellQuote(prepared.backendPath)}
export DSH_EXPERIMENT_HIDDEN_PATHS=${shellQuote(prepared.hiddenPaths.join(','))}
export DSH_EXPERIMENT_PORT=${shellQuote(String(config.remotePort))}
export PATH=${shellQuote(p.tools + '/usr/bin')}:"$PATH"
setsid node ${shellQuote(p.release + '/apps/cli/lib/bin.js')} --profile experiment-worker </dev/null >>${shellQuote(p.logs + '/worker-' + prepared.deploymentId + '.log')} 2>&1 &
echo "$!" > "$pidfile"
printf '%s' ${shellQuote(prepared.deploymentId)} > ${shellQuote(p.state + '/worker.deployment')}`
  await remote(config, script, signal)
}

/**
 * Prepare a release and restore the previous idle worker if activation fails.
 * @param config - trusted SSH target and deployment paths.
 * @param snapshot - source archive and its content digest.
 * @param token - receiver secret from the credential service.
 * @param modelCredentials - model-provider credentials resolved through the local credential service.
 * @param signal - aborts setup and transport.
 * @returns the verified release and device report.
 */
export async function deploy(
  config: DeploymentConfig,
  snapshot: SourceSnapshot,
  token: string,
  modelCredentials: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<PreparedEnvironment> {
  await installSource(config, snapshot, signal)
  const prepared = await validateEnvironment(config, snapshot.digest, signal)
  const p = paths(config, snapshot.digest)
  await installPrivateFile(config, p.tokenFile, `${token}\n`, signal)
  await installPrivateFile(config, p.modelCredentials, `${JSON.stringify({ version: 1, refs: modelCredentials })}\n`, signal)
  const active = await remote(config, `if [ -f ${shellQuote(p.state + '/worker.pid')} ] && kill -0 "$(cat ${shellQuote(p.state + '/worker.pid')})" 2>/dev/null; then cat ${shellQuote(p.state + '/worker.deployment')}; fi`, signal)
  const previous = active.trim()
  if (previous !== '' && previous !== snapshot.digest) {
    const health = await request(config, token, '/experiment/v1/health', 'GET', undefined, signal)
    const body = experimentHealthSchema.safeParse(health.value)
    if (health.status !== 200 || !body.success || body.data.busy || body.data.deploymentId !== previous) {
      throw new Error('previous worker is busy or unhealthy; deployment remains staged')
    }
    const stop = await request(config, token, '/experiment/v1/shutdown', 'POST', {}, signal)
    if (stop.status !== 200) throw new Error('previous worker refused idle shutdown')
    await remote(config, `pid=$(cat ${shellQuote(p.state + '/worker.pid')}); for n in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || exit 0; sleep 1; done; exit 1`, signal)
  }
  try {
    await launch(config, prepared, signal)
    const health = await request(config, token, '/experiment/v1/health', 'GET', undefined, signal)
    const body = experimentHealthSchema.safeParse(health.value)
    if (health.status !== 200 || !body.success || body.data.deploymentId !== snapshot.digest) {
      throw new Error('new worker did not return valid health for the deployed version')
    }
    return prepared
  } catch (error: unknown) {
    if (previous !== '' && previous !== snapshot.digest && /^[a-f0-9]{64}$/.test(previous)) {
      try {
        await remote(config, `set -eu
pidfile=${shellQuote(p.state + '/worker.pid')}
if [ -f "$pidfile" ] && [ "$(cat ${shellQuote(p.state + '/worker.deployment')})" = ${shellQuote(snapshot.digest)} ]; then
  pid=$(cat "$pidfile")
  kill "$pid" 2>/dev/null || true
  for n in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -9 "$pid" 2>/dev/null || true
  rm -f -- "$pidfile" ${shellQuote(p.state + '/worker.deployment')}
fi`, signal)
        await launch(config, { ...prepared, deploymentId: previous }, signal)
        const restored = await request(config, token, '/experiment/v1/health', 'GET', undefined, signal)
        const body = experimentHealthSchema.safeParse(restored.value)
        if (restored.status !== 200 || !body.success || body.data.deploymentId !== previous) {
          throw new Error('previous worker did not recover after the new release failed')
        }
      } catch (rollbackError: unknown) {
        throw new AggregateError([error, rollbackError], 'new worker failed and the previous worker could not be restored')
      }
    }
    throw error
  }
}
