/** Preparation completion follows provider evidence, including after interrupted SSH mutations. */
import { randomUUID } from 'node:crypto'
import { fromAny } from '@total-typescript/shoehorn'
import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { experimentIdSchema, serverIdSchema } from '@aspera/experiments'
import { EnvironmentPreparation, UnconfirmedPreparationCommand } from '../src/environment-preparation.ts'
import type { EnvironmentDriver, EnvironmentPreparationInput } from '../src/environment-preparation.ts'
import type { EnvironmentProgress } from '../src/types.ts'
import type { RemoteCommandResult } from '../src/transport.ts'
import { readyEnvironment } from './environment-fixture.ts'
import { SandboxVerificationError } from '../src/sandbox-verification.ts'
import { SandboxRepair, sandboxRepairPolicySchema } from '../src/sandbox-repair.ts'
import { preparationCommandPolicySchema } from '../src/preparation-command.ts'

interface RegisteredTool {
  name: string
  execute: (args: Record<string, unknown>, exec: { signal: AbortSignal; callId: ToolCallId }) => Promise<string>
}

function fixture() {
  const preparation = new EnvironmentPreparation(preparationCommandPolicySchema.parse({ pollIntervalMs: 1, recoveryTimeoutMs: 5 }))
  const registered = new Map<string, RegisteredTool>()
  const abort = new AbortController()
  const progress: EnvironmentProgress[] = []
  const result: RemoteCommandResult = { stdout: 'installed', stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false, exitConfirmed: true }
  const driver: EnvironmentDriver = {
    remote: vi.fn(async (_target, script) => script.includes('/exited') ? '0\n' : ''), remoteResult: vi.fn(async () => result),
    inspectEnvironment: vi.fn(async () => readyEnvironment()),
  }
  let interval = Promise.resolve()
  let run = async () => {}
  const append = vi.fn()
  const inject = vi.fn()
  const followup = vi.fn(() => { interval = run() })
  const agent = fromAny<Agent, object>({ session: { id: SessionId(randomUUID()), append }, inject, followup, status: 'idle',
    cancel: vi.fn(), whenIdle: () => interval })
  const ctx = fromAny<Context, object>({
    effect: (body: () => unknown) => body(), on: () => () => {},
    tools: { register: (tool: RegisteredTool) => { registered.set(tool.name, tool); return () => {} } },
  })
  preparation.install(ctx, agent)
  const input: EnvironmentPreparationInput = {
    experimentId: experimentIdSchema.parse(randomUUID()), serverId: serverIdSchema.parse(randomUUID()),
    serverName: 'GPU node', target: { host: 'node', sshPort: 22, remotePort: 43019, toolTimeoutMs: 1000 },
    password: 'private-ssh-password', requirements: { node: '^22.19.0 || >=24.0.0', pnpm: '11.7.0' },
    observation: readyEnvironment(), operation: 'bootstrap', outputChars: 4096,
    progress: async value => { progress.push(structuredClone(value)) },
  }
  const invocations: ToolCallId[] = []
  const call = (name: string, args: Record<string, unknown> = {}, signal = abort.signal) => {
    const tool = registered.get(name)
    if (tool === undefined) throw new Error('fixture tool is absent')
    const callId = brandString<ToolCallId>(randomUUID()); invocations.push(callId)
    return tool.execute({ server_id: input.serverId, ...args }, { signal, callId })
  }
  return { preparation, agent, input, driver, result, abort, append, inject, followup, progress, call, invocations,
    loop: (body: () => Promise<void>) => { run = body },
    ensure: <T>(verify: () => Promise<T>) => preparation.ensure(agent, input, driver, verify, abort.signal) }
}

it('records successful checks without requesting a model turn', async () => {
  const f = fixture()
  expect(await f.ensure(async () => ({ ready: true }))).toEqual({ value: { ready: true }, pathEntries: [] })
  expect(f.followup).not.toHaveBeenCalled()
  expect(f.append).not.toHaveBeenCalled()
  expect(f.inject).toHaveBeenCalledOnce()
  expect(JSON.stringify(f.inject.mock.calls)).not.toContain(f.input.password)
})

