import { describe, expect, it } from 'vitest'
import { MemoryStore, spentThisMonth, WorkbenchService } from '../src/core/index.ts'
import type { Turn, WorkbenchState } from '../src/core/index.ts'

const at = '2026-11-24T08:00:00.000Z'
/** This process's start: what the previous one left is older. */
const START = '2026-11-24T09:00:00.000Z'
/** @param turns - the turns of one message each, as a previous process left them. @returns the service. */
async function left(turns: readonly Turn[]): Promise<WorkbenchService> {
  const store = new MemoryStore()
  await store.save({
    version: 1, missions: [], briefs: [], memories: [], approvals: [], events: [],
    messages: turns.map((turn, index) => ({
      id: `msg_${index}`, channelId: 'chn_1', author: { kind: 'human', email: 'duke@datanalysis.re' }, text: '@alpha ?',
      mentions: ['agt_a'], createdAt: at, updatedAt: at, turns: [turn],
    })),
  } as unknown as WorkbenchState)
  return new WorkbenchService({ store })
}

describe('turns left running or queued by a previous process are cancelled at start', () => {
  it('running: « interrompu par un redémarrage »; queued: « non lancé : redémarrage »; settled ones untouched', async () => {
    const service = await left([
      { id: 'trn_r', agentId: 'agt_a', status: 'running', startedAt: at },
      { id: 'trn_q', agentId: 'agt_a', status: 'queued' },
      { id: 'trn_d', agentId: 'agt_a', status: 'done', eur: 0.5, finishedAt: at },
      { id: 'trn_f', agentId: 'agt_a', status: 'failed', reason: 'x', finishedAt: at },
    ])
    expect(await service.cancelInterruptedTurns(START)).toEqual({ running: 1, queued: 1 })
    const turns = ((await service.snapshot()).messages ?? []).map(m => m.turns?.[0])
    expect(turns[0]).toMatchObject({ status: 'cancelled', reason: 'interrompu par un redémarrage' })
    expect(turns[0]?.finishedAt).toBeDefined()
    expect(turns[1]).toMatchObject({ status: 'cancelled', reason: 'non lancé : redémarrage' })
    expect(turns[2]).toEqual({ id: 'trn_d', agentId: 'agt_a', status: 'done', eur: 0.5, finishedAt: at })
    expect(turns[3]).toEqual({ id: 'trn_f', agentId: 'agt_a', status: 'failed', reason: 'x', finishedAt: at })
  })

  it('a cancelled turn keeps what it already cost: its steps, or its help\'s advices, for the right agent', async () => {
    const service = await left([
      { id: 'trn_s', agentId: 'agt_a', status: 'running', steps: [{ role: 'worker', agentId: 'agt_b', eur: 0.25 }] },
      {
        id: 'trn_h', agentId: 'agt_a', status: 'running',
        help: {
          state: 'done', request: { task: 't', tried: 't', blocker: 'b', options: ['o'], need: 'fact' }, peerIds: ['agt_b'],
          advices: [{ slot: 'A', round: 1, text: 'x', eur: 0.04, agentId: 'agt_b' }], capEur: 0.2, skipped: [], askedAt: at,
        },
      },
    ])
    await service.cancelInterruptedTurns(START)
    const messages = (await service.snapshot()).messages ?? []
    expect(messages[0]?.turns?.[0]?.eur).toBe(0.25)
    expect(messages[1]?.turns?.[0]?.eur).toBe(0.04)
    // Steps count for their own agent, a help for the asker: as before the restart.
    // finishedAt is the cancellation's instant: counted in the current month.
    const now = new Date().toISOString()
    expect(spentThisMonth(messages, 'agt_b', now)).toBe(0.25)
    expect(spentThisMonth(messages, 'agt_a', now)).toBe(0.04)
  })

  it('posts nothing in the thread, and a second start finds nothing: no write', async () => {
    const service = await left([{ id: 'trn_r', agentId: 'agt_a', status: 'running' }])
    await service.cancelInterruptedTurns(START)
    expect((await service.snapshot()).messages).toHaveLength(1)
    const events = (await service.snapshot()).events.length
    expect(await service.cancelInterruptedTurns(START)).toEqual({ running: 0, queued: 0 })
    expect((await service.snapshot()).events.length).toBe(events)
  })
})
