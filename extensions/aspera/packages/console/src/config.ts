/** Browser refresh and retained-output limits. */
import z from '@deepseek-ai/schemastery'

/** Deployment choices shared by the Host and browser halves. */
export interface Config {
  pollIntervalMs: number
  retainedTextChars: number
  defaultControlPort: number
  metricWindowMs?: number
  observationReadBytes?: number
  traceRetainedChars?: number
  metricSampleLimit?: number
}

/** Validated settings for the experiment page. */
export const Config: z<Config> = z.object({
  pollIntervalMs: z.number().step(1).min(500).default(2000),
  retainedTextChars: z.number().step(1).min(1000).default(200000),
  defaultControlPort: z.number().step(1).min(1).max(65534).default(43019),
  metricWindowMs: z.number().step(1).min(60000).default(900000),
  observationReadBytes: z.number().step(1).min(1024).max(262144).default(65536),
  traceRetainedChars: z.number().step(1).min(65536).default(2000000),
  metricSampleLimit: z.number().step(1).min(30).max(10000).default(1000),
})
