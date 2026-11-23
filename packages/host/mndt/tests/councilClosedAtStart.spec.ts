import { describe, expect, it } from 'vitest'
import { MemoryStore, servedMessage, WorkbenchService } from '../src/core/index.ts'
import type { TurnCouncil, WorkbenchState } from '../src/core/index.ts'
import { reconcileInterrupted } from '../src/reconcile.ts'

const old = '2026-11-20T08:00:00.000Z'
/** @param state - the council's state. @param startedAt - when it started. @returns a council, one position recorded with its member. */
const council = (state: TurnCouncil['state'], startedAt = old): TurnCouncil => ({
  state, question: 'HT ou TTC ?', options: ['HT', 'TTC', 'aucune de ces options'],
  framing: { text: '{}', agentId: 'agt_a', eur: 0.01 },
  positions: [{ slot: 'A', choice: 1, text: 'HT', agentId: 'agt_b', model: 'route-b/m', eur: 0.02, tokens: { input: 10, output: 1 } }],
  critiques: [], dissent: [], capEur: 1, skipped: [], startedAt,
  ...(state === 'done' ? { decision: { kind: 'vote' as const, tally: { 1: 2 }, chosen: 1 } } : {}),
})

async function left(councils: readonly TurnCouncil[]): Promise<WorkbenchService> {
  const store = new MemoryStore()
  await store.save({
    version: 1, missions: [], briefs: [], memories: [], approvals: [], events: [],
    messages: councils.map((c, index) => ({
      id: `msg_${index}`, channelId: 'chn_1', author: { kind: 'human', email: 'duke@datanalysis.re' }, text: '@alpha ?', mentions: ['agt_a'],
      createdAt: c.startedAt, updatedAt: c.startedAt,
      turns: [{ id: `trn_${index}`, agentId: 'agt_a', status: c.state === 'done' ? 'done' : 'cancelled', startedAt: c.startedAt, council: c }],
    })),
  } as unknown as WorkbenchState)
  return new WorkbenchService({ store })
}

describe('a council left open by a previous process is closed at start', () => {
  it('deliberating, critiquing and deciding become done, « redémarrage », with no decision; a decided one is untouched', async () => {
    const service = await left([council('deliberating'), council('critiquing'), council('deciding'), council('done')])
    expect(await service.closeInterruptedCouncils(new Date().toISOString())).toBe(3)
    const closed = ((await service.snapshot()).messages ?? []).map(m => m.turns?.[0]?.council)
    expect(closed.slice(0, 3).every(c => c?.state === 'done' && c.decision === undefined && c.skipped.at(-1)?.reason === 'redémarrage')).toBe(true)
    expect(closed[3]).toEqual(council('done'))
  })

  it('no member is named once closed: without a decision, the served council keeps them withheld', async () => {
    const service = await left([council('critiquing')])
    await service.closeInterruptedCouncils(new Date().toISOString())
    const served = servedMessage(((await service.snapshot()).messages ?? [])[0] as never)
    const c = served.turns?.[0]?.council
    expect(c?.positions.every(p => p.agentId === undefined && p.model === undefined && p.eur === undefined)).toBe(true)
    expect(c?.skipped.at(-1)).toEqual({ reason: 'avis non obtenu : redémarrage' })
    expect(JSON.stringify(served)).not.toContain('agt_b')
  })

  it('the belt: a council started since this process started is left alone; reconcileInterrupted says how many it closed', async () => {
    const now = new Date().toISOString()
    const service = await left([council('critiquing'), council('deliberating', '2999-01-01T00:00:00.000Z')])
    const warned: string[] = []
    await reconcileInterrupted(service, now, (m) => { warned.push(m) }, () => undefined)
    const states = ((await service.snapshot()).messages ?? []).map(m => m.turns?.[0]?.council?.state)
    expect(states).toEqual(['done', 'deliberating'])
    expect(warned).toContain('mndt: 1 council(s) left open by a previous process were closed (« redémarrage »)')
  })

  it('a second start finds nothing: 0, and no write', async () => {
    const service = await left([council('deciding')])
    const now = new Date().toISOString()
    await service.closeInterruptedCouncils(now)
    const events = (await service.snapshot()).events.length
    expect(await service.closeInterruptedCouncils(now)).toBe(0)
    expect((await service.snapshot()).events.length).toBe(events)
  })
})
