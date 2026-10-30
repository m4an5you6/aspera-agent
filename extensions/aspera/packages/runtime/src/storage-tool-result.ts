/** Bounded storage and environment-operation results retain complete private snapshots for detail pages. */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { z } from 'zod'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { environmentStorageNodeSchema, environmentInspectionResponseSchema, environmentOperationStatusSchema, environmentOperationSchema, storageObjectIdSchema } from '@aspera/experiments'
import type { ExperimentId, ExperimentServerId, EnvironmentOperation } from '@aspera/experiments'
import { readEnvironmentInspection } from './environment-inspection.ts'

const policy = z.object({ maxBytes: z.number().int().min(4096).max(65536).default(8192) })
const sections = ['legacy', 'materials', 'environments', 'operations', 'launches', 'repairPlans', 'assets', 'materialOperations', 'materialCandidates', 'historicalEnvironments', 'diagnostics'] as const
const operationSchema = z.union([environmentOperationStatusSchema, environmentOperationSchema])
const observationSchema = z.union([environmentStorageNodeSchema, environmentInspectionResponseSchema, operationSchema])
type Inspection = z.infer<typeof observationSchema>
function entries(value: Inspection, section: typeof sections[number]): readonly unknown[] {
  if ('operationId' in value) {
    const receipt = 'processState' in value ? value.operation : value
    if (section === 'operations') return [value]
    if (section === 'launches') return 'launch' in value && value.launch !== undefined ? [value.launch] : []
    if (section === 'repairPlans') return receipt?.repairPlans ?? []
    if (section === 'diagnostics') return receipt?.diagnostics ?? []
    return []
  }
  if ('version' in value) {
    if (section === 'operations' || section === 'launches') return value[section]
    if (section === 'diagnostics') return [...(value.error === undefined ? [] : [value.error]), ...(value.storage === undefined ? [] : entries(value.storage, section))]
    return value.storage === undefined ? [] : entries(value.storage, section)
  }
  switch (section) {
    case 'materialCandidates': return value.catalog?.materialCandidates ?? []
    case 'historicalEnvironments': return value.catalog?.historicalEnvironments ?? []
    case 'diagnostics': return [...(value.error === undefined ? [] : [value.error]), ...(value.diagnostics ?? []), ...(value.catalog?.diagnostics ?? []), ...(value.storagePlan?.coverage?.unresolved ?? [])]
    case 'launches': return value.operations?.flatMap(row => row.launch === undefined ? [] : [row.launch]) ?? []
    default: return value[section] ?? []
  }
}

function operationSummary(value: EnvironmentOperation | undefined) {
  if (value === undefined) return undefined
  const environment = value.environment, borrowed = value.borrowed
  return { operationId: value.operationId, environmentId: value.environmentId, action: value.action, state: value.state,
    startedAt: value.startedAt, updatedAt: value.updatedAt, exitConfirmed: value.exitConfirmed, exitCode: value.exitCode,
    diagnosticCount: value.diagnostics?.length, repairPlanCount: value.repairPlans?.length,
    cleanup: value.cleanup === undefined ? undefined : { state: value.cleanup.state, generation: value.cleanup.generation,
      pathCount: value.cleanup.paths.length, packageCount: value.cleanup.packages.length, updatedAt: value.cleanup.updatedAt },
    recovery: value.recovery === undefined ? undefined : { state: value.recovery.state, createdAt: value.recovery.createdAt,
      updatedAt: value.recovery.updatedAt },
    failure: value.failure === undefined ? undefined : { code: value.failure.code, previousOperationId: value.failure.previousOperationId,
      createdAt: value.failure.createdAt },
    preflight: value.preflight === undefined ? undefined : { status: value.preflight.status, checkedAt: value.preflight.checkedAt },
    environment: environment === undefined ? undefined : { environmentId: environment.environmentId, generation: environment.generation,
      state: environment.state, directory: environment.directory, python: environment.python, pythonVersion: environment.pythonVersion,
      pythonAbi: environment.pythonAbi, packageCount: environment.packages.length, requirementCount: environment.requirements.length,
      verification: environment.verification === undefined ? undefined : { verified: environment.verification.verified,
        checkedAt: environment.verification.checkedAt, userSiteEnabled: environment.verification.userSiteEnabled,
        dependenciesValid: environment.verification.dependenciesValid, cuda: environment.verification.cuda,
        moduleCount: environment.verification.modules.length },
      sharing: { hardlinkBytes: environment.sharing.hardlinkBytes, cloneBytes: environment.sharing.cloneBytes,
        copyBytes: environment.sharing.copyBytes, addedBytes: environment.sharing.addedBytes } },
    borrowed: borrowed === undefined ? undefined : { directory: borrowed.directory, python: borrowed.python,
      sourceExperimentId: borrowed.sourceExperimentId, verified: borrowed.verified, checkedAt: borrowed.checkedAt, cuda: borrowed.cuda } }
}
function checkSnapshotPath(runRoot: string, path: string): void {
  const root = resolve(runRoot)
  for (let current = path;; current = dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('Storage snapshot contains a symbolic link') }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    if (current === root) return
    if (dirname(current) === current) throw new Error('Storage snapshot escaped its private experiment directory')
  }
}
/** Detail reads name a saved observation, never a model-provided filesystem path. */
export const storageToolPageSchema = z.object({ snapshotId: storageObjectIdSchema, section: z.enum(sections),
  offset: z.number().int().nonnegative().default(0), path: z.array(z.union([z.string().max(4096), z.number().int().nonnegative()])).max(12).optional() }).strict()

