/** Run production planning/execution profiles through published adapters and keyless replay. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setupWorkerProfile } from '@aspera/runtime'
import { clusterSubmissionSchema } from '@aspera/experiments'
import { removeTestDirectory } from './test-app.mjs'
import { resolvedFixture } from './fixtures/storage.mjs'
import { fixtureModelSnapshots, fixtureSelections } from './fixtures/models.mjs'
import { createWorkerApi } from './fixtures/worker-api.mjs'

const release = resolve(import.meta.dirname, '..')
mkdirSync(resolve(release, '.artifacts'), { recursive: true })
const directory = mkdtempSync(resolve(release, '.artifacts/worker-test-'))
const api = await createWorkerApi()
const selected = process.argv.find(argument => argument.startsWith('--case='))?.slice('--case='.length)
if (selected !== undefined) assert.ok(['node', 'command-wait', 'command-group', 'context-pressure', 'token-limit', 'token-limit-plan', 'managed-environments'].includes(selected), 'Unknown focused worker case')
try {
  const modelFixture = fixtureModelSnapshots(api.baseURL)
  const root = process.platform === 'win32' ? directory.slice(2).replaceAll('\\', '/') : directory
  const generation = randomUUID(); const id = randomUUID(); const serverId = randomUUID()
  const { server, inventory } = resolvedFixture({ id: serverId, name: 'Local replay', host: 'fixture.test', sshPort: 22, username: 'trainer', remotePort: 43019, remoteRoot: root, authMode: 'password' }, id, 'a'.repeat(64))
  const submission = clusterSubmissionSchema.parse({ protocol: 4, name: 'CPU fixture', models: modelFixture.models, experimentId: id, deploymentId: 'a'.repeat(64), inventories: [{ serverId, inventory }], objective: 'Prepare a version-specific experiment',
    coordinator: server, nodes: [{ server, devicePaths: ['/dev/nvidia_fixture'], backendPath: '/fixture/bwrap', hiddenPaths: [], gpuInfo: 'Replay; no GPU' }],
    inputs: [{ name: 'data.txt', sha256: createHash('sha256').update('dataset row\n').digest('hex') }], createdAt: 1, strategy: { mode: 'automatic', coordinator: 'single-agent' },
    versions: { dsh: '0.2.0-rc.2', extension: '0.1.1', harness: 'a'.repeat(64), data: [] } })
  const run = resolve(directory, 'runs', id)
  mkdirSync(resolve(directory, 'secrets'), { recursive: true })
  mkdirSync(resolve(directory, 'state'), { recursive: true })
  mkdirSync(resolve(run, 'agent-workspace'), { recursive: true })
  mkdirSync(resolve(run, 'inputs'), { recursive: true })
  writeFileSync(resolve(run, 'inputs/data.txt'), 'dataset row\n')
  const modelFile = resolve(directory, 'secrets/model.json')
  writeFileSync(modelFile, JSON.stringify({ version: 1, refs: modelFixture.refs }))
  writeFileSync(resolve(directory, 'state/coordinator.generation'), generation)
  writeFileSync(resolve(directory, 'secrets', id + '.json'), JSON.stringify({ submission, connections: [{ serverId, password: 'not-model-visible', token: 'b'.repeat(32), knownHostsFile: '/fixture/known_hosts' }],
    modelCredentialFile: modelFile, toolTimeoutMs: 1000, agentModel: fixtureSelections.preparation }))
  writeFileSync(resolve(run, 'approved-plan.json'), JSON.stringify({ revision: 1, summary: 'Approved local replay', steps: ['Record a version', 'Report unavailable GPU'], frameworks: [], createdAt: 1 }))
  const snapshots = []
  for (const scenario of [{ planning: true, http: true }, { planning: false, http: true }, { planning: false, http: true, nodeCommands: true }, { planning: true, renewRounds: 132 }, { planning: true, transient: true },
    { planning: false, http: true, nodeCommands: true, commandWait: true },
    { planning: false, http: true, nodeCommands: true, commandGroup: true },
    { planning: false, http: true, managedEnvironments: true },
    { planning: false, http: true, nodeCommands: true, stepReports: true, stepCommands: true },
    { planning: false, http: true, nodeCommands: true, stepReports: true, stepCommands: false },
    { planning: false, http: true, nodeCommands: true, stepReports: true, stepCommands: true, contextPressure: true },
    { planning: false, http: true, nodeCommands: true, tokenLimit: true },
    { planning: true, http: true, tokenLimit: true }]) {
    const { planning, renewRounds, transient } = scenario
    const caseName = scenario.commandGroup ? 'command-group' : scenario.commandWait ? 'command-wait' : scenario.managedEnvironments ? 'managed-environments' : scenario.contextPressure ? 'context-pressure' : scenario.tokenLimit ? planning ? 'token-limit-plan' : 'token-limit' : scenario.stepReports ? scenario.stepCommands ? 'step-execution' : 'step-acceptance-failure' : scenario.nodeCommands ? 'node' : transient ? 'recovery' : renewRounds ? 'renew' : planning ? 'plan' : 'execution'
    if (selected !== undefined && caseName !== selected) continue
    const home = resolve(directory, caseName + '-home')
    await setupWorkerProfile(home, release)
    const observed = resolve(directory, caseName + '-observed.json')
    for (const name of ['command-waits-v1', 'command-groups-v1', 'stage-acceptance-v1']) {
      const path = resolve(run, name)
      assert.ok(path.startsWith(run + (process.platform === 'win32' ? '\\' : '/')), 'Replay cleanup must remain inside its owned run')
      rmSync(path, { force: true, recursive: true })
    }
    rmSync(resolve(run, 'finish-decision.v1.json'), { force: true })
    rmSync(resolve(run, 'executions.jsonl'), { force: true })
    rmSync(resolve(run, 'execution-sources.v1.jsonl'), { force: true })
    if (scenario.stepReports) rmSync(resolve(run, 'execution-progress.v1.json'), { force: true })
    const config = { id, serverId, observed, runRoot: run, ...scenario }
    writeFileSync(resolve(directory, 'secrets', id + '.json'), JSON.stringify({ submission: {
      ...submission, objective: scenario.contextPressure ? 'Execute the fixed approved plan. Historical measured requirement: ' + 'fixed input evidence '.repeat(900) : submission.objective },
      connections: [{ serverId, password: 'not-model-visible', token: 'b'.repeat(32), knownHostsFile: '/fixture/known_hosts' }], modelCredentialFile: modelFile, toolTimeoutMs: 1000, agentModel: fixtureSelections.preparation }))
    const wire = api.begin(config)
    const profile = resolve(home, 'profiles/aspera-worker')
    const manifestPath = resolve(profile, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dependencies['@deepseek-ai/dsh-llm'] = '0.2.0-rc.2'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    writeFileSync(resolve(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'keyless-worker-replay',
      name: pathToFileURL(resolve(release, 'scripts/fixtures/worker.mjs')).href, config }] }]))
    writeFileSync(resolve(run, 'events.jsonl'), '')
    rmSync(resolve(run, planning ? 'planning-outcome.json' : 'outcome.json'), { force: true })
    const child = spawn(process.execPath, [resolve(release, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'aspera-worker'],
      { cwd: release, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DSH_HOME: home,
        DSH_EXPERIMENT_ROLE: planning ? 'planner' : 'agent', DSH_CLUSTER_ROOT: root, DSH_CLUSTER_EXPERIMENT: id, DSH_CLUSTER_GENERATION: generation,
        DSH_EXPERIMENT_TOKEN_FILE: resolve(directory, 'secrets/coordinator.token'), DSH_EXPERIMENT_DEPLOYMENT_ID: 'a'.repeat(64),
        DSH_EXPERIMENT_MODEL_CREDENTIAL_FILE: modelFile, DSH_EXPERIMENT_PORT: '0', DSH_CLUSTER_GOAL_WINDOW: renewRounds ? '2' : '128',
        DSH_CLUSTER_CONTEXT_POLICY_JSON: JSON.stringify(scenario.contextPressure ? { compaction: { thresholdRatio: 0.03, headroomTokens: 1024, retainRatio: 0.001, maxTokens: 512 }, pruning: {} } : {}),
        DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: '' } })
    let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    wire.onError = () => { child.kill('SIGTERM') }
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, renewRounds ? 180000 : 60000)
    try {
      await once(child, 'exit')
      assert.equal(timedOut, false, caseName + ': ' + output.slice(-6000) + '\n' + readFileSync(resolve(run, 'events.jsonl'), 'utf8').slice(-6000))
      if (wire.error) throw new Error(caseName + ': Worker HTTP replay failed: ' + output.slice(-6000), { cause: wire.error })
      const outcome = JSON.parse(readFileSync(resolve(run, planning ? 'planning-outcome.json' : 'outcome.json'), 'utf8'))
      assert.equal(outcome.state, scenario.tokenLimit ? 'blocked' : scenario.stepReports ? scenario.stepCommands ? 'completed' : 'blocked' : planning ? 'completed' : 'blocked', output.slice(-6000) + '\n' + JSON.stringify(outcome))
      if (scenario.stepReports) {
        const progress = JSON.parse(readFileSync(resolve(run, 'execution-progress.v1.json'), 'utf8'))
        assert.equal(progress.revision, 5); assert.deepEqual(progress.steps.map(step => step.state), ['completed', 'completed'])
        if (!scenario.stepCommands) assert.match(outcome.detail, /successful settled commands/)
      }
      const observations = JSON.parse(readFileSync(observed, 'utf8'))
      if (scenario.commandWait) assert.equal(observations.exclusiveWaitNoModelPolls, true)
      if (scenario.commandGroup) assert.equal(observations.groupStartedBeforeWait, true)
      assert.equal(observations.guidanceRead, true)
      assert.equal(wire.requests > 0, scenario.http === true)
      const source = planning ? 'plan' : 'execution'
      const events = readFileSync(resolve(run, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(item => item.source === source)
      assert.equal(JSON.stringify(events).includes('not-model-visible'), false)
      const changes = events.filter(item => item.event.type === 'goal/change')
      let contextEvidence
      if (scenario.contextPressure) {
        const summaries = events.filter(item => item.event.type === 'compaction/summary')
        assert.ok(summaries.length > 0, 'The real worker must summarize its long context through the private model')
        assert.ok(wire.summaryRequests > 0)
        assert.equal(observations.nodeLaunches, 1, 'Compaction must not repeat the settled command')
        assert.ok(events.some(item => item.event.type === 'tool/call' && item.event.seq > summaries[0].event.seq
          && item.event.data.name === 'finish_experiment'))
        for (const { event } of summaries) assert.equal(event.data.model, 'qwen-execution')
        contextEvidence = { compactionLogged: true, privateSummaryRequest: true, continuedAfterCompaction: true, commandStartedOnce: true }
      }
      if (scenario.tokenLimit) {
        assert.match(outcome.detail, /max-tokens/)
        assert.equal(observations.nodeLaunches, planning ? undefined : 1)
        assert.ok(events.some(item => item.event.type === 'turn/end' && item.event.data.reason.kind === 'max-tokens'))
        assert.equal(changes.at(-1).event.data.goal.blockedReason.code, 'aspera-model-token-limit')
      }
      if (renewRounds) {
        assert.equal(observations.rounds, 132)
        assert.equal(new Set(changes.map(item => item.event.data.goal.id)).size, 1)
        assert.equal(new Set(events.map(item => item.sessionId)).size, 1)
        const windows = changes.filter(item => item.event.data.operation === 'edit').map(item => item.event.data.goal.maxGoalRounds)
        assert.ok(windows.length >= 66, JSON.stringify(changes.slice(0, 4)))
        snapshots.push({ role: 'continuation', rounds: observations.rounds, sameGoal: true, sameSession: true, windows, outcome: outcome.state })
      } else snapshots.push({ role: scenario.commandGroup || scenario.commandWait || scenario.managedEnvironments || scenario.tokenLimit ? caseName : scenario.stepReports ? caseName : scenario.nodeCommands ? 'node-execution' : transient ? 'recovery' : source, ...observations, ...(scenario.http ? { adapterRequests: wire.requests } : {}), ...(contextEvidence === undefined ? {} : { contextEvidence }), outcome: outcome.state,
        goalPhases: changes.map(item => item.event.data.goal?.phase) })
    } finally {
      clearTimeout(timer)
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
      }
    }
  }
  const expectedPath = resolve(release, 'scripts/fixtures/worker.snapshot.json')
  if (process.argv.includes('--record')) {
    assert.equal(selected, undefined, 'Snapshot recording requires every worker case')
    writeFileSync(expectedPath, JSON.stringify(snapshots, null, 2) + '\n')
  }
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8'))
  assert.deepEqual(snapshots, selected === undefined ? expected : expected.filter(item => item.role === (selected === 'node' ? 'node-execution' : selected)))
  console.log('Production worker profiles: published provider HTTP requests, scoped tools, restrictions, durable plan/execution evidence and Goal snapshots passed without a model key.')
} finally { await api.close(); removeTestDirectory(directory, resolve(release, '.artifacts')) }
