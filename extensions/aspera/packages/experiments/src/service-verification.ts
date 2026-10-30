/** Agent-requested public inference checks keep credentials outside Session and result records. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { experimentIdSchema, serverIdSchema, serviceIdSchema, deploymentIdSchema } from './cluster-protocol.ts'

/** One explicit generation request; replaying its identity never sends another generation. */
export type ServiceVerificationId = string & Branded<'ServiceVerificationId'>
export type ServiceVerificationClaimId = string & Branded<'ServiceVerificationClaimId'>
/** Original public check identity is validated at model, file and wire inputs. */
export const serviceVerificationIdSchema = z.uuid().transform(value => brandString<ServiceVerificationId>(value))
/** One private Host claim cannot be substituted by a concurrent worker. */
export const serviceVerificationClaimIdSchema = z.uuid().transform(value => brandString<ServiceVerificationClaimId>(value))
export const serviceVerificationInputSchema = z.object({ operationId: serviceVerificationIdSchema, serviceId: serviceIdSchema,
  maxTokens: z.number().int().min(1).max(256) }).strict()
/** Individual HTTP observations include the original check time and bounded response text. */
export const serviceVerificationCheckSchema = z.object({ name: z.enum(['identity', 'unauthenticated', 'invalid-credential', 'models', 'generation']),
  passed: z.boolean(), status: z.number().int().optional(), checkedAt: z.number().int().nonnegative(), detail: z.string().max(32768) }).strict()
/** Generation transport uncertainty cannot be converted into an automatic retry. */
export const serviceVerificationResultSchema = z.object({ state: z.enum(['passed', 'failed', 'unknown']),
  checks: z.array(serviceVerificationCheckSchema).max(5), detail: z.string().max(32768), finishedAt: z.number().int().nonnegative() }).strict()
/** Independent version-1 records bind a public check to the original service process and release. */
export const serviceVerificationSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema,
  deploymentId: deploymentIdSchema, input: serviceVerificationInputSchema, commandId: z.string(), modelName: z.string(),
  url: z.string().url(), createdAt: z.number().int().nonnegative(), deadline: z.number().int().nonnegative(),
  state: z.enum(['requested', 'claimed', 'passed', 'failed', 'unknown']), claimId: serviceVerificationClaimIdSchema.optional(),
  result: serviceVerificationResultSchema.optional() }).strict()
export type ServiceVerificationInput = z.infer<typeof serviceVerificationInputSchema>
export type ServiceVerification = z.infer<typeof serviceVerificationSchema>
export type ServiceVerificationResult = z.infer<typeof serviceVerificationResultSchema>