/**
 * Save or page an allocation-owned observation using the configured model-output budget.
 * @param options - private run directory, authenticated node, raw observation or saved page, and output bound.
 * @returns a complete small operation, or bounded summary/detail pages retaining original times, exit facts and unmodified private data.
 */
export async function storageToolResult(options: {
  runRoot: string; experimentId: ExperimentId; serverId: ExperimentServerId; value?: unknown;
  page?: z.infer<typeof storageToolPageSchema>; maxBytes?: number; archiveServerId?: ExperimentServerId;
}): Promise<object> {
  const { maxBytes } = policy.parse({ maxBytes: options.maxBytes })
  const directory = resolve(options.runRoot, 'storage-tool-observations-v1', options.serverId)
  const operation = options.page === undefined ? operationSchema.safeParse(options.value) : undefined
  const flat = options.page === undefined ? environmentStorageNodeSchema.safeParse(options.value) : undefined
  const raw = options.page === undefined ? operation?.success ? operation.data : flat?.success ? flat.data : readEnvironmentInspection(options.value, options.experimentId, options.serverId) : undefined
  if (raw !== undefined && 'operationId' in raw) {
    if (raw.experimentId !== options.experimentId || raw.serverId !== options.serverId) throw new Error('Environment operation belongs to another allocation')
    if (Buffer.byteLength(JSON.stringify(raw)) <= maxBytes) return raw
  }
  const snapshotId = options.page?.snapshotId ?? createHash('sha256').update(JSON.stringify(raw)).digest('hex')
  const path = resolve(directory, snapshotId + '.json')
  checkSnapshotPath(options.runRoot, path)
  let value = raw
  if (value !== undefined) {
    if (value.serverId !== options.serverId) throw new Error('Storage observation belongs to another server')
    if (!existsSync(path)) await writeFileAtomic(path, JSON.stringify({ version: 1, experimentId: options.experimentId,
      serverId: options.archiveServerId ?? options.serverId, nodeId: options.serverId, value }), { mode: 0o600 })
  } else {
    if (lstatSync(path).isSymbolicLink()) throw new Error('Storage detail snapshot contains a symbolic link')
    const saved = z.object({ version: z.literal(1), experimentId: z.string(), serverId: z.string(), nodeId: z.string(), value: observationSchema })
      .parse(JSON.parse(readFileSync(path, 'utf8')))
    if (saved.experimentId !== options.experimentId || saved.serverId !== (options.archiveServerId ?? options.serverId) || saved.nodeId !== options.serverId) throw new Error('Storage detail snapshot belongs to another allocation')
    value = saved.value
  }
  if (options.page !== undefined) {
    const page = options.page
    let selected: unknown = entries(value, page.section)
    for (const key of page.path ?? []) {
      if (Array.isArray(selected)) {
        if (typeof key !== 'number' || key >= selected.length) throw new Error('Storage detail array cursor differs')
        selected = selected[key]
      } else {
        const record = z.record(z.string(), z.unknown()).parse(selected)
        const field = typeof key === 'number' ? Object.keys(record)[key] : key
        if (field === undefined || !Object.hasOwn(record, field)) throw new Error('Storage detail field cursor differs')
        selected = record[field]
      }
    }
    if (typeof selected === 'string') {
      const size = Math.max(1, Math.floor(maxBytes / 12))
      let text = selected.slice(page.offset, page.offset + size)
      const last = text.charCodeAt(text.length - 1)
      if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1)
      const nextOffset = page.offset + text.length
      return { snapshotId, checkedAt: 'checkedAt' in value ? value.checkedAt : value.updatedAt, text, total: selected.length,
        ...(nextOffset < selected.length ? { next: { ...page, offset: nextOffset } } : {}) }
    }
    if (selected === null || typeof selected === 'number' || typeof selected === 'boolean') return { snapshotId, checkedAt: 'checkedAt' in value ? value.checkedAt : value.updatedAt, value: selected }
    if (!Array.isArray(selected)) {
      const record = z.record(z.string(), z.unknown()).parse(selected)
      const keys = Object.keys(record)
      const fields: { key: string; keyTruncated: boolean; page: z.infer<typeof storageToolPageSchema>; value?: unknown }[] = []
      let nextOffset = page.offset
      while (nextOffset < keys.length) {
        const key = keys[nextOffset]!, label = key.slice(0, Math.floor(maxBytes / 24))
        let item: typeof fields[number] = { key: label, keyTruncated: key !== label, page: { ...page, offset: 0, path: [...(page.path ?? []), nextOffset] } }
        const fieldValue = record[key]
        if (fieldValue === null || typeof fieldValue === 'boolean' || typeof fieldValue === 'number'
          || typeof fieldValue === 'string' && fieldValue.length <= maxBytes / 2) {
          const inline = { ...item, value: fieldValue }
          if (Buffer.byteLength(JSON.stringify([...fields, inline])) <= maxBytes / 2) item = inline
        }
        if (Buffer.byteLength(JSON.stringify([...fields, item])) > maxBytes / 2) break
        fields.push(item); nextOffset++
      }
      return { snapshotId, checkedAt: 'checkedAt' in value ? value.checkedAt : value.updatedAt, fields,
        ...(nextOffset < keys.length ? { next: { ...page, offset: nextOffset } } : {}) }
    }
    const values: readonly unknown[] = selected
    const rows: unknown[] = []
    let nextOffset = page.offset
    while (nextOffset < values.length) {
      const item = values[nextOffset]!
      if (Buffer.byteLength(JSON.stringify([...rows, item])) > maxBytes / 2) break
      rows.push(item); nextOffset++
    }
    if (nextOffset === page.offset && nextOffset < values.length) return { snapshotId, checkedAt: 'checkedAt' in value ? value.checkedAt : value.updatedAt,
      rowIndex: nextOffset, detail: { ...page, offset: 0, path: [...(page.path ?? []), nextOffset] },
      ...(nextOffset + 1 < values.length ? { next: { ...page, offset: nextOffset + 1 } } : {}) }
    return { snapshotId, checkedAt: 'checkedAt' in value ? value.checkedAt : value.updatedAt, section: page.section, rows, total: values.length,
      ...(nextOffset < values.length ? { next: { ...page, offset: nextOffset } } : {}) }
  }
  if ('operationId' in value) {
    const receipt = 'processState' in value ? value.operation : value
    const details = { snapshotId, section: 'operations' as const, offset: 0, path: [0] }
    const facts = { snapshotId, experimentId: value.experimentId, serverId: value.serverId, operationId: value.operationId,
      state: value.state, checkedAt: 'checkedAt' in value ? value.checkedAt : value.updatedAt,
      ...('processState' in value ? { processState: value.processState, admissionReleased: value.admissionReleased, elapsedMs: value.elapsedMs }
        : { exitConfirmed: value.exitConfirmed, exitCode: value.exitCode }),
      details, next: 'Read complete saved operation fields with inspect_experiment_environment details_json; preserve the returned page identity.' }
    const summary = { ...facts, detail: value.detail !== undefined && Buffer.byteLength(value.detail) < maxBytes / 4 ? value.detail : undefined,
      ...('processState' in value ? { operation: operationSummary(receipt) } : operationSummary(receipt)),
      ...('runtime' in value && value.runtime !== undefined ? { runtime: { startedAt: value.runtime.startedAt,
        deadline: value.runtime.deadline, stopReason: value.runtime.stopReason, exitConfirmed: value.runtime.exitConfirmed,
        exitCode: value.runtime.exitCode, admissionReleased: value.runtime.admissionReleased, updatedAt: value.runtime.updatedAt } } : {}),
      ...('launch' in value && value.launch !== undefined ? { launch: { state: value.launch.state,
        createdAt: value.launch.createdAt, updatedAt: value.launch.updatedAt } } : {}),
      ...('reusePlan' in value && value.reusePlan !== undefined ? { reusePlan: { stage: value.reusePlan.stage,
        downloadBytes: value.reusePlan.downloadBytes, reusedBytes: value.reusePlan.reusedBytes, addedBytes: value.reusePlan.addedBytes,
        estimatedPeakBytes: value.reusePlan.estimatedPeakBytes, packageCount: value.reusePlan.packages.length, updatedAt: value.reusePlan.updatedAt } } : {}) }
    return Buffer.byteLength(JSON.stringify(summary)) <= maxBytes ? summary : facts
  }
  const observation = value
  const sectionPages = Object.fromEntries(sections.map(section => [section, { total: entries(observation, section).length,
    page: { snapshotId, section, offset: 0 } }]))
  const wrapped = 'version' in value ? value : undefined
  const storage = 'version' in value ? value.storage : value
  if (storage === undefined) return { snapshotId, serverId: value.serverId, checkedAt: value.checkedAt,
    complete: false, error: wrapped?.error?.slice(0, Math.floor(maxBytes / 8)), sections: sectionPages,
    next: 'Read saved diagnostic and process pages for the complete original error; unavailable storage values remain unknown.' }
  value = storage
  const summary = { snapshotId, serverId: value.serverId, name: value.name, checkedAt: value.checkedAt, source: value.source,
    availableBytes: value.availableBytes, capacityBytes: value.capacityBytes, sharedBytes: value.sharedBytes,
    reclaimableBytes: value.reclaimableBytes, complete: value.complete, error: wrapped?.error ?? value.error,
    storagePlan: value.storagePlan === undefined ? undefined : { state: value.storagePlan.state, operationId: value.storagePlan.operationId,
      coverage: value.storagePlan.coverage, mode: value.storagePlan.mode, policyRevision: value.storagePlan.policyRevision,
      capacityBasis: value.storagePlan.capacityBasis, reuse: value.storagePlan.reuse, volumes: value.storagePlan.volumes },
    catalog: value.catalog === undefined ? undefined : { complete: value.catalog.complete, cursor: value.catalog.cursor,
      entriesScanned: value.catalog.entriesScanned, roots: value.catalog.roots,
      materialCandidates: value.catalog.materialCandidates, diagnostics: value.catalog.diagnostics },
    sections: sectionPages,
    pendingOperations: value.materialOperations?.filter(row => row.state !== 'completed').map(row => ({ operationId: row.operationId, stage: row.stage, state: row.state, reuse: row.reuse })),
    next: 'Read inline field values directly; use details_json with returned pages for larger values. An incomplete inventory does not establish absence.' }
  if (Buffer.byteLength(JSON.stringify(summary)) <= maxBytes) return summary
  return { snapshotId, serverId: value.serverId, name: value.name, checkedAt: value.checkedAt, source: value.source,
    complete: value.complete, availableBytes: value.availableBytes, capacityBytes: value.capacityBytes,
    storagePlan: value.storagePlan === undefined ? undefined : { state: value.storagePlan.state, operationId: value.storagePlan.operationId,
      reuse: value.storagePlan.reuse === undefined ? undefined : { state: value.storagePlan.reuse.state, complete: value.storagePlan.reuse.complete } },
    errorPresent: wrapped?.error !== undefined || value.error !== undefined, sections: summary.sections, next: summary.next }
}
