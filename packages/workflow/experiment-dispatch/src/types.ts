/** Browser-safe experiment dispatch records. */
import type { ClusterRecord, ClusterServer, ClusterSubmission, ExperimentId, ExperimentServerId } from '@deepseek-ai/dsh-experiment-worker/types'
import type { z } from 'zod'
import type { pinnedTargetSchema } from './deployment-settings.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Saved experiment or server records changed; consumers reload their selection.
     * @mode emit
     * @param change - the registry whose durable records changed.
     */
    'experiment-fleet/changed'(change: { kind: 'servers' | 'experiments' }): void
  }
}

/** SSH account whose password is stored separately from deployment settings. */
export interface ExperimentSshAccount {
  readonly host: string
  readonly username: string
  readonly sshPort: number
  /** Optional profile-owned credential reference; otherwise the account selects its own reference. */
  readonly passwordRef?: string | undefined
}

/** Password presence and writability without exposing its value. */
export interface ExperimentPasswordStatus {
  readonly configured: boolean
  readonly writable: boolean
}

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

export type { ClusterChunk, ClusterFile, ClusterRecord, ClusterServer, ClusterState } from '@deepseek-ai/dsh-experiment-worker/types'

/** Browser goal and explicit joint participants, before request parsing. */
export interface FleetCreateRequest {
  experimentId: string
  objective: string
  serverIds: string[]
  files?: string[]
  uploads?: string[]
}

/** Server form with an unparsed UUID. Password values are accepted separately. */
export type FleetServerInput = Omit<ClusterServer, 'id'> & { id: string }

/** Stable coordinator identity and the complete saved server list. */
export interface FleetRegistry {
  coordinatorId?: ExperimentServerId | undefined
  servers: ClusterServer[]
}

/** Concrete input and execution evidence for one independently dispatched experiment. */
export interface FleetExperiment {
  request: { experimentId: ExperimentId; objective: string; serverIds: ExperimentServerId[]; files: string[]; uploads: string[] }
  coordinator: ClusterServer
  servers: ClusterServer[]
  coordinatorTarget: z.infer<typeof pinnedTargetSchema>
  targets: z.infer<typeof pinnedTargetSchema>[]
  createdAt: number
  state: 'preparing' | 'submitted' | 'failed' | 'cancelled'
  detail?: string | undefined
  sessionId: string
  goalId?: string | undefined
  goalRevision?: number | undefined
  sourceGoal?: { sessionId: string; id: string; revision: number } | undefined
  submission?: ClusterSubmission | undefined
  receipt?: ClusterRecord | undefined
  handoverRecorded: boolean
  latest?: ClusterRecord | undefined
  waitingFor: ExperimentServerId[]
}
