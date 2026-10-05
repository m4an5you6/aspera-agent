/** Version 1 observation files are independent of submitted tasks and queue generations. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { experimentIdSchema, serverIdSchema } from './cluster-protocol.ts'
import { experimentPhases } from './models.ts'

/** Stable identity of one registered command or Agent output source. */
export type ObservationSourceId = string & Branded<'ObservationSourceId'>
/** Only single path segments may name observation sources. */
export const observationSourceIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/).transform(value => brandString<ObservationSourceId>(value))
/** Ownership shared by catalog entries and every cursor. */
export const observationOwnerSchema = z.object({ experimentId: experimentIdSchema, serverId: serverIdSchema })
/** A registered source; legacy mixed files never claim separate streams. */
export const observationSourceSchema = observationOwnerSchema.extend({ version: z.literal(1), id: observationSourceIdSchema,
  kind: z.enum(['preparation', 'agent', 'process', 'legacy']), phase: z.enum(experimentPhases).optional(),
  sessionId: z.string().optional(), commandId: z.string().optional(), toolCallId: z.string().optional(), label: z.string(), createdAt: z.number(),
  streams: z.array(z.enum(['stdout', 'stderr', 'mixed'])), complete: z.boolean() }).strict()
/** Per-source byte cursor, including physical file identity. */
export const observationCursorSchema = observationOwnerSchema.extend({ sourceId: observationSourceIdSchema,
  stream: z.enum(['all', 'stdout', 'stderr', 'mixed']), generation: z.string(), offset: z.number().int().nonnegative() }).strict()
/** Tail, history, or incremental read. Before and cursor are mutually exclusive. */
export const observationReadSchema = observationOwnerSchema.extend({ sourceId: observationSourceIdSchema,
  stream: z.enum(['all', 'stdout', 'stderr', 'mixed']).default('all'), cursor: observationCursorSchema.optional(),
  before: observationCursorSchema.optional(), fromStart: z.boolean().optional(), limit: z.number().int().min(1024).max(262144).default(65536) }).strict()
  .refine(value => value.cursor === undefined || value.before === undefined, 'Choose one read direction')
/** Captured text with its real arrival time and order. Legacy entries omit unknown facts. */
export const observationLineSchema = z.object({ seq: z.number().int().nonnegative(), time: z.number().optional(),
  stream: z.enum(['stdout', 'stderr', 'mixed']), text: z.string() }).strict()
/** Both edges can resume independently, without replaying a partial final line. */
export const observationPageSchema = z.object({ lines: z.array(observationLineSchema), cursor: observationCursorSchema,
  before: observationCursorSchema, hasEarlier: z.boolean(), hasMore: z.boolean(), missing: z.boolean(), reset: z.boolean() }).strict()
/** Measured resource values; absence means not sampled, never zero. */
export const metricSampleSchema = observationOwnerSchema.extend({ time: z.number(), cpuPercent: z.number().optional(),
  memoryUsedBytes: z.number().optional(), memoryTotalBytes: z.number().optional(),
  gpus: z.array(z.object({ id: z.string(), name: z.string(), utilization: z.number().optional(), memoryUsedBytes: z.number().optional(), memoryTotalBytes: z.number().optional() })),
  training: z.record(z.string(), z.union([z.number(), z.string()])).optional(), error: z.string().optional() }).strict()
/** Resource history request; the Host validates ownership before reading. */
export const metricReadSchema = observationOwnerSchema.extend({ after: z.number().optional(), before: z.number().optional(),
  limit: z.number().int().min(1).max(1000).default(450) }).strict()
/** Registered observation source. */
export type ObservationSource = z.infer<typeof observationSourceSchema>
/** Public source read. */
export type ObservationRead = z.input<typeof observationReadSchema>
/** Public source page. */
export type ObservationPage = z.infer<typeof observationPageSchema>
/** Cursor binds file identity and selection to an experiment. */
export type ObservationCursor = z.infer<typeof observationCursorSchema>
/** One real metric observation. */
export type MetricSample = z.infer<typeof metricSampleSchema>
/** Resource history query. */
export type MetricRead = z.input<typeof metricReadSchema>
/** Deployment-owned sampling, retention, and response limits. */
export const observationPolicySchema = z.object({ intervalMs: z.number().int().min(500).default(2000),
  historyMs: z.number().int().min(60000).default(900000), readBytes: z.number().int().min(1024).max(262144).default(65536),
  metricSamples: z.number().int().min(30).max(10000).default(1000) }).default({ intervalMs: 2000, historyMs: 900000, readBytes: 65536, metricSamples: 1000 })
/** Validated observation policy. */
export type ObservationPolicy = z.infer<typeof observationPolicySchema>
