/** Prepare immutable remote sources and validate bwrap plus allocated CUDA devices. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceSnapshot } from './snapshot.ts'
import { copy, remote, RemoteCommandError, shellQuote } from './transport.ts'
import type { Target } from './transport.ts'
import type { StoragePlacement, InferenceMapping, GpuInventory, ControllerStatus } from '@aspera/experiments'
import { parseGpuInventory, normalizedSet } from '@aspera/experiments'
import { experimentSandboxArgv, gpuIdentityQueryScript, verifyServerStorage } from '@aspera/runtime'
import { SandboxVerificationError } from './sandbox-verification.ts'
import type { SandboxVerificationStage } from './sandbox-verification.ts'
import { z } from 'zod'

/** Trusted deployment configuration shared by the dispatch tools. */
export interface DeploymentConfig extends Target {
  readonly remoteRoot: string
  readonly storagePlacement?: StoragePlacement
  readonly inferenceMapping?: InferenceMapping
  readonly localRepo: string
  readonly dataRoots: readonly string[]
  readonly agentCredentialRefs: readonly string[]
  readonly tokenRef: string
  /** Interval for observing remote control process transitions. */
  readonly controlPollIntervalMs: number
  readonly documentationReadTimeoutMs?: number
  readonly documentationPageBytes?: number
  readonly managedEnvironments?: import('@aspera/runtime').ManagedEnvironmentPolicy
}

/** Probe result attached to one deployed version. */
export interface PreparedEnvironment {
  readonly state: 'ready'
  /** Capabilities required by this verified fixed release; older manifests omit them. */
  readonly requiredFeatures?: readonly string[]
  readonly deploymentId: string
  readonly preparationId: string
  readonly backend: 'bwrap'
  readonly backendPath: string
  readonly sandboxWriteProbe: 'passed'
  readonly cudaProbe: 'passed'
  readonly devicePaths: readonly string[]
  readonly hiddenPaths: readonly string[]
  readonly workspaceRoot: string
  readonly gpu: GpuInventory
  /** Credential-free resident identity attached only after controller acceptance. */
  readonly controller?: ControllerStatus
}

/** An earlier release installer has not reported that its process exited. */
export class ReleaseInstallationPending extends Error {}

