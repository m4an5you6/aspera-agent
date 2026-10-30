/** Allocation-scoped service lifecycle tools for the execution Agent. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { serverIdSchema, serviceIdSchema, serviceSchema } from '@aspera/experiments'
import { experimentIdSchema, prepareInferenceCheckpointSchema } from '@aspera/experiments'
import type { ClusterPrivate } from './cluster-runtime.ts'
import { clusterNodeRequest } from './cluster-runtime.ts'

const output = { schema: { type: 'string' as const }, render: (_args: object, value: string) => [{ type: 'text' as const, text: value }] }

/**
 * Register managed service start, inspection and confirmed stop through the original authenticated node API.
 * @param ctx - execution Agent scope.
 * @param runtime - immutable submission and private node connections.
 */
export function installInferenceServiceTools(ctx: Context, runtime: ClusterPrivate): void {
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'start_inference_service',
    description: 'Register a managed inference process on an assigned node. Reuse service_id only for an identical request. To run changed code or replace a failed/stopped service, call stop_inference_service, confirm released=true, then start with a NEW service_id. An identical old id returns its original record without restarting. Bind the model command to 127.0.0.1 on an unused port, supply its real HTTP health path and workspace-relative model_path. For a retained snapshot use snapshot.destination as model_path and load adapterPath in the command. Set publish=true only when public inference is requested and the node has a saved inferenceMapping. The node opens that mapping port on 0.0.0.0 with separate Bearer authentication and forwards to the private model port; never bind the model to the mapping port. model_name is the model API identifier. No credentials are returned. Check both local health and external reachability. Services survive Goal completion; no automatic restart.',
    parameters: { server_id: { type: 'string', required: true }, service_id: { type: 'string', required: true }, command: { type: 'string', required: true }, model_path: { type: 'string', required: true }, port: { type: 'number', required: true }, health_path: { type: 'string', required: true }, publish: { type: 'boolean' }, model_name: { type: 'string' } }, output,
    presentCall: args => ({ card: 'generic', title: 'Start inference service', kind: 'execute', rawInput: args }),
    execute: async (args, execution) => JSON.stringify(await clusterNodeRequest(runtime, serverIdSchema.parse(args.server_id), 'register-service',
      { id: serviceIdSchema.parse(args.service_id), command: args.command, modelPath: args.model_path, port: args.port, healthPath: args.health_path, publish: args.publish, modelName: args.model_name }, execution.signal)) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'stop_inference_service',
    description: 'Stop only a registered inference service belonging to this experiment on an assigned node. The program closes its public gateway, terminates the owned process and checks cleanup; no PID or port is accepted. Wait for released=true before replacing it. released=false or a lost reply means exit is not confirmed: inspect services or repeat this same stop; do not start another service or kill a PID from an ordinary command. Repeated stop does not restart work. Model files, checkpoints, environment and logs are retained. Changed code requires a NEW service_id after confirmed release, followed by health and public verification.',
    parameters: { server_id: { type: 'string', required: true }, service_id: { type: 'string', required: true } }, output,
    presentCall: args => ({ card: 'generic', title: 'Stop inference service', kind: 'execute', rawInput: args }),
    execute: async (args, execution) => {
      const serverId = serverIdSchema.parse(args.server_id), serviceId = serviceIdSchema.parse(args.service_id)
      if (!runtime.submission.nodes.some(node => node.server.id === serverId)) throw new Error('Service server is outside this experiment allocation')
      const result = serviceSchema.parse(await clusterNodeRequest(runtime, serverId, 'stop-service', { serviceId }, execution.signal))
      if (result.id !== serviceId || result.serverId !== serverId || result.experimentId !== runtime.submission.experimentId) throw new Error('Service stop returned a different experiment, server or service')
      return JSON.stringify(result)
    } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'get_inference_services',
    description: 'Read live process, HTTP health and release facts for registered inference services on every assigned node. Healthy means the health path responded; actual generation and public authentication require verify_inference_service. Stopped records remain historical and do not restart.',
    parameters: {}, output,
    presentCall: args => ({ card: 'generic', title: 'Inspect inference services', kind: 'other', rawInput: args }),
    execute: async (_args, execution) => JSON.stringify((await Promise.all(runtime.submission.nodes.map(node => clusterNodeRequest(runtime, node.server.id, 'services', {}, execution.signal)))).flat()) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'inspect_inference_checkpoints',
    description: 'Read native adapter checkpoints already sealed by a released earlier experiment on this assigned server. source_experiment_id identifies the original run, never a path. The program confirms the producer command and allocation have released and checks ownership, actual mount and file identities. Candidates include native step and checkpointId. Select the required checkpoint yourself; a directory name or an Agent report alone is insufficient. Discovery does not start training, inference or modify the source.',
    parameters: { server_id: { type: 'string', required: true }, source_experiment_id: { type: 'string', required: true } }, output,
    presentCall: args => ({ card: 'generic', title: 'Inspect retained inference checkpoints', kind: 'other', rawInput: args }),
    execute: async (args, execution) => JSON.stringify(await clusterNodeRequest(runtime, serverIdSchema.parse(args.server_id), 'inference-checkpoints',
      { sourceExperimentId: experimentIdSchema.parse(args.source_experiment_id) }, execution.signal)) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'prepare_inference_checkpoint',
    description: 'Create a protected inference-only adapter snapshot from a selected retained checkpoint. json: operationId UUID, sourceExperimentId UUID, checkpointId from inspection. The program hashes actual adapter/config/native TrainerState, rechecks release and links the same files into the current workspace without downloading, retraining or changing the source. Only same-volume hardlinks are supported; a cross-volume error never silently copies weights. The result adapterPath is read-only for ordinary commands and managed services. It contains no optimizer or scheduler and does not replace new training evidence. Reuse the exact operationId after a lost reply or incomplete publication; a new id cannot bypass an incomplete snapshot. You choose the inference implementation, start the managed service and request public verification.',
    parameters: { server_id: { type: 'string', required: true }, json: { type: 'string', required: true } }, output,
    presentCall: args => ({ card: 'generic', title: 'Prepare retained inference checkpoint', kind: 'execute', rawInput: args }),
    execute: async (args, execution) => JSON.stringify(await clusterNodeRequest(runtime, serverIdSchema.parse(args.server_id), 'inference-checkpoint-prepare',
      prepareInferenceCheckpointSchema.parse(JSON.parse(args.json)), execution.signal)) })))
}
