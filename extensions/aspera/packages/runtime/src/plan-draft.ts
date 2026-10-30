/** Persistent plan drafts accept local repairs before immutable final approval. */
import { existsSync, readFileSync, readdirSync, mkdirSync, lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { planSchema, planInputSchema, planDraftValueSchema, planDraftEditSchema, planDraftReadSchema, planRequirementIssues } from '@aspera/experiments'
import type { ExperimentPlan, PlanningOwner, PlanRequirements } from '@aspera/experiments'
import { PlanningStore, planningDigest, planningTextPage } from './planning-store.ts'
import { planRequirementsSourceSchema } from './plan-requirements.ts'
import type { PlanRequirementsSource } from './plan-requirements.ts'

type DraftValue = z.infer<typeof planDraftValueSchema>
const revisionSchema = z.object({ version: z.literal(1), formatVersion: z.literal('0.1.0'), revision: z.number().int().positive(),
  requestId: z.string(), requestHash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.number(), value: planDraftValueSchema }).strict()
type DraftRevision = z.infer<typeof revisionSchema>
/** Field-local validation evidence never contains the complete rejected plan. */
export interface PlanIssue { path: string; expected: string; actual: string }
/** Draft operations return revision and validation without repeating the plan text. */
export interface PlanDraftResult { state: 'draft' | 'invalid' | 'conflict' | 'frozen' | 'saved'; revision: number; issues: PlanIssue[]; issueCount?: number; issuesTruncated?: boolean; plan?: ExperimentPlan }

function actualAt(value: DraftValue, path: PropertyKey[]): string {
  let current: unknown = value
  for (const key of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) { current = undefined; break }
    current = Reflect.get(current, key)
  }
  return (JSON.stringify(current) ?? 'missing').slice(0, 256)
}
function validate(value: DraftValue, requirements?: PlanRequirements): { issues: PlanIssue[]; plan?: z.infer<typeof planInputSchema> } {
  const parsed = planInputSchema.safeParse(value)
  if (!parsed.success) return { issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), expected: issue.message, actual: actualAt(value, issue.path) })) }
  const issues: PlanIssue[] = []
  const add = (path: string, expected: string) => { issues.push({ path, expected, actual: actualAt(value, path.split('.')) }) }
  const plan = parsed.data
  if (plan.stages?.some(stage => stage.planStep > plan.steps.length)) add('stages', 'Each training stage must refer to an existing plan step')
  if (new Set(plan.stages?.map(stage => stage.stageId)).size !== (plan.stages?.length ?? 0)) add('stages', 'Training stages must have unique stageId values')
  if (plan.conditionalSteps?.some(step => step.step > plan.steps.length)) add('conditionalSteps', 'Conditional steps must refer to existing plan steps')
  if (new Set(plan.conditionalSteps?.map(step => step.step)).size !== (plan.conditionalSteps?.length ?? 0)) add('conditionalSteps', 'Conditional step numbers must be unique')
  if (plan.workload === 'inference') {
    if (plan.stages?.length) add('stages', 'An inference-only plan cannot include training stages or placeholder historical training; use retained checkpoint evidence')
  } else if (plan.frameworks.some(framework => /^(?:ms-swift|swift|transformers|peft)$/i.test(framework.name)) && !plan.stages?.length) add('stages', 'A Transformers training plan requires structured stages before approval; declare workload=inference only for a task with no new training')
  if (requirements !== undefined) issues.push(...planRequirementIssues(plan, requirements))
  return { issues, ...(issues.length === 0 ? { plan } : {}) }
}
function mergeFields(target: DraftValue, patch: DraftValue): DraftValue {
  const result = { ...target }
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Draft field is not permitted')
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const previous = result[key]
      result[key] = mergeFields(previous !== null && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}, value)
    } else result[key] = value
  }
  return result
}

function resolveStepEdits(input: z.infer<typeof planDraftEditSchema>['steps']): { step: number; text: string }[] {
  if (input === undefined) return []
  if (input.some(row => typeof row === 'string') && input.some(row => typeof row !== 'string')) throw new Error('Choose either text steps or numbered step patches; do not mix the formats')
  return input.map((row, index) => typeof row === 'string' ? { step: index + 1, text: row } : row)
}

