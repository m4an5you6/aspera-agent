/** Browser-safe phase selections and immutable provider configuration identities. */
import { z } from 'zod'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'

/** Phases with independent Agent model settings. */
export const experimentPhases = ['preparation', 'planning', 'execution'] as const
/** One recorded Agent role. */
export type ExperimentPhase = typeof experimentPhases[number]
/** Provider-owned reasoning ids are validated against the selected model before admission. */
export const phaseModelSelectionSchema = z.object({ provider: z.string().min(1), model: z.string().min(1),
  reasoningEffort: z.string().min(1).max(200).transform(value => brandString<ReasoningEffortId>(value)).optional() }).strict()
/** User selection, distinct from the model trained by the experiment. */
export type PhaseModelSelection = z.infer<typeof phaseModelSelectionSchema>
/** Complete three-phase selection; no implicit execution-time defaults. */
export const experimentModelsSchema = z.object({ preparation: phaseModelSelectionSchema,
  planning: phaseModelSelectionSchema, execution: phaseModelSelectionSchema }).strict()
/** Three independent Agent selections. */
export type ExperimentModels = z.infer<typeof experimentModelsSchema>
/** Non-secret evidence identifying the private provider configuration snapshot. */
export const phaseModelSnapshotSchema = phaseModelSelectionSchema.extend({
  adapter: z.enum(['deepseek-api-key', 'pi-ai']), adapterVersion: z.literal('0.2.0-rc.2'),
  api: z.string().min(1), baseURL: z.string().url().optional(),
  configurationRef: z.string().regex(/^ASPERA_MODEL_[A-Z0-9_]+$/),
  configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
/** Public immutable model summary; configurationRef resolves only on the Host. */
export type PhaseModelSnapshot = z.infer<typeof phaseModelSnapshotSchema>
/** All provider snapshots are committed before preparation starts. */
export const experimentModelSnapshotsSchema = z.object({ preparation: phaseModelSnapshotSchema,
  planning: phaseModelSnapshotSchema, execution: phaseModelSnapshotSchema }).strict()
/** Model snapshots carried in the receipt. */
export type ExperimentModelSnapshots = z.infer<typeof experimentModelSnapshotsSchema>
/** A configured model offered by the installed DSH provider directory. */
export interface ExperimentModelOption {
  provider: string
  providerName: string
  model: string
  name: string
  reasoning: { id: string; name: string }[]
  configured: boolean
  transferable: boolean
  detail?: string
}
/** Model settings response containing no credential values. */
export interface ExperimentModelDirectory {
  models: ExperimentModelOption[]
  current?: PhaseModelSelection
}
