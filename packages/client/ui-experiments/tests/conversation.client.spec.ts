/** Conversation tails preserve settled messages without mixing sources or partial lines. */
import { expect, it } from 'vitest'
import { experimentConversation } from '../src/client/conversation.ts'

it('renders settled text once per sequence and waits for partial lines', () => {
  const line = JSON.stringify({ seq: 7, type: 'assistant/message', data: { message: { content: [{ type: 'text',
    text: 'Training completed.' }] } } })
  const hidden = JSON.stringify({ seq: 8, type: 'system/message', data: { message: { content: [{ type: 'text',
    text: 'Private instructions.' }] } } })
  expect(experimentConversation('tail\n' + line + '\n' + hidden + '\n' + line + '\n' + line.slice(0, 20))).toEqual([
    { seq: 7, role: 'assistant', text: 'Training completed.' },
  ])
  expect(experimentConversation(line)).toEqual([])
})