/** One draft is writable only by its original planning Session and fixed release. */
export class PlanDraft {
  private readonly store: PlanningStore
  /** @param runRoot - private experiment directory. @param owner - fixed worker identity. @param pageBytes - maximum returned text bytes. @param requirements - authenticated submitted requirements, never model edits. */
  constructor(private readonly runRoot: string, owner: PlanningOwner, private readonly pageBytes: number, private readonly requirements?: PlanRequirementsSource) { this.store = new PlanningStore(runRoot, owner) }
  private async initialize(): Promise<void> {
    await this.store.initialize()
    await withFileLock(this.store.path('requirements-writer'), async () => {
      const path = this.store.path('requirements.v1.json')
      if (existsSync(path)) {
        const saved = z.object({ version: z.literal(1), source: planRequirementsSourceSchema }).strict().parse(JSON.parse(readFileSync(path, 'utf8')))
        if (planningDigest(saved.source) !== planningDigest(this.requirements ?? {})) throw new Error('Submitted plan requirements changed or were omitted; retain the original planning record')
      } else if (this.requirements !== undefined) await this.store.write(['requirements.v1.json'], { version: 1, source: this.requirements })
    })
  }
  private history(): DraftRevision[] {
    const directory = this.store.path('drafts')
    if (!existsSync(directory)) return []
    return readdirSync(directory).filter(name => /^\d{10}\.json$/.test(name)).sort().map(name =>
      revisionSchema.parse(JSON.parse(readFileSync(this.store.path('drafts', name), 'utf8'))))
  }
  private result(record?: DraftRevision): PlanDraftResult {
    const checked = validate(record?.value ?? {}, this.requirements?.requirements)
    const issues = [...checked.issues]
    while (issues.length > 1 && Buffer.byteLength(JSON.stringify(issues)) > this.pageBytes / 2) issues.pop()
    return { state: checked.issues.length === 0 ? 'draft' : 'invalid', revision: record?.revision ?? 0, issues,
      ...(issues.length === checked.issues.length ? {} : { issueCount: checked.issues.length, issuesTruncated: true }) }
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize()
    return withFileLock(this.store.path('draft-writer'), operation)
  }
  private frozen(): boolean { return existsSync(resolve(this.runRoot, 'plan.json')) || existsSync(resolve(this.runRoot, 'approved-plan.json')) }
  private async replace(value: DraftValue, requestId: string, requestHash: string, expectedRevision?: number): Promise<PlanDraftResult> {
    const history = this.history(), prior = history.find(record => record.requestId === requestId), current = history.at(-1)
    if (prior !== undefined) {
      if (prior.requestHash !== requestHash) throw new Error('Draft request identity already names different edits')
      return this.result(prior)
    }
    if (this.frozen()) return { ...this.result(current), state: 'frozen' }
    if (expectedRevision !== undefined && expectedRevision !== (current?.revision ?? 0)) return { ...this.result(current), state: 'conflict' }
    const record: DraftRevision = { version: 1, formatVersion: '0.1.0', revision: (current?.revision ?? 0) + 1,
      requestId, requestHash, createdAt: Date.now(), value }
    await this.store.write(['drafts', String(record.revision).padStart(10, '0') + '.json'], record)
    return this.result(record)
  }
  /** Save a parseable legacy submission even when its fields need repair.
   * @param value - parsed model-authored JSON object. @param requestId - original tool call identity. @returns saved draft revision and field errors.
   */
  async import(value: unknown, requestId: string): Promise<PlanDraftResult> {
    const checked = planDraftValueSchema.parse(value)
    return this.locked(async () => this.replace(checked, requestId, planningDigest(checked)))
  }
  /** Apply typed section edits without replacing omitted data.
   * @param input - revision-checked model request. @returns original idempotent result, conflict, or new draft revision.
   */
  async edit(input: z.input<typeof planDraftEditSchema>): Promise<PlanDraftResult> {
    const patch = planDraftEditSchema.parse(input), stepEdits = resolveStepEdits(patch.steps)
    return this.locked(async () => {
      const current = this.history().at(-1), value = structuredClone(current?.value ?? {})
      if (patch.summary !== undefined) value.summary = patch.summary
      if (patch.frameworks !== undefined) value.frameworks = patch.frameworks
      if (patch.workload !== undefined) value.workload = patch.workload
      if (patch.storagePolicy !== undefined) value.storagePolicy = patch.storagePolicy
      if (patch.conditionalSteps !== undefined) value.conditionalSteps = patch.conditionalSteps
      if (patch.steps !== undefined || patch.removeSteps !== undefined) {
        const steps = z.array(z.json()).parse(value.steps ?? [])
        for (const row of stepEdits) { while (steps.length < row.step) steps.push(null); steps[row.step - 1] = row.text }
        for (const number of patch.removeSteps ?? []) if (number <= steps.length) steps[number - 1] = null
        value.steps = steps
      }
      if (patch.stages !== undefined || patch.removeStages !== undefined || patch.removeStageFields !== undefined) {
        const stages = z.array(planDraftValueSchema).parse(value.stages ?? [])
        for (const stage of patch.stages ?? []) {
          const index = stages.findIndex(row => row.stageId === stage.stageId), previous = stages[index] ?? {}
          const merged = mergeFields(previous, planDraftValueSchema.parse(stage))
          if (index < 0) stages.push(merged); else stages[index] = merged
        }
        for (const row of patch.removeStageFields ?? []) { const stage = stages.find(value => value.stageId === row.stageId); if (stage !== undefined) for (const key of row.fields) delete stage[key] }
        value.stages = stages.filter(stage => !patch.removeStages?.includes(String(stage.stageId)))
      }
      for (const field of patch.removeFields ?? []) delete value[field]
      return this.replace(value, patch.requestId, planningDigest(patch), patch.expectedRevision)
    })
  }
  /** @returns validation for the latest saved draft without changing its contents. */
  async validate(): Promise<PlanDraftResult> { await this.initialize(); const result = this.result(this.history().at(-1)); return this.frozen() ? { ...result, state: 'frozen' } : result }
  /** Read a saved draft summary or a page tied to one revision.
   * @param input - section, optional original identity and continuation. @returns bounded explicit JSON text fragments and a next cursor.
   */
  async read(input: z.input<typeof planDraftReadSchema>): Promise<object> {
    const query = planDraftReadSchema.parse(input); await this.initialize()
    const record = this.history().at(-1), result = this.result(record)
    if (query.revision !== undefined && query.revision !== result.revision) return { ...result, state: 'conflict' }
    if (query.section === undefined) return { ...result, frozen: this.frozen(), sections: [...(this.requirements === undefined ? [] : ['requirements']), ...Object.keys(record?.value ?? {})] }
    let selected = query.section === 'requirements' ? this.requirements?.requirements : query.section === 'issues' ? validate(record?.value ?? {}, this.requirements?.requirements).issues : record?.value[query.section]
    if (query.step !== undefined) selected = z.array(z.json()).parse(selected ?? [])[query.step - 1]
    if (query.stageId !== undefined) selected = z.array(planDraftValueSchema).parse(selected ?? []).find(stage => stage.stageId === query.stageId)
    const page = planningTextPage(JSON.stringify(selected) ?? 'null', query.offset, this.pageBytes)
    return { revision: result.revision, frozen: this.frozen(), section: query.section, encoding: 'json-text-fragment', ...page,
      ...(page.nextOffset < page.totalCharacters ? { next: { ...query, revision: result.revision, offset: page.nextOffset } } : {}) }
  }
  /** Atomically publish a complete checked draft and freeze future edits.
   * @param revision - exact draft revision selected by the Agent. @returns accepted original plan or actionable validation issues.
   */
  async commit(revision: number): Promise<PlanDraftResult> {
    return this.locked(async () => {
      const current = this.history().at(-1), result = this.result(current)
      if (revision !== result.revision) return { ...result, state: 'conflict' }
      const file = resolve(this.runRoot, 'plan.json')
      if (existsSync(file)) {
        if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw new Error('Saved plan is not a regular owned receipt')
        const saved = z.object({ plan: planSchema, sessionId: z.string() }).strict().parse(JSON.parse(readFileSync(file, 'utf8')))
        const checked = validate(current?.value ?? {}, this.requirements?.requirements)
        const { revision: _revision, createdAt: _createdAt, ...savedInput } = saved.plan
        if (saved.sessionId !== this.store.owner.sessionId || checked.plan === undefined || JSON.stringify(savedInput) !== JSON.stringify(checked.plan)) throw new Error('Saved plan differs from this draft owner or contents')
        return { ...result, state: 'saved', plan: saved.plan }
      }
      if (existsSync(resolve(this.runRoot, 'approved-plan.json'))) return { ...result, state: 'frozen' }
      const checked = validate(current?.value ?? {}, this.requirements?.requirements)
      if (checked.plan === undefined) return result
      const plan = planSchema.parse({ ...checked.plan, revision: 1, createdAt: Date.now() })
      mkdirSync(this.runRoot, { recursive: true, mode: 0o700 })
      await writeFileAtomic(file, JSON.stringify({ plan, sessionId: this.store.owner.sessionId }) + '\n', { mode: 0o600 })
      return { ...result, state: 'saved', plan }
    })
  }
}
