/** Prepare cluster control roles without replacing a busy receiver or another source release. */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { controllerStatusSchema, gpuInventorySchema, parseGpuInventory, gpuInventoryText, normalizedSet, normalizedGpuInventory } from '@aspera/experiments'
import { controllerPolicyDigest, gpuIdentityQueryScript } from '@aspera/runtime'
import type { ControllerStatus } from '@aspera/experiments'
import type { ClusterNode, ClusterServer } from '@aspera/runtime'
import { installPrivateFile, installSource, validateEnvironment } from './deploy.ts'
import type { DeploymentConfig, PreparedEnvironment } from './deploy.ts'
import type { SourceSnapshot } from './snapshot.ts'
import { copy, remote, RemoteCommandError, request, shellQuote } from './transport.ts'
import type { Target } from './transport.ts'

/** Retries reuse an installed immutable release even after the local application is upgraded. */
export type DeploymentRelease = SourceSnapshot | { readonly digest: string; readonly reuse: true }

/** A saved release cannot be reconstructed by changing the experiment's immutable identity. */
export class SavedReleaseUnavailable extends Error {}

/** Failed controller checks retain structured, model-visible differences. */
export class ControllerDiagnostic extends Error {
  constructor(readonly diagnostic: { code: 'configuration-outdated' | 'hardware-changed' | 'unavailable' | 'unknown' | 'occupied';
    role: 'node' | 'coordinator'; detail: string; controller?: ControllerStatus; expected?: object }) {
    super(JSON.stringify(diagnostic))
  }
}

/** @param controller - authenticated status. @param target - selected server. @param prepared - accepted device inventory.
 * @param role - expected resident role. @returns validated status or a specific repair diagnostic.
 */
export function verifyController(controller: ControllerStatus, target: DeploymentConfig, prepared: PreparedEnvironment,
  role: 'node' | 'coordinator'): ControllerStatus {
  const expected = { backendPath: prepared.backendPath, devicePaths: normalizedSet(prepared.devicePaths), hiddenPaths: normalizedSet(prepared.hiddenPaths), gpu: prepared.gpu }
  const fail = (code: ControllerDiagnostic['diagnostic']['code'], detail: string): never => { throw new ControllerDiagnostic({ code, role, detail, controller, expected }) }
  if (controller.role !== role || controller.root !== target.remoteRoot) fail('unknown', 'Control process role or directory differs from this server')
  if (controller.legacy && controller.deploymentId !== prepared.deploymentId) fail('unknown', 'A legacy controller can only serve its verified original release; release its tasks before starting the selected release')
  if (controller.maintenance !== undefined) fail('occupied', `Control process is held by maintenance ${controller.maintenance}`)
  if (controller.policy.backendPath !== expected.backendPath || JSON.stringify(normalizedSet(controller.policy.devicePaths)) !== JSON.stringify(expected.devicePaths)
    || JSON.stringify(normalizedSet(controller.policy.hiddenPaths)) !== JSON.stringify(expected.hiddenPaths)) {
    fail('configuration-outdated', 'The control process authorization differs from the verified environment')
  }
  if (controller.policy.gpu === undefined) fail('unknown', 'The original controller has no GPU identity evidence; release its tasks and stop or upgrade it before preparing a new experiment')
  if (JSON.stringify(normalizedGpuInventory(controller.policy.gpu!)) !== JSON.stringify(normalizedGpuInventory(prepared.gpu))) fail('configuration-outdated', 'The control process retained another GPU identity or device mapping')
  if (role === 'node') {
    if (controller.actualGpu === undefined) fail('unavailable', controller.gpuError ?? 'Actual GPU access could not be confirmed')
    if (JSON.stringify(normalizedGpuInventory(controller.actualGpu!)) !== JSON.stringify(normalizedGpuInventory(prepared.gpu))) fail('hardware-changed', 'GPU hardware changed during preparation; recheck this node')
  }
  return controller
}

