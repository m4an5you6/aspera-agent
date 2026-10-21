/** Profile-owned settings for the DSH compactor and tool-result pruner of each phase Agent. */
import z from '@deepseek-ai/schemastery'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { ToolResultPruneConfig } from '@deepseek-ai/dsh-compaction-tool-result-pruner'

/** Each Agent resolves these settings with the same published DSH defaults as its profile. */
export interface PhaseContextPolicy {
  compaction: BasicCompactionConfig
  pruning: ToolResultPruneConfig
}

/** Reuse the DSH configuration schemas without storing new fields in experiment or Session records. */
export const PhaseContextPolicyConfig: z<PhaseContextPolicy> = z.object({
  compaction: BasicCompactionEngine.Config.default({}),
  pruning: ToolResultPruner.Config.default({}),
})