it('returns installation diagnosis to the existing Agent and requires verification after an autonomous source change', async () => {
  const f = fixture()
  let repaired = false
  const probeId = randomUUID()
  const inspect = vi.fn(async () => ({ phase: 'download', reason: 'no progress', remainingMs: 1000 }))
  const probe = vi.fn(async () => ({ id: probeId, available: true, bytes: 65536 }))
  const switchSource = vi.fn(async () => { repaired = true; return { installed: true } })
  f.input.operation = 'deployment'
  f.input.installation = { inspect, probe, switchSource }
  f.loop(async () => {
    await f.call('inspect_preparation_installation')
    const measured = JSON.parse(await f.call('probe_preparation_source', { kind: 'npm', url: 'https://mirror.example.test/' }))
    await f.call('switch_preparation_source', { probe_id: measured.id, reason: 'Measured registry download succeeds' })
    expect(f.progress.at(-1)?.phase).not.toBe('environment-ready')
    await f.call('verify_preparation_environment', { path_entries: [] })
  })
  const verify = vi.fn(async () => { if (!repaired) throw new Error('Installation idle timeout; original cache retained'); return 'checked original release' })
  expect((await f.ensure(verify)).value).toBe('checked original release')
  expect(f.followup).toHaveBeenCalledOnce()
  expect(probe).toHaveBeenCalledOnce()
  expect(switchSource).toHaveBeenCalledOnce()
  expect(JSON.stringify(switchSource.mock.calls)).toContain(f.agent.session.id)
  expect(verify).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(f.inject.mock.calls)).not.toContain(f.input.password)
})

it('requires durable verification before accepting completion', async () => {
  const f = fixture()
  f.input.progress = async value => { if (value.phase === 'environment-ready') throw new Error('disk is full') }
  await expect(f.ensure(async () => 'verified')).rejects.toThrow('progress could not be saved')
  expect(f.followup).not.toHaveBeenCalled()
  expect(f.append).not.toHaveBeenCalled()
})

it('stops repairs if command ownership cannot be saved', async () => {
  const f = fixture()
  f.input.progress = async value => { if (value.pendingCommand !== undefined) throw new Error('disk is full') }
  f.loop(async () => {
    await expect(f.call('run_preparation_command', { command: 'install dependencies' })).rejects.toThrow('progress could not be saved')
    await expect(f.call('run_preparation_command', { command: 'retry dependencies' })).rejects.toThrow(/already finished|outside the active preparation/)
  })
  await expect(f.ensure(async () => { throw new Error('missing Node') })).rejects.toThrow('progress could not be saved')
  expect(f.driver.remoteResult).not.toHaveBeenCalled()
})

it('lets the existing Agent install missing tools and only completes after provider verification', async () => {
  const f = fixture()
  let installed = false
  vi.mocked(f.driver.remoteResult).mockImplementation(async () => { installed = true; return f.result })
  f.loop(async () => {
    await f.call('inspect_preparation_environment')
    const result = JSON.parse(await f.call('run_preparation_command', { command: 'install required tools' }))
    expect(result).toMatchObject({ exitCode: 0, stdout: 'installed' })
    expect(JSON.parse(await f.call('verify_preparation_environment', { path_entries: ['/opt/aspera/bin'] }))).toMatchObject({ ready: true })
  })
  const verify = vi.fn(async () => { if (!installed) throw new Error('bubblewrap is missing'); return { backend: 'bwrap' } })
  const completed = await f.ensure(verify)
  expect(completed).toEqual({ value: { backend: 'bwrap' }, pathEntries: ['/opt/aspera/bin'] })
  expect(verify).toHaveBeenCalledTimes(2)
  expect(f.progress.some(value => value.pendingCommand !== undefined)).toBe(true)
  expect(f.progress.at(-1)).toMatchObject({ phase: 'environment-ready' })
  expect(f.progress.at(-1)?.pendingCommand).toBeUndefined()
})

