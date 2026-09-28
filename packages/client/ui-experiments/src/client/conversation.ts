/** Read-only conversation projection from one experiment's incremental Session log. */

/** One settled, user-visible message, identified by its source Session sequence. */
export interface ExperimentMessage {
  seq: number
  role: 'user' | 'assistant' | 'tool'
  text: string
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function content(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value.flatMap((block: unknown) => {
    const item = object(block)
    if (item?.type === 'text' && typeof item.text === 'string') return [item.text]
    if (item?.type === 'tool-result') return [content(item.content)]
    return []
  }).join('\n')
}

/**
 * Project complete message lines, deduplicating their sequence within this source.
 * @param text - bounded JSONL tail for one experiment; its first and last lines may be partial.
 * @returns settled text messages in source sequence order.
 */
export function experimentConversation(text: string): ExperimentMessage[] {
  const messages = new Map<number, ExperimentMessage>()
  for (const line of text.split('\n').slice(0, -1)) {
    let raw: unknown
    try { raw = JSON.parse(line) }
    catch (error) { void error; continue } // A retained tail may begin within an older event.
    const event = object(raw)
    if (event === undefined || typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq)) continue
    const data = object(event.data)
    const message = event.type === 'user/message' ? data : object(data?.message)
    const role = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant'
      : event.type === 'tool/result' ? 'tool' : undefined
    if (role === undefined || message === undefined) continue
    const body = content(message.content)
    if (body !== '') messages.set(event.seq, { seq: event.seq, role, text: body })
  }
  return [...messages.values()].sort((a, b) => a.seq - b.seq)
}