/** @param target - selected SSH account and control root. @param role - assigned role. @param token - private control credential.
 * @param password - private SSH credential. @param signal - inspection lifetime. @returns current public status; unknown legacy policies retain read-only evidence.
 */
export async function inspectController(target: DeploymentConfig, role: 'node' | 'coordinator', token: string,
  password: string | undefined, signal: AbortSignal): Promise<ControllerStatus> {
  const response = await request({ ...target, remotePort: target.remotePort + (role === 'coordinator' ? 1 : 0) }, token, '/aspera/v1/health', 'GET', undefined, signal, password)
  const parsed = z.object({ controller: controllerStatusSchema, features: z.array(z.string()) }).safeParse(response.value)
  if (response.status === 200 && parsed.success && parsed.data.features.includes('controller-readiness-v1')) {
    return { ...parsed.data.controller, ...(!parsed.data.features.includes('controller-maintenance-v1') ? { legacy: true } : {}) }
  }
  const legacy = await remote(target, `python3 -c ${shellQuote(`import glob,json,pathlib,stat,subprocess
p=pathlib.Path(${JSON.stringify(target.remoteRoot + '/state/' + role + '.pid')})
if not p.exists(): print(json.dumps({'running':False}))
else:
 pid=int(p.read_text().strip()); base=pathlib.Path('/proc')/str(pid)
 if not base.exists(): print(json.dumps({'running':False}))
 else:
  entries=dict(item.split(b'=',1) for item in (base/'environ').read_bytes().split(b'\\0') if b'=' in item)
  allowed=['DSH_EXPERIMENT_ROLE','DSH_CLUSTER_ROOT','DSH_EXPERIMENT_DEPLOYMENT_ID','DSH_EXPERIMENT_DEVICES','DSH_EXPERIMENT_BWRAP','DSH_EXPERIMENT_HIDDEN_PATHS_JSON','DSH_EXPERIMENT_GPU_SNAPSHOT']
  devices=[p for pattern in ['/dev/nvidia[0-9]*','/dev/nvidiactl','/dev/nvidia-uvm','/dev/nvidia-uvm-tools','/dev/nvidia-modeset','/dev/nvidia-caps/nvidia-cap*'] for p in glob.glob(pattern) if stat.S_ISCHR(pathlib.Path(p).stat().st_mode)]
  query_result=subprocess.run(['python3','-c',${JSON.stringify(gpuIdentityQueryScript)},'${target.toolTimeoutMs / 1000}'],capture_output=True,text=True,timeout=${target.toolTimeoutMs / 1000})
  if query_result.returncode!=0: raise RuntimeError(query_result.stderr)
  query=query_result.stdout
  print(json.dumps({'running':True,'pid':pid,'processStart':(base/'stat').read_text().rsplit(')',1)[1].split()[19],'hostBootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'devices':devices,'query':query,'configuration':{key:entries.get(key.encode(),b'').decode() for key in allowed}}))`)}`, signal, password)
  const observation = z.object({ running: z.literal(true), pid: z.number().int().positive(), processStart: z.string(), hostBootId: z.string(),
    devices: z.array(z.string()), query: z.string(), configuration: z.record(z.string(), z.string()) }).safeParse(JSON.parse(legacy))
  if (response.status === 200 && observation.success && observation.data.configuration.DSH_EXPERIMENT_GPU_SNAPSHOT) {
    const value = observation.data; const saved = value.configuration
    const policy = { backendPath: saved.DSH_EXPERIMENT_BWRAP ?? '', hiddenPaths: z.array(z.string()).parse(JSON.parse(saved.DSH_EXPERIMENT_HIDDEN_PATHS_JSON ?? 'null')),
      devicePaths: normalizedSet((saved.DSH_EXPERIMENT_DEVICES ?? '').split(',').filter(Boolean)), gpu: gpuInventorySchema.parse(JSON.parse(saved.DSH_EXPERIMENT_GPU_SNAPSHOT!)) }
    return controllerStatusSchema.parse({ version: 1, role: saved.DSH_EXPERIMENT_ROLE, deploymentId: saved.DSH_EXPERIMENT_DEPLOYMENT_ID,
      root: saved.DSH_CLUSTER_ROOT, pid: value.pid, processStart: value.processStart, hostBootId: value.hostBootId,
      bootId: `legacy:${value.hostBootId}:${value.pid}:${value.processStart}`, policy, policyDigest: controllerPolicyDigest(policy), legacy: true,
      actualGpu: parseGpuInventory(value.query, value.devices), occupied: { experiments: [], allocations: [], commands: [], services: [] } })
  }
  throw new ControllerDiagnostic({ code: 'unknown', role, detail: `Original controller lacks verifiable GPU authorization or safe maintenance support. Release its tasks and stop or upgrade it without replacing its sealed release. Read-only observations: ${legacy}` })
}

/**
 * Check an original release before configuring its account, without requiring Node.
 * @param target - saved SSH target.
 * @param release - original release directory.
 * @param digest - saved immutable identity.
 * @param password - private SSH credential.
 * @param signal - operation cancellation.
 * @returns the verified original DSH and extension versions.
 */
export async function verifySavedRelease(target: Target, release: string,
  digest: string, password?: string, signal?: AbortSignal): Promise<{ dsh: string; extension: string }> {
  try {
    const output = await remote(target, `set -eu
for file in .ready setup.mjs node_modules/@deepseek-ai/dsh/lib/bin.js node_modules/@aspera/runtime/scripts/probe-sandbox.mjs node_modules/@aspera/runtime/scripts/probe-gpu.py; do
  test -f ${shellQuote(release)}/"$file" || { echo "Saved release entry is missing: $file; copy this experiment" >&2; exit 1; }
done
cat ${shellQuote(release + '/aspera-release.json')}`, signal, password)
    const manifest = z.object({ version: z.literal(1), deploymentId: z.literal(digest), dsh: z.string().min(1), extension: z.string().min(1) })
    return manifest.parse(JSON.parse(output))
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof RemoteCommandError && !error.result.exitConfirmed) throw error
    throw new SavedReleaseUnavailable(`Saved release is unavailable; copy this experiment. ${String(error)}`)
  }
}

/**
 * Install immutable source and verify sandbox and GPU access.
 * @param target - fixed SSH target.
 * @param source - immutable source.
 * @param password - selected SSH password.
 * @param signal - preparation cancellation.
 * @param installation - supervised installer supplied by resumable fleet preparation.
 * @returns probed node.
 */
export async function prepareClusterServer(target: DeploymentConfig, source: DeploymentRelease, password: string | undefined,
  signal: AbortSignal, installation?: () => Promise<void>): Promise<PreparedEnvironment> {
  if (installation !== undefined) await installation()
  else if ('reuse' in source) {
    const release = target.storagePlacement?.releaseRoot ?? `${target.remoteRoot}/releases/${source.digest}`
    await verifySavedRelease(target, release, source.digest, password, signal)
  } else await installSource(target, source, signal, password)
  return validateEnvironment(target, source.digest, signal, password)
}

/**
 * Start or reuse an authenticated control process without replacing active work.
 * @param target - fixed target.
 * @param prepared - verified release.
 * @param role - resident process role.
 * @param token - control credential.
 * @param password - SSH credential.
 * @param signal - preparation cancellation.
 */
export async function ensureClusterRole(target: DeploymentConfig, prepared: PreparedEnvironment,
  role: 'coordinator' | 'node', token: string,
  password: string | undefined, signal: AbortSignal): Promise<void> {
  const control = { ...target, remotePort: target.remotePort + (role === 'coordinator' ? 1 : 0) }
  const compatible = (value: unknown) => {
    const health = z.object({ protocol: z.literal(4), role: z.literal(role), deploymentId: z.string().regex(/^[a-f0-9]{64}$/), features: z.array(z.string()).optional() }).safeParse(value)
    return health.success && health.data.features?.includes('public-inference-v1') === true
  }
  if (control.remotePort > 65535) throw new Error('coordinator port exceeds 65535')
  try {
    const health = await request(control, token, '/aspera/v1/health', 'GET', undefined, signal, password)
    if (health.status === 200 && compatible(health.value)) {
      const status = z.object({ controller: controllerStatusSchema }).safeParse(health.value)
      verifyController(status.success ? status.data.controller : await inspectController(target, role, token, password, signal), target, prepared, role)
      return
    }
  } catch (error) { signal.throwIfAborted(); if (error instanceof ControllerDiagnostic) throw error }
  const root = target.remoteRoot
  const release = target.storagePlacement?.releaseRoot ?? `${root}/releases/${prepared.deploymentId}`
  const pidFile = `${root}/state/${role}.pid`
  const active = await remote(target, `if [ -f ${shellQuote(pidFile)} ] && kill -0 "$(cat ${shellQuote(pidFile)})" 2>/dev/null; then printf active; fi`, signal, password)
  if (active === 'active') throw new Error(`${role} on port ${control.remotePort} is running an incompatible or unavailable controller. Keep its original release until all tasks finish and cleanup is confirmed, then stop that controller before retrying.`)
  await remote(target, `node --input-type=module -e ${shellQuote(`import { createServer } from 'node:net'; const server = createServer(); server.once('error', error => { console.error('Control port ${control.remotePort} is unavailable: ' + error.message); process.exitCode = 1 }); server.listen({ host: '127.0.0.1', port: ${control.remotePort}, exclusive: true }, () => server.close())`)}`, signal, password)
  const incomingToken = `${root}/secrets/${role}-${randomUUID()}.incoming`
  await installPrivateFile(target, incomingToken, token, signal, password)
  await remote(target, `set -eu
trap 'rm -f -- ${shellQuote(incomingToken)}' EXIT
ln ${shellQuote(incomingToken)} ${shellQuote(root + '/secrets/' + role + '.token')} 2>/dev/null || cmp -s ${shellQuote(incomingToken)} ${shellQuote(root + '/secrets/' + role + '.token')}`, signal, password)
  await installPrivateFile(target, `${root}/secrets/${role}-model.json`, JSON.stringify({ version: 1, refs: {} }), signal, password)
  const env: Record<string, string> = {
    DSH_HOME: `${root}/state/${role}-home`, DSH_CLUSTER_ROOT: root, DSH_EXPERIMENT_ROLE: role,
    DSH_EXPERIMENT_WORKSPACE: `${root}/workspace`, DSH_EXPERIMENT_TOKEN_FILE: `${root}/secrets/${role}.token`,
    DSH_EXPERIMENT_MODEL_CREDENTIAL_FILE: `${root}/secrets/${role}-model.json`,
    DSH_EXPERIMENT_LOG_FILE: `${root}/logs/${role}.log`, DSH_EXPERIMENT_DEPLOYMENT_ID: prepared.deploymentId,
    DSH_EXPERIMENT_DEVICES: prepared.devicePaths.join(','), DSH_EXPERIMENT_BWRAP: prepared.backendPath,
    DSH_EXPERIMENT_GPU_SNAPSHOT: JSON.stringify(prepared.gpu),
    DSH_EXPERIMENT_HIDDEN_PATHS_JSON: JSON.stringify(prepared.hiddenPaths), DSH_EXPERIMENT_PORT: String(control.remotePort),
  }
  const executablePath = target.pathEntries?.length ? `export PATH=${shellQuote(target.pathEntries.join(':'))}:"$PATH"\n` : ''
  await remote(target, `set -eu
umask 077
lock=${shellQuote(root + '/state/' + role + '.launch')}
mkdir "$lock" || { echo 'control process launch is already in progress' >&2; exit 1; }
trap 'rmdir "$lock"' EXIT
if [ -f ${shellQuote(pidFile)} ] && kill -0 "$(cat ${shellQuote(pidFile)})" 2>/dev/null; then exit 0; fi
${executablePath}${Object.entries(env).map(([name, value]) => `export ${name}=${shellQuote(value)}`).join('\n')}
cd ${shellQuote(root + '/workspace')}
node ${shellQuote(release + '/setup.mjs')} --worker
setsid node ${shellQuote(release + '/node_modules/@deepseek-ai/dsh/lib/bin.js')} --profile aspera-worker </dev/null >>${shellQuote(root + '/logs/' + role + '.log')} 2>&1 &
echo "$!" > ${shellQuote(pidFile)}`, signal, password)
  const deadline = Date.now() + target.toolTimeoutMs
  let lastError: unknown
  do {
    signal.throwIfAborted()
    try {
      const health = await request(control, token, '/aspera/v1/health', 'GET', undefined, signal, password)
      if (health.status === 200 && compatible(health.value)) {
        const status = z.object({ controller: controllerStatusSchema }).safeParse(health.value)
        verifyController(status.success ? status.data.controller : await inspectController(target, role, token, password, signal), target, prepared, role)
        return
      }
      lastError = new Error(`control HTTP ${health.status}`)
    } catch (error) { lastError = error }
    const alive = await remote(target, `kill -0 "$(cat ${shellQuote(pidFile)})" 2>/dev/null && printf active || true`, signal, password)
    if (alive !== 'active') throw new Error(`${role} stopped during startup; inspect ${root}/logs/${role}.log`)
    await delay(Math.min(target.controlPollIntervalMs, Math.max(0, deadline - Date.now())), undefined, { signal })
  } while (Date.now() < deadline)
  throw new Error(`${role} did not become ready: ${String(lastError)}`)
}

/**
 * Transfer node login credentials into the coordinator’s private directory.
 * @param coordinator - selected coordinator.
 * @param server - node whose login is delegated.
 * @param id - experiment identity.
 * @param password - coordinator SSH password.
 * @param signal - transfer cancellation.
 * @returns private remote host-key and optional identity paths.
 */
export async function delegateClusterLogin(coordinator: DeploymentConfig, server: ClusterServer, id: string,
  password: string | undefined, signal: AbortSignal): Promise<{ knownHostsFile: string; identityFile?: string }> {
  const prefix = `${coordinator.remoteRoot}/secrets/${id}-${server.id}`
  const knownHostsFile = `${prefix}.known_hosts`
  await installPrivateFile(coordinator, knownHostsFile, readFileSync(server.knownHostsFile ?? join(homedir(), '.ssh',
    'known_hosts'), 'utf8'), signal, password)
  if (server.authMode === 'password') return { knownHostsFile }
  if (server.identityFile === undefined) throw new Error(`An explicit private identity file is required to delegate SSH key login for ${server.name}`)
  const identityFile = `${prefix}.identity`
  await copy(coordinator, server.identityFile, identityFile, signal, password)
  await remote(coordinator, `chmod 600 ${shellQuote(identityFile)}`, signal, password)
  return { knownHostsFile, identityFile }
}

/**
 * Capture prepared node facts for immutable admission.
 * @param server - selected node.
 * @param prepared - checked runtime.
 * @returns non-secret node inventory.
 */
export async function describeClusterNode(server: ClusterServer, prepared: PreparedEnvironment): Promise<ClusterNode> {
  return { server, backendPath: prepared.backendPath, devicePaths: [...prepared.devicePaths], hiddenPaths: [...prepared.hiddenPaths],
    gpuInfo: gpuInventoryText(prepared.gpu) }
}
