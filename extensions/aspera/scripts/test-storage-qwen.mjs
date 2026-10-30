/** Real Qwen requests exercise isolated shipped coordinator, node and execution profiles on Linux. */
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { setupWorkerProfile, resolveStoragePlacement, managedEnvironmentConfig, managedEnvironmentPolicySchema } from '@aspera/runtime'
import { CLUSTER_HANDOVER, clusterRecordSchema, clusterSubmissionSchema, parseGpuInventory } from '@aspera/experiments'
import { gpuIdentityQueryScript } from '../packages/runtime/lib/gpu-query.js'
import { inspectStorage } from '../packages/runtime/scripts/storage.mjs'
import { prepareEnvironmentAndWait } from '../packages/runtime/lib/environment-operation.js'
import { prepareMaterialAndWait } from '../packages/runtime/lib/material-operation.js'

assert.equal(process.platform, 'linux', 'This test exercises the selected Linux node')
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const root = resolve(config.root), release = resolve(import.meta.dirname, '..')
assert.match(root, /^\/root\/gpufree-data\/aspera-storage-preflight-[a-zA-Z0-9_-]+$/)
assert.ok(release.startsWith(root + '/'))
const control = resolve(root, 'control'), data = resolve(root, 'data')
const credentials = resolve(control, 'secrets/model.json'), sid = config.submission.coordinator.id
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); const temporary = path + '.' + randomUUID() + '.incoming'; writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 }); renameSync(temporary, path) }
mkdirSync(data, { recursive: true })
const copied = JSON.parse(readFileSync(config.modelFile, 'utf8'))
const selected = config.submission.models.execution, configuration = copied.refs[selected.configurationRef]
assert.equal(createHash('sha256').update(configuration).digest('hex'), selected.configurationHash)
const keyRef = JSON.parse(configuration).keyRef
assert.equal(typeof copied.refs[keyRef], 'string')
write(credentials, { version: 1, refs: { [selected.configurationRef]: configuration, [keyRef]: copied.refs[keyRef] } })
const nodeToken = randomUUID(), coordinatorToken = randomUUID()
for (const [name, token] of [['node', nodeToken], ['coordinator', coordinatorToken]]) {
  mkdirSync(resolve(control, 'secrets'), { recursive: true, mode: 0o700 })
  writeFileSync(resolve(control, 'secrets', name + '.token'), token, { mode: 0o600 })
}
writeFileSync(resolve(control, 'secrets/known_hosts'), '', { mode: 0o600 })
write(resolve(control, '.aspera-owner.json'), { version: 1, serverId: sid, kind: 'control' })
const devices = readdirSync('/dev').filter(name => /^nvidia(?:\d+|ctl|-uvm|-uvm-tools|-modeset)$/.test(name)).map(name => '/dev/' + name)
if (existsSync('/dev/nvidia-caps')) devices.push(...readdirSync('/dev/nvidia-caps').filter(name => /^nvidia-cap\d+$/.test(name)).map(name => '/dev/nvidia-caps/' + name))
const query = execFileSync('python3', ['-c', gpuIdentityQueryScript, '10'], { encoding: 'utf8' })
const gpu = parseGpuInventory(query, devices.filter(name => statSync(name).isCharacterDevice()))
const children = [], report = { model: { provider: selected.provider, model: selected.model }, cases: [], root, startedAt: new Date().toISOString() }
const policy = { artifact: 'other', checkpointCount: 0, optimizerState: false, schedulerState: false, recoveryPoints: [], outputMinimumBytes: 1024, checkpointMinimumBytes: 0, basis: 'Storage architecture validation; retain reports, no training checkpoints' }
let nodePort
async function request(port, token, route, body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) })
  const value = await response.json()
  if (!response.ok) throw new Error(route + ': ' + JSON.stringify(value))
  return value
}
async function start(role, port) {
  const home = resolve(control, 'state', role + '-home'), ready = resolve(root, role + '-ready.json')
  await setupWorkerProfile(home, release)
  write(resolve(home, 'profiles/aspera-worker/cordis.patch.yml'), [{ insert: [{ id: 'storage-test-ready', name: pathToFileURL(resolve(release, 'scripts/fixtures/storage-qwen-ready.mjs')).href, config: { path: ready } }] }])
  const child = spawn(process.execPath, [resolve(release, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'aspera-worker'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    DSH_HOME: home, DSH_EXPERIMENT_ROLE: role, DSH_CLUSTER_ROOT: control, DSH_EXPERIMENT_PORT: String(port),
    DSH_EXPERIMENT_DEPLOYMENT_ID: config.deploymentId, DSH_EXPERIMENT_TOKEN_FILE: resolve(control, 'secrets', role + '.token'),
    DSH_EXPERIMENT_MODEL_CREDENTIAL_FILE: credentials, DSH_EXPERIMENT_DEVICES: gpu.devicePaths.join(','), DSH_EXPERIMENT_GPU_SNAPSHOT: JSON.stringify(gpu),
    DSH_EXPERIMENT_BWRAP: config.submission.nodes[0].backendPath, DSH_EXPERIMENT_HIDDEN_PATHS_JSON: JSON.stringify([...new Set([control, config.sourceControl, ...config.submission.nodes[0].hiddenPaths])]),
    DSH_CLUSTER_ENVIRONMENT_POLICY_JSON: JSON.stringify(config.environmentPolicy ?? {}), DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: '' } })
  const done = once(child, 'exit'); let output = ''
  child.stdout.on('data', value => { output = (output + value).slice(-6000) }); child.stderr.on('data', value => { output = (output + value).slice(-6000) })
  children.push({ child, done, role })
  const deadline = Date.now() + 60000
  while (!existsSync(ready)) { if (child.exitCode !== null || Date.now() >= deadline) throw new Error(role + ' startup failed: ' + output); await delay(100) }
  return JSON.parse(readFileSync(ready, 'utf8')).port
}
function initialize(name, objective) {
  const id = randomUUID(), observed = inspectStorage({ directory: data })
  const candidate = observed.candidates.find(value => value.directory === data)
  assert.ok(candidate, 'The test uses a fresh observation of its actual mount')
  const server = { ...config.submission.coordinator, remoteRoot: control, remotePort: nodePort, host: '127.0.0.1', authMode: 'password' }
  server.storagePlacement = resolveStoragePlacement({ ...server, storagePreference: { mode: 'manual', directory: data } }, id, config.deploymentId, observed, candidate.id, 'Isolated same-volume real-provider validation', 1024)
  const node = { ...config.submission.nodes[0], server, devicePaths: gpu.devicePaths, hiddenPaths: [...new Set([control, config.sourceControl, ...config.submission.nodes[0].hiddenPaths])], gpuInfo: query }
  const submission = clusterSubmissionSchema.parse({ ...config.submission, models: { preparation: selected, planning: selected, execution: selected }, experimentId: id, deploymentId: config.deploymentId, name, objective,
    coordinator: server, nodes: [node], inventories: [{ serverId: sid, inventory: observed }], inputs: [], createdAt: Date.now(), strategy: { mode: 'semi', coordinator: 'single-agent' } })
  const placement = server.storagePlacement
  for (const dir of [placement.workspaceRoot, placement.releaseRoot, resolve(control, 'secrets')]) mkdirSync(dirname(dir), { recursive: true, mode: 0o700 })
  mkdirSync(placement.workspaceRoot, { recursive: true, mode: 0o700 })
  if (!existsSync(placement.releaseRoot)) execFileSync('cp', ['-al', release, placement.releaseRoot])
  write(resolve(placement.namespaceRoot, '.aspera-owner.json'), { version: 1, serverId: sid, kind: 'storage' })
  write(resolve(placement.runRoot, '.aspera-owner.json'), { version: 1, serverId: sid, experimentId: id })
  write(resolve(control, 'secrets', id + '.json'), { submission, connections: [{ serverId: sid, password: 'loopback-test-only', token: nodeToken, knownHostsFile: resolve(control, 'secrets/known_hosts') }], modelCredentialFile: credentials, toolTimeoutMs: 30000, agentModel: { provider: selected.provider, model: selected.model } })
  return submission
}
function eventsAt(run) {
  const path = resolve(run, 'events.jsonl')
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse)
}
function savedRows(directory, receipt) {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap(name => {
    const path = receipt === undefined ? resolve(directory, name) : resolve(directory, name, receipt)
    return existsSync(path) && statSync(path).isFile() ? [JSON.parse(readFileSync(path, 'utf8'))] : []
  })
}
function scenarioEvidence(item, run) {
  const events = eventsAt(run), calls = events.filter(value => value.event.type === 'tool/call').map(value => value.event.data)
  const preflights = savedRows(resolve(run, 'storage-preflight-v2/environments')).map(value => value.preflight)
  if (item.name === 'historical-source') return preflights.some(value => value.status === 'repair-required' && /RECORD.*decord-0\.6\.0/.test(value.detail))
    && calls.some(call => /RECORD|decord/.test(call.arguments) && (call.name === 'finish_experiment' || call.name === 'report_experiment_step' && JSON.parse(call.arguments).state === 'completed'))
    && !calls.some(call => call.name === 'prepare_experiment_environment' && JSON.parse(JSON.parse(call.arguments).json).action !== 'verify-reuse')
  const planPath = resolve(run, 'storage-plan.v1.json')
  if (!existsSync(planPath)) return false
  const plan = JSON.parse(readFileSync(planPath, 'utf8')), operations = savedRows(resolve(run, 'material-operations-v1'), 'receipt.v1.json')
  const policyPath = resolve(run, 'storage-preflight-v2/policy-current.v1.json')
  if (!existsSync(policyPath) || plan.policyRevision !== JSON.parse(readFileSync(policyPath, 'utf8')).revision) return false
  const log = resolve(run, 'workspace/reports/check.log')
  if (plan.state !== 'ready' || plan.mode !== 'commit' || !plan.coverage?.complete
    || !operations.some(value => value.action === 'acquire' && value.state === 'completed' && value.exitConfirmed && value.admissionReleased)
    || !existsSync(log) || !readFileSync(log, 'utf8').includes('storage-preflight-ok')) return false
  const commands = savedRows(resolve(control, 'state/node-home/storages/aspera_node/commands')).map(value => value.record ?? value)
  if (!commands.some(value => value.experimentId === run.split('/').at(-1) && value.command.includes('scripts/check_env.py')
    && value.state === 'completed' && value.exitCode === 0 && value.released)) return false
  if (item.name === 'isolated-flow') {
    const trials = savedRows(resolve(run, 'storage-plans-v1')).filter(value => value.mode === 'preview')
    return operations.some(value => value.verificationStatus === 'partial')
      && new Set(trials.map(value => value.declaredOutputBytes)).size >= 2
      && savedRows(resolve(run, 'storage-preflight-v2/proposals')).some(value => value.state === 'approved' && value.expectedRevision > 0 && value.policy.checkpointCount === 0)
  }
  return operations.every(value => value.downloadedBytes === 0)
    && preflights.some(value => value.status === 'reusable')
    && savedRows(resolve(run, 'environment-operations-v1'), 'receipt.v1.json').some(value => value.borrowed?.mode === 'borrowed-readonly')
}
async function checkProgramFlow(submission, run) {
  const id = submission.experimentId, signal = AbortSignal.timeout(300000), environmentPolicy = managedEnvironmentPolicySchema.parse(config.environmentPolicy ?? {})
  const context = { sessionId: 'program-only-' + id, planRevision: 1 }
  const node = (operation, body = {}) => request(nodePort, nodeToken, '/aspera/v4/node/' + operation, { experimentId: id, ...body })
  await node('allocate', { deploymentId: submission.deploymentId, node: submission.nodes[0], protocol: 4 })
  const fixture = JSON.parse(readFileSync(resolve(run, 'workspace/env/storage-fixture.json'), 'utf8'))
  const environment = async (action, fields = {}) => {
    const operationId = randomUUID(), body = { environmentId: 'training', operationId, action, requirements: fixture.requirements, modules: fixture.modules, requireCuda: false, ...fields }
    return prepareEnvironmentAndWait({ experimentId: id, serverId: sid, operationId, policy: environmentPolicy, signal,
      transport: { submit: () => node('environment-prepare', { ...body, evidenceContext: context }), read: () => node('environment-status', { operationId }) } })
  }
  const material = async (action, fields = {}) => {
    const operationId = randomUUID()
    return prepareMaterialAndWait({ experimentId: id, serverId: sid, operationId, materialId: fixture.materialId, policy: environmentPolicy, signal,
      submit: () => node('material-prepare', { operationId, materialId: fixture.materialId, action, ...fields, evidenceContext: context }), read: () => node('material-status', { operationId }) })
  }
  try {
    const initialPolicy = { ...policy, checkpointCount: 1 }
    const original = await node('storage-policy-status', { evidenceContext: context, approvedStoragePolicy: initialPolicy })
    const checked = await environment('verify-reuse', { reuseCandidateId: fixture.environmentCandidate })
    assert.equal(checked.operation.preflight.status, 'repair-required')
    const repaired = await environment('repair', { repairPlanId: checked.operation.repairPlans[0].id })
    assert.equal(repaired.state, 'completed', JSON.stringify(repaired))
    const verified = await material('verify')
    assert.equal(verified.state, 'completed', JSON.stringify(verified)); assert.equal(verified.verificationStatus, 'partial')
    const assess = (outputBytes, mode = 'preview', revision = original.current.revision) => node('storage-assess', { evidenceContext: context, approvedStoragePolicy: initialPolicy,
      operationId: randomUUID(), mode, policyRevision: revision, environmentId: 'training', requirements: fixture.requirements,
      outputBytes, checkpointBytes: 4096, materialRequirements: { planRevision: 1, complete: true,
        materials: [{ kind: 'model', repository: 'Qwen/Qwen3.5-9B', revision: 'c202236235762e1c871ad0ccb60c8ee5ba337b9a', files: fixture.materialFiles, materialId: fixture.materialId }] } })
    const first = await assess(64 * 1024 ** 2), corrected = await assess(4 * 1024 ** 2)
    assert.equal(first.state, 'ready', JSON.stringify(first)); assert.equal(corrected.state, 'ready', JSON.stringify(corrected))
    const proposal = await node('storage-policy-propose', { operationId: randomUUID(), expectedRevision: original.current.revision, policy,
      reason: 'Isolated test no longer retains the temporary snapshot', evidenceContext: context })
    assert.equal((await node('storage-policy-status')).current.revision, original.current.revision)
    const decision = await node('storage-policy-decide', { proposalId: proposal.proposalId, expectedRevision: original.current.revision, approve: true })
    const admitted = await assess(4 * 1024 ** 2, 'commit', decision.revision)
    assert.equal(admitted.state, 'ready', JSON.stringify(admitted))
    const acquired = await material('acquire', { budgetId: admitted.operationId })
    assert.equal(acquired.state, 'completed', JSON.stringify(acquired))
    const repeated = await environment('create')
    assert.equal(repeated.state, 'completed', JSON.stringify(repeated)); assert.equal(repeated.reusePlan.downloadBytes, 0)
    const repeatedMaterial = await material('acquire', { budgetId: admitted.operationId })
    assert.equal(repeatedMaterial.state, 'completed', JSON.stringify(repeatedMaterial)); assert.equal(repeatedMaterial.downloadedBytes, 0)
    const accepted = await node('environment-acceptance')
    assert.equal(accepted.verified, true, JSON.stringify(accepted))
    return { name: 'authenticated-program-flow', modelCalled: false, preflight: checked.operation.preflight, first, corrected,
      initialPolicy: original.current, proposal, decision, admitted, acquired, repeated: repeated.reusePlan, repeatedMaterial, accepted }
  } finally { assert.equal((await node('release')).released, true, 'The program-only test must release its actual node allocation') }
}
try {
  nodePort = await start('node', 0)
  const scope = '这是存储架构隔离测试，不进行训练，不下载完整模型。保留所有旧环境与材料。使用 scoped tools 完成真实检查，根据诊断自主选择处理方案。计划的 storagePolicy 使用 other、checkpointCount=0、不保留 optimizer/scheduler、无 recoveryPoints、outputMinimumBytes=1024、checkpointMinimumBytes=0，保留测试报告。'
  const goals = config.cases ?? [{ name: 'historical-source', objective: scope + '只读调查原实验 32289b60-dfeb-460a-870b-7d72a5ad2ffb 的 pyenv，检查 decord==0.6.0 的环境复用可行性，记录具体完整性差异。不要安装或修复该历史源。' }]
  const cases = []
  for (const [index, item] of goals.entries()) {
    const submission = initialize(item.name, item.objective), run = submission.coordinator.storagePlacement.runRoot
    if (config.prepareCase) execFileSync('python3', ['-B', config.prepareCase, JSON.stringify({ root, control, submission, case: item.name,
      sourceControl: config.sourceControl, managed: managedEnvironmentConfig({ experimentId: submission.experimentId,
        node: submission.nodes[0], deploymentId: submission.deploymentId, controlRoot: control, hiddenPaths: [...submission.nodes[0].hiddenPaths, submission.coordinator.storagePlacement.namespaceRoot] },
      managedEnvironmentPolicySchema.parse(config.environmentPolicy ?? {}), 'inspect') })], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 })
    const plan = { revision: 1, summary: item.objective, steps: item.name === 'historical-source'
      ? ['核验历史环境完整性及适用性，保留原始来源', '记录诊断、处理选择及证据']
      : ['核验环境与材料来源并选择可行方案', '准备当前测试环境、材料和容量策略', '执行已有小型检查并记录最终证据'], frameworks: [],
      storagePolicy: { ...policy, ...item.policy }, createdAt: Date.now() }
    const record = clusterRecordSchema.parse({ submission, payloadHash: createHash('sha256').update(JSON.stringify(submission)).digest('hex'),
      sequence: 100 + index, revision: 1, state: 'awaiting-approval', resourcesReleased: true, updatedAt: Date.now(), handover: CLUSTER_HANDOVER, plan, executions: [], services: [] })
    write(resolve(control, 'state/coordinator-home/storages/aspera_queue/experiments', submission.experimentId + '.json'), { version: 4, record })
    cases.push({ item, submission, run })
  }
  const coordinatorPort = await start('coordinator', nodePort + 1)
  report.planSource = 'Initial isolated fixture approved through the production coordinator; real execution model and tools are unchanged'
  if (config.programBaseline) {
    const baseline = cases.shift()
    assert.ok(baseline, 'The reuse validation requires an independent program baseline')
    report.cases.push(await checkProgramFlow(baseline.submission, baseline.run))
    const cancelled = await request(coordinatorPort, coordinatorToken, '/aspera/v4/cancel', { experimentId: baseline.submission.experimentId })
    assert.equal(cancelled.resourcesReleased, true, 'The baseline must be released before a model may borrow it')
  }
  if (config.programOnly) {
    const test = cases[0]
    try { report.cases.push(await checkProgramFlow(test.submission, test.run)) }
    finally { for (const test of cases) await request(coordinatorPort, coordinatorToken, '/aspera/v4/cancel', { experimentId: test.submission.experimentId }) }
  } else for (const { item, submission, run } of cases) {
    const started = Date.now(), deadline = started + (config.caseTimeoutMs ?? 900000)
    let status, approved = false, scenarioAccepted = false, acceptance
    while (Date.now() < deadline) {
      status = await request(coordinatorPort, coordinatorToken, '/aspera/v4/status', { experimentId: submission.experimentId })
      if (status.record.state === 'awaiting-approval') {
        assert.equal(approved, false, 'A test must not approve a changed plan twice')
        const { basis: _basis, ...actual } = status.record.plan.storagePolicy ?? {}
        const { basis: _expectedBasis, ...expected } = { ...policy, ...item.policy }
        assert.deepEqual(actual, expected, 'The generated plan must retain the fixed test content; explanatory wording is free')
        await request(coordinatorPort, coordinatorToken, '/aspera/v4/approve', { experimentId: submission.experimentId, revision: status.record.plan.revision }); approved = true
      }
      if (approved && status.record.state === 'running' && !status.record.resourcesReleased) {
        const policies = await request(nodePort, nodeToken, '/aspera/v4/node/storage-policy-status', { experimentId: submission.experimentId })
        for (const proposal of policies.proposals.filter(value => value.state === 'pending')) {
          assert.ok(proposal.policy.checkpointCount <= 1 && proposal.policy.artifact === 'other', 'Policy confirmation is restricted to the synthetic validation')
          await request(nodePort, nodeToken, '/aspera/v4/node/storage-policy-decide', { experimentId: submission.experimentId, proposalId: proposal.proposalId, expectedRevision: proposal.expectedRevision, approve: true })
        }
        if (!scenarioAccepted && scenarioEvidence(item, run)) {
          if (item.name !== 'historical-source') {
            acceptance = await request(nodePort, nodeToken, '/aspera/v4/node/environment-acceptance', { experimentId: submission.experimentId })
            assert.equal(acceptance.verified, true, 'The node independently checks the prepared environment before the test is stopped: ' + JSON.stringify(acceptance))
          }
          scenarioAccepted = true
          await request(coordinatorPort, coordinatorToken, '/aspera/v4/cancel', { experimentId: submission.experimentId })
        }
      }
      if (['completed', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(status.record.state) && status.record.resourcesReleased) break
      await delay(1000)
    }
    if (!status?.record.resourcesReleased) await request(coordinatorPort, coordinatorToken, '/aspera/v4/cancel', { experimentId: submission.experimentId })
    const events = eventsAt(run)
    const calls = events.filter(value => value.event.type === 'tool/call').map(value => value.event.data)
    const preflights = existsSync(resolve(run, 'storage-preflight-v2/environments')) ? readdirSync(resolve(run, 'storage-preflight-v2/environments')).map(name => JSON.parse(readFileSync(resolve(run, 'storage-preflight-v2/environments', name), 'utf8')).preflight) : []
    const result = { name: item.name, experimentId: submission.experimentId, state: status?.record.state, resourcesReleased: status?.record.resourcesReleased,
      seconds: (Date.now() - started) / 1000, approved, events: events.length,
      startedModelSteps: events.filter(value => value.event.type === 'step/start').length,
      completedModelResponses: events.filter(value => value.event.type === 'assistant/message' && value.event.data.message.source?.kind === 'model').length,
      scenarioAccepted, acceptance, stoppedAfterScenarioValidation: scenarioAccepted && status?.record.state === 'cancelled',
      calls: calls.map(call => ({ name: call.name, arguments: call.arguments })), preflights, run }
    report.cases.push(result); write(resolve(root, 'qwen-result.json'), report)
    assert.ok(calls.some(call => call.name === 'prepare_experiment_environment'), 'The actual model must call environment preparation')
    assert.ok(preflights.length > 0, 'Actual model requests must produce real readonly preflight evidence')
    assert.ok(status?.record.resourcesReleased, 'The test must confirm resource release')
    assert.equal(scenarioAccepted, true, 'Independent scenario evidence must be complete; this does not certify a training Goal')
    if (item.name === 'historical-source') {
      assert.ok(preflights.some(value => value.status === 'repair-required' && /decord-0\.6\.0.*RECORD|RECORD.*decord-0\.6\.0/.test(value.detail)), 'The actual historical decord mismatch must be independently observed')
      assert.ok(!calls.some(call => call.name === 'prepare_experiment_environment' && JSON.parse(JSON.parse(call.arguments).json).action !== 'verify-reuse'), 'Read-only investigation must not install or repair another environment')
    }
    else {
      const plans = readdirSync(resolve(run, 'storage-plans-v1')).map(name => JSON.parse(readFileSync(resolve(run, 'storage-plans-v1', name), 'utf8')))
      assert.ok(plans.some(value => value.mode === 'commit' && value.state === 'ready'), 'The Agent must commit an admitted budget')
      const operations = readdirSync(resolve(run, 'material-operations-v1')).map(name => JSON.parse(readFileSync(resolve(run, 'material-operations-v1', name, 'receipt.v1.json'), 'utf8')))
      assert.ok(operations.some(value => value.action === 'acquire' && value.state === 'completed'), 'The Agent must publish complete selected auxiliary materials')
      if (item.name === 'isolated-flow') {
        assert.ok(calls.some(call => call.name === 'propose_experiment_storage_policy'), 'The Agent must request the semantic policy revision')
        assert.ok(operations.some(value => value.verificationStatus === 'partial'), 'The Agent must encounter real partial reuse')
      } else assert.equal(operations.reduce((sum, value) => sum + value.downloadedBytes, 0), 0, 'Repeated preparation must reuse verified file contents')
      result.materialOperations = operations.map(value => ({ operationId: value.operationId, action: value.action, state: value.state, downloadedBytes: value.downloadedBytes, reusedBytes: value.reusedBytes }))
    }
  }
  report.passed = true
} catch (error) {
  report.passed = false; report.error = String(error); report.errorStack = error instanceof Error ? error.stack : undefined; process.exitCode = 1
} finally {
  for (const item of children.reverse()) {
    if (item.child.exitCode !== null) continue
    const timer = setTimeout(() => { item.child.kill('SIGKILL') }, 30000)
    item.child.kill('SIGTERM'); try { await item.done } finally { clearTimeout(timer) }
  }
  report.finishedAt = new Date().toISOString(); write(resolve(root, 'qwen-result.json'), report)
  console.log(JSON.stringify(report))
}
