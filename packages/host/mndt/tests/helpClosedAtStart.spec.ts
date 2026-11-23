import { describe, expect, it } from 'vitest'
import { MemoryStore, servedMessage, WorkbenchService } from '../src/core/index.ts'
import type { TurnHelp, WorkbenchState } from '../src/core/index.ts'

const at = '2026-11-24T08:00:00.000Z'
/** @param state - the help's state. @returns a help, one advice recorded with its peer. */
const help = (state: TurnHelp['state']): TurnHelp => ({
  state,
  request: { task: 't', tried: 't', blocker: 'b', options: ['o'], need: 'fact' },
  peerIds: ['agt_b', 'agt_c'],
  advices: [{ slot: 'A', round: 1, text: 'HT', eur: 0.01, tokens: { input: 10, output: 1 }, agentId: 'agt_c', model: 'route-b/m' }],
  capEur: 0.2, skipped: [], askedAt: at,
  ...(state === 'done' ? { reading: { retained: 'A', why: 'w', verdict: 'unblocked' as const } } : {}),
})

/** @returns a service whose state holds one help per state, as a previous process left them. */
async function left(): Promise<WorkbenchService> {
  const store = new MemoryStore()
  const states: TurnHelp['state'][] = ['asked', 'advising', 'reading', 'done']
  const state = {
    version: 1, missions: [], briefs: [], memories: [], approvals: [], events: [],
    messages: states.map((s, index) => ({
      id: `msg_${index}`, channelId: 'chn_1', author: { kind: 'human', email: 'duke@datanalysis.re' }, text: '@alpha ?', mentions: ['agt_a'],
      createdAt: at, updatedAt: at, turns: [{ id: `trn_${index}`, agentId: 'agt_a', status: s === 'done' ? 'done' : 'running', help: help(s) }],
    })),
  } as unknown as WorkbenchState
  await store.save(state)
  return new WorkbenchService({ store })
}

describe('a help left open by a previous process is closed at start', () => {
  it('asked, advising and reading become done, « redémarrage », with no reading; a finished one is untouched', async () => {
    const service = await left()
    expect(await service.closeInterruptedHelps()).toBe(3)
    const messages = (await service.snapshot()).messages ?? []
    const helps = messages.map(m => m.turns?.[0]?.help)
    expect(helps.slice(0, 3).every(h => h?.state === 'done' && h.reading === undefined && h.skipped.at(-1)?.reason === 'redémarrage')).toBe(true)
    expect(helps[3]).toEqual(help('done'))
  })

  it('no peer is named once closed: without a reading, the served help keeps them withheld', async () => {
    const service = await left()
    await service.closeInterruptedHelps()
    const served = ((await service.snapshot()).messages ?? []).slice(0, 3).map(servedMessage)
    for (const message of served) {
      const closed = message.turns?.[0]?.help
      expect(closed?.peerIds).toEqual([])
      expect(closed?.advices.every(a => a.agentId === undefined && a.model === undefined && a.eur === undefined)).toBe(true)
      expect(JSON.stringify(message)).not.toMatch(/agt_b|agt_c/)
      expect(closed?.skipped.at(-1)).toEqual({ reason: 'avis non obtenu : redémarrage' })
    }
  })

  it('a second start finds nothing open: 0, and no write', async () => {
    const service = await left()
    await service.closeInterruptedHelps()
    const events = (await service.snapshot()).events.length
    expect(await service.closeInterruptedHelps()).toBe(0)
    expect((await service.snapshot()).events.length).toBe(events)
  })
})
