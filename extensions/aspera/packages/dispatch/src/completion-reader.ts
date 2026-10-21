/** Retrospective verification reads only original node files and writes independent review receipts. */
import { posix } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { completionEvidenceProgram } from '@aspera/runtime'
import { completionSourceSchema, historicalEnvironmentSchema, serverIdSchema } from '@aspera/experiments'
import type { CompletionSourceInput, CompletionSupplement, CompletionReview, CompletionAssessment, ExperimentServerId } from '@aspera/experiments'
import type { FleetExperiment } from './types.ts'
import type { FleetDriver } from './fleet.ts'
import type { ArchiveConnection, RunArchiveReader, RunArchivePolicy } from './run-archive-reader.ts'
import type { CompletionReviewSnapshot } from './completion-review.ts'
import { shellQuote } from './transport.ts'

const observedFileSchema = z.object({ sha256: z.string(), generation: z.string(), bytes: z.number(), text: z.string(), tail: z.string(), truncated: z.boolean() })
/** Program-selected scoped operations retain compatibility with offline protocol-4 releases. */
export class CompletionReader {
  private readonly program = completionEvidenceProgram()
  /** @param driver - private transport. @param connection - original account resolver. @param archive - authenticated/fallback source provider. @param policy - existing bounded read policy. */
  constructor(private readonly driver: Pick<FleetDriver, 'remote'>,
    private readonly connection: (record: FleetExperiment, serverId: ExperimentServerId) => Promise<ArchiveConnection>,
    private readonly archive: Pick<RunArchiveReader, 'catalog'>, private readonly policy: RunArchivePolicy) {}

