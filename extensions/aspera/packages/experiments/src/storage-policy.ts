/** Approved retained content is separate from estimated byte counts. */
import { z } from 'zod'
const bytes = z.number().int().nonnegative()
/** Required retained content is independent of its current size estimate. */
export const experimentStoragePolicySchema = z.object({
  artifact: z.enum(['adapter', 'full-model', 'other']), checkpointCount: bytes,
  optimizerState: z.boolean(), schedulerState: z.boolean(), recoveryPoints: z.array(z.string().min(1).max(200)).max(100),
  outputMinimumBytes: bytes, checkpointMinimumBytes: bytes, basis: z.string().min(1).max(4096),
}).strict()
/** Agent-proposed retention choices require program-owned approval. */
export type ExperimentStoragePolicy = z.infer<typeof experimentStoragePolicySchema>

/** Check automatic-mode proposals against the approved retained content.
 * @param approved - original approved strategy. @param proposed - requested strategy.
 * @returns whether every approved retention requirement remains present.
 */
export function storagePolicyPreserves(approved: ExperimentStoragePolicy, proposed: ExperimentStoragePolicy): boolean {
  return approved.artifact === proposed.artifact && proposed.checkpointCount >= approved.checkpointCount
    && (!approved.optimizerState || proposed.optimizerState) && (!approved.schedulerState || proposed.schedulerState)
    && approved.recoveryPoints.every(point => proposed.recoveryPoints.includes(point))
    && proposed.outputMinimumBytes >= approved.outputMinimumBytes && proposed.checkpointMinimumBytes >= approved.checkpointMinimumBytes
}
