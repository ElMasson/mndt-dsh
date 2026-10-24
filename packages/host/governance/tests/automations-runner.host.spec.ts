import { describe, expect, it, vi } from 'vitest'
import { executeAutomation } from '@deepseek-ai/dsh-host-governance/src/automations-runner.ts'

const target = { id: 'a1', owner: 'stephane', prompt: 'summarise the inbox' }

describe('sequencing', () => {
  it('creates the agent, starts the workflow with its prompt, and disposes', async () => {
    const order: string[] = []
    const dispose = vi.fn(async () => { order.push('dispose') })

    const outcome = await executeAutomation({
      createAgent: async () => { order.push('create'); return { dispose } },
      startWorkflow: async (_handle, prompt) => { order.push(`start:${prompt}`); return { done: true } },
    }, target)

    expect(order).toEqual(['create', 'start:summarise the inbox', 'dispose'])
    expect(outcome).toEqual({ ok: true, result: { done: true } })
  })

  it('does not start a workflow when agent creation fails, and reports why', async () => {
    const startWorkflow = vi.fn(async () => 'never')

    const outcome = await executeAutomation({
      createAgent: async () => { throw new Error('no agent factory registered') },
      startWorkflow,
    }, target)

    expect(startWorkflow).not.toHaveBeenCalled()
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('no agent factory')
  })

  it('disposes the agent when the workflow throws, and reports why', async () => {
    const dispose = vi.fn(async () => {})

    const outcome = await executeAutomation({
      createAgent: async () => ({ dispose }),
      startWorkflow: async () => { throw new Error('script threw') },
    }, target)

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('script threw')
  })

  it('reports success even when teardown fails, but still attempts teardown', async () => {
    const dispose = vi.fn(async () => { throw new Error('teardown refused') })

    const outcome = await executeAutomation({
      createAgent: async () => ({ dispose }),
      startWorkflow: async () => 'ok',
    }, target)

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(outcome).toEqual({ ok: true, result: 'ok' })
  })

  it('reports a workflow that stopped in error instead of a success', async () => {
    const outcome = await executeAutomation({
      createAgent: async () => ({ dispose: async () => {} }),
      startWorkflow: async () => ({ value: undefined, stopReason: 'error', error: 'worker-exit: sandbox refused' }),
    }, { id: 'a1', owner: 'stephane', prompt: 'do the thing' })

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('worker-exit: sandbox refused')
  })

  it('still reports a completed workflow as a success', async () => {
    const outcome = await executeAutomation({
      createAgent: async () => ({ dispose: async () => {} }),
      startWorkflow: async () => ({ value: 42, stopReason: 'completed' }),
    }, { id: 'a2', owner: 'stephane', prompt: 'count' })

    expect(outcome.ok).toBe(true)
  })
})
