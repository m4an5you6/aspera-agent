/** Storage tool pages preserve complete saved observations within a model-output budget. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, renameSync, symlinkSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { experimentIdSchema, serverIdSchema, environmentStorageNodeSchema, environmentOperationStatusSchema } from '@aspera/experiments'
import { storageToolPageSchema, storageToolResult } from '../src/storage-tool-result.ts'

const base = resolve('.artifacts'); mkdirSync(base, { recursive: true })
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('pages a large package inventory from a stable private snapshot instead of returning truncated JSON', async () => {
  const runRoot = mkdtempSync(resolve(base, 'storage-pages-')); roots.push(runRoot)
  const experimentId = experimentIdSchema.parse(randomUUID()), serverId = serverIdSchema.parse(randomUUID())
  const value = environmentStorageNodeSchema.parse({ serverId, name: 'fixture', checkedAt: 123, source: 'remote',
    availableBytes: 6_000_000_000, capacityBytes: 50_000_000_000, workspaceBytes: 1, sharedBytes: 2, reclaimableBytes: 3,
    environments: [], legacy: [], complete: false,
    materials: Array.from({ length: 600 }, (_, index) => ({ name: 'package-' + index, version: '1', wheelHash: 'a'.repeat(64), source: 'fixture', bytes: 10, cachedAt: 123, available: true })) })
  const options = { runRoot, experimentId, serverId, maxBytes: 4096 }
  const summary = await storageToolResult({ ...options, value })
  expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(4096)
  const decoded = JSON.parse(JSON.stringify(summary))
  let page = storageToolPageSchema.parse(decoded.sections.materials.page)
  const rows: unknown[] = []
  for (;;) {
    const result = JSON.parse(JSON.stringify(await storageToolResult({ ...options, page })))
    expect(result.checkedAt).toBe(123); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096)
    rows.push(...result.rows)
    if (result.next === undefined) break
    page = storageToolPageSchema.parse(result.next)
  }
  expect(rows).toEqual(value.materials)
  const saved = JSON.parse(readFileSync(resolve(runRoot, 'storage-tool-observations-v1', serverId, decoded.snapshotId + '.json'), 'utf8'))
  expect(saved.value).toEqual(value)
  await expect(storageToolResult({ ...options, experimentId: experimentIdSchema.parse(randomUUID()), page })).rejects.toThrow('another allocation')
})

it('expands a single oversized record and preserves complete Unicode detail text', async () => {
  const runRoot = mkdtempSync(resolve(base, 'storage-large-record-')); roots.push(runRoot)
  const experimentId = experimentIdSchema.parse(randomUUID()), serverId = serverIdSchema.parse(randomUUID())
  const source = '来源😀'.repeat(4000)
  const value = environmentStorageNodeSchema.parse({ serverId, name: 'fixture', checkedAt: 123, source: 'remote',
    availableBytes: 1, capacityBytes: 2, workspaceBytes: 0, sharedBytes: 0, reclaimableBytes: 0, environments: [], legacy: [], complete: false,
    materials: [{ name: 'large', version: '1', wheelHash: 'a'.repeat(64), source, bytes: 1, cachedAt: 123, available: true }] })
  const options = { runRoot, experimentId, serverId, maxBytes: 4096 }
  const summary = JSON.parse(JSON.stringify(await storageToolResult({ ...options, value })))
  const record = JSON.parse(JSON.stringify(await storageToolResult({ ...options, page: storageToolPageSchema.parse(summary.sections.materials.page) })))
  const detail = JSON.parse(JSON.stringify(await storageToolResult({ ...options, page: storageToolPageSchema.parse(record.detail) })))
  let page = storageToolPageSchema.parse(detail.fields.find((field: { key: string }) => field.key === 'source').page)
  let result = ''
  for (;;) {
    const part = JSON.parse(JSON.stringify(await storageToolResult({ ...options, page })))
    expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThanOrEqual(4096)
    expect(part.text).not.toMatch(/[\ud800-\udbff]$/)
    result += part.text
    if (part.next === undefined) break
    page = storageToolPageSchema.parse(part.next)
  }
  expect(result).toBe(source)
})

it('reads small candidate fields together while retaining pages for oversized content', async () => {
  const runRoot = mkdtempSync(resolve(base, 'storage-inline-fields-')); roots.push(runRoot)
  const experimentId = experimentIdSchema.parse(randomUUID()), serverId = serverIdSchema.parse(randomUUID())
  const material = { name: 'fixture-来源😀', version: '1.0', wheelHash: 'a'.repeat(64), source: '来源😀'.repeat(4000),
    bytes: 0, cachedAt: 123, available: false }
  const value = environmentStorageNodeSchema.parse({ serverId, name: 'fixture', checkedAt: 123, source: 'remote',
    availableBytes: 1, capacityBytes: 2, workspaceBytes: 0, sharedBytes: 0, reclaimableBytes: 0,
    environments: [], legacy: [], complete: false, materials: [material] })
  const options = { runRoot, experimentId, serverId, maxBytes: 4096 }
  const summary = JSON.parse(JSON.stringify(await storageToolResult({ ...options, value })))
  const row = JSON.parse(JSON.stringify(await storageToolResult({ ...options, page: storageToolPageSchema.parse(summary.sections.materials.page) })))
  const page = storageToolPageSchema.parse(row.detail)
  const detail = JSON.parse(JSON.stringify(await storageToolResult({ ...options, page })))
  expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThanOrEqual(options.maxBytes)
  let reads = 1
  for (const key of ['name', 'version', 'wheelHash', 'bytes', 'cachedAt', 'available'] as const) {
    const field = detail.fields.find((entry: { key: string }) => entry.key === key)
    expect(field).toBeDefined()
    const fallback = storageToolPageSchema.parse(field.page)
    let selected = field.value
    if (!Object.hasOwn(field, 'value')) {
      reads++
      const part = JSON.parse(JSON.stringify(await storageToolResult({ ...options, page: fallback })))
      selected = Object.hasOwn(part, 'value') ? part.value : part.text
    }
    expect(selected).toBe(material[key])
  }
  expect(reads).toBe(1)
  const source = detail.fields.find((field: { key: string }) => field.key === 'source')
  expect(source).not.toHaveProperty('value')
  const first = JSON.parse(JSON.stringify(await storageToolResult({ ...options, page: storageToolPageSchema.parse(source.page) })))
  expect(first.text).toBeTruthy(); expect(first.next).toBeDefined()
})

it('refuses a snapshot directory replaced by a link even when the copied record has matching ownership', async () => {
  const root = mkdtempSync(resolve(base, 'storage-link-')); roots.push(root)
  const runRoot = resolve(root, 'run'); mkdirSync(runRoot)
  const experimentId = experimentIdSchema.parse(randomUUID()), serverId = serverIdSchema.parse(randomUUID())
  const value = environmentStorageNodeSchema.parse({ serverId, name: 'fixture', checkedAt: 123, source: 'remote', availableBytes: 1,
    capacityBytes: 2, workspaceBytes: 0, sharedBytes: 0, reclaimableBytes: 0, environments: [], legacy: [], complete: false })
  const options = { runRoot, experimentId, serverId }
  const summary = JSON.parse(JSON.stringify(await storageToolResult({ ...options, value })))
  const directory = resolve(runRoot, 'storage-tool-observations-v1', serverId), moved = resolve(root, 'outside-run')
  renameSync(directory, moved); symlinkSync(moved, directory, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    await expect(storageToolResult({ ...options, page: storageToolPageSchema.parse(summary.sections.materials.page) })).rejects.toThrow('symbolic link')
  } finally { unlinkSync(directory) }
})

it('preserves wrapped inspection errors and pages process evidence without inventing capacity', async () => {
  const runRoot = mkdtempSync(resolve(base, 'storage-inspection-error-')); roots.push(runRoot)
  const experimentId = experimentIdSchema.parse(randomUUID()), serverId = serverIdSchema.parse(randomUUID())
  const value = { version: 1, experimentId, serverId, checkedAt: 123, operations: [], launches: [],
    error: 'Package reference requires confirmed environment deletion: original-experiment' }
  const options = { runRoot, experimentId, serverId, maxBytes: 4096 }
  const result = JSON.parse(JSON.stringify(await storageToolResult({ ...options, value })))
  expect(result).toMatchObject({ complete: false, checkedAt: 123, error: value.error })
  expect(result).not.toHaveProperty('availableBytes')
  const page = storageToolPageSchema.parse(result.sections.diagnostics.page)
  expect(await storageToolResult({ ...options, page })).toMatchObject({ rows: [value.error] })
  await expect(storageToolResult({ ...options, value: { ...value, experimentId: randomUUID() } })).rejects.toThrow('another experiment')
})

it('unwraps the known legacy response while retaining its real environment observation', async () => {
  const runRoot = mkdtempSync(resolve(base, 'storage-inspection-legacy-')); roots.push(runRoot)
  const experimentId = experimentIdSchema.parse(randomUUID()), serverId = serverIdSchema.parse(randomUUID())
  const storage = { serverId, name: 'legacy', checkedAt: 12, source: 'remote', availableBytes: 17, capacityBytes: 30,
    workspaceBytes: 1, sharedBytes: 2, reclaimableBytes: 0, environments: [], legacy: [], complete: false }
  const result = await storageToolResult({ runRoot, experimentId, serverId, value: { operations: [], launches: [], storage, error: 'Original incomplete scan retained' } })
  expect(result).toMatchObject({ checkedAt: 12, availableBytes: 17, complete: false, error: 'Original incomplete scan retained' })
  await expect(storageToolResult({ runRoot, experimentId, serverId, value: { operations: [], unexpected: [] } })).rejects.toThrow('Unsupported environment inspection')
})

it('keeps a large completed environment result valid JSON and pages its original package files', async () => {
  const runRoot = mkdtempSync(resolve(base, 'environment-result-pages-')); roots.push(runRoot)
  const experimentId = experimentIdSchema.parse(randomUUID()), serverId = serverIdSchema.parse(randomUUID()), operationId = randomUUID()
  const files = Array.from({ length: 20000 }, (_, index) => `torch/include/generated_${index}_${'x'.repeat(40)}.h`)
  const value = environmentOperationStatusSchema.parse({ experimentId, serverId, operationId, state: 'completed', checkedAt: 123,
    elapsedMs: 120000, processState: 'exited', admissionReleased: true,
    operation: { version: 1, experimentId, serverId, operationId, environmentId: 'training', requestHash: 'a'.repeat(64),
      action: 'repair', state: 'completed', commandId: 'environment-' + operationId, startedAt: 1, updatedAt: 122,
      exitConfirmed: true, exitCode: 0, environment: { version: 1, experimentId, serverId, deploymentId: 'a'.repeat(64),
        environmentId: 'training', generation: randomUUID(), purpose: 'train', directory: '/fixture/env', python: '/fixture/env/bin/python',
        pythonVersion: '3.10.12', pythonAbi: 'fixture-abi', uv: '/usr/bin/uv', uvVersion: '0.13.0', state: 'ready',
        requirements: ['torch==2.14.1'], packages: [{ id: 'a'.repeat(64), name: 'torch', version: '2.14.1', wheelHash: 'b'.repeat(64),
          source: 'fixture', tags: ['py3-none-any'], pythonAbi: 'fixture-abi', contentHash: 'c'.repeat(64), modified: false, files }],
        privateFiles: [], sharing: { hardlinkBytes: 6000000000, cloneBytes: 0, copyBytes: 0, logicalBytes: 6000000000,
          allocatedBytes: 1024, addedBytes: 1024, estimatedCopyBytes: 0, reasons: [] },
        verification: { verified: true, checkedAt: 122, python: '/fixture/env/bin/python', prefix: '/fixture/env',
          userSiteEnabled: false, dependenciesValid: true, modules: ['torch'], cuda: true }, updatedAt: 122 } } })
  const options = { runRoot, experimentId, serverId, maxBytes: 4096 }
  expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(1_000_000)
  const result = JSON.parse(JSON.stringify(await storageToolResult({ ...options, value })))
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(options.maxBytes)
  expect(result).toMatchObject({ state: 'completed', processState: 'exited', admissionReleased: true, checkedAt: 123,
    operation: { exitCode: 0, environment: { python: '/fixture/env/bin/python', verification: { verified: true, cuda: true } } } })
  const original = JSON.parse(readFileSync(resolve(runRoot, 'storage-tool-observations-v1', serverId, result.snapshotId + '.json'), 'utf8'))
  expect(original.value).toEqual(value)
  const page = storageToolPageSchema.parse({ ...result.details, path: [0, 'operation', 'environment', 'packages', 0, 'files'] })
  const first = JSON.parse(JSON.stringify(await storageToolResult({ ...options, page })))
  expect(first.rows.length).toBeGreaterThan(0); expect(first.total).toBe(files.length); expect(first.next).toBeDefined()
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(options.maxBytes)
  const receipt = JSON.parse(JSON.stringify(await storageToolResult({ ...options, value: value.operation })))
  expect(receipt).toMatchObject({ state: 'completed', exitConfirmed: true, exitCode: 0,
    environment: { python: '/fixture/env/bin/python', packageCount: 1 } })
  expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(options.maxBytes)
  await expect(storageToolResult({ ...options, experimentId: experimentIdSchema.parse(randomUUID()), page })).rejects.toThrow('another allocation')
})

it('preserves small operation replies and bounds long failure diagnostics without changing their outcome', async () => {
  const runRoot = mkdtempSync(resolve(base, 'environment-failure-pages-')); roots.push(runRoot)
  const experimentId = experimentIdSchema.parse(randomUUID()), serverId = serverIdSchema.parse(randomUUID())
  const value = environmentOperationStatusSchema.parse({ experimentId, serverId, operationId: randomUUID(), state: 'failed',
    checkedAt: 123, elapsedMs: 1000, processState: 'exited', admissionReleased: true, detail: 'Wheel RECORD differs' })
  const options = { runRoot, experimentId, serverId, maxBytes: 4096 }
  expect(await storageToolResult({ ...options, value })).toEqual(value)
  const detail = '安装材料校验失败😀'.repeat(20000)
  const result = JSON.parse(JSON.stringify(await storageToolResult({ ...options, value: { ...value, detail } })))
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(options.maxBytes)
  expect(result).toMatchObject({ state: 'failed', processState: 'exited', admissionReleased: true, checkedAt: 123 })
  const page = storageToolPageSchema.parse({ ...result.details, path: [0, 'detail'] })
  const first = JSON.parse(JSON.stringify(await storageToolResult({ ...options, page })))
  expect(first.text).toBeTruthy(); expect(first.next).toBeDefined()
  const original = JSON.parse(readFileSync(resolve(runRoot, 'storage-tool-observations-v1', serverId, result.snapshotId + '.json'), 'utf8'))
  expect(original.value.detail).toBe(detail)
})
