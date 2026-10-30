/** Node-owned public-check requests are claimed once by the local Host and never replay a generation. */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { serviceVerificationSchema, serviceVerificationInputSchema, serviceVerificationResultSchema } from '@aspera/experiments'
import type { ExperimentId, InferenceService, ServiceVerification, ServiceVerificationInput, ServiceVerificationResult, ServiceVerificationId, ServiceVerificationClaimId } from '@aspera/experiments'

/** Public checks retain the exact original service and request identities across reconnects. */
export class ServiceVerifications {
  /** @param root - program-derived experiment directory. @param deploymentId - current fixed release. @param timeoutMs - original request deadline. */
  constructor(private readonly root: (id: ExperimentId) => string, private readonly deploymentId: string, private readonly timeoutMs: number) {}
  private path(id: ExperimentId, operationId: ServiceVerificationId): string {
    return resolve(this.root(id), 'service-verifications-v1', serviceVerificationInputSchema.shape.operationId.parse(operationId) + '.json')
  }
  private async save(value: ServiceVerification): Promise<ServiceVerification> {
    await writeFileAtomic(this.path(value.experimentId, value.input.operationId), JSON.stringify(value) + '\n', { mode: 0o600 }); return value
  }
  /** @param id - owning experiment. @param operationId - original request. @returns a saved operation, without making an HTTP request. */
  read(id: ExperimentId, operationId: ServiceVerificationId): ServiceVerification | undefined {
    const path = this.path(id, operationId)
    if (!existsSync(path)) return undefined
    const value = serviceVerificationSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    if (value.experimentId !== id || value.deploymentId !== this.deploymentId || value.input.operationId !== operationId) throw new Error('Service verification ownership changed')
    return value
  }
  /** @param id - owning experiment. @returns saved requests for Host execution or recovery. */
  list(id: ExperimentId): ServiceVerification[] {
    const root = resolve(this.root(id), 'service-verifications-v1')
    return !existsSync(root) ? [] : readdirSync(root).filter(name => name.endsWith('.json')).map(name => this.read(id, serviceVerificationInputSchema.shape.operationId.parse(name.slice(0, -5)))!)
      .sort((left, right) => left.createdAt - right.createdAt || left.input.operationId.localeCompare(right.input.operationId))
  }
  /** @param id - owning experiment. @param input - Agent-selected test. @param service - verified current service. @returns the original request or its unchanged result. */
  async submit(id: ExperimentId, input: ServiceVerificationInput, service: InferenceService): Promise<ServiceVerification> {
    input = serviceVerificationInputSchema.parse(input)
    if (service.experimentId !== id || service.id !== input.serviceId || service.released || service.state !== 'healthy'
      || service.external === undefined || service.modelName === undefined) throw new Error('Public verification requires an owned healthy published service with model_name')
    const prior = this.read(id, input.operationId)
    if (prior !== undefined) {
      if (JSON.stringify(prior.input) !== JSON.stringify(input) || prior.commandId !== service.commandId || prior.url !== service.external.url
        || prior.modelName !== service.modelName) throw new Error('Service verification operation content changed')
      return prior
    }
    const createdAt = Date.now()
    return this.save(serviceVerificationSchema.parse({ version: 1, experimentId: id, serverId: service.serverId, deploymentId: this.deploymentId,
      input, commandId: service.commandId, modelName: service.modelName, url: service.external.url, createdAt, deadline: createdAt + this.timeoutMs, state: 'requested' }))
  }
  /** @param id - owning experiment. @param operationId - saved test. @param claimId - Host execution identity. @returns a one-time claim; other claimants must not execute it. */
  async claim(id: ExperimentId, operationId: ServiceVerificationId, claimId: ServiceVerificationClaimId): Promise<ServiceVerification> {
    const prior = this.read(id, operationId)
    if (prior === undefined) throw new Error('Service verification request is missing')
    if (prior.state !== 'requested') return prior
    if (prior.deadline <= Date.now()) return this.save({ ...prior, state: 'unknown', result: { state: 'unknown', checks: [], detail: 'Original verification deadline expired before Host claim; no generation was submitted by this operation', finishedAt: Date.now() } })
    return this.save(serviceVerificationSchema.parse({ ...prior, state: 'claimed', claimId }))
  }
  /** @param id - owning experiment. @param operationId - original request. @param claimId - original Host claim. @param result - bounded Host observations. @returns durable terminal observations. */
  async complete(id: ExperimentId, operationId: ServiceVerificationId, claimId: ServiceVerificationClaimId, result: ServiceVerificationResult): Promise<ServiceVerification> {
    result = serviceVerificationResultSchema.parse(result)
    const prior = this.read(id, operationId)
    if (prior === undefined || prior.claimId !== claimId) throw new Error('Service verification belongs to another Host claim')
    if (prior.state !== 'claimed') {
      if (JSON.stringify(prior.result) !== JSON.stringify(result)) throw new Error('Service verification result changed')
      return prior
    }
    const names = result.checks.map(check => check.name)
    if (result.state === 'passed' && (new Set(names).size !== 5 || result.checks.some(check => !check.passed))) throw new Error('Public verification cannot pass without every independent check')
    return this.save({ ...prior, state: result.state, result })
  }
}
