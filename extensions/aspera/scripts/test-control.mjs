/** Verify production control admission, durable plans and restart without a GPU or model key. */
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync, symlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { setupWorkerProfile } from '@aspera/runtime'
import { clusterSubmissionSchema } from '@aspera/experiments'
import { removeTestDirectory } from './test-app.mjs'
import { resolvedFixture } from './fixtures/storage.mjs'
import { fixtureModelSnapshots, fixtureSelections } from './fixtures/models.mjs'
const modelFixture = fixtureModelSnapshots()

const release = resolve(import.meta.dirname, '..')
mkdirSync(resolve(release, '.artifacts'), { recursive: true })
const directory = mkdtempSync(resolve(release, '.artifacts/control-test-'))
const root = process.platform === 'win32' ? directory.slice(2).replaceAll('\\', '/') : directory
const id = randomUUID(); const serverId = randomUUID(); const deploymentId = 'a'.repeat(64); const token = 'b'.repeat(64)
const { server, inventory } = resolvedFixture({ id: serverId, name: 'CPU admission fixture', host: 'fixture.test', sshPort: 22, username: 'trainer', remotePort: 43019, remoteRoot: root, authMode: 'password' }, id, deploymentId)
const submission = clusterSubmissionSchema.parse({ protocol: 4, name: 'CPU fixture', models: modelFixture.models, experimentId: id, deploymentId, inventories: [{ serverId, inventory }], objective: 'Plan only, awaiting confirmation', coordinator: server,
  nodes: [{ server, devicePaths: ['/dev/nvidia_fixture'], backendPath: '/fixture/bwrap', hiddenPaths: [], gpuInfo: 'CPU fixture; no GPU validation' }],
  inputs: [{ name: 'data.txt', sha256: createHash('sha256').update('dataset row\n').digest('hex') }], createdAt: 1,
  strategy: { mode: 'semi', coordinator: 'single-agent' },
  versions: { dsh: '0.2.0-rc.2', extension: '0.1.1', harness: deploymentId, data: [] } })
const run = resolve(directory, 'runs', id)
const modelFile = resolve(directory, 'secrets/model.json'); const knownHosts = resolve(directory, 'secrets/known_hosts')
const ready = resolve(directory, 'ready.json'); const home = resolve(directory, 'state/coordinator-home')
mkdirSync(resolve(run, 'inputs'), { recursive: true }); mkdirSync(resolve(directory, 'secrets'), { recursive: true })
mkdirSync(resolve(directory, 'releases', deploymentId), { recursive: true })
writeFileSync(resolve(directory, 'releases', deploymentId, '.ready'), '')
symlinkSync(resolve(release, 'node_modules'), resolve(directory, 'releases', deploymentId, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
writeFileSync(resolve(run, 'inputs/data.txt'), 'dataset row\n')
writeFileSync(modelFile, JSON.stringify({ version: 1, refs: modelFixture.refs })); writeFileSync(knownHosts, '')
writeFileSync(resolve(directory, 'secrets/coordinator.token'), token)
writeFileSync(resolve(directory, 'secrets', id + '.json'), JSON.stringify({ submission,
  connections: [{ serverId, password: 'not-model-visible', token, knownHostsFile: knownHosts }], modelCredentialFile: modelFile,
  toolTimeoutMs: 1000, agentModel: fixtureSelections.preparation }))
const planHome = resolve(run, 'agent-homes', 'plan')
await setupWorkerProfile(planHome, resolve(directory, 'releases', deploymentId))
writeFileSync(resolve(planHome, 'profiles/aspera-worker/cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'keyless-plan-replay',
  name: pathToFileURL(resolve(release, 'scripts/fixtures/worker.mjs')).href,
  config: { id, serverId, planning: true, semi: true, ask: true, observed: resolve(directory, 'plan-observed.json') } }] }]))
await setupWorkerProfile(home, release)
writeFileSync(resolve(home, 'profiles/aspera-worker/cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'control-readiness',
  name: pathToFileURL(resolve(release, 'scripts/fixtures/worker.mjs')).href, config: { ready } }] }]))
