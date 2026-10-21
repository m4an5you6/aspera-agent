/** Preparation tools use the same storage service before the new run or controller exists. */
import { posix } from 'node:path'
import { gzipSync } from 'node:zlib'
import { managedEnvironmentProgram, managedEnvironmentPolicySchema, storageGovernancePolicySchema } from '@aspera/runtime'
import type { ManagedEnvironmentPolicy } from '@aspera/runtime'
import type { ServerSettings, ServerInventory, ExperimentId } from '@aspera/experiments'
import { shellQuote } from './transport.ts'
import { inspectExperimentMaterialsSchema } from '@aspera/experiments'
import { fetchCanonicalMaterialMetadata } from './material-metadata.ts'

/** Login credentials remain with the Fleet; model requests cannot supply commands or paths. */
export interface PreparationStorageTransport {
  /** @param server - selected server. @param command - program-owned Python. @param signal - original preparation lifetime. @returns helper stdout. */
  run(server: ServerSettings, command: string, signal: AbortSignal): Promise<string>
  /** @param server - selected server. @param signal - original preparation lifetime. @returns fresh SSH disk observations. */
  inspect(server: ServerSettings, signal: AbortSignal): Promise<ServerInventory>
}

/**
 * Inspect or reclaim confirmed historical private residue without requiring a live controller.
 * @param options - selected server, observed account, scoped operation and credential-owning transport.
 * @returns helper results with a refreshed inventory for a subsequent storage selection.
 */
export async function preparationStorage(options: {
  server: ServerSettings; inventory: ServerInventory; id: ExperimentId; deploymentId: string; operation: string; input: object;
  policy: ManagedEnvironmentPolicy; signal: AbortSignal; transport: PreparationStorageTransport;
}): Promise<{ inventory: ServerInventory; history: unknown }> {
  const { server, inventory, id, operation, input, signal, transport } = options
  const controlRoot = server.remoteRoot ?? posix.join(inventory.home, '.local/share/aspera', server.id)
  const runRoot = posix.join(controlRoot, 'runs', id)
  let canonical: unknown
  let canonicalFailure: string | undefined
  if (operation === 'history-material-inspect' && 'request' in input) {
    const request = inspectExperimentMaterialsSchema.parse(input.request)
    try { canonical = await fetchCanonicalMaterialMetadata({ request, readBytes: options.policy.readBytes, readTimeoutMs: options.policy.readTimeoutMs, signal, fetcher: fetch }) }
    catch (error) { signal.throwIfAborted(); canonicalFailure = String(error) }
  }
  const config = { action: operation, placement: { experimentId: id, serverId: server.id, namespaceRoot: controlRoot, controlRoot,
    runRoot, workspaceRoot: posix.join(runRoot, 'workspace'), minimumFreeBytes: options.policy.minimumFreeBytes },
    deploymentId: options.deploymentId, serverName: server.name, policy: managedEnvironmentPolicySchema.parse(options.policy),
    governancePolicy: storageGovernancePolicySchema.parse(options.policy.governance ?? {}), ...input,
    ...(canonical === undefined ? {} : { canonical }) }
  const source = managedEnvironmentProgram().split('if __name__ == "__main__":')[0]!
  const command = 'python3 -c ' + shellQuote('import base64,gzip,json;exec(gzip.decompress(base64.b64decode("' + gzipSync(source).toString('base64')
    + '")));print(json.dumps(main(json.loads(base64.b64decode("' + Buffer.from(JSON.stringify(config)).toString('base64') + '")))))')
  let history: unknown
  try { history = JSON.parse(await transport.run(server, command, signal)) }
  catch (error) { signal.throwIfAborted(); history = { state: 'unavailable', detail: String(error) } }
  if (canonicalFailure !== undefined && typeof history === 'object' && history !== null) history = { ...history, canonicalMetadataError: canonicalFailure }
  return { inventory: await transport.inspect(server, signal), history }
}