it('keeps nonzero command diagnostics available for another repair attempt', async () => {
  const f = fixture()
  let installed = false
  vi.mocked(f.driver.remote).mockImplementation(async (_target, command) => command.includes('/exited') ? installed ? '0\n' : '1\n' : '')
  vi.mocked(f.driver.remoteResult)
    .mockResolvedValueOnce({ ...f.result, exitCode: 1, stdout: 'package metadata', stderr: 'download unavailable' })
    .mockImplementationOnce(async () => { installed = true; return f.result })
  f.loop(async () => {
    expect(JSON.parse(await f.call('run_preparation_command', { command: 'first download' }))).toMatchObject({
      exitCode: 1, stdout: 'package metadata', stderr: 'download unavailable',
    })
    await f.call('run_preparation_command', { command: 'repair package source' })
    await f.call('verify_preparation_environment', { path_entries: [] })
  })
  await f.ensure(async () => { if (!installed) throw new Error('tools missing'); return 'verified' })
  expect(f.driver.remoteResult).toHaveBeenCalledTimes(2)
})

it('reconciles the original timed-out command and returns its persisted download failure to the Agent', async () => {
  const f = fixture(); let repaired = false
  vi.mocked(f.driver.remoteResult).mockResolvedValue({ ...f.result, exitCode: null, timedOut: true, exitConfirmed: false })
  vi.mocked(f.driver.remote).mockImplementation(async (_target, command) => {
    if (!command.includes('/command.py')) return ''
    const directory = f.progress.findLast(value => value.pendingCommand !== undefined)!.pendingCommand!.directory
    return JSON.stringify({ status: { version: 1, experimentId: f.input.experimentId, serverId: f.input.serverId,
      sessionId: f.agent.session.id, toolCallId: f.invocations.at(-1),
      commandId: directory.split('/').at(-1), exitCode: 143, exitConfirmed: true, timedOut: true, cancelled: false, signal: 'SIGTERM' },
    lines: [{ seq: 0, time: 1, stream: 'stderr', text: 'download exceeded the shared deadline; cache retained\n' }], offset: 200, hasMore: false })
  })
  f.loop(async () => {
    const result = JSON.parse(await f.call('run_preparation_command', { command: 'curl --retry 3 --max-time 300 example' }))
    expect(result).toMatchObject({ exitConfirmed: true, timedOut: true, exitCode: 143 })
    expect(result.stderr).toContain('cache retained')
    repaired = true
    await f.call('verify_preparation_environment', { path_entries: [] })
  })
  expect((await f.ensure(async () => { if (!repaired) throw new Error('uv missing'); return 'verified' })).value).toBe('verified')
  expect(f.driver.remoteResult).toHaveBeenCalledOnce()
  expect(f.progress.at(-1)?.pendingCommand).toBeUndefined()
})

it('gives downloads the same command budget and retains output independently of the SSH reader', async () => {
  const f = fixture(); let installed = false
  f.input.directories = { workspace: '/hidden-namespace/runs/experiment/workspace', release: '/hidden-namespace/releases/fixed', control: '/hidden-namespace/control' }
  vi.mocked(f.driver.remoteResult).mockImplementation(async (_target, wire, _signal, _password, _output, input) => {
    const command = input ?? wire
    expect(command).toContain('request.v1.json')
    expect(command).toContain('ASPERA_PREPARATION_REMAINING_MS')
    expect(command).not.toContain('mkfifo')
    expect(command).not.toContain('/hidden-namespace')
    expect(command).not.toMatch(/command\.py follow /)
    installed = true; return f.result
  })
  f.loop(async () => { await f.call('run_preparation_command', { command: 'download fixed uv' }); await f.call('verify_preparation_environment', { path_entries: [] }) })
  await f.ensure(async () => { if (!installed) throw new Error('uv missing'); return 'verified' })
})