  private async run(record: FleetExperiment, serverId: ExperimentServerId,
    operation: 'inspectCompletionIdentity' | 'inspectCompletionFile' | 'inspectCompletionSession' | 'inspectHistoricalEnvironment' | 'saveCompletionReview' | 'saveCompletionAssessment' | 'inspectExperimentFinalization' | 'listCompletionFiles',
    input: object, signal: AbortSignal): Promise<unknown> {
    const submission = record.submission
    if (submission?.protocol !== 4) throw new Error('Completion review requires a pinned protocol-4 submission')
    const node = submission.nodes.find(node => node.server.id === serverId)
    if (node === undefined) throw new Error('Completion evidence node is outside the original submission')
    const server = node.server
    const runRoot = server.storagePlacement?.runRoot ?? posix.join(server.remoteRoot!, 'runs', record.request.experimentId)
    const payload = Buffer.from(JSON.stringify({ experimentId: record.request.experimentId, serverId, runRoot,
      controlRoot: server.remoteRoot, releaseRoot: server.storagePlacement?.releaseRoot ?? posix.join(server.remoteRoot!, 'releases', record.submission!.deploymentId),
      deploymentId: record.submission!.deploymentId, node, maxBytes: this.policy.archiveCatalogBytes,
      ...input })).toString('base64')
    const program = `${this.program}\nconsole.log(JSON.stringify(${operation}(JSON.parse(Buffer.from('${payload}', 'base64').toString('utf8')))))`
    const connection = await this.connection(record, serverId)
    return JSON.parse(await this.driver.remote({ ...connection.target, toolTimeoutMs: this.policy.archiveRequestTimeoutMs },
      `node --input-type=module -e ${shellQuote(program)}`, AbortSignal.any([signal, AbortSignal.timeout(this.policy.archiveRequestTimeoutMs)]), connection.password))
  }
  /** @param record - pinned task. @param signal - read lifetime. @returns fresh original result, commands, plan reports and completed-Goal evidence. */
  async snapshot(record: FleetExperiment, signal: AbortSignal): Promise<CompletionReviewSnapshot> {
    if (record.submission?.protocol !== 4) throw new Error('Historical review requires an original protocol-4 submission')
    const commands: CompletionReviewSnapshot['commands'] = [], files: NonNullable<CompletionReviewSnapshot['files']> = []
    let coordinator: Awaited<ReturnType<RunArchiveReader['catalog']>>['catalog'] | undefined
    for (const node of record.submission.nodes) {
      await this.run(record, node.server.id, 'inspectCompletionIdentity', {}, signal)
      const { catalog } = await this.archive.catalog(record, node.server.id, undefined, signal)
      if (catalog.truncated) throw new Error('Original command or file catalog is incomplete; increase the configured read budget')
      commands.push(...catalog.processes)
      const list = z.object({ files: z.array(z.object({ serverId: serverIdSchema, path: z.string(), bytes: z.number() })), truncated: z.boolean() })
        .parse(await this.run(record, node.server.id, 'listCompletionFiles', { maxEntries: this.policy.archiveCatalogEntries,
          excludeDirectories: this.policy.archiveExcludeDirectories }, signal))
      files.push(...list.files)
      if (node.server.id === record.coordinator.id) coordinator = catalog
    }
    const original = coordinator?.record
    if (original === undefined || JSON.stringify(original.submission) !== JSON.stringify(record.submission)
      || original.payloadHash !== createHash('sha256').update(JSON.stringify(record.submission)).digest('hex')) throw new Error('Original coordinator result and submission digest cannot be confirmed')
    const trace = z.object({ sessionId: z.string(), finished: z.boolean(), finishStatus: z.enum(['completed', 'blocked']).optional() }).parse(await this.run(record, record.coordinator.id, 'inspectCompletionSession', { sessionId: original.sessionId }, signal))
    if (trace.sessionId !== original.sessionId) throw new Error('Original completion proof belongs to another Session')
    return { record: original, ...(coordinator?.progress === undefined ? {} : { progress: coordinator.progress }), commands, files,
      finished: trace.finished, finishStatus: trace.finishStatus }
  }
  /** @param record - original task. @param input - relative source. @param signal - reader lifetime. @returns independently hashed current source. */
  async source(record: FleetExperiment, input: CompletionSourceInput, signal: AbortSignal) {
    const maxBytes = ['parameters', 'evaluation', 'training', 'inference'].includes(input.purpose) ? this.policy.archiveCatalogBytes : this.policy.archiveReadBytes
    const observed = observedFileSchema.parse(await this.run(record, input.serverId, 'inspectCompletionFile', { path: input.path, maxBytes, metadataOnly: input.purpose === 'artifact' }, signal))
    return { ...completionSourceSchema.parse({ ...input, sha256: observed.sha256, generation: observed.generation, bytes: observed.bytes }),
      text: observed.text, tail: observed.tail, truncated: observed.truncated }
  }
  /** @param record - original task. @param entry - actual environment and framework. @param signal - reader lifetime. @returns a metadata-only historical record. */
  async environment(record: FleetExperiment, entry: CompletionSupplement['entry'], signal: AbortSignal) {
    return historicalEnvironmentSchema.parse(await this.run(record, entry.serverId, 'inspectHistoricalEnvironment',
      { environment: entry.environment, framework: entry.framework, version: entry.version }, signal))
  }
  /** @param record - original result. @param review - program-verified supplementary receipt. @param signal - write lifetime. @returns after the independent remote receipt is durable. */
  async commit(record: FleetExperiment, review: CompletionReview, signal: AbortSignal, assessment?: CompletionAssessment): Promise<void> {
    if (assessment !== undefined) z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await this.run(record, record.coordinator.id, 'saveCompletionAssessment', { assessment }, signal))
    z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await this.run(record, record.coordinator.id, 'saveCompletionReview', { receipt: review }, signal))
  }
  /** @param record - pinned experiment. @param signal - read lifetime. @returns bounded program journals, with no training or repair actions. */
  finalization(record: FleetExperiment, signal: AbortSignal): Promise<unknown> {
    return this.run(record, record.coordinator.id, 'inspectExperimentFinalization', { maxEntries: this.policy.archiveCatalogEntries }, signal)
  }
}
