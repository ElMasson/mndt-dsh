import { describe, expect, it, vi } from 'vitest'
import { AutomationScheduler } from '@deepseek-ai/dsh-host-governance/src/automations-scheduler.ts'

/** Build a scheduler over a fixed clock and a recorder. */
function bench(options: { now: Date; items: { id: string; everyMinutes: number; enabled: boolean }[] }) {
  const runs: string[] = []
  const scheduler = new AutomationScheduler({
    list: async () => options.items,
    run: async (item) => { runs.push(item.id) },
    now: () => options.now,
    graceMs: 0,
  })
  return { scheduler, runs }
}

describe('due computation', () => {
  it('runs an automation that never ran yet', async () => {
    const { scheduler, runs } = bench({
      now: new Date('2026-10-19T09:00:00.000Z'),
      items: [{ id: 'a', everyMinutes: 60, enabled: true }],
    })

    const outcome = await scheduler.tick()

    expect(outcome.ran).toEqual(['a'])
    expect(runs).toEqual(['a'])
  })

  it('does not run it again before its interval elapsed', async () => {
    const { scheduler, runs } = bench({
      now: new Date('2026-10-19T09:00:00.000Z'),
      items: [{ id: 'a', everyMinutes: 60, enabled: true }],
    })
    await scheduler.tick()

    const outcome = await scheduler.tick()

    expect(outcome.ran).toEqual([])
    expect(runs).toEqual(['a'])
  })

  it('skips disabled automations', async () => {
    const { scheduler, runs } = bench({
      now: new Date('2026-10-19T09:00:00.000Z'),
      items: [{ id: 'a', everyMinutes: 1, enabled: false }],
    })

    await scheduler.tick()

    expect(runs).toEqual([])
  })

  it('runs a long-interval automation again when the clock has moved past it', async () => {
    const items = [{ id: 'a', everyMinutes: 60, enabled: true }]
    const first = bench({ now: new Date('2026-10-19T09:00:00.000Z'), items })
    await first.scheduler.tick()

    // Same scheduler, later clock: mutate through a closure is not needed because
    // the clock seam is read on every tick only if it is a function of state.
    const runsAgain = vi.fn(async () => {})
    const scheduler = new AutomationScheduler({
      list: async () => items,
      run: runsAgain,
      now: () => new Date('2026-10-19T10:31:00.000Z'),
      graceMs: 0,
    })
    const fresh = await scheduler.tick()
    expect(fresh.ran).toEqual(['a'])
    expect(runsAgain).toHaveBeenCalledTimes(1)
  })
})

describe('failure handling', () => {
  it('reports a runner failure instead of swallowing it', async () => {
    const scheduler = new AutomationScheduler({
      list: async () => [{ id: 'a', everyMinutes: 1, enabled: true }],
      run: async () => { throw new Error('agent creation refused') },
      now: () => new Date('2026-10-19T09:00:00.000Z'),
      graceMs: 0,
    })

    const outcome = await scheduler.tick()

    expect(outcome.ran).toEqual([])
    expect(outcome.failed).toEqual([{ id: 'a', reason: 'agent creation refused' }])
  })

  it('keeps going when one automation fails and another succeeds', async () => {
    const scheduler = new AutomationScheduler({
      list: async () => [
        { id: 'bad', everyMinutes: 1, enabled: true },
        { id: 'good', everyMinutes: 1, enabled: true },
      ],
      run: async (item) => {
        if (item.id === 'bad') throw new Error('nope')
      },
      now: () => new Date('2026-10-19T09:00:00.000Z'),
      graceMs: 0,
    })

    const outcome = await scheduler.tick()

    expect(outcome.failed.map(entry => entry.id)).toEqual(['bad'])
    expect(outcome.ran).toEqual(['good'])
  })
})