it('scopes fixed uv acquisition to the selected node and still requires independent verification', async () => {
  const f = fixture(); f.input.requirements.uv = '0.13.0'; let installed = false
  vi.mocked(f.driver.remoteResult).mockImplementation(async (_target, wire, _signal, _password, _output, input) => {
    const command = input ?? wire
    expect(command).toContain('ASPERA_PREPARATION_COMMAND_DIRECTORY/command.py')
    expect(command).toContain('0.13.0')
    installed = true
    return { ...f.result, stdout: JSON.stringify({ reused: true, downloadBytes: 0, pathEntries: ['/cache/uv/bin'] }) }
  })
  f.loop(async () => {
    await expect(f.call('prepare_preparation_tool', { server_id: randomUUID(), tool: 'uv' })).rejects.toThrow('outside')
    const result = JSON.parse(await f.call('prepare_preparation_tool', { tool: 'uv' }))
    expect(JSON.parse(result.stdout).downloadBytes).toBe(0)
    expect(f.progress.at(-1)?.phase).not.toBe('environment-ready')
    await f.call('verify_preparation_environment', { path_entries: ['/cache/uv/bin'] })
  })
  expect((await f.ensure(async () => { if (!installed) throw new Error('uv missing'); return 'verified' })).value).toBe('verified')
})

it('serializes parallel Agent commands and verifies only after both have settled', async () => {
  const f = fixture()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let inFlight = 0
  let maximum = 0
  let completed = 0
  vi.mocked(f.driver.remoteResult).mockImplementation(async () => {
    inFlight += 1; maximum = Math.max(maximum, inFlight)
    try {
      if (completed === 0) { started.resolve(); await release.promise }
      completed += 1
      return f.result
    } finally { inFlight -= 1 }
  })
  f.loop(async () => {
    await Promise.all([f.call('run_preparation_command', { command: 'install node' }), f.call('run_preparation_command', { command: 'install pnpm' })])
    await f.call('verify_preparation_environment', { path_entries: [] })
  })
  const pending = f.ensure(async () => { if (completed !== 2) throw new Error('dependencies are incomplete'); return 'ready' })
  try {
    await started.promise
    expect(f.driver.remoteResult).toHaveBeenCalledOnce()
  } finally { release.resolve() }
  expect((await pending).value).toBe('ready')
  expect(maximum).toBe(1)
  const directories = f.progress.flatMap(value => value.pendingCommand === undefined ? [] : [value.pendingCommand.directory])
  expect(new Set(directories).size).toBe(2)
})

it('rejects an Agent that ends its turn without passing the required checks', async () => {
  const f = fixture()
  await expect(f.ensure(async () => { throw new Error('sandbox write escaped') })).rejects.toThrow('without passing environment verification')
})

it('never lets a model select another server or modify an already verified step', async () => {
  const f = fixture()
  let passed = false
  f.loop(async () => {
    await expect(f.call('run_preparation_command', { server_id: randomUUID(), command: 'install' })).rejects.toThrow('outside')
    passed = true
    await f.call('verify_preparation_environment', { path_entries: [] })
    await expect(f.call('run_preparation_command', { command: 'extra mutation' })).rejects.toThrow('already finished')
  })
  await f.ensure(async () => { if (!passed) throw new Error('missing'); return 'ready' })
  expect(f.driver.remoteResult).not.toHaveBeenCalled()
})

it('reports platform restrictions without accepting an unverified sandbox', async () => {
  const f = fixture()
  f.loop(async () => { await f.call('report_preparation_blocked', { reason: 'Container denies namespace creation; enable the required platform capability.' }) })
  await expect(f.ensure(async () => { throw new Error('Operation not permitted') })).rejects.toThrow('Container denies namespace')
  expect(f.driver.remoteResult).not.toHaveBeenCalled()
})

it('gives the original Agent the exact sandbox refusal and requires revalidation after repair', async () => {
  const f = fixture(); f.input.operation = 'deployment'
  let repaired = false
  const refused = new SandboxVerificationError('sandbox-launch', '/usr/bin/bwrap', {
    exitCode: 1, stdout: '', stderr: "bwrap: Can't mount proc on /newroot/proc: Operation not permitted\n" })
  vi.mocked(f.driver.remoteResult).mockImplementation(async () => { repaired = true; return f.result })
  f.loop(async () => {
    const inspection = JSON.parse(await f.call('inspect_preparation_environment'))
    expect(inspection.latestVerification).toMatchObject({ ready: false, diagnostic: {
      requiresPlatformAction: true, stderr: refused.diagnostic.stderr } })
    await f.call('run_preparation_command', { command: 'repair compatible account configuration' })
    expect(f.progress.at(-1)?.phase).not.toBe('environment-ready')
    await f.call('verify_preparation_environment', { path_entries: [] })
  })
  const verify = vi.fn(async () => { if (!repaired) throw refused; return 'full sandbox verified' })
  expect((await f.ensure(verify)).value).toBe('full sandbox verified')
  expect(verify).toHaveBeenCalledTimes(2)
  const context = JSON.stringify(f.followup.mock.calls)
  expect(context).toContain("Can't mount proc")
  expect(context).not.toContain(f.input.password)
})

