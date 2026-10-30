/** Large recovery requests travel through input without omitting original authorization. */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { expect, it, onTestFinished, vi } from 'vitest'
import { clusterSubmissionSchema, experimentIdSchema, serverIdSchema } from '@aspera/experiments'
import { ControllerRecovery } from '../src/controller-recovery.ts'
import { RemoteInterruption } from '../src/interruption-remote.ts'
import { runControllerScript } from '../src/controller-script.ts'
import { inventory, modelSnapshots, placement } from '../../experiments/tests/fixtures.ts'
import type { DeploymentConfig } from '../src/deploy.ts'
import type { FleetDriver } from '../src/fleet.ts'

const serverId = serverIdSchema.parse(randomUUID())
const experimentId = experimentIdSchema.parse(randomUUID())
const target: DeploymentConfig = { host: 'fixture.invalid', sshPort: 22, remotePort: 43019, remoteRoot: '/owned',
  localRepo: '/sealed', dataRoots: [], agentCredentialRefs: [], tokenRef: 'private-token-ref', toolTimeoutMs: 1000, controlPollIntervalMs: 100 }

it('keeps the full historical submission outside the remote command arguments', async () => {
  const server = { id: serverId, name: 'CPU fixture', host: target.host, sshPort: 22, username: 'trainer', remotePort: target.remotePort,
    remoteRoot: target.remoteRoot, authMode: 'password', storagePlacement: placement(serverId, experimentId, target.remoteRoot) }
  const submission = clusterSubmissionSchema.parse({ protocol: 4, name: 'Large original task', models: modelSnapshots(), experimentId,
    deploymentId: 'a'.repeat(64), inventories: [{ serverId, inventory: inventory(target.remoteRoot) }], coordinator: server,
    nodes: [{ server, devicePaths: ['/dev/nvidia0'], backendPath: '/usr/bin/bwrap', hiddenPaths: [], gpuInfo: 'CPU fixture' }],
    objective: '中文、引号\'和换行\n'.repeat(1000), inputs: [], createdAt: 1, strategy: { mode: 'automatic', coordinator: 'single-agent' },
    versions: { dsh: '0.2.0-rc.2', extension: '0.1.1', harness: 'a'.repeat(64), data: [] } })
  const allowedSubmissions = Array.from({ length: 20 }, () => ({ submission, payloadHash: 'b'.repeat(64) }))
  const remote = vi.fn<FleetDriver['remote']>(async () => JSON.stringify({ version: 1, state: 'offline', root: target.remoteRoot,
    role: 'coordinator', home: '/owned/state/coordinator-home', hostBootId: 'host', digest: 'c'.repeat(64), savedPid: null,
    releaseBinding: null, processes: [], blockers: [], records: [], converged: [] }))
  await new ControllerRecovery({ target, serverId, role: 'coordinator', release: '/sealed/release',
    allowedExperimentIds: [experimentId], allowedServerIds: [serverId], allowedSubmissions }, { remote }).inspect(AbortSignal.timeout(1000))
  const call = remote.mock.calls[0]!
  expect(Buffer.byteLength(call[1])).toBeLessThan(4096)
  const input = JSON.parse(call[4]!)
  expect(input.request.allowedSubmissions).toEqual(allowedSubmissions)
  expect(input.request.allowedExperimentIds).toEqual([experimentId])
  expect(input.request.allowedServerIds).toEqual([serverId])
  expect(input.program).toContain('def run(request):')
  expect(Buffer.byteLength(call[4]!)).toBeGreaterThan(500000)
})

it('uses the same short input transport for read-only discovery of original tasks', async () => {
  const remote = vi.fn<FleetDriver['remote']>(async () => '{"records":[]}')
  await expect(new RemoteInterruption({ remote }, 1000).discover({ target, serverId, experimentIds: [experimentId] },
    AbortSignal.timeout(1000))).resolves.toEqual([])
  const call = remote.mock.calls[0]!
  expect(Buffer.byteLength(call[1])).toBeLessThan(4096)
  expect(JSON.parse(call[4]!).request).toMatchObject({ mode: 'discover', serverId, experimentIds: [experimentId] })
})

it.each([false, true])('parses the entire input before executing the helper (truncated=%s)', async truncated => {
  const remote = vi.fn<FleetDriver['remote']>(async () => '{}')
  await runControllerScript({ remote }, target, { mode: 'inspect' }, AbortSignal.timeout(1000))
  const call = remote.mock.calls[0]!
  const prefix = "python3 -B -c '"
  expect(call[1].startsWith(prefix)).toBe(true)
  const loader = call[1].slice(prefix.length, -1).replaceAll("'\\''", "'")
  const request = { text: '中文\'与换行\n', padding: 'x'.repeat(1024 * 1024) }
  const input = JSON.stringify({ program: 'import json,sys; print(json.dumps(json.loads(sys.argv[1])))', request })
  const child = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', loader],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal: AbortSignal.timeout(10000) })
  const closed = new Promise<void>(resolve => child.once('close', () => { resolve() }))
  onTestFinished(async () => { if (child.exitCode === null) child.kill(); await closed })
  let stdout = ''; let stderr = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', (part: string) => { stdout += part }); child.stderr.on('data', (part: string) => { stderr += part })
  const result = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  child.stdin.end(truncated ? input.slice(0, -1) : input)
  const exit = await result
  if (truncated) { expect(exit).toBe(1); expect(stdout).toBe(''); expect(stderr).toContain('JSONDecodeError') }
  else { expect(exit).toBe(0); expect(stderr).toBe(''); expect(JSON.parse(stdout)).toEqual(request) }
})

it('records transfer context without copying the request or credential into wrapper diagnostics', async () => {
  const remote = vi.fn<FleetDriver['remote']>(async () => 'invalid JSON')
  await expect(runControllerScript({ remote }, target, { mode: 'inspect' }, AbortSignal.timeout(1000), 'private-password'))
    .rejects.toThrow(/response is invalid JSON \(bytes=\d+, operation=read-only\)/)
})
