/** Browser-safe experiment dispatch records. */
import type { ClusterRecord, ClusterSubmission, ExperimentId, ExperimentServerId, ExperimentBudget, ServerSettings, ServerInventory, StoragePlacement, InferenceMapping } from '@aspera/experiments/types'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ExperimentModels, ExperimentModelSnapshots } from '@aspera/experiments/types'
import type { ServerEnvironment, ServerProbe } from '@aspera/experiments/types'

/** Durable command ownership survives local cancellation and restart. */
export interface PreparationCommand { directory: string }
/** Per-node progress accompanies the detailed preparation Session. */
export interface EnvironmentProgress {
  serverId: ExperimentServerId
  phase: 'inspecting-environment' | 'configuring-environment' | 'repairing-environment' | 'verifying-environment' | 'environment-ready'
  observation?: ServerEnvironment
  pendingCommand?: PreparationCommand
  detail?: string
}

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
  name?: string
  models?: ExperimentModels
  objective: string
  serverIds: string[]
  coordinatorId: string
  files?: string[]
  uploads?: { name: string; size: number }[]
  mode: 'semi' | 'automatic'
}

/** Server form with an unparsed UUID. Password values are accepted separately. */
export type FleetServerInput = Omit<ServerSettings, 'id' | 'storagePlacement'> & { id: string }

/** Peer server registrations; coordinatorId is retained only when reading older registries. */
export interface FleetRegistry {
  coordinatorId?: ExperimentServerId | undefined
  servers: ServerSettings[]
  probes?: Record<string, ServerProbe>
  checks?: Record<string, ServerConnectionCheck>
}

/** Latest check and separately dated successful hardware observations. */
export interface ServerConnectionCheck {
  status: 'unchecked' | 'checking' | 'passed' | 'failed' | 'interrupted'
  configuration: string
  startedAt?: number
  checkedAt?: number
  error?: string
  result?: ServerProbe
  lastSuccess?: { checkedAt: number; result: ServerProbe }
  gpu?: 'passed' | 'unavailable'
  control?: 'passed' | 'unavailable'
}

/** One confirmed deletion request, independent of experiment and server identities. */
export type DeletionOperationId = Branded<'AsperaDeletionOperationId'>

/** Node-specific progress for an explicitly requested experiment deletion. */
export interface ExperimentDeletion {
  experimentId: ExperimentId
  operationId: DeletionOperationId
  cleanupRemote: boolean
  started: boolean
  state: 'deleting' | 'failed' | 'deleted'
  updatedAt: number
  nodes: { serverId: ExperimentServerId; path: string; state: 'pending' | 'cleaned'; detail?: string }[]
  detail?: string
}

/** Eligibility and exact owned locations shown before confirmation. */
export interface ExperimentDeletionPreview {
  experimentId: ExperimentId
  name: string
  eligible: boolean
  reason?: 'active' | 'cleanup-unconfirmed'
  cleanupAvailable: boolean
  /** Local records can be removed independently of remote cleanup. */
  recordDeletionAvailable: boolean
  nodes: { serverId: ExperimentServerId; name: string; path: string }[]
}

/** One confirmed batch operation; the same identity cannot change its cleanup policy. */
export interface DeleteExperimentsRequest { operationId: string; experimentIds: string[]; cleanupRemote: boolean; allowUnconfirmed?: boolean }

/** Local configuration deletion retains every linked experiment and its pinned destination. */
export interface ServerDeletionPreview {
  serverId: ExperimentServerId
  linkedExperiments: { experimentId: ExperimentId; name: string; unfinished: boolean }[]
  unconfirmedExperimentIds: ExperimentId[]
}

/** Deleted experiments may still own remote resources; these notices contain no credentials. */
export interface UnconfirmedWorkNotice { experimentId: ExperimentId; name: string; serverIds: ExperimentServerId[] }

/** Minimal durable identity retained after removing management records. */
export interface DeletedExperiment {
  experimentId: ExperimentId
  requestHash: string
  deletedAt: number
  sourceGoal?: { sessionId: string; id: string; revision: number }
}

/** Concrete input and execution evidence for one independently dispatched experiment. */
export interface FleetExperiment {
  request: { experimentId: ExperimentId; objective: string; serverIds: ExperimentServerId[]; coordinatorId?: ExperimentServerId; files: string[]; uploads: { name: string; size: number }[]; mode: 'semi' | 'automatic'; budget?: ExperimentBudget; name?: string; models?: ExperimentModels }
  coordinator: ServerSettings
  servers: ServerSettings[]
  coordinatorTarget: PinnedDeployment
  targets: PinnedDeployment[]
  createdAt: number
  agentModel: ModelSelection
  models?: ExperimentModelSnapshots
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
  preparation?: { protocol: 3 | 4; stage: 'inspecting' | 'selecting-storage' | 'preparing-storage' | 'deploying' | 'checking-network' | 'transferring' | 'submitting' | EnvironmentProgress['phase'];
    inventories: { serverId: ExperimentServerId; inventory: ServerInventory }[]; placements: StoragePlacement[];
    environments?: EnvironmentProgress[]
    inputs?: { name: string; sha256: string }[] }
}

/** Snapshot delivered over the reconnecting Remote stream. */
export type { InstallationPolicy, InstallationProgress, InstallationRound } from './installation-model.ts'

/** An explicit retry keeps experiment identity and starts a distinct recovery budget. */
export interface PreparationRetryResult { record: FleetExperiment; installations: import('./installation-model.ts').InstallationProgress[] }

/** Snapshot delivered over the reconnecting Remote stream. */
export interface FleetSnapshot { registry: FleetRegistry; experiments: FleetExperiment[]; deletedIds: ExperimentId[]; deletions: ExperimentDeletion[];
  installations: import('./installation-model.ts').InstallationProgress[];
  removedServerIds: ExperimentServerId[]; unconfirmedWork: UnconfirmedWorkNotice[] }

/** Immutable deployment policy; all credential fields are references. */
export interface PinnedDeployment {
  host: string; sshPort: number; remotePort: number; username?: string; authMode?: 'password' | 'key';
  passwordRef?: string; knownHostsFile?: string; remoteRoot?: string; storagePlacement?: StoragePlacement; localRepo: string; identityFile?: string;
  dataRoots: string[]; tokenRef: string; agentCredentialRefs: string[];
  pathEntries?: string[]
  preparationOutputChars: number
  toolTimeoutMs: number; controlPollIntervalMs: number;
  minimumFreeBytes?: number
  inferenceMapping?: InferenceMapping
}
export type { ErrorNoticeScope } from './error-notices.ts'
