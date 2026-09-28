/** Browser refresh and retained-output limits. */
import z from '@deepseek-ai/schemastery'

/** Deployment choices shared by the Host and browser halves. */
export interface Config {
  pollIntervalMs: number
  retainedTextChars: number
}

/** Validated settings for the experiment page. */
export const Config: z<Config> = z.object({
  pollIntervalMs: z.number().step(1).min(500).default(3000),
  retainedTextChars: z.number().step(1).min(1000).default(200000),
})
