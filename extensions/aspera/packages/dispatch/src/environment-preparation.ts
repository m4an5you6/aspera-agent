/** The standard dispatch Agent repairs SSH environments; providers own verification and completion. */
import { randomUUID } from 'node:crypto'
import { posix, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { ObservationWriter, redactObservation } from '@aspera/runtime'
import { observationSourceIdSchema } from '@aspera/experiments'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { executableDirectoriesSchema, serverIdSchema } from '@aspera/experiments'
import type { ExperimentId, ExperimentServerId, ServerEnvironment, ObservationSource } from '@aspera/experiments'
import { remote, remoteResult, RemoteCommandError, shellQuote } from './transport.ts'
import type { Target, RemoteCommandResult } from './transport.ts'
import { inspectEnvironment } from './environment.ts'
import type { EnvironmentRequirements } from './environment.ts'
import { SavedReleaseUnavailable, ControllerDiagnostic } from './cluster-deploy.ts'
import { SandboxVerificationError } from './sandbox-verification.ts'
import type { ControllerRepairTools } from './controller-repair.ts'
import type { SandboxRepairTools, SandboxRepairDiagnostic } from './sandbox-repair.ts'
import { ReleaseInstallationPending } from './deploy.ts'
import type { EnvironmentProgress, PreparationCommand } from './types.ts'
import type { InstallationTools } from './installation.ts'
import { installationSourceProbeIdSchema } from './installation-model.ts'
import { preparationCommandScript, recoverPreparationCommand, preparationCommandSource, preparationCommandPolicySchema } from './preparation-command.ts'
import type { PreparationCommandPolicy, RecoveredPreparationCommand } from './preparation-command.ts'

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
  commandDeadline?: number
  installation?: InstallationTools
  controller?: ControllerRepairTools
  sandbox?: SandboxRepairTools
  progress: (value: EnvironmentProgress) => Promise<void>
}

/** An unfinished remote mutation must be reconciled before another mutation can start. */
export class UnconfirmedPreparationCommand extends Error {}

interface ActivePreparation {
  serverId: ExperimentServerId
  inspect: (signal: AbortSignal) => Promise<object>
  command: (script: string, signal: AbortSignal, callId: string, ownedRepair?: boolean) => Promise<RemoteCommandResult>
  verify: (pathEntries: string[], signal: AbortSignal, callId: ToolCallId) => Promise<object>
  block: (reason: string) => Promise<void>
  installation?: InstallationTools
  repair: (signal: AbortSignal) => Promise<object>
  repairSandbox: (signal: AbortSignal, callId: ToolCallId) => Promise<object>
  prepareTool: (signal: AbortSignal, callId: ToolCallId) => Promise<object>
}

/** Installs preparation tools on the existing DSH Agent, without another model loop. */
export class EnvironmentPreparation {
  private active: ActivePreparation | undefined
  private reject: ((error: Error) => void) | undefined

