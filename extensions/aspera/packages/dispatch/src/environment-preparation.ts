/** The standard dispatch Agent repairs SSH environments; providers own verification and completion. */
import { randomUUID } from 'node:crypto'
import { posix, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { ObservationWriter } from '@aspera/runtime'
import { observationSourceIdSchema } from '@aspera/experiments'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { executableDirectoriesSchema, serverIdSchema } from '@aspera/experiments'
import type { ExperimentId, ExperimentServerId, ServerEnvironment } from '@aspera/experiments'
import { remote, remoteResult, RemoteCommandError, shellQuote } from './transport.ts'
import type { Target, RemoteCommandResult } from './transport.ts'
import { inspectEnvironment } from './environment.ts'
import type { EnvironmentRequirements } from './environment.ts'
import { SavedReleaseUnavailable } from './cluster-deploy.ts'
import { ReleaseInstallationPending } from './deploy.ts'
import type { EnvironmentProgress, PreparationCommand } from './types.ts'
import type { InstallationTools } from './installation.ts'
import { installationSourceProbeIdSchema } from './installation-model.ts'

/** Injectable SSH operations are shared by production tools and the profile replay. */
export interface EnvironmentDriver {
  inspectEnvironment: typeof inspectEnvironment
  remote: typeof remote
  remoteResult: typeof remoteResult
}

/** Saved inputs for one serialized node preparation interval. */
export interface EnvironmentPreparationInput {
  experimentId: ExperimentId
  serverId: ExperimentServerId
  serverName: string
  target: Target
  controlRoot?: string
  directories?: { workspace: string; release: string; control: string }
  password?: string
  requirements: EnvironmentRequirements
  operation: 'bootstrap' | 'deployment' | 'controller' | 'network'
  observation: ServerEnvironment
  pendingCommand?: PreparationCommand
  outputChars: number
  installation?: InstallationTools
  progress: (value: EnvironmentProgress) => Promise<void>
}

/** An unfinished remote mutation must be reconciled before another mutation can start. */
export class UnconfirmedPreparationCommand extends Error {}

interface ActivePreparation {
  serverId: ExperimentServerId
  inspect: (signal: AbortSignal) => Promise<object>
  command: (script: string, signal: AbortSignal, callId: string) => Promise<RemoteCommandResult>
  verify: (pathEntries: string[], signal: AbortSignal, callId: ToolCallId) => Promise<object>
  block: (reason: string) => Promise<void>
  installation?: InstallationTools
}

/** Installs preparation tools on the existing DSH Agent, without another model loop. */
export class EnvironmentPreparation {
  private active: ActivePreparation | undefined
  private reject: ((error: Error) => void) | undefined

  /** Register tools after the storage selector has restricted inherited tools.
   * @param ctx - the preparation Agent's scoped context. @param agent - owning Agent.
   */
  install(ctx: Context, agent: Agent): void {
    const output = { schema: { type: 'string' as const }, render: (_args: object, value: string) => [{ type: 'text' as const, text: value }] }
    const presentCall = (args: object) => ({ card: 'generic' as const, title: 'Aspera environment preparation', kind: 'other' as const, rawInput: args })
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'inspect_preparation_environment',
      description: 'Inspect the assigned Linux account, executable versions and actual bubblewrap probe. Works before Node or Aspera is installed.',
      parameters: { server_id: { type: 'string', required: true } }, output, presentCall,
      execute: async (args, exec) => JSON.stringify(await this.owner(args.server_id).inspect(exec.signal)) })))
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'run_preparation_command',
      description: 'Run a foreground POSIX command on the currently assigned server using its existing SSH account permissions. Install and configure required user-space dependencies. Never background work, read credentials, replace sealed releases, stop controllers, change host drivers, or disable isolation checks. Nonzero exits retain stdout and stderr.',
      parameters: { server_id: { type: 'string', required: true }, command: { type: 'string', required: true } }, output, presentCall,
      execute: async (args, exec) => JSON.stringify(await this.owner(args.server_id).command(args.command, exec.signal, exec.callId)) })))
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'verify_preparation_environment',
      description: 'Run the application-owned checks for this preparation step. Supply absolute executable directories when tools were installed outside the original SSH PATH. Completion requires a successful provider result.',
      parameters: { server_id: { type: 'string', required: true }, path_entries: { type: 'array', items: { type: 'string' }, required: true } }, output, presentCall,
      execute: async (args, exec) => JSON.stringify(await this.owner(args.server_id).verify(executableDirectoriesSchema.parse(args.path_entries), exec.signal, exec.callId)) })))
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'report_preparation_blocked',
      description: 'End preparation when the selected account cannot meet a requirement. Include the actual diagnostic and the specific cloud-platform or operator action required.',
      parameters: { server_id: { type: 'string', required: true }, reason: { type: 'string', required: true } }, output, presentCall,
      execute: async args => { await this.owner(args.server_id).block(args.reason); return 'Preparation is blocked.' } })))
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'inspect_preparation_installation',
      description: 'Read the original supervised installer, real download/compiler progress, remaining budget, exit receipt and log source. Polling does not start another installer or reset limits.',
      parameters: { server_id: { type: 'string', required: true } }, output, presentCall,
      execute: async (args, exec) => JSON.stringify(await this.installer(args.server_id).inspect(exec.signal)) })))
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'probe_preparation_source',
      description: 'Measure an HTTPS npm registry or Node header distribution on the selected server, using the exact fixed release version and a bounded download. No saved credentials are sent. Use evidence to decide whether to wait, repair the environment or switch sources.',
      parameters: { server_id: { type: 'string', required: true }, kind: { type: 'string', enum: ['npm', 'nodeHeaders'], required: true }, url: { type: 'string', required: true } }, output, presentCall,
      execute: async (args, exec) => JSON.stringify(await this.installer(args.server_id).probe(args.kind === 'npm' ? 'npm' : 'nodeHeaders', args.url, exec.signal)) })))
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'switch_preparation_source',
      description: 'Autonomously use a successfully probed source for this installation only. Stops the identity-matched old installer and confirms exit before reusing its cache. Counts the new attempt against the existing retry and time budgets. TLS, frozen versions and integrity verification remain required. No user confirmation is needed.',
      parameters: { server_id: { type: 'string', required: true }, probe_id: { type: 'string', required: true }, reason: { type: 'string', required: true } }, output, presentCall,
      execute: async (args, exec) => JSON.stringify(await this.installer(args.server_id).switchSource(installationSourceProbeIdSchema.parse(args.probe_id), args.reason, exec.signal, { sessionId: agent.session.id, callId: exec.callId })) })))
    ctx.on('agent/error', ({ agent: owner, error }) => { if (owner === agent) this.reject?.(new Error(String(error))) })
  }

  private owner(raw: string): ActivePreparation {
    const id = serverIdSchema.parse(raw)
    if (this.active?.serverId !== id) throw new Error('Server is outside the active preparation step')
    return this.active
  }
  private installer(raw: string): InstallationTools {
    const tools = this.owner(raw).installation
    if (!tools) throw new Error('Installation tools are unavailable outside the current deployment step')
    return tools
  }

  /**
   * Verify one node and let the standard Agent repair a failed check.
   * @param agent - existing preparation Session owner.
   * @param input - fixed node, release requirements and durable progress writer.
   * @param driver - SSH provider.
   * @param verify - deterministic check; resolves only when this step is complete.
   * @param signal - experiment cancellation.
   * @returns checked value and the executable directories used for the check.
   */
  async ensure<T>(agent: Agent, input: EnvironmentPreparationInput, driver: EnvironmentDriver,
    verify: (target: Target, observation: ServerEnvironment, signal: AbortSignal, callId?: ToolCallId) => Promise<T>, signal: AbortSignal): Promise<{ value: T; pathEntries: string[] }> {
    if (this.active !== undefined) throw new Error('Preparation Agent already owns a node step')
    let target = input.target
    let observation = input.observation
    let pending = input.pendingCommand
    let accepted: { value: T; pathEntries: string[] } | undefined
    let terminal: Error | undefined
    let ended = false
    let operations = Promise.resolve()
    const serial = <R>(operation: () => Promise<R>): Promise<R> => {
      const result = operations.then(() => {
        signal.throwIfAborted()
        if (ended || terminal !== undefined) throw new Error('Preparation step has already finished')
        return operation()
      })
      operations = result.then(() => {}, () => {})
      return result
    }
    const progress = async (phase: EnvironmentProgress['phase'], detail?: string) => {
      try {
        await input.progress({ serverId: input.serverId, phase, observation, ...(pending === undefined ? {} : { pendingCommand: pending }),
          ...(detail === undefined ? {} : { detail }) })
      } catch (error) {
        terminal = new Error(`Preparation progress could not be saved: ${String(error)}`, { cause: error })
        this.reject?.(terminal)
        throw terminal
      }
    }
    const reconcile = async (lifetime = signal) => {
      if (pending === undefined) return
      const exit = await driver.remote(target, `if [ -f ${shellQuote(pending.directory + '/exited')} ]; then cat ${shellQuote(pending.directory + '/exited')}; else printf unknown; fi`, lifetime, input.password)
      if (!/^\d+\s*$/.test(exit)) throw new UnconfirmedPreparationCommand(`Remote preparation command has no confirmed exit: ${pending.directory}. Inspect that command before retrying; it will not be started again.`)
      pending = undefined
      await progress('inspecting-environment', `Previous preparation command exited ${exit.trim()}; rechecking the environment.`)
    }
    await reconcile()
    const check = async (pathEntries: string[], operationSignal = signal, callId?: ToolCallId): Promise<object> => {
      const lifetime = AbortSignal.any([signal, operationSignal])
      target = { ...target, pathEntries }
      await progress('verifying-environment')
      let value: T
      try {
        observation = await driver.inspectEnvironment(target, input.password, lifetime)
        value = await verify(target, observation, lifetime, callId)
      } catch (error) {
        lifetime.throwIfAborted()
        if (error instanceof SavedReleaseUnavailable || error instanceof ReleaseInstallationPending) throw error
        if (error instanceof RemoteCommandError && !error.result.exitConfirmed) throw error
        await progress('configuring-environment', String(error))
        return { ready: false, error: String(error) }
      }
      await progress('environment-ready')
      accepted = { value, pathEntries }
      return { ready: true, result: value }
    }
    const initial = await check([...(target.pathEntries ?? [])])
    const message = createUserMessage({ source: { kind: 'aspera', experimentId: input.experimentId }, content: [{
      type: 'text', text: JSON.stringify({ operation: 'prepare-experiment-environment', experimentId: input.experimentId, step: input.operation,
        serverId: input.serverId, serverName: input.serverName, requirements: input.requirements,
        directories: input.directories,
        observation, verification: initial, pathEntries: target.pathEntries ?? [],
        instruction: accepted !== undefined ? 'This check passed. Retain these observations as context for the next preparation step; no repair is requested.'
          : 'Prepare this server using its existing SSH account permissions. Inspect the installation and complete logs before repairing network, disk, permissions, tool versions or compiler requirements. You choose download sources autonomously: probe an HTTPS candidate and switch only when its measured result supports that choice. Keep existing caches, original release material, frozen lockfile and checkpoints. Heartbeats and repeated retry text do not mean progress. Installation restarts, including source changes, share the saved retry and total budget. Never read or forward credentials, change global registry settings, disable TLS/integrity, replace sealed releases, stop controllers, change host drivers or disable isolation. Use foreground repair commands within the remaining budget and verify_preparation_environment after repair. Only program verification establishes success. Report concrete permission/kernel/device blockers. Do not complete the dispatch Goal.' }),
    }] })
    // The inbox records context while the loop retains ownership of the first system surface node.
    if (accepted !== undefined) { agent.inject(message); return accepted }
    const failed = new Promise<never>((_resolve, reject) => { this.reject = error => { terminal = error; reject(error) } })
    const stop = (error: Error) => { terminal = error; this.reject?.(error) }
    const handlers: ActivePreparation = {
      serverId: input.serverId,
      inspect: async operationSignal => { observation = await driver.inspectEnvironment(target, input.password, AbortSignal.any([signal, operationSignal])); await progress('inspecting-environment'); return observation },
      verify: async (paths, operationSignal, callId) => {
        if (accepted !== undefined || terminal !== undefined) throw new Error('Preparation step has already finished')
        try { return await check(paths, operationSignal, callId) }
        catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error))
          stop(failure)
          throw failure
        }
      },
      block: async reason => {
        if (accepted !== undefined) throw new Error('Preparation step has already finished')
        if (reason.trim() === '') throw new Error('A preparation blocker requires a reason')
        terminal = new Error(reason)
      },
      command: async (script, operationSignal, callId) => {
        const lifetime = AbortSignal.any([signal, operationSignal])
        if (accepted !== undefined || terminal !== undefined) throw new Error('Preparation step has already finished')
        if (script.trim() === '') throw new Error('Preparation command must not be empty')
        lifetime.throwIfAborted()
        await reconcile(lifetime)
        const control = input.controlRoot ?? posix.join(observation.home, '.local/share/aspera', input.serverId)
        const active = await driver.remote(target, `for role in coordinator node; do
  file=${shellQuote(control + '/state')}/"$role.pid"
  if [ -f "$file" ] && kill -0 "$(cat "$file")" 2>/dev/null; then printf active; fi
done`, lifetime, input.password)
        if (active !== '' && (input.operation === 'bootstrap' || input.operation === 'deployment')) throw new Error('A node controller is running. Reuse its compatible environment; stop it only after its tasks finish and cleanup is confirmed before changing shared dependencies.')
        const commandId = randomUUID()
        pending = { directory: posix.join(observation.home, '.local/state/aspera/preparation', input.experimentId, input.serverId, commandId) }
        await progress('configuring-environment')
        const capture = new ObservationWriter(resolve(resolveDshHome(), 'aspera-observations', input.experimentId), {
          version: 1, id: observationSourceIdSchema.parse(`preparation-${commandId}`), experimentId: input.experimentId, serverId: input.serverId,
          kind: 'preparation', phase: 'preparation', sessionId: agent.session.id, commandId, toolCallId: callId, label: input.operation,
          createdAt: Date.now(), streams: ['stdout', 'stderr'], complete: false }, input.password === undefined ? [] : [input.password])
        let result: RemoteCommandResult
        let captureComplete = false
        try {
          result = await driver.remoteResult(target, `umask 077
mkdir -p ${shellQuote(posix.dirname(pending.directory))}
mkdir ${shellQuote(pending.directory)} || exit 1
mkfifo ${shellQuote(pending.directory + '/stdout.pipe')} ${shellQuote(pending.directory + '/stderr.pipe')} || exit 1
tee ${shellQuote(pending.directory + '/stdout.log')} < ${shellQuote(pending.directory + '/stdout.pipe')} &
output_reader=$!
tee ${shellQuote(pending.directory + '/stderr.log')} < ${shellQuote(pending.directory + '/stderr.pipe')} >&2 &
error_reader=$!
sh -c ${shellQuote(script)} > ${shellQuote(pending.directory + '/stdout.pipe')} 2> ${shellQuote(pending.directory + '/stderr.pipe')}
status=$?
wait "$output_reader"
wait "$error_reader"
rm -f ${shellQuote(pending.directory + '/stdout.pipe')} ${shellQuote(pending.directory + '/stderr.pipe')}
printf '%s\\n' "$status" > ${shellQuote(pending.directory + '/exited')}
exit "$status"`, lifetime, input.password, (stream, chunk) => { capture.append(stream, chunk) })
          if (result.exitConfirmed) {
            const receipt = await driver.remote(target, `if [ -f ${shellQuote(pending.directory + '/exited')} ]; then cat ${shellQuote(pending.directory + '/exited')}; else printf unknown; fi`, lifetime, input.password)
            result = { ...result, exitConfirmed: /^\d+\s*$/.test(receipt) }
          }
          captureComplete = result.exitConfirmed
        } catch (error) {
          const unresolved = new UnconfirmedPreparationCommand(`Preparation command outcome is unknown at ${pending.directory}: ${String(error)}`)
          await progress('configuring-environment', unresolved.message); stop(unresolved); throw unresolved
        } finally { capture.close(captureComplete) }
        const publicResult = { ...result, stdout: result.stdout.slice(-input.outputChars), stderr: result.stderr.slice(-input.outputChars) }
        if (!result.exitConfirmed) {
          const unresolved = new UnconfirmedPreparationCommand(`Preparation command outcome is unknown at ${pending.directory}; inspect its exit before retrying.`)
          await progress('configuring-environment', unresolved.message); stop(unresolved)
        } else {
          pending = undefined
          await progress(result.exitCode === 0 ? 'configuring-environment' : 'repairing-environment',
            result.exitCode === 0 ? undefined : publicResult.stderr || publicResult.stdout)
        }
        return publicResult
      },
    }
    this.active = {
      serverId: input.serverId,
      inspect: operationSignal => serial(() => handlers.inspect(operationSignal)),
      command: (script, operationSignal, callId) => serial(() => handlers.command(script, operationSignal, callId)),
      verify: (paths, operationSignal, callId) => serial(() => handlers.verify(paths, operationSignal, callId)),
      block: reason => serial(() => handlers.block(reason)),
      installation: input.installation === undefined ? undefined : {
        inspect: operationSignal => serial(() => input.installation!.inspect(AbortSignal.any([signal, operationSignal]))),
        probe: (kind, url, operationSignal) => serial(() => input.installation!.probe(kind, url, AbortSignal.any([signal, operationSignal]))),
        switchSource: (probeId, reason, operationSignal, invocation) => serial(() => input.installation!.switchSource(probeId, reason, AbortSignal.any([signal, operationSignal]), invocation)),
      },
    }
    const abort = () => { agent.cancel({ kind: 'user' }); this.reject?.(new Error('Environment preparation was cancelled')) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      agent.followup(message)
      await Promise.race([agent.whenIdle(), failed])
      signal.throwIfAborted()
      if (terminal !== undefined) throw terminal
      if (accepted === undefined) throw new Error('Preparation Agent ended without passing environment verification')
      return accepted
    } finally {
      ended = true
      signal.removeEventListener('abort', abort)
      this.active = undefined; this.reject = undefined
      if (agent.status === 'running') agent.cancel({ kind: 'user' })
      try { await agent.whenIdle() } finally { await operations }
    }
  }
}
