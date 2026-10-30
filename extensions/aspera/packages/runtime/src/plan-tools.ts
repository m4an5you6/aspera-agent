/** Typed planning tools expose the same fields used by immutable plan acceptance. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { planInputSchema, planDraftEditSchema, planDraftReadSchema, stageSchedulerSchema, stageSamplesSchema, stageRequirementSchema } from '@aspera/experiments'
import { PlanDraft } from './plan-draft.ts'
import { planningTextPage } from './planning-store.ts'

const object = z.record(z.string(), z.json())
function schemaValue(input: z.infer<typeof object>): ValueSchemaSpec {
  const description = [input.description, ...['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format'].flatMap(key => input[key] === undefined ? [] : [`${key}: ${JSON.stringify(input[key])}`])].filter(value => value !== undefined).join('; ')
  const annotations = description === '' ? {} : { description }
  if (input.anyOf !== undefined) {
    const branches = z.array(object).min(2).parse(input.anyOf), types = branches.map(branch => branch.type)
    if (types.some(type => typeof type !== 'string') || new Set(types).size !== types.length) throw new Error('Planning tool alternatives require distinct JSON types')
    const [first, second, ...rest] = branches.map(schemaValue)
    if (first === undefined || second === undefined) throw new Error('Planning tool alternatives require at least two schemas')
    return { oneOf: [first, second, ...rest], ...annotations }
  }
  const type = input.type
  if (type === 'object') {
    const properties = z.record(z.string(), object).parse(input.properties ?? {}), required = z.array(z.string()).parse(input.required ?? [])
    return { type, additionalProperties: input.additionalProperties === true, properties: Object.fromEntries(Object.entries(properties).map(([key, field]) =>
      [key, { ...schemaValue(field), ...(required.includes(key) ? { required: true as const } : {}) }])), ...annotations }
  }
  if (type === 'array') return { type, items: schemaValue(object.parse(input.items)), ...annotations }
  if (type === 'string') return { type, ...(input.enum === undefined ? {} : { enum: z.array(z.string()).parse(input.enum) }),
    ...(input.const === undefined ? {} : { const: z.string().parse(input.const) }), ...annotations }
  if (type === 'number' || type === 'integer' || type === 'boolean' || type === 'null') return { type, ...annotations }
  throw new Error('Planning tool field cannot be projected from its validation schema: ' + JSON.stringify(input))
}
/** Project the supported DSH field vocabulary from Zod's input schema, retaining numeric constraints in descriptions.
 * @param schema - authoritative model-input schema. @returns model-visible parameter declarations.
 */
export function planningToolParameters(schema: z.ZodType): ParameterSchemaSpec {
  const projected = schemaValue(object.parse(z.toJSONSchema(schema, { io: 'input' })))
  if (!('type' in projected) || projected.type !== 'object') throw new Error('Planning tool parameters must be an object')
  return projected.properties ?? {}
}
/** Structured input and legacy JSON submissions share the final plan validator. */
export const planToolParameters = { plan: schemaValue(object.parse(z.toJSONSchema(planInputSchema, { io: 'input' }))),
  draft_revision: { type: 'integer' as const, description: 'Exact saved draft revision to commit; omit plan and plan_json when selecting a draft.' },
  plan_json: { type: 'string' as const, description: 'Compatibility input. Parseable rejected plans remain available as a repairable draft.' } }
const saveSchema = z.object({ status: z.enum(['completed', 'blocked']), detail: z.string().optional(), plan: object.optional(),
  plan_json: z.string().optional(), draft_revision: z.number().int().nonnegative().optional() }).strict()
const sections = { summary: planInputSchema.shape.summary, workload: planInputSchema.shape.workload, steps: planInputSchema.shape.steps, stepEdits: planDraftEditSchema.shape.steps, frameworks: planInputSchema.shape.frameworks,
  stages: planInputSchema.shape.stages, scheduler: stageSchedulerSchema, samples: stageSamplesSchema,
  results: stageRequirementSchema.shape.results, conditionalSteps: planInputSchema.shape.conditionalSteps, storagePolicy: planInputSchema.shape.storagePolicy }
