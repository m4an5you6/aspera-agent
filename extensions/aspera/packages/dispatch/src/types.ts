/** Browser-safe experiment dispatch records. */
import type { ClusterRecord, ClusterSubmission, ExperimentId, ExperimentServerId, ExperimentBudget, ServerSettings, ServerInventory, StoragePlacement, InferenceMapping } from '@aspera/experiments/types'
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

export type { ClusterChunk, ClusterFile, ClusterRecord, ClusterServer, ClusterState, ServerSettings, ServerInventory, ServerProbe, StoragePlacement } from '@aspera/experiments/types'

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
export type FleetServerInput = Omit<ServerSettings, 'id' | 'storagePlacement'> & { id: string }

/** Stable coordinator identity and the complete saved server list. */
export interface FleetRegistry {
  coordinatorId?: ExperimentServerId | undefined
  servers: ServerSettings[]
  probes?: Record<string, { gpuInfo: string; allocations: string[]; inventory: ServerInventory }>
}

/** Concrete input and execution evidence for one independently dispatched experiment. */
export interface FleetExperiment {
  request: { experimentId: ExperimentId; objective: string; serverIds: ExperimentServerId[]; files: string[]; uploads: { name: string; size: number }[]; mode: 'semi' | 'automatic'; budget?: ExperimentBudget }
  coordinator: ServerSettings
  servers: ServerSettings[]
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
  preparation?: { protocol: 3; stage: 'inspecting' | 'selecting-storage' | 'preparing-storage' | 'deploying' | 'checking-network' | 'transferring' | 'submitting';
    inventories: { serverId: ExperimentServerId; inventory: ServerInventory }[]; placements: StoragePlacement[];
    inputs?: { name: string; sha256: string }[] }
}

/** Snapshot delivered over the reconnecting Remote stream. */
export interface FleetSnapshot { registry: FleetRegistry; experiments: FleetExperiment[] }

/** Immutable deployment policy; all credential fields are references. */
export interface PinnedDeployment {
  host: string; sshPort: number; remotePort: number; username?: string; authMode?: 'password' | 'key';
  passwordRef?: string; knownHostsFile?: string; remoteRoot?: string; storagePlacement?: StoragePlacement; localRepo: string; identityFile?: string;
  dataRoots: string[]; allowedSystemPackages: string[]; tokenRef: string; agentCredentialRefs: string[];
  toolTimeoutMs: number; controlPollIntervalMs: number;
  minimumFreeBytes?: number
  inferenceMapping?: InferenceMapping
}
