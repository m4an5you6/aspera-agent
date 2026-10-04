/** Resolve optional node addresses using bidirectional preparation probes. */
import { z } from 'zod'
import type { ClusterNode, ExperimentId, ExperimentServerId, ServerInventory } from '@aspera/experiments'
import { request } from './transport.ts'
import type { DeploymentConfig } from './deploy.ts'

/** Pinned authenticated participant used only by the trusted dispatcher. */
export interface NetworkParticipant {
  node: ClusterNode
  target: DeploymentConfig
  token: string
  password?: string
  inventory: ServerInventory
}

/** Test candidate addresses from every other participant before freezing one per node.
 * @param id - experiment. @param participants - authorized nodes and private credentials.
 * @param signal - preparation lifetime.
 * @param serverId - optionally verify only this node's inbound paths during its preparation interval.
 * @returns nodes with verified training addresses for the requested participants.
 */
export async function resolveTrainingNetwork(id: ExperimentId, participants: NetworkParticipant[], signal: AbortSignal, serverId?: ExperimentServerId): Promise<ClusterNode[]> {
  if (serverId !== undefined && !participants.some(peer => peer.node.server.id === serverId)) throw new Error('Network verification server is outside the selected group')
  if (participants.length === 1) return participants.map(value => value.node)
  const call = async (peer: NetworkParticipant, operation: string, body: object, lifetime?: AbortSignal) => {
    const result = await request(peer.target, peer.token, `/aspera/v4/node/${operation}`, 'POST', { experimentId: id, ...body }, lifetime, peer.password)
    if (result.status !== 200) throw new Error(`${peer.node.server.name}: ${JSON.stringify(result.value)}`)
    return result.value
  }
  const started: NetworkParticipant[] = []
  try {
    const proofs = new Map<ExperimentServerId, object>()
    for (const peer of participants) {
      started.push(peer)
      const proof = z.object({ experimentId: z.literal(id), serverId: z.literal(peer.node.server.id), nonce: z.uuid(), port: z.number().int() }).strict()
        .parse(await call(peer, 'probe-network-start', { serverId: peer.node.server.id }, signal))
      proofs.set(peer.node.server.id, proof)
    }
    const selected: ClusterNode[] = []
    for (const peer of participants) {
      if (serverId !== undefined && peer.node.server.id !== serverId) { selected.push(peer.node); continue }
      const candidates = peer.node.server.trainingAddress === undefined
        ? peer.inventory.addresses.toSorted((a, b) => Number(b.private) - Number(a.private) || a.address.localeCompare(b.address)).map(value => value.address)
        : [peer.node.server.trainingAddress]
      const failures: string[] = []
      let address: string | undefined
      for (const host of [...new Set(candidates)]) {
        signal.throwIfAborted()
        const results = await Promise.allSettled(participants.filter(other => other !== peer)
          .map(async other => z.object({ connected: z.literal(true) }).parse(await call(other, 'probe-network-connect', { host, proof: proofs.get(peer.node.server.id) }, signal))))
        if (results.every(result => result.status === 'fulfilled')) { address = host; break }
        failures.push(`${host}: ${results.flatMap(result => result.status === 'rejected' ? [String(result.reason)] : []).join('; ')}`)
      }
      if (address === undefined) throw new Error(`No mutually reachable internal address for ${peer.node.server.name}. ${failures.join(' | ') || 'No eligible network interface was found.'}`)
      selected.push({ ...peer.node, server: { ...peer.node.server, trainingAddress: address } })
    }
    return selected
  } finally {
    const results = await Promise.allSettled(started.map(peer => call(peer, 'probe-network-stop', {})))
    const failed = results.find(result => result.status === 'rejected')
    // oxlint-disable-next-line no-unsafe-finally -- Admission must fail if a probe listener cannot be confirmed closed.
    if (failed?.status === 'rejected' && !signal.aborted) throw new Error(`Network probe cleanup failed: ${String(failed.reason)}`)
  }
}