let control
async function start(withGpu = false) {
  if (existsSync(ready)) unlinkSync(ready)
  const child = spawn(process.execPath, [resolve(release, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'aspera-worker'],
    { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DSH_HOME: home,
      DSH_EXPERIMENT_ROLE: 'coordinator', DSH_CLUSTER_ROOT: root, DSH_EXPERIMENT_PORT: '0', DSH_EXPERIMENT_DEPLOYMENT_ID: deploymentId,
      DSH_EXPERIMENT_GPU_SNAPSHOT: withGpu ? JSON.stringify({ gpus: [{ uuid: 'GPU-11111111-1111-1111-1111-111111111111', name: 'CPU XML fixture', devicePath: '/dev/nvidia5' }], devicePaths: ['/dev/nvidia5'] }) : '',
      DSH_EXPERIMENT_TOKEN_FILE: resolve(directory, 'secrets/coordinator.token'), DSH_EXPERIMENT_MODEL_CREDENTIAL_FILE: modelFile,
      DSH_CLUSTER_POLL_MS: '100', DSH_CLUSTER_CLEANUP_MS: '1000', DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: '' } })
  const exited = once(child, 'exit'); let output = ''
  child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  const close = async () => { const timer = setTimeout(() => { child.kill('SIGKILL') }, 10000); child.kill('SIGTERM'); try { await exited } finally { clearTimeout(timer) } }
  try {
    const deadline = Date.now() + 60000
    while (!existsSync(ready)) { if (child.exitCode !== null || Date.now() >= deadline) throw new Error('Control startup failed: ' + output.slice(-4000)); await delay(50) }
    const port = JSON.parse(readFileSync(ready, 'utf8')).port
    while (true) {
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error('Control routes did not become ready: ' + output.slice(-4000))
      const response = await fetch(`http://127.0.0.1:${port}/aspera/v1/health`, { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000) })
      const text = await response.text()
      if (response.ok && text !== '' && JSON.parse(text).role === 'coordinator') break
      await delay(50)
    }
    return { close, port, request: async (operation, body, authorized = true) => {
      const response = await fetch(`http://127.0.0.1:${port}/aspera/v2/${operation}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { ...(authorized ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) })
      return { status: response.status, value: await response.json() }
    } }
  } catch (error) { await close(); throw error }
}
try {
  control = await start(true)
  assert.equal((await control.request('health', undefined, false)).status, 401)
  const healthy = (await control.request('health')).value
  assert.equal(healthy.role, 'coordinator')
  assert.equal(healthy.controller.policy.gpu.gpus[0].devicePath, '/dev/nvidia5')
  assert.ok(healthy.features.includes('controller-maintenance-v1'))
  const maintenance = { operationId: randomUUID(), bootId: healthy.controller.bootId, policyDigest: healthy.controller.policyDigest }
  assert.equal((await control.request('maintenance-begin', maintenance, false)).status, 401)
  assert.equal((await control.request('maintenance-begin', { ...maintenance, bootId: 'stale-process' })).status, 400)
  const fences = await Promise.all([control.request('maintenance-begin', maintenance), control.request('maintenance-begin', maintenance)])
  assert.ok(fences.every(response => response.status === 200 && response.value.maintenance === maintenance.operationId))
  assert.equal((await control.request('maintenance-cancel', { ...maintenance, operationId: randomUUID() })).status, 400)
  server.remotePort = control.port - 1
  submission.coordinator.remotePort = server.remotePort
  const privatePath = resolve(directory, 'secrets', id + '.json')
  const materials = JSON.parse(readFileSync(privatePath, 'utf8'))
  materials.submission = submission
  writeFileSync(privatePath, JSON.stringify(materials))
  const fenced = await control.request('submit', submission)
  assert.equal(fenced.status, 400); assert.match(fenced.value.error, /maintenance/)
  assert.equal((await control.request('maintenance-cancel', maintenance)).status, 200)
  const receipt = await control.request('submit', submission)
  assert.equal(receipt.status, 200); assert.equal(receipt.value.handover, '本机派发完成，远端实验已接管')
  // Planning includes a fresh profile boot; use the profile smoke's 60-second bound.
  let deadline = Date.now() + 60000; let planned
  while (Date.now() < deadline) {
    planned = await control.request('status', { experimentId: id })
    if (planned.value.record?.state === 'waiting-reply') break
    if (['failed', 'blocked'].includes(planned.value.record?.state)) throw new Error(JSON.stringify(planned.value))
    await delay(100)
  }
  assert.equal(planned.value.record.state, 'waiting-reply')
  const question = planned.value.record.questions[0]
  const paused = readFileSync(resolve(directory, 'plan-observed.json'), 'utf8')
  // An operator has no open connection while the original tool remains pending.
  await delay(300)
  assert.equal(readFileSync(resolve(directory, 'plan-observed.json'), 'utf8'), paused)
  const reply = { experimentId: id, questionId: question.questionId, revision: question.revision,
    sessionId: question.sessionId, callId: question.callId, answer: { answers: [{ id: 'trial', selected: ['Continue with a measured trial'] }] } }
  assert.equal((await control.request('answer-question', { ...reply, revision: question.revision + 1 })).status, 400)
  const replies = await Promise.all([control.request('answer-question', reply), control.request('answer-question', reply)])
  assert.ok(replies.every(item => item.status === 200))
  assert.equal((await control.request('answer-question', { ...reply, answer: { answers: [{ id: 'trial', selected: ['Stop for a revised experiment'] }] } })).status, 400)
  deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    planned = await control.request('status', { experimentId: id })
    if (planned.value.record?.state === 'awaiting-approval') break
    if (['failed', 'blocked'].includes(planned.value.record?.state)) throw new Error(JSON.stringify(planned.value))
    await delay(100)
  }
  assert.equal(planned.value.record.state, 'awaiting-approval')
  assert.equal(planned.value.record.resourcesReleased, true)
  const occupied = await control.request('maintenance-begin', maintenance)
  assert.equal(occupied.status, 400); assert.match(occupied.value.error, /occupied/)
  assert.ok(planned.value.record.planningSessionId)
  const stepRead = await control.request('execution-progress', { experimentId: id })
  assert.equal(stepRead.status, 200); assert.equal(stepRead.value.supported, true)
  assert.equal(stepRead.value.progress.revision, 0)
  assert.deepEqual(stepRead.value.progress.steps.map(step => step.state), ['pending', 'pending'])
  const earlyReport = await control.request('report-execution-step', { experimentId: id, planRevision: 1,
    sessionId: `aspera-execution-${id}`, generation: readFileSync(resolve(directory, 'state/coordinator.generation'), 'utf8'),
    callId: 'premature-execution', expectedRevision: 0, step: 1, state: 'running' })
  assert.equal(earlyReport.value.accepted, false)
  assert.equal(existsSync(resolve(run, 'execution-progress.v1.json')), false)
  assert.equal(planned.value.record.planningSessionId, question.sessionId)
  const events = readFileSync(resolve(run, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  const changes = events.filter(item => item.event.type === 'goal/change').map(item => item.event.data)
  assert.equal(new Set(changes.map(change => change.goal.id)).size, 1)
  assert.deepEqual(changes.map(change => change.operation), ['create', 'pause', 'resume', 'complete'])
  const calls = events.filter(item => item.event.type === 'tool/call' && item.event.data.callId === question.callId)
  const results = events.filter(item => item.event.type === 'tool/result' && item.event.data.message.source.callId === question.callId)
  assert.equal(calls.length, 1)
  assert.equal(results.length, 1)
  assert.equal(results[0].sessionId, question.sessionId)
  const snapshot = {
    question: { version: question.version, revision: question.revision, stage: question.stage, questions: question.questions },
    savedAnswer: planned.value.record.questions[0].answer,
    originalToolResult: { isError: Boolean(results[0].event.data.message.isError),
      answer: JSON.parse(results[0].event.data.message.content.find(block => block.type === 'text').text) },
    goalTransitions: changes.map(change => ({ operation: change.operation, phase: change.goal.phase })),
  }
  assert.deepEqual(snapshot, JSON.parse(readFileSync(resolve(release, 'scripts/fixtures/control.snapshot.json'), 'utf8')))
  assert.equal((await control.request('answer-question', reply)).status, 400)
  await control.close(); control = await start()
  assert.equal((await control.request('health')).value.controller.policy.gpu, undefined)
  assert.equal((await control.request('status', { experimentId: id })).value.record.state, 'awaiting-approval')
  unlinkSync(resolve(run, 'inputs/data.txt'))
  const duplicate = await control.request('submit', submission)
  assert.equal(duplicate.status, 200); assert.equal(duplicate.value.sequence, receipt.value.sequence)
  assert.equal(duplicate.value.planningSessionId, planned.value.record.planningSessionId)
  assert.equal((await control.request('submit', { ...submission, objective: 'Changed objective' })).status, 400)
  const orphan = randomUUID(); mkdirSync(resolve(directory, 'runs', orphan))
  const orphanSubmission = { ...submission, experimentId: orphan,
    coordinator: resolvedFixture(submission.coordinator, orphan, deploymentId).server,
    nodes: submission.nodes.map(node => ({ ...node, server: resolvedFixture(node.server, orphan, deploymentId).server })) }
  writeFileSync(resolve(directory, 'secrets', orphan + '.json'), JSON.stringify({
    ...JSON.parse(readFileSync(resolve(directory, 'secrets', id + '.json'), 'utf8')), submission: orphanSubmission }))
  writeFileSync(resolve(directory, 'runs', orphan, 'started.json'), JSON.stringify({ sessionId: 'unknown', goalId: 'unknown' }))
  const refused = await control.request('submit', orphanSubmission)
  assert.equal(refused.status, 400); assert.match(refused.value.error, /operator reconciliation/)
  const refusedCancel = await control.request('cancel', { experimentId: orphan, submission: orphanSubmission })
  assert.equal(refusedCancel.status, 400); assert.match(refusedCancel.value.error, /operator reconciliation/)
  assert.equal((await control.request('cancel', { experimentId: id })).value.state, 'cancelled')
  assert.equal((await control.request('answer-question', reply)).status, 400)
  assert.equal((await control.request('submit', submission)).value.state, 'cancelled')
  console.log('Production coordinator: authenticated maintenance, atomic admission fence, occupied-task refusal, material admission, durable planning, restart, receipt recovery and cancellation passed.')
} finally { await control?.close(); removeTestDirectory(directory, resolve(release, '.artifacts')) }
