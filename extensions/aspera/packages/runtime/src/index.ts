import type {} from './messages.ts'
/** Persistent coordinator, node, and execution roles launched by a dsh profile. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { applyClusterRole } from './cluster.ts'
import type { ClusterRoleConfig } from './cluster.ts'

export * from '@aspera/experiments'
export { inspectServerStorage, prepareServerStorage, verifyServerStorage, resolveStoragePlacement, serverRunRoot, serverReleaseRoot } from './storage.ts'
export { clusterFileHash, readClusterPrivate, clusterPrivateSchema, clusterAgentModelSchema } from './cluster-runtime.ts'
export type { ClusterPrivate } from './cluster-runtime.ts'
export type { ClusterRoleConfig } from './cluster.ts'

/** Validated role configuration supplied by the profile. */
export interface Config extends ClusterRoleConfig {}
/** Role limits are deployment settings; wire constants stay in experiments. */
export const Config: z<Config> = z.object({
  role: z.union(['coordinator', 'node', 'agent', 'planner']).required(),
  root: z.string().required(), tokenFile: z.string().required(), deploymentId: z.string().required(),
  backendPath: z.string().default('/usr/bin/bwrap'), hiddenPaths: z.array(z.string()).default([]),
  devicePaths: z.array(z.string()).default([]), experimentId: z.string(),
  chunkBytes: z.number().step(1).min(1024).max(65536).default(65536),
  fileLimit: z.number().step(1).min(1).default(1000),
  cleanupTimeoutMs: z.number().step(1).min(1000).default(30000),
  serviceRequestTimeoutMs: z.number().step(1).min(1000).default(300000),
  serviceRequestBytes: z.number().step(1).min(1024).default(16777216),
  pollIntervalMs: z.number().step(1).min(100).default(1000),
  documentationHosts: z.array(z.string()).default(['github.com', 'raw.githubusercontent.com', 'docs.nvidia.com', 'unsloth.ai', 'docs.unsloth.ai', 'swift.readthedocs.io', 'huggingface.co']),
  documentationBytes: z.number().step(1).min(1024).default(1048576),
  goalContinuationWindow: z.number().step(1).min(2).max(10000).default(128),
  networkProbeLifetimeMs: z.number().step(1).min(1000).default(300000),
})
export const inject = ['webServer', 'storage', 'storageDomain', 'subprocess', 'sandbox', 'agents', 'goals', 'credentials', 'agentDefaultModel', 'sessionPersistence', 'agentPresets', 'userQuestions']
/** @param ctx - worker profile services. @param config - fixed role and operation bounds. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await applyClusterRole(ctx, config)
}

export type { AsperaMessageSource } from './messages.ts'

export { setupWorkerProfile } from './profiles.ts'