it('blocks a container permission refusal when an Agent declares completion without verification', async () => {
  const f = fixture()
  f.loop(async () => {})
  await expect(f.ensure(async () => { throw new SandboxVerificationError('sandbox-launch', '/usr/bin/bwrap', {
    exitCode: 1, stdout: '', stderr: "bwrap: Can't mount proc on /newroot/proc: Operation not permitted" }) }))
    .rejects.toThrow('without passing environment verification')
  expect(f.progress.some(value => value.phase === 'environment-ready')).toBe(false)
})

it('offers a measured private-proc repair to the original Agent and requires the installed launcher for revalidation', async () => {
  const f = fixture(); let repaired = false
  const launcher = { version: 1 as const, path: '/control/tools/sandbox/' + 'a'.repeat(64) + '/bin/bwrap', digest: 'a'.repeat(64) }
  const inspect = vi.fn(async () => ({ version: 1 as const, state: 'available' as const, strategy: 'private-proc' as const,
    reason: 'Private PID/proc launch passed with all inner isolation flags and zero capabilities',
    stdout: 'isolated', stderr: '', exitCode: 0, requiresPlatformAction: false }))
  const repair = vi.fn(async () => { repaired = true; return { version: 1 as const, state: 'configured' as const, strategy: 'private-proc' as const,
    reason: 'Immutable launcher installed', stdout: '', stderr: '', exitCode: 0, requiresPlatformAction: false,
    launcher, pathEntries: [launcher.path.slice(0, -6)] } })
  f.input.sandbox = { inspect, repair }
  f.loop(async () => {
    const inspected = JSON.parse(await f.call('inspect_preparation_environment'))
    expect(inspected.latestVerification.diagnostic).toMatchObject({ requiresPlatformAction: false,
      sandboxRepair: { state: 'available', tool: 'repair_preparation_sandbox' } })
    await expect(f.call('report_preparation_blocked', { reason: 'Only the cloud platform can fix proc mounts' })).rejects.toThrow('available sandbox repair')
    await expect(f.call('repair_preparation_sandbox', { server_id: randomUUID() })).rejects.toThrow('outside')
    expect(JSON.parse(await f.call('repair_preparation_sandbox'))).toMatchObject({ state: 'configured', verificationRequired: true, launcher })
    expect(f.progress.at(-1)?.phase).not.toBe('environment-ready')
    await f.call('verify_preparation_environment', { path_entries: [] })
  })
  const verify = vi.fn(async (target: EnvironmentPreparationInput['target']) => {
    if (!repaired) throw new SandboxVerificationError('sandbox-launch', '/usr/bin/bwrap', {
      exitCode: 1, stdout: '', stderr: "bwrap: Can't mount proc on /newroot/proc: Operation not permitted" })
    expect(target.pathEntries?.[0]).toBe(launcher.path.slice(0, -6))
    return 'full provider acceptance'
  })
  expect((await f.preparation.ensure(f.agent, f.input, f.driver, verify, f.abort.signal)).value).toBe('full provider acceptance')
  expect(repair).toHaveBeenCalledOnce()
  expect(JSON.stringify(f.followup.mock.calls)).toContain('repair_preparation_sandbox')
  expect(JSON.stringify(f.followup.mock.calls)).not.toContain(f.input.password)
})