const schemaRead = z.object({ section: z.enum(['summary', 'workload', 'steps', 'stepEdits', 'frameworks', 'stages', 'scheduler', 'samples', 'results', 'conditionalSteps', 'storagePolicy']).optional(),
  offset: z.number().int().nonnegative().default(0) }).strict()
const example = { summary: 'Version-specific training plan', workload: 'training', steps: ['Run the approved training stage'],
  frameworks: [{ name: 'transformers', version: 'pinned-version', documentation: 'https://huggingface.co/docs/transformers/' }],
  stages: [{ stageId: 'stage1', planStep: 1, title: 'Training', framework: 'transformers', startStep: 0, additionalSteps: 30, endStep: 30,
    metricScope: 'stage', loggingSteps: 1, scheduler: { mode: 'fresh', type: 'linear', learningRate: 0.0001, warmupSteps: 0, totalSteps: 30 },
    results: { baseControl: false } }] }
const samplesExample = { unit: 'example', meaning: 'consumed', expectedCount: 30, basis: 'Verified consumption at batch size one', perDeviceBatchSize: 1, gradientAccumulationSteps: 1, worldSize: 1 }
const output = { schema: { type: 'string' as const }, render: (_args: object, value: string) => [{ type: 'text' as const, text: value }] }
const presentCall = (args: object) => ({ card: 'generic' as const, title: 'Aspera plan', kind: 'other' as const, rawInput: args })

/** Install read-only schema inspection and revision-checked planning edits into the planning Agent only.
 * @param ctx - scoped Agent context. @param draft - fixed planning Session's draft. @param pageBytes - model-facing text limit.
 * @param finish - existing Goal completion/blocking integration, called only after durable plan acceptance.
 */
