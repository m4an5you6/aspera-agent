/** Real Web composition with deterministic remote-execution replies. SSH/GPU behavior has separate owner tests. */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, expect, it, onTestFailed, vi } from 'vitest'
import type { ExperimentDispatchRemote, FleetExperiment } from '@deepseek-ai/dsh-experiment-dispatch'
import type { ClusterRecord, ExperimentId, ExperimentServerId } from '@deepseek-ai/dsh-experiment-worker'
import { launchWebScaffold, watchConsole, compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'
const expected = fileURLToPath(new URL('./expected/experiments', import.meta.url))
let scaffold: WebScaffold
let browser: Browser
let page: Page
let remote: ExperimentDispatchRemote
let tripwire: ReturnType<typeof watchConsole>
const rows: FleetExperiment[] = []
let log = 'step 1: loss=0.8\n'
const idMap = new Map<string, string>()

beforeAll(async () => {
  scaffold = await launchWebScaffold({})
  remote = scaffold.ctx.get('experimentDispatch') as ExperimentDispatchRemote
  expect(remote).toBeDefined()
  vi.spyOn(remote, 'experiments').mockImplementation(() => structuredClone(rows))
  vi.spyOn(remote, 'createExperiment').mockImplementation(async (input) => {
    const registry = remote.servers()
    const servers = registry.servers.filter(server => input.serverIds.includes(server.id))
    const id = input.experimentId as ExperimentId
    idMap.set(id, `EXPERIMENT_${rows.length + 1}`)
    const submission = { protocol: 2 as const, experimentId: id, deploymentId: 'a'.repeat(64), objective: input.objective,
      coordinator: registry.servers[0]!, nodes: servers.map(server => ({ server, devicePaths: ['/dev/nvidia0'],
        backendPath: '/usr/bin/bwrap', hiddenPaths: [], gpuInfo: 'GPU 0' })),
      inputs: [], createdAt: 1 }
    const target = { ...servers[0]!, localRepo: scaffold.workspaceCwd, dataRoots: [], allowedSystemPackages: [],
      agentCredentialRefs: [], tokenRef: 'TEST', controlPollIntervalMs: 1000, toolTimeoutMs: 30000 }
    const row: FleetExperiment = { request: { experimentId: id, objective: input.objective,
      serverIds: input.serverIds as ExperimentServerId[], files: input.files ?? [], uploads: input.uploads ?? [] },
    coordinator: registry.servers[0]!, servers, coordinatorTarget: target, targets: servers.map(server => ({ ...target, ...server })),
    sessionId: `dispatch-${id}`, createdAt: rows.length + 1, state: 'preparing', handoverRecorded: false, waitingFor: [], submission }
    rows.push(row)
    return structuredClone(row)
  })
  vi.spyOn(remote, 'refreshExperiment').mockImplementation(async id => structuredClone(rows.find(row => row.request.experimentId === id)!))
  vi.spyOn(remote, 'readExperiment').mockImplementation(async (_id, kind, offset) => {
    const bytes = Buffer.from(kind === 'log' ? log : kind === 'events' ? JSON.stringify({ seq: 7, type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '所有节点已准备，开始联合训练。' }] } } }) + '\n' : '')
    return { generation: 'log-1', offset, nextOffset: bytes.length, data: bytes.subarray(offset).toString('base64'),
      eof: true, reset: false }
  })
  vi.spyOn(remote, 'experimentFiles').mockImplementation(async (_id,
    serverId) => ({ files: [{ serverId: serverId as ExperimentServerId, path: 'output.txt', size: 6, modifiedAt: 0 }], truncated: false }))
  vi.spyOn(remote, 'cancelExperiment').mockImplementation(async (id) => {
    const row = rows.find(row => row.request.experimentId === id)!
    row.latest = { ...row.latest!, state: 'cancelled', resourcesReleased: true, revision: row.latest!.revision + 1 }
    return structuredClone(row)
  })
  vi.spyOn(remote, 'downloadExperimentFile').mockResolvedValue('/test-experiment-download')
  scaffold.ctx.effect(() => scaffold.ctx.webServer.register({ kind: 'prefix', path: '/test-experiment-download',
    handler: async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="output.txt"' }); res.end('result')
    } }))
  browser = await chromium.launch(process.env.DSH_WEB_E2E_BROWSER_CHANNEL === 'chrome' ? { channel: 'chrome' } : {})
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
  tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '实验', exact: true }).click()
}, 180_000)
afterAll(async () => { await browser?.close(); vi.restoreAllMocks(); await scaffold?.close() })