it('rejects sandbox configuration without a subsequent independent verification', async () => {
  const f = fixture()
  f.input.sandbox = { inspect: async () => ({ version: 1, state: 'available', strategy: 'private-proc', reason: 'Probe passed',
    stdout: '', stderr: '', exitCode: 0, requiresPlatformAction: false }),
    repair: async () => ({ version: 1, state: 'configured', strategy: 'private-proc', reason: 'Installed', stdout: '', stderr: '', exitCode: 0,
      requiresPlatformAction: false, launcher: { version: 1, path: '/control/bin/bwrap', digest: 'b'.repeat(64) }, pathEntries: ['/control/bin'] }) }
  f.loop(async () => {
    await f.call('repair_preparation_sandbox')
    await expect(f.call('report_preparation_blocked', { reason: 'Account repair exhausted' })).rejects.toThrow('has not been verified')
  })
  await expect(f.ensure(async () => { throw new SandboxVerificationError('sandbox-launch', '/usr/bin/bwrap', {
    exitCode: 1, stdout: '', stderr: 'proc mount denied' }) })).rejects.toThrow('without passing environment verification')
  expect(f.progress.some(value => value.phase === 'environment-ready')).toBe(false)
})

it('records the dedicated immutable install while leaving active controllers and shared dependencies intact', async () => {
  const f = fixture(); let installed = false
  const launcher = { version: 1, path: '/control/tools/sandbox/' + 'c'.repeat(64) + '/bin/bwrap', digest: 'c'.repeat(64) }
  const diagnostic = () => ({ version: 1, strategy: 'private-proc', state: installed ? 'configured' : 'available',
    reason: 'Measured private-proc fixture', stdout: '', stderr: '', exitCode: 0, requiresPlatformAction: false,
    ...(installed ? { launcher, pathEntries: [launcher.path.slice(0, -6)] } : {}) })
  vi.mocked(f.driver.remote).mockImplementation(async (_target, script) => script.includes('/exited') ? '0\n' : 'active')
  vi.mocked(f.driver.remoteResult).mockImplementation(async (_target, wire, _signal, _password, _output, input) => {
    const script = input ?? wire
    if (script.replaceAll('\\"', '"').includes('"mode":"repair"')) installed = true
    return { ...f.result, stdout: JSON.stringify(diagnostic()) }
  })
  f.input.sandbox = new SandboxRepair({ experimentId: f.input.experimentId, serverId: f.input.serverId,
    policy: sandboxRepairPolicySchema.parse({}), minimumFreeBytes: 0 }, f.driver)
  f.loop(async () => {
    await f.call('repair_preparation_sandbox')
    expect(f.progress.some(value => value.pendingCommand !== undefined)).toBe(true)
    await f.call('verify_preparation_environment', { path_entries: [] })
  })
  await f.ensure(async () => { if (!installed) throw new SandboxVerificationError('sandbox-launch', '/usr/bin/bwrap', {
    exitCode: 1, stdout: '', stderr: 'proc mount refused' }); return 'verified without stopping active controllers' })
  expect(f.progress.at(-1)?.pendingCommand).toBeUndefined()
  const commands = vi.mocked(f.driver.remoteResult).mock.calls.map(call => call[5] ?? call[1])
  expect(commands.filter(script => script.replaceAll('\\"', '"').includes('"mode":"repair"'))).toHaveLength(1)
  expect(commands.some(script => script.includes('ASPERA_PREPARATION_COMMAND_DIRECTORY'))).toBe(true)
  expect(commands.some(script => script.includes('kill -9'))).toBe(false)
})

