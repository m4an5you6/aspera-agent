/** Canonical provider metadata can be fetched by the local Host without transferring model payloads. */
import { z } from 'zod'
import type { inspectExperimentMaterialsSchema } from '@aspera/experiments'

/**
 * Read bounded metadata from the canonical provider and verify its immutable identity.
 * @param options - validated request, resolved limits, cancellation and HTTP dependency.
 * @returns the provider document for the node's independent file-manifest validation.
 */
export async function fetchCanonicalMaterialMetadata(options: {
  request: z.infer<typeof inspectExperimentMaterialsSchema>; readBytes: number; readTimeoutMs: number;
  signal: AbortSignal; fetcher: typeof fetch;
}): Promise<unknown> {
  const { request, signal, readBytes, readTimeoutMs, fetcher } = options
  if (request.provider !== 'huggingface') throw new Error('Canonical immutable metadata requires a provider-attested revision; mirror parameters are insufficient')
  const prefix = request.kind === 'dataset' ? 'datasets/' : 'models/'
  const response = await fetcher('https://huggingface.co/api/' + prefix + request.repository + '/revision/' + request.revision + '?blobs=true',
    { signal: AbortSignal.any([signal, AbortSignal.timeout(readTimeoutMs)]), redirect: 'error' })
  if (!response.ok) throw new Error('Canonical metadata request failed: HTTP ' + response.status)
  const chunks: Buffer[] = []; let length = 0
  if (response.body !== null) for await (const chunk of response.body) {
    length += chunk.length
    if (length > readBytes) throw new Error('Canonical metadata exceeds configured read bytes')
    chunks.push(Buffer.from(chunk))
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  z.object({ sha: z.literal(request.revision), id: z.literal(request.repository) }).parse(value)
  return value
}
