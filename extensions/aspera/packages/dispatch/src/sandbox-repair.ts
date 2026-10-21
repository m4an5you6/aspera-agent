/** Account-scoped, immutable bubblewrap compatibility launchers and their measured diagnostics. */
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { z } from 'zod'
import { experimentIsolationArgs } from '@aspera/runtime'
import { executableDirectoriesSchema } from '@aspera/experiments'
import type { ExperimentId, ExperimentServerId, ServerEnvironment } from '@aspera/experiments'
import { remoteResult, RemoteCommandError, shellQuote } from './transport.ts'
import type { RemoteCommandResult, Target } from './transport.ts'

/** Deployment-varying limits for compatibility probes and supervised cleanup. */
export const sandboxRepairPolicySchema = z.object({
  probeTimeoutMs: z.number().int().min(1000).max(120000).default(15000),
  cleanupTimeoutMs: z.number().int().min(100).max(10000).default(1000),
  pollIntervalMs: z.number().int().min(1).max(1000).default(20),
  maxAttempts: z.number().int().min(0).max(10).default(2),
})

/** Resolved compatibility repair limits; repeated use of an installed launcher costs no attempt. */
export type SandboxRepairPolicy = z.infer<typeof sandboxRepairPolicySchema>

const launcherSchema = z.object({ version: z.literal(1), path: z.string().startsWith('/'), digest: z.string().regex(/^[a-f0-9]{64}$/) })
const evidence = z.object({ version: z.literal(1), strategy: z.literal('private-proc'), reason: z.string().min(1),
  stdout: z.string(), stderr: z.string(), exitCode: z.number().int().nullable(), requiresPlatformAction: z.boolean() })
const diagnosticSchema = z.discriminatedUnion('state', [
  evidence.extend({ state: z.literal('available') }),
  evidence.extend({ state: z.literal('configured'), launcher: launcherSchema, pathEntries: executableDirectoriesSchema }),
  evidence.extend({ state: z.literal('unavailable') }),
  evidence.extend({ state: z.literal('unknown') }),
])

/** A measured alternative preserves the full inner sandbox; configuration never establishes completion. */
export type SandboxRepairDiagnostic = z.infer<typeof diagnosticSchema>

/** Preparation's serial executor supplies the durable mutation receipt and complete command logging. */
export interface SandboxRepairTools {
  /** @param target - current verified PATH. @param observation - current account evidence. @param signal - cancellation.
   * @returns measured repair availability or integrity-checked launcher identity.
   */
  inspect(target: Target, observation: ServerEnvironment, signal: AbortSignal): Promise<SandboxRepairDiagnostic>
  /** @param target - current verified PATH. @param observation - current account evidence.
   * @param command - program-owned foreground mutation under preparation's durable ownership. @param signal - cancellation.
   * @returns configuration result; successful preparation still requires independent verification.
   */
  repair(target: Target, observation: ServerEnvironment, command: (script: string) => Promise<RemoteCommandResult>, signal: AbortSignal): Promise<SandboxRepairDiagnostic>
}

/** Fixed inputs are resolved by the program, never supplied by the model. */
export interface SandboxRepairInput {
  experimentId: ExperimentId
  serverId: ExperimentServerId
  controlRoot?: string
  password?: string
  policy: SandboxRepairPolicy
}

const program = readFileSync(new URL('../scripts/repair-sandbox.py', import.meta.url), 'utf8')

/** Installs a private-PID/proc launcher using only privileges already held by the selected account. */
export class SandboxRepair implements SandboxRepairTools {
  /** @param input - fixed account ownership and probe limits. @param driver - shared SSH operation. */
  constructor(private readonly input: SandboxRepairInput, private readonly driver: { remoteResult: typeof remoteResult }) {}

  private script(mode: 'inspect' | 'repair', target: Target, observation: ServerEnvironment): string | undefined {
    const python = observation.programs.find(value => value.name === 'python3')?.path
    const bwrap = observation.programs.find(value => value.name === 'bwrap')?.path
    if (!python?.startsWith('/') || !bwrap?.startsWith('/')) return undefined
    const request = { version: 1, mode, experimentId: this.input.experimentId, serverId: this.input.serverId,
      controlRoot: this.input.controlRoot ?? posix.join(observation.home, '.local/share/aspera', this.input.serverId),
      adoptLegacyControlRoot: this.input.controlRoot !== undefined,
      bwrap, python, isolationArgs: experimentIsolationArgs(), ...this.input.policy,
      probeTimeoutMs: Math.min(this.input.policy.probeTimeoutMs, Math.max(100, target.toolTimeoutMs - this.input.policy.cleanupTimeoutMs - 1000)) }
    return `${shellQuote(python)} -c ${shellQuote(program)} ${shellQuote(JSON.stringify(request))}`
  }

  private missing(): SandboxRepairDiagnostic {
    return { version: 1, strategy: 'private-proc', state: 'unavailable', reason: 'Install Python 3 and bubblewrap before inspecting the compatibility launcher.',
      stdout: '', stderr: '', exitCode: null, requiresPlatformAction: false }
  }

  private decode(result: RemoteCommandResult): SandboxRepairDiagnostic {
    if (!result.exitConfirmed || result.timedOut || result.cancelled) throw new RemoteCommandError(result)
    const parsed = diagnosticSchema.safeParse((() => {
      try { return JSON.parse(result.stdout) } catch (error) { if (!(error instanceof SyntaxError)) throw error; return undefined }
    })())
    if (!parsed.success) return { version: 1, strategy: 'private-proc', state: 'unknown',
      reason: 'Compatibility inspection did not return a complete program receipt; inspect its preserved output.',
      stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, requiresPlatformAction: false }
    if (result.exitCode !== 0 && (parsed.data.state === 'available' || parsed.data.state === 'configured')) {
      return { ...parsed.data, state: 'unknown', reason: 'The compatibility command failed after producing its result.', exitCode: result.exitCode }
    }
    return parsed.data
  }

  /** @param target - current PATH. @param observation - account evidence. @param signal - cancellation.
   * @returns confirmed compatibility probe and launcher integrity evidence.
   */
  async inspect(target: Target, observation: ServerEnvironment, signal: AbortSignal): Promise<SandboxRepairDiagnostic> {
    const script = this.script('inspect', target, observation)
    return script === undefined ? this.missing() : this.decode(await this.driver.remoteResult(target, script, signal, this.input.password))
  }

  /** @param target - current PATH. @param observation - account evidence. @param command - durable serial command executor.
   * @param signal - cancellation. @returns immutable launcher configuration; callers must request verification.
   */
  async repair(target: Target, observation: ServerEnvironment, command: (script: string) => Promise<RemoteCommandResult>, signal: AbortSignal): Promise<SandboxRepairDiagnostic> {
    signal.throwIfAborted()
    const script = this.script('repair', target, observation)
    return script === undefined ? this.missing() : this.decode(await command(script))
  }
}
