/** Prepare cluster control roles without replacing a busy receiver or another source release. */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { ClusterNode, ClusterServer } from '@aspera/runtime'
import { installPrivateFile, installSource, validateEnvironment } from './deploy.ts'
import type { DeploymentConfig, PreparedEnvironment } from './deploy.ts'
import type { SourceSnapshot } from './snapshot.ts'
import { copy, remote, request, shellQuote } from './transport.ts'

/**
 * Install immutable source and verify sandbox and GPU access.
 * @param target - fixed SSH target.
 * @param source - immutable source.
 * @param password - selected SSH password.
 * @param signal - preparation cancellation.
 * @returns probed node.
 */
export async function prepareClusterServer(target: DeploymentConfig, source: SourceSnapshot, password: string | undefined,
  signal: AbortSignal): Promise<PreparedEnvironment> {
  await installSource(target, source, signal, password)
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
    if (health.status === 200 && compatible(health.value)) return
  } catch (error) { signal.throwIfAborted(); void error }
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
    DSH_EXPERIMENT_HIDDEN_PATHS_JSON: JSON.stringify(prepared.hiddenPaths), DSH_EXPERIMENT_PORT: String(control.remotePort),
  }
  await remote(target, `set -eu
umask 077
lock=${shellQuote(root + '/state/' + role + '.launch')}
mkdir "$lock" || { echo 'control process launch is already in progress' >&2; exit 1; }
trap 'rmdir "$lock"' EXIT
if [ -f ${shellQuote(pidFile)} ] && kill -0 "$(cat ${shellQuote(pidFile)})" 2>/dev/null; then exit 0; fi
${Object.entries(env).map(([name, value]) => `export ${name}=${shellQuote(value)}`).join('\n')}
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
      if (health.status === 200 && compatible(health.value)) return
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
 * @param target - connection target.
 * @param password - SSH password.
 * @param signal - cancellation.
 * @returns non-secret node inventory.
 */
export async function describeClusterNode(server: ClusterServer, prepared: PreparedEnvironment, target: DeploymentConfig,
  password: string | undefined, signal: AbortSignal): Promise<ClusterNode> {
  return { server, backendPath: prepared.backendPath, devicePaths: [...prepared.devicePaths], hiddenPaths: [...prepared.hiddenPaths],
    gpuInfo: await remote(target, 'nvidia-smi -L', signal, password) }
}