export function installPlanTools(ctx: Context, draft: PlanDraft, pageBytes: number, finish: (state: 'completed' | 'blocked', detail?: string) => void): void {
  ctx.on('tools/execute', async (execution, next) => {
    if (execution.name !== 'save_experiment_plan') return next()
    const request = object.safeParse(execution.arguments)
    if (!request.success || request.data.status !== 'completed' || request.data.draft_revision !== undefined
      || [request.data.plan, request.data.plan_json].filter(value => value !== undefined).length !== 1) return next()
    let value = request.data.plan
    if (typeof request.data.plan_json === 'string') {
      try { value = JSON.parse(request.data.plan_json) }
      catch (error) { if (error instanceof SyntaxError) return next(); throw error }
    }
    const parsed = object.safeParse(value)
    if (!parsed.success) return next()
    execution.signal.throwIfAborted()
    // Full submissions remain repairable when the argument validator rejects a nested field.
    const saved = await draft.import(parsed.data, execution.callId)
    const result = await next()
    return result.isError ? { ...result, content: [...result.content, { type: 'text', text: JSON.stringify(saved) }] } : result
  })
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'get_experiment_plan_schema',
    description: 'Read the exact plan input schema and a valid example. steps describes saved text entries, also accepted by draft edits; stepEdits describes draft inputs including numbered patches. Select a section and use returned offsets for more. samples.unit is example|microbatch; samples.meaning is consumed|fetched; explanation belongs in basis; results.baseControl is boolean. Schema and final validation share the same definitions.',
    parameters: planningToolParameters(schemaRead), output, presentCall, execute: async args => {
      const query = schemaRead.parse(args)
      const selected = query.section === undefined ? planInputSchema : sections[query.section]
      const values = { summary: example.summary, workload: 'inference', steps: example.steps, stepEdits: [{ step: 1, text: example.steps[0] }], frameworks: example.frameworks, stages: example.stages,
        scheduler: example.stages[0]!.scheduler, samples: samplesExample, results: example.stages[0]!.results, conditionalSteps: [{ step: 1, trigger: 'command-failure', commandIds: ['probe'] }],
        storagePolicy: { artifact: 'adapter', checkpointCount: 2, optimizerState: true, schedulerState: true, recoveryPoints: ['checkpoint-30'],
          outputMinimumBytes: 0, checkpointMinimumBytes: 0, basis: 'Retain the adapter and required recovery states; estimate bytes separately' } }
      const text = JSON.stringify({ schema: z.toJSONSchema(selected, { io: 'input' }), example: query.section === undefined ? example : values[query.section],
        rules: ['workload=inference forbids training stages; do not invent historical stages or placeholder scheduler values. Omitted workload retains training checks.',
          'startStep + additionalSteps = endStep', 'Stage and conditional-step references must exist', 'stageId and conditional step numbers must be unique', 'Scheduler horizon must cover the approved stage',
          'Optional sample counts must not be inferred from optimizer steps; preserve immutable submitted requirements'] })
      const page = planningTextPage(text, query.offset, pageBytes)
      return JSON.stringify({ encoding: 'json-text-fragment', ...page, ...(page.nextOffset < page.totalCharacters ? { next: { ...query, offset: page.nextOffset } } : {}) })
    } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'read_experiment_plan_draft', description: 'Read the saved draft revision, validation issues or a bounded section. section=requirements reads immutable user-submitted requirements when present; draft edits cannot change them. Read returned pages rather than regenerating the plan. A changed revision rejects an old page cursor.',
    parameters: planningToolParameters(planDraftReadSchema), output, presentCall, execute: async args => JSON.stringify(await draft.read(planDraftReadSchema.parse(args))) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'update_experiment_plan_draft',
    description: 'Create or repair a durable draft in any order. Supply requestId and expectedRevision (zero initially). Omitted fields remain unchanged. steps accepts either text entries addressed from step one or {step,text} patches with original one-based numbers; do not mix formats. Shorter text lists retain trailing steps. stages merge by stageId, including partial scheduler/samples/results. Removal is explicit and never renumbers steps. Incomplete drafts remain saved. On conflict read the current revision; reuse requestId only for exactly the same edit. No commands or approval are performed.',
    parameters: planningToolParameters(planDraftEditSchema), output, presentCall, execute: async args => JSON.stringify(await draft.edit(planDraftEditSchema.parse(args))) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'validate_experiment_plan_draft', description: 'Check the saved draft using the complete final plan rules. Returns field paths, actual values and required types or constraints without repeating the plan. This does not approve or execute it.',
    parameters: {}, output, presentCall, execute: async () => JSON.stringify(await draft.validate()) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'save_experiment_plan',
    description: 'Complete planning by committing draft_revision, or submit a structured plan directly. Legacy plan_json remains accepted. Use exactly one input when status=completed. Parseable invalid full submissions remain saved; repair only reported fields with update_experiment_plan_draft and commit the returned revision. The program validates the entire plan before freezing it; semi mode still requires approval. status=blocked records an unmet requirement without launching commands.',
    parameters: { status: { type: 'string', enum: ['completed', 'blocked'], required: true }, detail: { type: 'string' }, ...planToolParameters }, output, presentCall,
    execute: async (args, execution) => {
      const request = saveSchema.parse(args)
      if (request.status === 'blocked') { finish('blocked', request.detail); return JSON.stringify({ state: 'blocked', detail: request.detail }) }
      if ([request.plan, request.plan_json, request.draft_revision].filter(value => value !== undefined).length !== 1) return JSON.stringify({ state: 'invalid', detail: 'Choose exactly one of plan, plan_json or draft_revision' })
      let revision = request.draft_revision
      if (revision === undefined) {
        let value: unknown = request.plan
        if (request.plan_json !== undefined) {
          try { value = JSON.parse(request.plan_json) }
          catch (error) { return JSON.stringify({ state: 'invalid-json', detail: String(error) }) }
        }
        const result = await draft.import(value, execution.callId)
        if (result.state !== 'draft') return JSON.stringify(result)
        revision = result.revision
      }
      const result = await draft.commit(revision)
      if (result.state === 'saved') { finish('completed', request.detail); return JSON.stringify({ state: 'completed', draftRevision: revision, detail: request.detail }) }
      return JSON.stringify(result)
    } })))
}