  /** @param commandPolicy - resolved command, read and exit-recovery limits. */
  constructor(private readonly commandPolicy: PreparationCommandPolicy = preparationCommandPolicySchema.parse({})) {}

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
      description: 'Run a foreground POSIX command on the assigned server within one program-enforced budget. ASPERA_PREPARATION_REMAINING_MS and ASPERA_PREPARATION_DEADLINE_MS expose that budget; downloads and all retries must share it. ASPERA_PREPARATION_CACHE_DIRECTORY retains reusable material across attempts. The tool supervises exit and recovers complete logs after SSH disconnects. A confirmed timeout is repairable in this Session; never repeat an unconfirmed operation. Prefer prepare_preparation_tool for fixed uv. Never background work, read credentials, replace sealed releases, stop controllers, change host drivers, or disable isolation checks.',
      parameters: { server_id: { type: 'string', required: true }, command: { type: 'string', required: true } }, output, presentCall,
      execute: async (args, exec) => JSON.stringify(await this.owner(args.server_id).command(args.command, exec.signal, exec.callId)) })))
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'prepare_preparation_tool',
      description: 'Prepare the fixed uv version declared by this release on the assigned server. The program checks its existing executable and validated cached material before downloading, preserves partial downloads and validates SHA-256 and Python/platform tags. Uses the same command deadline and original preparation Session. Python 3 with pip wheel/tag parsing must already be available. Returns executable directories; afterwards call verify_preparation_environment with them. It does not install training dependencies or establish readiness.',
      parameters: { server_id: { type: 'string', required: true }, tool: { type: 'string', enum: ['uv'], required: true } }, output,
      presentCall: args => ({ ...presentCall(args), title: 'Aspera preparation tool installation' }),
      execute: async (args, exec) => { if (args.tool !== 'uv') throw new Error('Unsupported preparation tool'); return JSON.stringify(await this.owner(args.server_id).prepareTool(exec.signal, exec.callId)) } })))
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'verify_preparation_environment',
      description: 'Run the application-owned checks for this preparation step. Supply absolute executable directories when tools were installed outside the original SSH PATH. Completion requires a successful provider result.',
      parameters: { server_id: { type: 'string', required: true }, path_entries: { type: 'array', items: { type: 'string' }, required: true } }, output, presentCall,
      execute: async (args, exec) => JSON.stringify(await this.owner(args.server_id).verify(executableDirectoriesSchema.parse(args.path_entries), exec.signal, exec.callId)) })))
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'report_preparation_blocked',
      description: 'End preparation when the selected account cannot meet a requirement. Include the actual diagnostic and the specific cloud-platform or operator action required.',
      parameters: { server_id: { type: 'string', required: true }, reason: { type: 'string', required: true } }, output, presentCall,
      execute: async args => { await this.owner(args.server_id).block(args.reason); return 'Preparation is blocked.' } })))
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'repair_preparation_controller',
      description: 'Request an identity-bound repair of the controller assigned to this preparation step. Before startup the program checks original submissions and all task, Agent, command and inference-service exits. It can close a started orphan only after every authorized original node confirms release, preserving any original terminal outcome; missing outcomes become interrupted. It never stops active, queued or awaiting-approval work automatically. Unselected nodes and unconfirmable identities remain blocked with a manual interruption instruction. The program fences admission, retains the stable home and old profiles, creates a profile for the selected fixed release and restarts with verified GPU authorization. Returned interruption receipts are program checks. Never supply a PID, profile path, ledger edit or device grant. Afterwards call verify_preparation_environment; this tool does not establish preparation completion.',
      parameters: { server_id: { type: 'string', required: true } }, output,
      presentCall: args => ({ ...presentCall(args), title: 'Aspera controller repair' }),
      execute: async (args, exec) => JSON.stringify(await this.owner(args.server_id).repair(exec.signal)) })))
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'repair_preparation_sandbox',
      description: 'Request the program-owned private-PID/proc compatibility launcher on the assigned server. The program measures feasibility, preserves every inner bubblewrap namespace and device grant, drops all capabilities, installs an immutable content-addressed launcher and records its exit. Uses only existing account privileges; never changes host kernel policy. No PID, path or isolation flags may be supplied. Afterwards call verify_preparation_environment; configuration alone does not complete preparation.',
      parameters: { server_id: { type: 'string', required: true } }, output,
      presentCall: args => ({ ...presentCall(args), title: 'Aspera sandbox repair' }),
      execute: async (args, exec) => JSON.stringify(await this.owner(args.server_id).repairSandbox(exec.signal, exec.callId)) })))
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
    let verification: object | undefined
    let sandboxDiagnosis: SandboxRepairDiagnostic | undefined
    let sandboxPaths: string[] = []
    let sandboxNeedsVerification = false
    let pending = input.pendingCommand
    let previousCommand: RemoteCommandResult | undefined
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
      if (pending.directory.includes('/controller-repairs/') && input.controller !== undefined) await input.controller.reconcile(pending.directory, lifetime)
      const root = resolve(resolveDshHome(), 'aspera-observations', input.experimentId)
      const source = preparationCommandSource(root, pending.directory)
      const recovered = source === undefined ? undefined : await recoverPreparationCommand(driver, target, pending.directory, root, source,
        this.commandPolicy, input.password, lifetime)
      const exit = recovered === undefined ? await driver.remote(target, `if [ -f ${shellQuote(pending.directory + '/exited')} ]; then cat ${shellQuote(pending.directory + '/exited')}; else printf unknown; fi`, lifetime, input.password) : String(recovered.exitCode)
      if (!/^\d+\s*$/.test(exit)) throw new UnconfirmedPreparationCommand(`Remote preparation command has no confirmed exit: ${pending.directory}. Inspect that command before retrying; it will not be started again.`)
      previousCommand = recovered
      pending = undefined
      await progress('inspecting-environment', `Previous preparation command exited ${exit.trim()}; rechecking the environment.`)
    }
    await reconcile()
    const check = async (pathEntries: string[], operationSignal = signal, callId?: ToolCallId): Promise<object> => {
      const lifetime = AbortSignal.any([signal, operationSignal])
      pathEntries = [...new Set([...sandboxPaths, ...pathEntries])]
      target = { ...target, pathEntries }
      await progress('verifying-environment')
      let value: T
      try {
        observation = await driver.inspectEnvironment(target, input.password, lifetime)
        const backend = observation.programs.find(program => program.name === 'bwrap')?.path ?? ''
        if (input.sandbox !== undefined && /\/tools\/sandbox\/[a-f0-9]{64}\/bin\/bwrap$/.test(backend)) {
          sandboxDiagnosis = await input.sandbox.inspect(target, observation, lifetime)
          if (sandboxDiagnosis.state !== 'configured' || sandboxDiagnosis.launcher.path !== backend) {
            throw new SandboxVerificationError('sandbox-launch', backend, { exitCode: observation.sandboxExitCode,
              stdout: sandboxDiagnosis.stdout, stderr: sandboxDiagnosis.reason + '\n' + sandboxDiagnosis.stderr })
          }
        }
        if (observation.sandboxExitCode !== 0) throw new SandboxVerificationError('sandbox-launch',
          observation.programs.find(program => program.name === 'bwrap')?.path ?? '',
          { exitCode: observation.sandboxExitCode, stdout: '', stderr: observation.diagnostics })
        value = await verify(target, observation, lifetime, callId)
      } catch (error) {
        lifetime.throwIfAborted()
        if (error instanceof SavedReleaseUnavailable || error instanceof ReleaseInstallationPending) throw error
        if (error instanceof RemoteCommandError && !error.result.exitConfirmed) throw error
        if (error instanceof SandboxVerificationError && error.diagnostic.stage === 'sandbox-launch' && input.sandbox !== undefined) {
          sandboxDiagnosis = await input.sandbox.inspect(target, observation, lifetime)
        }
        await progress(error instanceof SandboxVerificationError ? 'repairing-environment' : 'configuring-environment', String(error))
        verification = { ready: false, error: String(error), ...(error instanceof ControllerDiagnostic || error instanceof SandboxVerificationError ? {
          diagnostic: error instanceof SandboxVerificationError && sandboxDiagnosis !== undefined ? { ...error.diagnostic,
            requiresPlatformAction: sandboxDiagnosis.requiresPlatformAction, requiredAction: sandboxDiagnosis.reason,
            sandboxRepair: { ...sandboxDiagnosis, ...(['available', 'configured'].includes(sandboxDiagnosis.state) ? { tool: 'repair_preparation_sandbox' } : {}) },
          } : error.diagnostic } : {}) }
        return verification
      }
      await progress('environment-ready')
      accepted = { value, pathEntries }
      verification = { ready: true, result: value, ...(sandboxDiagnosis === undefined ? {} : { sandboxRepair: sandboxDiagnosis }) }
      return verification
    }
    const initial = await check([...(target.pathEntries ?? [])])
    const message = createUserMessage({ source: { kind: 'aspera', experimentId: input.experimentId }, content: [{
      type: 'text', text: JSON.stringify({ operation: 'prepare-experiment-environment', experimentId: input.experimentId, step: input.operation,
        serverId: input.serverId, serverName: input.serverName, requirements: input.requirements,
        managedEnvironmentTools: input.requirements.uv === undefined ? undefined : `Install fixed uv ${input.requirements.uv}, normally at /usr/local/bin/uv, and Python 3 using this account's existing permissions. Tool paths are verified before handover. Training dependencies belong to execution's managed environment tools, never account .local.`,
        directories: input.directories,
        observation, verification: initial, pathEntries: target.pathEntries ?? [], controllerRepairAvailable: input.controller !== undefined,
        sandboxInstruction: 'Shell inspection exercises the execution namespaces before installation or storage selection. Deployment verification uses the full launch, device grants, hidden directories and cleared environment. When diagnostic.sandboxRepair offers repair_preparation_sandbox, call that dedicated tool and then verify_preparation_environment. Its private PID/proc parent preserves every inner isolation flag with zero capabilities and no_new_privs; it uses privileges this account already holds. Never disable user namespaces, bind host proc into the final sandbox, change host AppArmor/sysctl/drivers, or declare a cloud blocker without checking an available program-owned repair. Configuration alone is not verification.',
        controllerInstruction: input.controller === undefined ? undefined : 'Inspect GPU identities, controller authorization and offline SSH recovery evidence with inspect_preparation_environment. An unavailable control port or an old profile binding can be repaired by repair_preparation_controller after the program confirms durable resource release. This tool creates a separate fixed-release profile while retaining original tasks and Sessions. Never stop or start a controller or rewrite its profiles through shell commands. Afterwards call verify_preparation_environment. Unknown ownership, active tasks, unsupported legacy maintenance and unconfirmed exits require a concrete diagnostic; control-port refusal alone does not establish a cloud-platform or account-permission blocker.',
        previousCommand: previousCommand === undefined ? undefined : { ...previousCommand,
          stdout: redactObservation(previousCommand.stdout.slice(-input.outputChars), input.password ? [input.password] : []),
          stderr: redactObservation(previousCommand.stderr.slice(-input.outputChars), input.password ? [input.password] : []) },
        commandBudgetMs: Math.min(target.toolTimeoutMs, Math.max(0, (input.commandDeadline ?? Date.now() + target.toolTimeoutMs) - Date.now())),
        commandInstruction: 'For missing fixed uv, call prepare_preparation_tool before a custom download. It checks existing executables and verified complete/partial material. All download retries share the supplied command budget; use the retained cache rather than a new temporary installation. A confirmed timeout result permits repair in this Session; an unknown exit does not. Include returned executable directories in verify_preparation_environment. Only provider verification completes preparation.',
        instruction: accepted !== undefined ? 'This check passed. Retain these observations as context for the next preparation step; no repair is requested.'
          : 'Prepare this server using its existing SSH account permissions. Inspect the installation and complete logs before repairing network, disk, permissions, tool versions or compiler requirements. You choose download sources autonomously: probe an HTTPS candidate and switch only when its measured result supports that choice. Keep existing caches, original release material, frozen lockfile and checkpoints. Heartbeats and repeated retry text do not mean progress. Installation restarts, including source changes, share the saved retry and total budget. Never read or forward credentials, change global registry settings, disable TLS/integrity, replace sealed releases, stop controllers, change host drivers or disable isolation. Use foreground repair commands within the remaining budget and verify_preparation_environment after repair. Only program verification establishes success. Report concrete permission/kernel/device blockers. Do not complete the dispatch Goal.' }),
    }] })
    // The inbox records context while the loop retains ownership of the first system surface node.
    if (accepted !== undefined) { agent.inject(message); return accepted }
    const failed = new Promise<never>((_resolve, reject) => { this.reject = error => { terminal = error; reject(error) } })
    const stop = (error: Error) => { terminal = error; this.reject?.(error) }
    const handlers: ActivePreparation = {
      serverId: input.serverId,
      prepareTool: async (operationSignal, callId) => {
        const python = observation.programs.find(program => program.name === 'python3')?.path
        if (input.requirements.uv === undefined) throw new Error('The selected release does not declare a uv requirement')
        if (!python?.startsWith('/')) throw new Error('Install Python 3 and its pip wheel/tag parser before preparing uv')
        return handlers.command(`exec ${shellQuote(python)} -B -I "$ASPERA_PREPARATION_COMMAND_DIRECTORY/command.py" uv "$ASPERA_PREPARATION_COMMAND_DIRECTORY"`, operationSignal, callId)
      },
      inspect: async operationSignal => { const lifetime = AbortSignal.any([signal, operationSignal]); observation = await driver.inspectEnvironment(target, input.password, lifetime); await progress('inspecting-environment');
        return { ...observation, latestVerification: verification, ...(input.controller === undefined ? {} : { controller: await input.controller.inspect(lifetime) }) } },
      repair: async operationSignal => {
        if (input.controller === undefined) throw new Error('Controller repair is unavailable outside its assigned preparation step')
        if (accepted !== undefined || terminal !== undefined) throw new Error('Preparation step has already finished')
        const lifetime = AbortSignal.any([signal, operationSignal]); await reconcile(lifetime)
        await progress('repairing-environment')
        try {
          const result = await input.controller.repair(lifetime, async directory => { pending = { directory }; await progress('repairing-environment') })
          await reconcile(lifetime)
          return result
        } catch (error) {
          await progress('repairing-environment', String(error))
          if (pending !== undefined) {
            try { await reconcile(lifetime) } catch (unconfirmed) {
              const failure = new UnconfirmedPreparationCommand(`Controller repair is unconfirmed: ${String(unconfirmed)}`); stop(failure); throw failure
            }
          }
          return { repaired: false, error: String(error), ...(error instanceof ControllerDiagnostic ? { diagnostic: error.diagnostic } : {}) }
        }
      },
      repairSandbox: async (operationSignal, callId) => {
        if (input.sandbox === undefined) throw new Error('Sandbox repair is unavailable in this preparation step')
        if (accepted !== undefined || terminal !== undefined) throw new Error('Preparation step has already finished')
        const lifetime = AbortSignal.any([signal, operationSignal])
        await reconcile(lifetime)
        observation = await driver.inspectEnvironment(target, input.password, lifetime)
        await progress('repairing-environment', 'Preparation Agent requested the program-owned sandbox compatibility repair.')
        try {
          sandboxDiagnosis = await input.sandbox.repair(target, observation, script => handlers.command(script, lifetime, callId, true), lifetime)
        } catch (error) {
          if (terminal !== undefined) throw terminal
          throw error
        }
        if (sandboxDiagnosis.state === 'configured') {
          sandboxPaths = sandboxDiagnosis.pathEntries
          sandboxNeedsVerification = true
          target = { ...target, pathEntries: [...new Set([...sandboxPaths, ...(target.pathEntries ?? [])])] }
        }
        await progress('repairing-environment', sandboxDiagnosis.reason)
        return { ...sandboxDiagnosis, verificationRequired: true }
      },
      verify: async (paths, operationSignal, callId) => {
        if (accepted !== undefined || terminal !== undefined) throw new Error('Preparation step has already finished')
        try {
          const checked = await check(paths, operationSignal, callId)
          sandboxNeedsVerification = false
          return checked
        }
        catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error))
          stop(failure)
          throw failure
        }
      },
      block: async reason => {
        if (accepted !== undefined) throw new Error('Preparation step has already finished')
        if (reason.trim() === '') throw new Error('A preparation blocker requires a reason')
        if (sandboxNeedsVerification || sandboxDiagnosis?.state === 'available' || (sandboxDiagnosis?.state === 'configured' && sandboxPaths.length === 0)) {
          throw new Error('A program-measured available sandbox repair has not been verified. Call repair_preparation_sandbox and verify_preparation_environment before reporting an exhausted account-level blocker.')
        }
        terminal = new Error(reason)
      },
      command: async (script, operationSignal, callId, ownedRepair = false) => {
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
        if (!ownedRepair && active !== '' && (input.operation === 'bootstrap' || input.operation === 'deployment')) throw new Error('A node controller is running. Reuse its compatible environment; stop it only after its tasks finish and cleanup is confirmed before changing shared dependencies.')
        const commandId = randomUUID()
        const timeoutMs = Math.min(target.toolTimeoutMs, (input.commandDeadline ?? Date.now() + target.toolTimeoutMs) - Date.now())
        if (timeoutMs <= 0) throw new Error('Preparation budget exhausted; retry preparation to start a new recovery budget')
        pending = { directory: posix.join(observation.home, '.local/state/aspera/preparation', input.experimentId, input.serverId, commandId) }
        await progress('configuring-environment')
        const root = resolve(resolveDshHome(), 'aspera-observations', input.experimentId)
        const source: ObservationSource = {
          version: 1, id: observationSourceIdSchema.parse(`preparation-${commandId}`), experimentId: input.experimentId, serverId: input.serverId,
          kind: 'preparation', phase: 'preparation', sessionId: agent.session.id, commandId, toolCallId: callId, label: input.operation,
          createdAt: Date.now(), streams: ['stdout', 'stderr'], complete: false }
        const capture = new ObservationWriter(root, source, input.password === undefined ? [] : [input.password])
        let result: RemoteCommandResult
        let captureComplete = false
        try {
          const python = observation.programs.find(program => program.name === 'python3')?.path
          // Base executables remain outside the experiment namespaces hidden by the execution sandbox.
          const cacheDirectory = posix.join(observation.home, '.cache/aspera/preparation', input.serverId)
          let transport: RemoteCommandResult | undefined
          try {
            transport = await driver.remoteResult({ ...target, toolTimeoutMs: python?.startsWith('/') ? this.commandPolicy.readTimeoutMs
              : timeoutMs + this.commandPolicy.stopGraceMs + this.commandPolicy.readTimeoutMs },
              preparationCommandScript({ directory: pending.directory, cacheDirectory, command: script, source, timeoutMs,
                policy: this.commandPolicy, python: python?.startsWith('/') ? python : undefined, uvVersion: input.requirements.uv,
                uvPath: observation.programs.find(program => program.name === 'uv')?.path }), lifetime, input.password)
          } catch (error) {
            await progress('configuring-environment', `SSH reader stopped; checking the original command: ${String(error)}`)
          }
          const alreadyCancelled = lifetime.aborted
          let recovered: RecoveredPreparationCommand
          try {
            recovered = await recoverPreparationCommand(driver, target, pending.directory, root, source, this.commandPolicy,
              input.password, alreadyCancelled ? AbortSignal.timeout(this.commandPolicy.recoveryTimeoutMs) : lifetime, alreadyCancelled)
          } catch (error) {
            if (alreadyCancelled || !lifetime.aborted) throw error
            recovered = await recoverPreparationCommand(driver, target, pending.directory, root, source, this.commandPolicy,
              input.password, AbortSignal.timeout(this.commandPolicy.recoveryTimeoutMs), true)
          }
          result = recovered.supervised ? recovered : { ...(transport ?? recovered), exitConfirmed: recovered.exitConfirmed, exitCode: recovered.exitCode }
          if (!recovered.supervised) { capture.append('stdout', result.stdout); capture.append('stderr', result.stderr) }
          captureComplete = result.exitConfirmed
        } catch (error) {
          const unresolved = new UnconfirmedPreparationCommand(`Preparation command outcome is unknown at ${pending.directory}: ${String(error)}`)
          await progress('configuring-environment', unresolved.message); stop(unresolved); throw unresolved
        } finally { capture.close(captureComplete) }
        const publicResult = { ...result, stdout: redactObservation(result.stdout.slice(-input.outputChars), input.password ? [input.password] : []),
          stderr: redactObservation(result.stderr.slice(-input.outputChars), input.password ? [input.password] : []) }
        if (!result.exitConfirmed) {
          const unresolved = new UnconfirmedPreparationCommand(`Preparation command outcome is unknown at ${pending.directory}; inspect its exit before retrying.`)
          await progress('configuring-environment', unresolved.message); stop(unresolved)
        } else {
          pending = undefined
          const succeeded = result.exitCode === 0 && !result.timedOut && !result.cancelled
          await progress(succeeded ? 'configuring-environment' : 'repairing-environment',
            succeeded ? undefined : publicResult.stderr || publicResult.stdout)
        }
        return publicResult
      },
    }
    this.active = {
      serverId: input.serverId,
      inspect: operationSignal => serial(() => handlers.inspect(operationSignal)),
      command: (script, operationSignal, callId) => serial(() => handlers.command(script, operationSignal, callId)),
      verify: (paths, operationSignal, callId) => serial(() => handlers.verify(paths, operationSignal, callId)),
      repair: operationSignal => serial(() => handlers.repair(operationSignal)),
      repairSandbox: (operationSignal, callId) => serial(() => handlers.repairSandbox(operationSignal, callId)),
      prepareTool: (operationSignal, callId) => serial(() => handlers.prepareTool(operationSignal, callId)),
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
