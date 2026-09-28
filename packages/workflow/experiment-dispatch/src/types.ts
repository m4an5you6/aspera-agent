/** Browser-safe experiment dispatch records. */

/** Complete receiver record retained for status and handover presentation. */
export interface ExperimentDispatchRecord {
  readonly submissionId: string
  readonly deploymentId: string
  readonly spec: {
    readonly objective: string
    readonly agentModel?: { readonly provider: string; readonly model: string } | undefined
    readonly trainingModel?: string | undefined
    readonly datasetRefs: string[]
    readonly trainingMethod?: string | undefined
    readonly requiredGpus?: number | undefined
    readonly constraints: string[]
    readonly outputPath: string
  }
  readonly payloadHash: string
  readonly sessionId: string
  readonly goalId?: string | undefined
  readonly goalPhase?: 'active' | 'paused' | 'blocked' | 'complete' | undefined
  readonly artifactPath: string
  readonly workerLogPath: string
  readonly workerLogAvailable?: boolean | undefined
  readonly artifactFiles?: { readonly path: string; readonly sizeBytes: number }[] | undefined
  readonly artifactListTruncated?: boolean | undefined
  readonly state: 'reserved' | 'accepted' | 'complete' | 'blocked' | 'failed' | 'cancelled' | 'interrupted'
  readonly detail?: string | undefined
  readonly createdAt: number
  readonly updatedAt: number
}

/** Saved local identity and complete receiver evidence shown in Web. */
export interface ExperimentDispatchEntry {
  readonly submissionId: string
  readonly sessionId?: string
  readonly goalId?: string
  readonly goalRevision?: number
  readonly host?: string
  readonly handover?: '本机派发完成，远端实验已接管'
  readonly receipt?: ExperimentDispatchRecord
  readonly latest?: ExperimentDispatchRecord
}
