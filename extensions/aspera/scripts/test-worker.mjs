/** Run the production planning/execution profiles using a keyless replay adapter. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setupWorkerProfile } from '@aspera/runtime'
import { clusterSubmissionSchema } from '@aspera/experiments'
import { removeTestDirectory } from './test-app.mjs'

const release = resolve(import.meta.dirname, '..')
mkdirSync(resolve(release, '.artifacts'), { recursive: true })
const directory = mkdtempSync(resolve(release, '.artifacts/worker-test-'))
const root = process.platform === 'win32' ? directory.slice(2).replaceAll('\\', '/') : directory
const generation = randomUUID(); const id = randomUUID(); const serverId = randomUUID()
const server = { id: serverId, name: 'Local replay', host: 'fixture.test', sshPort: 22, username: 'trainer', remotePort: 43019, remoteRoot: root, authMode: 'password' }
const submission = clusterSubmissionSchema.parse({ protocol: 2, experimentId: id, deploymentId: 'a'.repeat(64), objective: 'Prepare a version-specific experiment',
  coordinator: server, nodes: [{ server, devicePaths: ['/dev/nvidia_fixture'], backendPath: '/fixture/bwrap', hiddenPaths: [], gpuInfo: 'Replay; no GPU' }],
  inputs: [{ name: 'data.txt', sha256: createHash('sha256').update('dataset row\n').digest('hex') }], createdAt: 1, strategy: { mode: 'automatic', coordinator: 'single-agent' },
  versions: { dsh: '0.2.0-rc.2', extension: '0.2.0', harness: 'a'.repeat(64), data: [] } })
const run = resolve(directory, 'runs', id)
mkdirSync(resolve(directory, 'secrets'), { recursive: true })
mkdirSync(resolve(directory, 'state'), { recursive: true })
mkdirSync(resolve(run, 'agent-workspace'), { recursive: true })
mkdirSync(resolve(run, 'inputs'), { recursive: true })
writeFileSync(resolve(run, 'inputs/data.txt'), 'dataset row\n')
const modelFile = resolve(directory, 'secrets/model.json')
writeFileSync(modelFile, JSON.stringify({ version: 1, refs: {} }))
writeFileSync(resolve(directory, 'state/coordinator.generation'), generation)
writeFileSync(resolve(directory, 'secrets', id + '.json'), JSON.stringify({ submission, connections: [{ serverId, password: 'not-model-visible', token: 'b'.repeat(32), knownHostsFile: '/fixture/known_hosts' }],
  modelCredentialFile: modelFile, toolTimeoutMs: 1000, agentModel: { provider: 'deepseek', model: 'deepseek-chat' } }))
writeFileSync(resolve(run, 'approved-plan.json'), JSON.stringify({ revision: 1, summary: 'Approved local replay', steps: ['Record a version', 'Report unavailable GPU'], frameworks: [], createdAt: 1 }))
const snapshots = []
try {
  for (const scenario of [{ planning: true }, { planning: false }, { planning: true, renewRounds: 132 }, { planning: true, transient: true }]) {
    const { planning, renewRounds, transient } = scenario
    const home = resolve(directory, transient ? 'recovery-home' : renewRounds ? 'renew-home' : planning ? 'plan-home' : 'execution-home')
    await setupWorkerProfile(home, release)
    const observed = resolve(directory, transient ? 'recovery-observed.json' : renewRounds ? 'renew-observed.json' : planning ? 'plan-observed.json' : 'execution-observed.json')
    const profile = resolve(home, 'profiles/aspera-worker')
    const manifestPath = resolve(profile, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dependencies['@deepseek-ai/dsh-llm'] = '0.2.0-rc.2'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    writeFileSync(resolve(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'keyless-worker-replay',
      name: pathToFileURL(resolve(release, 'scripts/fixtures/worker.mjs')).href, config: { id, serverId, planning, observed, renewRounds, transient } }] }]))
    writeFileSync(resolve(run, 'events.jsonl'), '')
    const child = spawn(process.execPath, [resolve(release, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'aspera-worker'],
      { cwd: release, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DSH_HOME: home,
        DSH_EXPERIMENT_ROLE: planning ? 'planner' : 'agent', DSH_CLUSTER_ROOT: root, DSH_CLUSTER_EXPERIMENT: id, DSH_CLUSTER_GENERATION: generation,
        DSH_EXPERIMENT_TOKEN_FILE: resolve(directory, 'secrets/coordinator.token'), DSH_EXPERIMENT_DEPLOYMENT_ID: 'a'.repeat(64),
        DSH_EXPERIMENT_MODEL_CREDENTIAL_FILE: modelFile, DSH_EXPERIMENT_PORT: '0', DSH_CLUSTER_GOAL_WINDOW: renewRounds ? '2' : '128', DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: '' } })
    let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 60000)
    try {
      await once(child, 'exit')
      assert.equal(timedOut, false, output.slice(-6000))
      const outcome = JSON.parse(readFileSync(resolve(run, planning ? 'planning-outcome.json' : 'outcome.json'), 'utf8'))
      assert.equal(outcome.state, planning ? 'completed' : 'blocked', output.slice(-6000) + '\n' + JSON.stringify(outcome))
      const observations = JSON.parse(readFileSync(observed, 'utf8'))
      assert.equal(observations.guidanceRead, true)
      const source = planning ? 'plan' : 'execution'
      const events = readFileSync(resolve(run, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(item => item.source === source)
      assert.equal(JSON.stringify(events).includes('not-model-visible'), false)
      const changes = events.filter(item => item.event.type === 'goal/change')
      if (renewRounds) {
        assert.equal(observations.rounds, 132)
        assert.equal(new Set(changes.map(item => item.event.data.goal.id)).size, 1)
        assert.equal(new Set(events.map(item => item.sessionId)).size, 1)
        const windows = changes.filter(item => item.event.data.operation === 'edit').map(item => item.event.data.goal.maxGoalRounds)
        assert.ok(windows.length >= 66, JSON.stringify(changes.slice(0, 4)))
        snapshots.push({ role: 'continuation', rounds: observations.rounds, sameGoal: true, sameSession: true, windows, outcome: outcome.state })
      } else snapshots.push({ role: transient ? 'recovery' : source, ...observations, outcome: outcome.state,
        goalPhases: changes.map(item => item.event.data.goal?.phase) })
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
  }
  const expected = JSON.parse(readFileSync(resolve(release, 'scripts/fixtures/worker.snapshot.json'), 'utf8'))
  assert.deepEqual(snapshots, expected)
  console.log('Production worker profiles: scoped tools, plugin/interaction restrictions, framework guidance, durable plan/execution evidence and Goal snapshots passed without a model key.')
} finally { removeTestDirectory(directory, resolve(release, '.artifacts')) }