function paths(config: DeploymentConfig, digest: string) {
  const root = config.remoteRoot
  const storage = config.storagePlacement
  return {
    root, release: storage?.releaseRoot ?? `${root}/releases/${digest}`, archive: `${storage?.namespaceRoot ?? root}/incoming/${digest}.tar`,
    workspace: storage?.workspaceRoot ?? `${root}/workspace`,
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
  if (config.storagePlacement !== undefined) await verifyServerStorage(config, config.storagePlacement, password, signal, statSync(snapshot.archive).size)
  await remote(config, `umask 077; mkdir -p ${[p.archive.slice(0, p.archive.lastIndexOf('/')), p.release.slice(0, p.release.lastIndexOf('/')), p.workspace, `${p.root}/secrets`, p.state, p.logs, p.tools].map(shellQuote).join(' ')}`, signal, password)
  await copy(config, snapshot.archive, p.archive, signal, password)
  const script = `set -eu
umask 077
lock=${shellQuote(p.release + '.installing')}
if ! mkdir "$lock" 2>/dev/null; then
  test -f "$lock/exited" || { echo "ASPERA_INSTALL_PENDING=$lock" >&2; exit 1; }
  rm -- "$lock/exited"
  rmdir "$lock"
  mkdir "$lock"
fi
stage=''
finish() {
  status=$?
  if [ -n "$stage" ]; then rm -rf -- "$stage"; fi
  printf '%s\\n' "$status" > "$lock/exited"
}
trap finish EXIT
trap '' HUP
export XDG_CACHE_HOME=${shellQuote((config.storagePlacement?.namespaceRoot ?? p.root) + '/cache')}
export npm_config_cache="$XDG_CACHE_HOME/npm"
export COREPACK_HOME="$XDG_CACHE_HOME/corepack"
export TMPDIR=${shellQuote(p.workspace + '/tmp')}
mkdir -p "$XDG_CACHE_HOME" "$TMPDIR"
test "$(sha256sum ${shellQuote(p.archive)} | cut -d ' ' -f 1)" = ${shellQuote(snapshot.archiveHash)}
if [ -e ${shellQuote(p.release)} ] && [ ! -f ${shellQuote(p.release + '/.ready')} ]; then
  echo 'existing release directory is incomplete' >&2; exit 1
fi
if [ ! -f ${shellQuote(p.release + '/.ready')} ]; then
  stage=${shellQuote(p.release + '.building-' + randomUUID())}
  mkdir -p "$stage"
  tar -xf ${shellQuote(p.archive)} -C "$stage"
  cd "$stage"
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install --frozen-lockfile --prod --store-dir "$XDG_CACHE_HOME/pnpm"
  elif command -v corepack >/dev/null 2>&1; then
    corepack pnpm install --frozen-lockfile --prod --store-dir "$XDG_CACHE_HOME/pnpm"
  else
    echo 'pnpm and corepack are unavailable' >&2; exit 1
  fi
  test -f node_modules/@deepseek-ai/dsh/lib/bin.js
  touch .ready
  if [ ! -e ${shellQuote(p.release)} ]; then mv "$stage" ${shellQuote(p.release)}; fi
fi`
  try { await remote(config, script, signal, password) }
  catch (error) {
    if (error instanceof RemoteCommandError && error.result.stderr.includes('ASPERA_INSTALL_PENDING=')) {
      throw new ReleaseInstallationPending(`Release installation has no confirmed exit at ${p.release}.installing; inspect the original installer before retrying.`)
    }
    throw error
  }
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
  const discovery = await remote(config, `set -eu
bwrap_bin=$(command -v bwrap || true)
test -n "$bwrap_bin" || { echo 'bubblewrap is missing from the verified executable directories' >&2; exit 1; }
python3 -c ${shellQuote(`import glob,json,pathlib,stat,sys
root=pathlib.Path(${JSON.stringify(p.root)})
manifest=json.loads(pathlib.Path(${JSON.stringify(p.release + '/package.json')}).read_text())
required=['managed-environment-reuse-v1'] if manifest.get('asperaEnvironmentTools',{}).get('reuseVersion')==1 else []
if manifest.get('asperaEnvironmentTools',{}).get('cleanupVersion')==1: required.append('managed-environment-cleanup-v1')
if manifest.get('asperaEnvironmentTools',{}).get('installVersion') in (2,3): required.append('managed-environment-install-v2')
if manifest.get('asperaEnvironmentTools',{}).get('installVersion')==3: required.append('managed-environment-install-v3')
if manifest.get('asperaEnvironmentTools',{}).get('storageVersion')==1: required.extend(['storage-governance-v1','historical-environment-borrow-v1','managed-materials-v1'])
if manifest.get('asperaEnvironmentTools',{}).get('storageFormat')=='0.1.0': required.append('purpose-storage-0.1.0')
if manifest.get('asperaEnvironmentTools',{}).get('materialFormat') in ('0.1.1','0.1.2'): required.append('targeted-materials-0.1.1')
if manifest.get('asperaEnvironmentTools',{}).get('materialFormat')=='0.1.2': required.append('material-source-bindings-0.1.2')
if manifest.get('asperaEnvironmentTools',{}).get('registrationFormat')=='0.1.3': required.extend(['storage-registration-0.1.3','bounded-diagnostics-0.1.3','command-admission-0.1.3'])
if manifest.get('asperaEnvironmentTools',{}).get('reuseVerificationVersion')==1: required.append('storage-reuse-verification-v1')
if manifest.get('asperaEnvironmentTools',{}).get('reusePrecheckVersion')==1: required.append('historical-environment-precheck-v1')
if manifest.get('asperaEnvironmentTools',{}).get('wheelMetadataRepairVersion') in (1,2): required.append('managed-wheel-metadata-v1')
if manifest.get('asperaEnvironmentTools',{}).get('wheelMetadataRepairVersion')==2: required.append('managed-wheel-metadata-v2')
if manifest.get('asperaEnvironmentTools',{}).get('managerCacheVersion')==1: required.append('managed-manager-cache-v1')
if manifest.get('asperaEnvironmentTools',{}).get('inputSharingVersion')==1: required.append('managed-input-sharing-v1')
if manifest.get('asperaEnvironmentTools',{}).get('releaseAssetSharingVersion')==1: required.append('managed-release-asset-sharing-v1')
if manifest.get('asperaEnvironmentTools',{}).get('repairVersion')==1: required.append('managed-environment-repair-v1')
if manifest.get('asperaEnvironmentTools',{}).get('storagePreflightVersion')==2: required.append('storage-preflight-v2')
if manifest.get('asperaEnvironmentTools',{}).get('canonicalDatasetVersion')==1: required.append('canonical-modelscope-dataset-v1')
if manifest.get('asperaEnvironmentTools',{}).get('sandboxVersion')==1: required.append('bounded-sandbox-launch-v1')
if manifest.get('asperaEnvironmentTools',{}).get('sandboxIpcVersion')==1: required.append('short-temporary-paths-v1')
if manifest.get('asperaEnvironmentTools',{}).get('commandOutputVersion')==1: required.append('command-output-v1')
if manifest.get('asperaEnvironmentTools',{}).get('commandIdentityVersion')==1: required.append('command-wait-identity-v1')
if manifest.get('asperaEnvironmentTools',{}).get('materialRecoveryVersion')==1: required.append('managed-material-recovery-v1')
if manifest.get('asperaEnvironmentTools',{}).get('lockReceiptVersion')==1: required.append('managed-environment-lock-receipt-v1')
if manifest.get('asperaEnvironmentTools',{}).get('requirementLedgerVersion')==1: required.append('storage-requirement-ledger-v1')
if manifest.get('asperaCompletionVersion')==1: required.append('completion-evidence-v1')
if manifest.get('asperaFinalizationVersion')==2: required.append('experiment-finalization-v2')
if manifest.get('asperaStageAttemptVersion')==1: required.append('stage-attempt-recovery-v1')
if 'asperaStageEvidenceVersion' in manifest and manifest['asperaStageEvidenceVersion'] not in (1,2,3,4): raise RuntimeError('Unsupported stage evidence version')
if manifest.get('asperaStageEvidenceVersion') in (1,2,3,4): required.append('stage-evidence-reading-v1')
if manifest.get('asperaStageEvidenceVersion') in (2,3,4): required.append('stage-evidence-reading-v2')
if manifest.get('asperaStageEvidenceVersion') in (3,4): required.append('stage-checkpoint-evidence-v3')
if manifest.get('asperaStageEvidenceVersion')==4: required.append('stage-checkpoint-evidence-v4')
if 'asperaCheckpointProtectionVersion' in manifest and manifest['asperaCheckpointProtectionVersion']!=1: raise RuntimeError('Unsupported checkpoint protection version')
if manifest.get('asperaCheckpointProtectionVersion')==1: required.append('checkpoint-protection-v1')
if 'asperaAgentRecoveryVersion' in manifest and manifest['asperaAgentRecoveryVersion']!=1: raise RuntimeError('Unsupported Agent recovery version')
if manifest.get('asperaAgentRecoveryVersion')==1: required.append('agent-recovery-v1')
if manifest.get('asperaServiceVerificationVersion')==1: required.append('public-inference-verification-v1')
if manifest.get('asperaServiceLifecycleVersion') not in (None,1): raise SystemExit('Unsupported inference service lifecycle version')
if manifest.get('asperaServiceLifecycleVersion')==1: required.append('inference-service-lifecycle-v1')
if manifest.get('asperaInferenceCheckpointVersion') not in (None,1): raise SystemExit('Unsupported inference checkpoint snapshot version')
if manifest.get('asperaInferenceCheckpointVersion')==1: required.append('inference-checkpoint-snapshots-v1')
if manifest.get('asperaEnvironmentTools',{}).get('readonlyConsumerVersion') in (1,2): required.append('readonly-source-consumers-v1')
if manifest.get('asperaEnvironmentTools',{}).get('readonlyConsumerVersion')==2: required.append('readonly-source-consumers-v2')
planning=manifest.get('asperaPlanningTools')
if planning is not None and (not isinstance(planning,dict) or set(planning)-{'version','formatVersion','requirementsVersion','inferenceVersion'} or planning.get('version')!=1 or planning.get('formatVersion')!='0.1.0' or 'requirementsVersion' in planning and planning['requirementsVersion']!=1 or 'inferenceVersion' in planning and planning['inferenceVersion']!=1): raise RuntimeError('Unsupported fixed-release planning tools format')
if planning is not None: required.extend(['planning-drafts-0.1.0','documentation-pages-0.1.0'])
if planning is not None and planning.get('requirementsVersion')==1: required.append('planning-requirements-v1')
if planning is not None and planning.get('inferenceVersion')==1: required.append('inference-plan-v1')
hidden=[str(root/'secrets'),str(root/'state')]
ssh=pathlib.Path.home()/'.ssh'
if ssh.is_dir(): hidden.append(str(ssh))
namespaces=${JSON.stringify(config.storagePlacement === undefined ? [] : [config.storagePlacement.namespaceRoot])}
owners=root/'state'/'storage-roots'
if owners.is_dir():
 for entry in owners.iterdir(): namespaces.append(json.loads((entry/'.aspera-owner.json').read_text())['namespaceRoot'])
devices=sorted(set(path for pattern in ['/dev/nvidia[0-9]*','/dev/nvidiactl','/dev/nvidia-uvm','/dev/nvidia-uvm-tools','/dev/nvidia-modeset','/dev/nvidia-caps/nvidia-cap*'] for path in glob.glob(pattern) if stat.S_ISCHR(pathlib.Path(path).stat().st_mode)))
if not any(path[len('/dev/nvidia'):].isdigit() for path in devices): raise RuntimeError('no allocated NVIDIA character device')
print(json.dumps({'backendPath':sys.argv[1],'devicePaths':devices,'hiddenPaths':hidden,'namespaceRoots':sorted(set(namespaces)),'requiredFeatures':required}))`)} "$bwrap_bin"`, signal, password)
  const absolute = z.string().startsWith('/')
  const observed = z.object({ backendPath: absolute, devicePaths: z.array(absolute), hiddenPaths: z.array(absolute), namespaceRoots: z.array(absolute), requiredFeatures: z.array(z.string()).optional() }).parse(JSON.parse(discovery))
  const spec = { backendPath: observed.backendPath, workspaceRoot: p.workspace, devicePaths: observed.devicePaths,
    hiddenPaths: [...observed.hiddenPaths, p.root, ...observed.namespaceRoots] }
  const launch = (command: readonly string[]) => experimentSandboxArgv(spec, command).map(shellQuote).join(' ')
  const diagnosticProbeBytes = 1024 * 1024
  const diagnostic = experimentSandboxArgv({ ...spec, diagnosticTemporaryBytes: diagnosticProbeBytes }, ['python3', '-c',
    `import os; s=os.statvfs('/tmp'); assert s.f_blocks*s.f_frsize<=${diagnosticProbeBytes}, 'Diagnostic temporary storage is not bounded'; open('/tmp/aspera-probe','w').write('ok')`]).map(shellQuote).join(' ')
  const script = `set -eu
printf 'ASPERA_VERIFY_STAGE=sandbox-launch\\n' >&2
${launch(['python3', '-c', "import signal; assert not any(signal.getsignal(value) == signal.SIG_IGN for value in (signal.SIGTERM, signal.SIGINT)), 'Sandbox command ignores SIGTERM/SIGINT; repair its private launcher'"])}
printf 'ASPERA_VERIFY_STAGE=diagnostic-isolation\\n' >&2
${diagnostic}
umask 077
secret_probe=${shellQuote(p.root + '/secrets/probe-' + randomUUID())}
printf 'private' > "$secret_probe"
trap 'rm -f -- "$secret_probe"' EXIT
test -f ${shellQuote(p.release + '/.ready')}
sandbox_probe=$(cat ${shellQuote(p.release + '/node_modules/@aspera/runtime/scripts/probe-sandbox.mjs')})
gpu_probe=$(cat ${shellQuote(p.release + '/node_modules/@aspera/runtime/scripts/probe-gpu.py')})
printf 'ASPERA_VERIFY_STAGE=workspace-isolation\\n' >&2
${launch(['node', '--input-type=module', '-e'])} "$sandbox_probe" probe-sandbox ${shellQuote(p.workspace)} /usr
${launch(['test', '!', '-e', p.release + '/.ready'])}
printf 'ASPERA_VERIFY_STAGE=credential-isolation\\n' >&2
${launch(['test', '!', '-e'])} "$secret_probe"
printf 'ASPERA_VERIFY_STAGE=gpu-access\\n' >&2
${launch(['nvidia-smi', '-L'])}
${launch(['python3', '-c'])} "$gpu_probe"
printf 'DSH_DEVICES=%s\\nDSH_BWRAP=%s\\nDSH_HIDDEN=%s\\n' ${shellQuote(observed.devicePaths.join(','))} ${shellQuote(observed.backendPath)} ${shellQuote(JSON.stringify(observed.hiddenPaths))}`
  const gpuScript = `\nprintf 'DSH_GPU_BEGIN\\n'\npython3 -c ${shellQuote(gpuIdentityQueryScript)} ${shellQuote(String(config.toolTimeoutMs / 1000))}\nprintf 'DSH_GPU_END\\n'`
  let output: string
  try { output = await remote(config, script + gpuScript, signal, password) }
  catch (error) {
    signal?.throwIfAborted()
    if (!(error instanceof RemoteCommandError) || !error.result.exitConfirmed || error.result.cancelled || error.result.timedOut) throw error
    const stages: SandboxVerificationStage[] = ['sandbox-launch', 'diagnostic-isolation', 'workspace-isolation', 'credential-isolation', 'gpu-access']
    const stage = stages.filter(value => error.result.stderr.includes('ASPERA_VERIFY_STAGE=' + value)).at(-1) ?? 'sandbox-launch'
    throw new SandboxVerificationError(stage, observed.backendPath, error.result)
  }
  const match = /^DSH_DEVICES=(.+)$/m.exec(output)
  const backend = /^DSH_BWRAP=(.+)$/m.exec(output)
  const hidden = /^DSH_HIDDEN=(.+)$/m.exec(output)
  const gpuQuery = /^DSH_GPU_BEGIN\r?\n([\s\S]*?)\r?\nDSH_GPU_END$/m.exec(output)?.[1]
  if (match?.[1] === undefined || backend?.[1] === undefined || hidden?.[1] === undefined) {
    throw new Error('remote sandbox/GPU probe did not report its backend and granted devices')
  }
  return {
    state: 'ready', deploymentId: digest, preparationId: digest, backend: 'bwrap',
    ...(observed.requiredFeatures === undefined ? {} : { requiredFeatures: observed.requiredFeatures }),
    backendPath: backend[1], devicePaths: normalizedSet(match[1].split(',')), hiddenPaths: z.array(z.string()).parse(JSON.parse(hidden[1])), workspaceRoot: p.workspace,
    gpu: parseGpuInventory(gpuQuery ?? '', match[1].split(',')),
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
