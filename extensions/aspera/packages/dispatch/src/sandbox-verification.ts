/** Actionable sandbox failures returned to the original preparation Session. */
import type { RemoteCommandResult } from './transport.ts'

/** Independent checks performed with the complete experiment launch. */
export type SandboxVerificationStage = 'sandbox-launch' | 'workspace-isolation' | 'credential-isolation' | 'gpu-access'

/** Program-observed failure, including the unchanged remote command output. */
export interface SandboxVerificationDiagnostic {
  readonly stage: SandboxVerificationStage
  readonly backendPath: string
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly requiresPlatformAction: boolean
  readonly requiredAction: string
}

/** A failed isolation check cannot be replaced by an Agent's completion claim. */
export class SandboxVerificationError extends Error {
  readonly diagnostic: SandboxVerificationDiagnostic

  /**
   * Record a confirmed probe failure without including account credentials.
   * @param stage - independent check that failed.
   * @param backendPath - discovered bubblewrap executable.
   * @param result - preserved command streams and exit code.
   */
  constructor(stage: SandboxVerificationStage, backendPath: string,
    result: Pick<RemoteCommandResult, 'exitCode' | 'stdout' | 'stderr'>) {
    const requiresPlatformAction = stage === 'sandbox-launch' && /Operation not permitted|Permission denied|No permissions to create/i.test(result.stderr)
    const requiredAction = requiresPlatformAction
      ? 'Verify container permissions for user, PID, IPC and UTS namespaces and mounting /proc. Repair compatible user-space configuration within the selected account permissions, then rerun verification. If the container still denies these operations, request the cloud platform or host administrator to provide them. Keep every isolation flag.'
      : 'Inspect the preserved command output, repair the selected account environment and rerun verification with the same isolation and device grants.'
    super(`Sandbox verification failed at ${stage} (exit ${result.exitCode}): ${result.stderr || result.stdout}`)
    this.diagnostic = { stage, backendPath, ...result, requiresPlatformAction, requiredAction }
  }
}
