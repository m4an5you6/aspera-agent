/** Public verification waits for the program-owned Host request without another model request. */
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { serverIdSchema, serviceVerificationInputSchema, serviceVerificationSchema } from '@aspera/experiments'
import type { ClusterPrivate, ClusterRuntimeConfig } from './cluster-runtime.ts'
import { clusterNodeRequest } from './cluster-runtime.ts'
import { finalizationPolicySchema } from './finalization-policy.ts'

/** @param ctx - execution Agent scope. @param runtime - original submission. @param config - existing wait/read limits. */
export function installServiceVerificationTool(ctx: Context, runtime: ClusterPrivate, config: ClusterRuntimeConfig): void {
  const policy = finalizationPolicySchema.parse(config.finalization ?? {})
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'verify_inference_service',
    description: 'Request program-owned public verification of an assigned healthy published service. json: operationId UUID, serviceId UUID, maxTokens (1..256). The local Aspera Host checks exact service identity, unauthenticated and invalid-key rejection, the model listing and a real response to a fixed harmless standard prompt. No experiment Goal, chat history, free-form prompt or credential is sent to that endpoint. Waits internally; no model polling. Reuse the operationId after a lost reply; claimed or unknown generation outcomes are never replayed. Node-to-public routing failure does not disprove Host reachability. Inspect actual checks before completing.',
    parameters: { server_id: { type: 'string', required: true }, json: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] },
    presentCall: args => ({ card: 'generic', title: 'Verify public inference service', kind: 'execute', rawInput: args }),
    execute: async (args, execution) => {
      const serverId = serverIdSchema.parse(args.server_id), input = serviceVerificationInputSchema.parse(JSON.parse(args.json))
      const read = () => clusterNodeRequest(runtime, serverId, 'service-verification-status', { operationId: input.operationId },
        AbortSignal.any([execution.signal, AbortSignal.timeout(policy.readTimeoutMs)]))
      let value = serviceVerificationSchema.parse(await clusterNodeRequest(runtime, serverId, 'service-verification-prepare', { input }, execution.signal))
      let lastSuccess = Date.now()
      while (['requested', 'claimed'].includes(value.state)) {
        execution.signal.throwIfAborted()
        if (Date.now() >= value.deadline) return JSON.stringify({ ...value, state: 'unknown', detail: 'Original verification deadline expired; inspect the original operation before another generation' })
        await delay(policy.pollIntervalMs, undefined, { signal: execution.signal })
        try {
          value = serviceVerificationSchema.parse(await read()); lastSuccess = Date.now()
        } catch (error) {
          execution.signal.throwIfAborted()
          if (Date.now() - lastSuccess >= policy.reconnectTimeoutMs) return JSON.stringify({ ...value, state: 'unknown', detail: 'Connection recovery budget exhausted; original public verification was not replayed: ' + String(error) })
        }
      }
      return JSON.stringify(value)
    },
  })))
}
