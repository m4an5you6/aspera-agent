/** Private cleanup residue cannot expose writable aliases of published dependencies. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { experimentEnvironmentSchema, prepareExperimentEnvironmentSchema, environmentRequirementsSchema, environmentOperationSchema } from '@aspera/experiments'
import { managedEnvironmentMounts, ManagedEnvironments, managedEnvironmentPolicyForRelease, managedEnvironmentPolicySchema } from '../src/managed-environment.ts'
import { experimentSandboxArgv } from '../src/experiment-sandbox.ts'
import { Context } from '@deepseek-ai/cordis'
import { experimentIdSchema } from '@aspera/experiments'
import type { ClusterNode } from '@aspera/experiments'
import { fromAny } from '@total-typescript/shoehorn'

const base = resolve('.artifacts'); mkdirSync(base, { recursive: true })
const roots: string[] = []
it('projects installer pip settings only to capable fixed releases', () => {
  const current = managedEnvironmentPolicySchema.parse({})
  const { pipVersion, ...previous } = current
  expect(managedEnvironmentPolicyForRelease(current, false)).toEqual(previous)
  expect(managedEnvironmentPolicySchema.omit({ pipVersion: true }).safeParse(managedEnvironmentPolicyForRelease(current, false)).success).toBe(true)
  expect(managedEnvironmentPolicyForRelease(current, true)).toEqual({ ...previous, pipVersion })
  expect(managedEnvironmentPolicySchema.omit({ pipVersion: true }).safeParse(managedEnvironmentPolicyForRelease(current, true)).success).toBe(false)
})
it('retains merged direct requirements beyond one request while enforcing the per-request limit', () => {
  const requirements = Array.from({ length: 513 }, (_, index) => `fixture-${index}==1`)
  expect(environmentRequirementsSchema.parse({ version: 1, requestHash: 'a'.repeat(64), requirements }).requirements).toEqual(requirements)
  expect(prepareExperimentEnvironmentSchema.safeParse({ environmentId: 'training', operationId: randomUUID(), action: 'create', requirements }).success).toBe(false)
})
it('retains structured failure identity and refuses another operation or a self-referencing retry', () => {
  const experimentId = randomUUID(), serverId = randomUUID(), operationId = randomUUID(), previousOperationId = randomUUID()
  const failure = { version: 1, experimentId, serverId, operationId, previousOperationId, environmentId: 'training', requestHash: 'a'.repeat(64),
    code: 'unchanged-failure', contextHash: 'b'.repeat(64), requirementsHash: 'c'.repeat(64), inputRequirementsHash: 'c'.repeat(64), packages: ['d'.repeat(64)],
    path: 'packaging/__init__.py', detail: 'Resolve the original package conflict before another installation', createdAt: 30 }
  const record = { version: 1, experimentId, serverId, operationId, environmentId: 'training', requestHash: failure.requestHash,
    action: 'install', state: 'blocked', commandId: 'environment-' + operationId, startedAt: 10, updatedAt: 30, exitConfirmed: true, exitCode: 1, failure }
  expect(environmentOperationSchema.parse(record).failure?.previousOperationId).toBe(previousOperationId)
  for (const changed of [{ serverId: randomUUID() }, { operationId: randomUUID() }, { previousOperationId: operationId }, { path: '../outside' }]) {
    expect(environmentOperationSchema.safeParse({ ...record, failure: { ...failure, ...changed } }).success).toBe(false)
  }
  const { failure: _failure, ...legacy } = record
  expect(environmentOperationSchema.parse(legacy).failure).toBeUndefined()
})
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== base) throw new Error('Test cleanup escaped its owned directory')
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const root = mkdtempSync(resolve(base, 'cleanup-mounts-')); roots.push(root)
  const experimentId = randomUUID(); const serverId = randomUUID(); const operationId = randomUUID()
  const run = resolve(root, 'runs', experimentId); const workspace = resolve(run, 'workspace')
  const directory = resolve(workspace, 'env/python'); const residue = resolve(workspace, 'tmp/environment-' + operationId)
  for (const path of [resolve(directory, 'lib/python3.12/site-packages'), residue, resolve(run, 'environments-v1'), resolve(run, 'environment-requests-v1'), resolve(run, 'environment-cleanups-v1')]) mkdirSync(path, { recursive: true })
  writeFileSync(resolve(run, '.aspera-owner.json'), JSON.stringify({ version: 1, experimentId, serverId }))
  const environment = experimentEnvironmentSchema.parse({ version: 1, experimentId, serverId, deploymentId: 'a'.repeat(64), environmentId: 'training', generation: randomUUID(),
    purpose: 'training', directory, python: resolve(directory, 'bin/python'), pythonVersion: '3.12', pythonAbi: 'fixture', uv: '/usr/bin/uv', uvVersion: '0.13.0',
    state: 'ready', requirements: [], packages: [], privateFiles: [], sharing: { hardlinkBytes: 0, cloneBytes: 0, copyBytes: 0, logicalBytes: 0, allocatedBytes: 0, addedBytes: 0, estimatedCopyBytes: 0, reasons: [] },
    verification: { verified: true, checkedAt: 1, python: resolve(directory, 'bin/python'), prefix: directory, userSiteEnabled: false, dependenciesValid: true, modules: [] }, updatedAt: 1 })
  writeFileSync(resolve(run, 'environments-v1/training.json'), JSON.stringify(environment))
  writeFileSync(resolve(directory, '.aspera-environment.json'), JSON.stringify({ version: 1, environmentId: 'training', generation: environment.generation }))
  const request = prepareExperimentEnvironmentSchema.parse({ environmentId: 'training', operationId, action: 'verify' })
  writeFileSync(resolve(run, 'environment-requests-v1', operationId + '.json'), JSON.stringify({ request }))
  const cleanup = { version: 1, experimentId, serverId, operationId, environmentId: 'training', generation: environment.generation, state: 'pending', paths: [residue], packages: [], createdAt: 1, updatedAt: 2 }
  const cleanupPath = resolve(run, 'environment-cleanups-v1', operationId + '.json')
  writeFileSync(cleanupPath, JSON.stringify(cleanup))
  return { root, run, workspace, directory, residue, environment, cleanup, cleanupPath, request }
}
it('masks pending hard-link aliases after binding the workspace and permits the verified environment', () => {
  const f = fixture(); const mounts = managedEnvironmentMounts(f.run, f.workspace)
  expect(mounts.hiddenPaths).toEqual([f.residue]); expect(mounts.readonlyPaths).toEqual([f.directory])
  const argv = experimentSandboxArgv({ backendPath: '/usr/bin/bwrap', workspaceRoot: f.workspace, devicePaths: [], hiddenPaths: [], environment: mounts }, ['true'])
  const hidden = argv.indexOf(f.residue)
  expect(argv[hidden - 1]).toBe('--tmpfs'); expect(argv.slice(hidden + 1, hidden + 3)).toEqual(['--remount-ro', f.residue])
  expect(hidden).toBeGreaterThan(argv.indexOf('--bind'))
})
it('refuses cleanup safety errors and mismatched experiment or cleanup paths', () => {
  const f = fixture()
  for (const changed of [{ state: 'blocked' }, { experimentId: randomUUID() }, { paths: [f.root] }]) {
    writeFileSync(f.cleanupPath, JSON.stringify({ ...f.cleanup, ...changed }))
    expect(() => managedEnvironmentMounts(f.run, f.workspace)).toThrow()
  }
})
it('returns independent recovery diagnostics without rewriting the original receipt or timestamps', () => {
  const f = fixture(); const id = experimentIdSchema.parse(f.environment.experimentId)
  const node = fromAny<ClusterNode, object>({ server: { id: f.environment.serverId, name: 'fixture', host: 'localhost', username: 'root', remoteRoot: f.root,
    storagePlacement: { experimentId: id, serverId: f.environment.serverId, namespaceRoot: f.root, runRoot: f.run, workspaceRoot: f.workspace, controlRoot: f.root, minimumFreeBytes: 0 } }, backendPath: '/usr/bin/bwrap', devicePaths: [], hiddenPaths: [], gpuInfo: '' })
  const folder = resolve(f.run, 'environment-operations-v1', f.request.operationId); mkdirSync(folder, { recursive: true })
  const original = { version: 1, experimentId: id, serverId: node.server.id, operationId: f.request.operationId, environmentId: f.request.environmentId, requestHash: 'b'.repeat(64), action: 'verify', state: 'blocked', commandId: 'environment-' + f.request.operationId, startedAt: 10, updatedAt: 20, exitConfirmed: true, exitCode: 1 }
  const path = resolve(folder, 'receipt.v1.json'); writeFileSync(path, JSON.stringify(original))
  const before = readFileSync(path, 'utf8'); const recoveryFolder = resolve(f.run, 'environment-recoveries-v1'); mkdirSync(recoveryFolder)
  writeFileSync(resolve(recoveryFolder, f.request.operationId + '.json'), JSON.stringify({ version: 1, experimentId: id, serverId: node.server.id, operationId: f.request.operationId, environmentId: 'training', generation: f.environment.generation, sourceReceiptHash: 'c'.repeat(64), state: 'verification-required', createdAt: 100, updatedAt: 100, detail: 'Program verification required' }))
  const result = new ManagedEnvironments(new Context()).receipt({ experimentId: id, node, deploymentId: 'a'.repeat(64), controlRoot: f.root, hiddenPaths: [] }, f.request)
  expect(result.updatedAt).toBe(20); expect(result.recovery?.updatedAt).toBe(100); expect(result.cleanup?.state).toBe('pending')
  expect(readFileSync(path, 'utf8')).toBe(before)
})
