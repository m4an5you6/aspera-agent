/** Browser-safe experiment dispatch records. */
import type { ClusterRecord, ClusterServer, ClusterSubmission, ExperimentId, ExperimentServerId, ExperimentBudget } from '@aspera/experiments/types'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'

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

export type { ClusterChunk, ClusterFile, ClusterRecord, ClusterServer, ClusterState } from '@aspera/experiments/types'

/** Browser goal and explicit joint participants, before request parsing. */
export interface FleetCreateRequest {
  experimentId: string
  objective: string
  serverIds: string[]
  files?: string[]
  uploads?: { name: string; size: number }[]
  mode: 'semi' | 'automatic'
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
  request: { experimentId: ExperimentId; objective: string; serverIds: ExperimentServerId[]; files: string[]; uploads: { name: string; size: number }[]; mode: 'semi' | 'automatic'; budget?: ExperimentBudget }
  coordinator: ClusterServer
  servers: ClusterServer[]
  coordinatorTarget: PinnedDeployment
  targets: PinnedDeployment[]
  createdAt: number
  agentModel: ModelSelection
  state: 'staging' | 'preparing' | 'submitted' | 'failed' | 'cancelled'
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

/** Snapshot delivered over the reconnecting Remote stream. */
export interface FleetSnapshot { registry: FleetRegistry; experiments: FleetExperiment[] }

/** Immutable deployment policy; all credential fields are references. */
export interface PinnedDeployment {
  host: string; sshPort: number; remotePort: number; username?: string; authMode?: 'password' | 'key';
  passwordRef?: string; knownHostsFile?: string; remoteRoot: string; localRepo: string; identityFile?: string;
  dataRoots: string[]; allowedSystemPackages: string[]; tokenRef: string; agentCredentialRefs: string[];
  toolTimeoutMs: number; controlPollIntervalMs: number;
}