it('retains a sandbox install with a lost command channel until the original receipt is reconciled', async () => {
  const f = fixture()
  vi.mocked(f.driver.remote).mockImplementation(async (_target, command) => command.includes('/exited') ? 'unknown' : '')
  const diagnostic = { version: 1, strategy: 'private-proc', state: 'available', reason: 'Compatible private proc',
    stdout: '', stderr: '', exitCode: 0, requiresPlatformAction: false }
  vi.mocked(f.driver.remoteResult).mockImplementation(async (_target, wire, _signal, _password, _output, input) => {
    const script = input ?? wire
    return script.replaceAll('\\"', '"').includes('"mode":"repair"')
      ? { ...f.result, stdout: '', exitConfirmed: false, timedOut: true } : { ...f.result, stdout: JSON.stringify(diagnostic) }
  })
  f.input.sandbox = new SandboxRepair({ experimentId: f.input.experimentId, serverId: f.input.serverId,
    policy: sandboxRepairPolicySchema.parse({}), minimumFreeBytes: 0 }, f.driver)
  f.loop(async () => { await f.call('repair_preparation_sandbox') })
  await expect(f.ensure(async () => { throw new SandboxVerificationError('sandbox-launch', '/usr/bin/bwrap', {
    exitCode: 1, stdout: '', stderr: 'proc mount refused' }) })).rejects.toBeInstanceOf(UnconfirmedPreparationCommand)
  f.input.pendingCommand = f.progress.at(-1)?.pendingCommand
  expect(f.input.pendingCommand).toBeDefined()
  vi.mocked(f.driver.remote).mockResolvedValue('unknown')
  await expect(f.ensure(async () => 'ready')).rejects.toThrow('no confirmed exit')
  expect(vi.mocked(f.driver.remoteResult).mock.calls.filter(call => (call[5] ?? call[1]).replaceAll('\\"', '"').includes('"mode":"repair"'))).toHaveLength(1)
})

it('retains an unconfirmed mutation and refuses to repeat it on retry', async () => {
  const f = fixture()
  vi.mocked(f.driver.remote).mockImplementation(async (_target, command) => command.includes('/exited') ? 'unknown' : '')
  vi.mocked(f.driver.remoteResult).mockResolvedValue({ ...f.result, exitCode: null, timedOut: true, exitConfirmed: false })
  f.loop(async () => { await f.call('run_preparation_command', { command: 'long installation' }) })
  await expect(f.ensure(async () => { throw new Error('tools missing') })).rejects.toBeInstanceOf(UnconfirmedPreparationCommand)
  const pending = f.progress.at(-1)?.pendingCommand
  expect(pending).toBeDefined()
  f.input.pendingCommand = pending
  vi.mocked(f.driver.remote).mockResolvedValue('unknown')
  await expect(f.ensure(async () => 'ready')).rejects.toThrow('no confirmed exit')
  expect(f.driver.remoteResult).toHaveBeenCalledOnce()
  vi.mocked(f.driver.remote).mockResolvedValue('0\n')
  expect((await f.ensure(async () => 'ready')).value).toBe('ready')
  expect(f.driver.remoteResult).toHaveBeenCalledOnce()
})

it('requires its command exit record even if the SSH shell reported an exit', async () => {
  const f = fixture()
  vi.mocked(f.driver.remote).mockImplementation(async (_target, script) => script.includes('/exited') ? 'unknown' : '')
  vi.mocked(f.driver.remoteResult).mockResolvedValue({ ...f.result, exitCode: 137 })
  f.loop(async () => { await f.call('run_preparation_command', { command: 'installation interrupted by a signal' }) })
  await expect(f.ensure(async () => { throw new Error('missing tools') })).rejects.toBeInstanceOf(UnconfirmedPreparationCommand)
  expect(f.progress.at(-1)?.pendingCommand).toBeDefined()
})

