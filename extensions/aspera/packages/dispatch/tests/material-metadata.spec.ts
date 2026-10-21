/** Host metadata requests attest immutable repository identities without fetching payloads. */
import { expect, it, vi } from 'vitest'
import { inspectExperimentMaterialsSchema } from '@aspera/experiments'
import { fetchCanonicalMaterialMetadata } from '../src/material-metadata.ts'

function fixture() {
  const request = inspectExperimentMaterialsSchema.parse({ kind: 'model', provider: 'huggingface', repository: 'fixture/model', revision: 'a'.repeat(40), mirror: 'https://modelscope.cn' })
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: request.repository, sha: request.revision, siblings: [] }))
  return { request, readBytes: 1024, readTimeoutMs: 1000, signal: new AbortController().signal, fetcher }
}
it('contacts the canonical commit endpoint even when a mirror is selected', async () => {
  const f = fixture(); await fetchCanonicalMaterialMetadata(f)
  expect(f.fetcher).toHaveBeenCalledWith('https://huggingface.co/api/models/fixture/model/revision/' + 'a'.repeat(40) + '?blobs=true', expect.objectContaining({ redirect: 'error' }))
})
it('rejects a floating or foreign repository response and oversized metadata', async () => {
  const f = fixture()
  for (const value of [{ id: f.request.repository, sha: 'b'.repeat(40) }, { id: 'other/model', sha: f.request.revision }]) {
    f.fetcher.mockResolvedValueOnce(Response.json(value))
    await expect(fetchCanonicalMaterialMetadata(f)).rejects.toThrow()
  }
  f.fetcher.mockResolvedValueOnce(new Response('x'.repeat(2048)))
  await expect(fetchCanonicalMaterialMetadata(f)).rejects.toThrow(/configured read bytes/)
})
it('does not treat a mirror revision parameter as provider attestation', async () => {
  const f = fixture(); f.request.provider = 'modelscope'
  await expect(fetchCanonicalMaterialMetadata(f)).rejects.toThrow(/provider-attested/)
  expect(f.fetcher).not.toHaveBeenCalled()
})