it('saves password servers, submits multiple Goals, and shows queued receipts, resumed logs, errors and downloads', async () => {
  onTestFailed(async () => { await writeFile('.artifacts/experiments-browser-failure.txt',
    JSON.stringify(tripwire.pageErrors) + '\n' + await page.locator('body').ariaSnapshot()) })
  const panel = page.getByRole('heading', { name: '实验', exact: true }).locator('../../..')
  await panel.getByRole('button', { name: '服务器', exact: true }).click()
  for (const name of ['GPU A', 'GPU B']) {
    await panel.getByRole('button', { name: '添加服务器', exact: true }).click()
    await panel.getByLabel('名称', { exact: true }).fill(name)
    await panel.getByLabel('SSH 地址', { exact: true }).fill(name === 'GPU A' ? 'gpu-a.example.test' : 'gpu-b.example.test')
    await panel.getByLabel('用户名', { exact: true }).fill('trainer')
    await panel.getByLabel('服务器密码', { exact: true }).fill('test-only-password')
    await panel.getByLabel('远端目录', { exact: true }).fill('/srv/experiments')
    await panel.getByLabel('训练网络地址', { exact: true }).fill(name === 'GPU A' ? '10.0.0.1' : '10.0.0.2')
    await panel.getByRole('button', { name: '保存服务器', exact: true }).click()
    await panel.getByRole('heading', { name: new RegExp(name) }).waitFor()
  }
  const registry = remote.servers()
  expect(registry.servers).toHaveLength(2)
  expect(registry.coordinatorId).toBe(registry.servers[0]!.id)
  expect(JSON.stringify(registry)).not.toContain('test-only-password')
  await compareOrRefreshGolden(join(expected, 'servers.expected.md'), await panel.ariaSnapshot(), webSnapshotMode())
  for (const objective of ['联合短训练 A', '独立短训练 B']) {
    await panel.getByRole('button', { name: '新建实验', exact: true }).click()
    await panel.getByLabel('Goal', { exact: true }).fill(objective)
    await panel.getByRole('checkbox', { name: /GPU A/ }).check()
    if (objective.endsWith('A')) await panel.getByRole('checkbox', { name: /GPU B/ }).check()
    await panel.getByRole('button', { name: '提交实验', exact: true }).click()
    await panel.getByRole('heading', { name: objective, exact: true }).waitFor()
    await panel.getByRole('status').filter({ hasText: '准备中' }).waitFor()
  }
  expect(rows).toHaveLength(2)
  expect(rows[0]!.sessionId).not.toBe(rows[1]!.sessionId)
  for (const [index, row] of rows.entries()) {
    const accepted: ClusterRecord = { submission: row.submission!, payloadHash: 'b'.repeat(64), sequence: index, revision: 1,
      state: 'queued', resourcesReleased: true, updatedAt: 1, handover: '本机派发完成，远端实验已接管' }
    row.state = 'submitted'; row.receipt = accepted; row.latest = accepted; row.handoverRecorded = true
  }
  scaffold.ctx.emit('experiment-fleet/changed', { kind: 'experiments' })
  await panel.getByText('本机派发完成，远端实验已接管', { exact: true }).waitFor()
  await panel.getByRole('status').filter({ hasText: '排队中' }).waitFor()
  let snapshot = await panel.ariaSnapshot()
  for (const [id, label] of idMap) snapshot = snapshot.replaceAll(id, label)
  await compareOrRefreshGolden(join(expected, 'handover.expected.md'), snapshot, webSnapshotMode())
  await panel.getByRole('button', { name: '执行会话', exact: true }).click()
  await panel.getByText('所有节点已准备，开始联合训练。', { exact: true }).waitFor()
  await panel.getByRole('button', { name: '节点日志', exact: true }).click()
  await panel.getByText('step 1: loss=0.8', { exact: false }).waitFor()
  log += 'step 2: loss=0.4\n'
  await panel.getByRole('button', { name: '刷新', exact: true }).click()
  await panel.getByText('step 2: loss=0.4', { exact: false }).waitFor()
  expect(await panel.locator('pre').first().textContent()).toBe(log)
  rows[1]!.latest = { ...rows[1]!.latest!, state: 'failed', detail: '节点间通信检查失败', revision: 2 }
  await panel.getByRole('button', { name: '刷新', exact: true }).click()
  await panel.getByRole('alert').filter({ hasText: '节点间通信检查失败' }).waitFor()
  await panel.getByRole('button', { name: '输出文件', exact: true }).click()
  const downloaded = page.waitForEvent('download')
  await panel.getByRole('button', { name: '下载', exact: true }).first().click()
  const file = await downloaded
  const stream = await file.createReadStream(); const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  expect(Buffer.concat(chunks).toString()).toBe('result')
  await panel.getByRole('button', { name: '复制为新实验', exact: true }).click()
  expect(await panel.getByRole('textbox', { name: 'Goal', exact: true }).inputValue()).toBe('独立短训练 B')
  expect(await panel.getByRole('checkbox', { name: /GPU A/ }).isChecked()).toBe(true)
  expect(tripwire.pageErrors).toEqual([])
}, 120_000)
