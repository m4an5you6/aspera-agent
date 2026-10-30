/** Small saved-record fixtures retain real service identities without a node or credentials. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { fromAny } from '@total-typescript/shoehorn'
import type { FleetExperiment } from '@aspera/dispatch/types'
import type { InferenceService } from '@aspera/experiments/types'

/** @param patch - service differences. @returns a registered service suitable for client projections. */
export function inferenceService(patch: Partial<InferenceService> = {}): InferenceService {
  return { id: brandString<InferenceService['id']>('service'), experimentId: brandString<InferenceService['experimentId']>('child'),
    serverId: brandString<InferenceService['serverId']>('node'), commandId: 'command', command: 'python -m server', modelPath: 'checkpoints/230',
    port: 18000, healthPath: '/health', state: 'healthy', createdAt: 10, updatedAt: 20, released: false, modelName: 'qwen35-9b-lora',
    external: { url: 'https://inference.example.test/base', port: 3000, state: 'reachable', checkedAt: 18 }, ...patch }
}

/** @param id - task owner. @param services - direct service records. @param patch - recovery or error metadata. @returns the record fields used by service projections. */
export function inferenceRow(id: string, services: InferenceService[], patch: Partial<FleetExperiment> = {}): FleetExperiment {
  return fromAny<FleetExperiment, object>({ request: { experimentId: id, name: id, objective: id, serverIds: ['node'] },
    servers: [{ id: 'node', name: '4090-1' }], latest: { revision: 1, services }, createdAt: 1, ...patch })
}
