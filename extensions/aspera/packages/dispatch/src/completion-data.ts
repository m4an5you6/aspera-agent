/** Supplementary evidence keeps JSON framing while removing credentials from structured and embedded data. */
import { redactObservation } from '@aspera/runtime'

function structured(text: string): { value: unknown } | undefined {
  if (!/^\s*[[{]/.test(text)) return undefined
  try { return { value: JSON.parse(text) } }
  catch (error) { /* Plain text and incomplete file windows retain their original text representation. */ void error; return undefined }
}

/** @param text - evidence text or an embedded JSON/JSONL document. @param secrets - account-owned credentials.
 * @returns redacted text whose complete JSON objects and lines remain parseable.
 */
export function redactCompletionText(text: string, secrets: readonly string[]): string {
  const document = structured(text)
  if (document !== undefined) return JSON.stringify(redactCompletionData(document.value, secrets))
  return text.split('\n').map(line => {
    const parsed = structured(line)
    return parsed === undefined ? redactObservation(line, secrets) : JSON.stringify(redactCompletionData(parsed.value, secrets))
  }).join('\n')
}

/** @param value - parsed evidence, receipt or Session event. @param secrets - account-owned credentials.
 * @returns credential-free data with unchanged non-secret values, field names and JSON structure.
 */
export function redactCompletionData(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactCompletionText(value, secrets)
  if (Array.isArray(value)) return value.map(entry => redactCompletionData(entry, secrets))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    /^(?:extra)?headers$/i.test(key) ? { redacted: true }
      : /(?:authorization|api[_-]?key|password|(?:access[_-]?)?token|secret)$/i.test(key) && entry !== null
        ? '[redacted]' : redactCompletionData(entry, secrets)]))
  return value
}
