import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it } from 'vitest'
import { installGoalUnattended } from '../src/unattended.ts'
import type { GoalUnattended } from '../src/unattended.ts'

function fixture() {
  const events: unknown[] = []
  const root = { id: 'root', session: { snapshotEvents: () => events } } as unknown as Agent
  const child = { id: 'child' } as Agent
  const agents = [root, child]
  let phase: 'active' | 'complete' = 'active'
  let service: GoalUnattended | undefined
  const ctx = {
    agents: {
      get: (id: string) => agents.find(agent => agent.id === id),
      roots: () => [root],
      list: () => agents,
      isOwnedBy: (id: string, owner: Agent) => id === child.id && owner === root,
    },
    goals: { get: () => ({ id: 'goal-1', phase }) },
    provide: (_name: string, value: GoalUnattended) => { service = value },
  } as unknown as Context
  const install = (): GoalUnattended => {
    installGoalUnattended(ctx)
    if (service === undefined) throw new Error('unattended service was not installed')
    return service
  }
  return { events, root, child, install, complete: () => { phase = 'complete' } }
}

it('recovers an active Goal and its owned child after plugin reload', () => {
  const { root, child, install } = fixture()
  expect(install().covers(root)).toBe(true)
  expect(install().covers(child)).toBe(true)
})

it('covers a completed Goal until the next direct human message across reload', () => {
  const { events, root, complete, install } = fixture()
  events.push({ type: 'goal/change', data: { operation: 'complete', goal: { id: 'goal-1' } } })
  complete()
  expect(install().covers(root)).toBe(true)
  expect(install().covers(root)).toBe(true)
  events.push({ type: 'user/message', data: { source: { kind: 'user' } } })
  expect(install().covers(root)).toBe(false)
})
