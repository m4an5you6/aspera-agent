/** CPU-only observations used by installed-profile tests; no real disk durability is asserted. */
import { createHash, randomUUID } from 'node:crypto'
import { resolveStoragePlacement } from '@aspera/runtime'
import { serverInventorySchema } from '@aspera/experiments'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

export function inventory(directory = '/fixture/data') {
  const home = '/home/trainer'
  const candidates = [...new Set([directory, home])].map(path => {
    const mount = { mountPoint: path, root: '/', source: path === home ? '/dev/system-fixture' : '/dev/data-fixture', filesystem: 'ext4', device: path === home ? '8:1' : '8:2' }
    return { id: createHash('sha256').update(JSON.stringify({ directory: path, mount })).digest('hex'), directory: path, mount,
      availableBytes: 20_000_000_000, totalBytes: 40_000_000_000, writable: true, systemVolume: path === home, persistence: 'unknown' }
  })
  return serverInventorySchema.parse({ observedAt: 1, home, candidates, addresses: [{ interface: 'eth0', address: '10.0.0.1', family: 'IPv4', private: true }], routes: [] })
}

export function resolvedFixture(server, experimentId, digest) {
  const observed = inventory(server.remoteRoot)
  return { server: { ...server, storagePlacement: resolveStoragePlacement(server, experimentId, digest, observed, observed.candidates[0].id, 'Explicit CPU fixture path', 1024) }, inventory: observed }
}

/** Replay model responses through the production preparation Agent and its actual tools. */
export function installStorageReplay(ctx, observedCalls) {
  const turns = new Map()
  ctx.on('llm/stream', async function* (options, next) {
    let input
    for (const message of options.messages) for (const block of message.content ?? []) {
      if (block.type !== 'text' || !block.text.startsWith('{')) continue
      try { const value = JSON.parse(block.text); if (value.operation === 'prepare-experiment-storage') input = value }
      catch (error) { if (!(error instanceof SyntaxError)) throw error }
    }
    if (input === undefined) { yield* next(); return }
    const names = (options.tools ?? []).map(tool => tool.name).sort()
    if (JSON.stringify(names) !== JSON.stringify(['inspect_server_storage', 'select_experiment_storage'])) throw new Error('Preparation tool scope changed: ' + names.join(','))
    const step = turns.get(input.experimentId) ?? 0
    turns.set(input.experimentId, step + 1)
    const pending = input.servers.filter(server => server.selected === undefined)
    const server = pending[Math.floor(step / 2)]
    if (server === undefined) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Storage choices are recorded; continue deployment.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const candidate = server.inventory.candidates.find(value => value.writable && !value.systemVolume && value.availableBytes >= input.minimumFreeBytes)
    if (candidate === undefined) throw new Error('CPU replay has no eligible data candidate')
    const name = step % 2 === 0 ? 'inspect_server_storage' : 'select_experiment_storage'
    const args = step % 2 === 0 ? { server_id: server.id } : { server_id: server.id, candidate_id: candidate.id, reason: 'The observed data disk has sufficient free space; cloud persistence is unknown.' }
    observedCalls.push({ experimentId: input.experimentId, name })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }, { global: true })
}