it('requires the original Agent to call verification after a scoped controller repair', async () => {
  const f = fixture(); f.input.operation = 'controller'; let repaired = false
  const repair = vi.fn(async () => { repaired = true; return { repaired: true, verificationRequired: true } })
  f.input.controller = { inspect: async () => ({ ready: false, requested: ['/dev/nvidia5'], granted: ['/dev/nvidia2'] }), repair, reconcile: async () => {} }
  f.loop(async () => {
    const inspected = JSON.parse(await f.call('inspect_preparation_environment'))
    expect(inspected.controller.granted).toEqual(['/dev/nvidia2'])
    await expect(f.call('repair_preparation_controller', { server_id: randomUUID() })).rejects.toThrow('outside')
    await f.call('repair_preparation_controller')
    expect(f.progress.at(-1)?.phase).not.toBe('environment-ready')
    await f.call('verify_preparation_environment', { path_entries: [] })
  })
  await expect(f.ensure(async () => { if (!repaired) throw new Error('GPU authorization mismatch'); return 'verified GPU' })).resolves.toMatchObject({ value: 'verified GPU' })
  expect(repair).toHaveBeenCalledOnce()
})
it('rejects controller repair claims without program verification', async () => {
  const f = fixture(); f.input.operation = 'controller'
  f.input.controller = { inspect: async () => ({}), repair: async () => ({ repaired: true }), reconcile: async () => {} }
  f.loop(async () => { await f.call('repair_preparation_controller') })
  await expect(f.ensure(async () => { throw new Error('GPU authorization mismatch') })).rejects.toThrow('without passing')
})
it('permits controller diagnostics while keeping the original controller alive', async () => {
  const f = fixture()
  f.input.operation = 'controller'
  let diagnosed = false
  vi.mocked(f.driver.remote).mockImplementation(async (_target, script) => script.includes('/exited') ? '0\n' : 'active')
  f.loop(async () => {
    await f.call('run_preparation_command', { command: 'cat /control/logs/node.log' })
    diagnosed = true
    await f.call('verify_preparation_environment', { path_entries: [] })
  })
  await f.ensure(async () => { if (!diagnosed) throw new Error('control health unavailable'); return 'healthy' })
  expect(f.driver.remoteResult).toHaveBeenCalledOnce()
})

it('does not change shared dependencies while a controller is active', async () => {
  const f = fixture()
  vi.mocked(f.driver.remote).mockResolvedValue('active')
  f.loop(async () => {
    await expect(f.call('run_preparation_command', { command: 'upgrade node' })).rejects.toThrow('controller is running')
    await f.call('report_preparation_blocked', { reason: 'Finish active work before changing the shared environment.' })
  })
  await expect(f.ensure(async () => { throw new Error('incompatible version') })).rejects.toThrow('Finish active work')
  expect(f.driver.remoteResult).not.toHaveBeenCalled()
})

it('passes individual tool cancellation to the SSH operation', async () => {
  const f = fixture()
  vi.mocked(f.driver.remote).mockImplementation(async (_target, command) => command.includes('/exited') ? 'unknown' : '')
  const commandAbort = new AbortController()
  vi.mocked(f.driver.remoteResult).mockImplementation(async (_target, _script, signal) => {
    commandAbort.abort()
    expect(signal?.aborted).toBe(true)
    return { ...f.result, exitCode: null, cancelled: true, exitConfirmed: false }
  })
  f.loop(async () => { await f.call('run_preparation_command', { command: 'install' }, commandAbort.signal) })
  await expect(f.ensure(async () => { throw new Error('missing') })).rejects.toBeInstanceOf(UnconfirmedPreparationCommand)
})

it('confirms the original command after cancellation during status polling', async () => {
  const f = fixture(), commandAbort = new AbortController()
  vi.mocked(f.driver.remote).mockImplementation(async (_target, command) => {
    if (!command.includes('/command.py')) return ''
    if (!command.includes(' stop ')) { commandAbort.abort(); throw new Error('status read cancelled') }
    const directory = f.progress.findLast(value => value.pendingCommand !== undefined)!.pendingCommand!.directory
    return JSON.stringify({ status: { version: 1, experimentId: f.input.experimentId, serverId: f.input.serverId,
      commandId: directory.split('/').at(-1), sessionId: f.agent.session.id, toolCallId: f.invocations.at(-1),
      exitCode: 0, exitConfirmed: true, timedOut: false, cancelled: true, signal: null }, lines: [], offset: 0, hasMore: false })
  })
  f.loop(async () => {
    expect(JSON.parse(await f.call('run_preparation_command', { command: 'install' }, commandAbort.signal))).toMatchObject({ cancelled: true, exitConfirmed: true, exitCode: 0 })
    expect(f.progress.at(-1)?.pendingCommand).toBeUndefined()
    await f.call('report_preparation_blocked', { reason: 'User cancelled the fixture command' })
  })
  await expect(f.ensure(async () => { throw new Error('missing') })).rejects.toThrow('User cancelled')
  expect(f.driver.remoteResult).toHaveBeenCalledOnce()
})
