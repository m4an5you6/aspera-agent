/** Preparation tools use the same storage service before the new run or controller exists. */
import { posix } from 'node:path'
import { z } from 'zod'
import { managedEnvironmentProgram, managedEnvironmentPolicySchema, storageGovernancePolicySchema, pythonMainInput } from '@aspera/runtime'
import type { ManagedEnvironmentPolicy } from '@aspera/runtime'
import type { ServerSettings, ServerInventory, ExperimentId } from '@aspera/experiments'
import { inspectExperimentMaterialsSchema } from '@aspera/experiments'
import { fetchCanonicalMaterialMetadata } from './material-metadata.ts'

/** Login credentials remain with the Fleet; model requests cannot supply commands or paths. */
export interface PreparationStorageTransport {
  /** @param server - selected server. @param command - fixed short Python entry. @param signal - original preparation lifetime. @param input - complete UTF-8 helper/request packet. @returns helper stdout. */
  run(server: ServerSettings, command: string, signal: AbortSignal, input?: string): Promise<string>
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
  const config = { action: operation, placement: { experimentId: id, serverId: server.id, namespaceRoot: controlRoot, controlRoot,
    runRoot, workspaceRoot: posix.join(runRoot, 'workspace'), minimumFreeBytes: options.policy.minimumFreeBytes },
    deploymentId: options.deploymentId, serverName: server.name, policy: managedEnvironmentPolicySchema.parse(options.policy),
    governancePolicy: storageGovernancePolicySchema.parse(options.policy.governance ?? {}), reuseVerificationVersion: 1, ...input,
    ...(operation === 'history-material-verify' ? { deadline: Date.now() + storageGovernancePolicySchema.parse(options.policy.governance ?? {}).verificationTimeoutMs } : {}),
    ...(canonical === undefined ? {} : { canonical }) }
  const source = managedEnvironmentProgram().split('if __name__ == "__main__":')[0]!
  const invoke = async (fields: object) => {
    const invocation = pythonMainInput(source, fields)
    return JSON.parse(await transport.run(server, invocation.command, signal, invocation.input))
  }
  let history: unknown
  try {
    history = await invoke(config)
    if (operation === 'history-material-inspect' && 'request' in input) {
      const request = inspectExperimentMaterialsSchema.parse(input.request)
      const pending = z.object({ state: z.literal('metadata-pending'), deadline: z.number().optional() }).safeParse(history)
      if (pending.success && request.metadataSource !== 'node' && request.metadataSource !== 'cache') {
        try { canonical = await fetchCanonicalMaterialMetadata({ request, readBytes: options.policy.readBytes, pollIntervalMs: options.policy.operationPollIntervalMs,
          readTimeoutMs: pending.data.deadline === undefined ? options.policy.readTimeoutMs : Math.max(1, Math.min(options.policy.readTimeoutMs, pending.data.deadline - Date.now())), signal, fetcher: fetch }) }
        catch (error) { signal.throwIfAborted(); canonicalFailure = String(error) }
        if (canonical !== undefined) history = await invoke({ ...config, canonical })
      }
    }
  }
  catch (error) { signal.throwIfAborted(); history = { state: 'unavailable', detail: String(error) } }
  if (canonicalFailure !== undefined && typeof history === 'object' && history !== null) history = { ...history, canonicalMetadataError: canonicalFailure }
  return { inventory: await transport.inspect(server, signal), history }
}
