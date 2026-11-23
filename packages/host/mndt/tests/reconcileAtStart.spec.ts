import { describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import type { Message, WorkbenchState } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import { reconcileInterrupted } from '../src/reconcile.ts'

const owner = 'duke@datanalysis.re'
const old = '2026-11-20T08:00:00.000Z'

/** @returns a service whose state holds what a previous process left: a running turn and a running mission. */
async function leftOver() {
  const store = new MemoryStore()
  await store.save({
    version: 1, briefs: [], memories: [], approvals: [], events: [],
    missions: [{ id: 'mis_old', kind: 'briefing', prompt: 'p', status: 'running', createdBy: owner, createdAt: old, startedAt: old, visibility: 'team' }],
    agents: [{ id: 'agt_a', handle: 'alpha', name: 'alpha', provider: 'route-a', model: 'm', connectors: [], eurPerMonth: 5, createdBy: owner, createdAt: old }],
    channels: [{ id: 'chn_1', name: 'compta', title: 'compta', kind: 'team', members: [owner], agents: ['agt_a'], connectors: [], createdBy: owner, createdAt: old }],
    messages: [{
      id: 'msg_old', channelId: 'chn_1', author: { kind: 'human', email: owner }, text: '@alpha ?', mentions: ['agt_a'],
      createdAt: old, updatedAt: old, turns: [{ id: 'trn_old', agentId: 'agt_a', status: 'running', startedAt: old }],
    }],
  } as unknown as WorkbenchState)
  const service = new WorkbenchService({ store })
  const api = createMndtApi({
    service, runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
    identity: { tokens: { owner: { user: owner } } },
    grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }] }) },
  })
  const post = async (text: string): Promise<Message> =>
    (await api({ method: 'POST', path: '/channels/chn_1/messages', authorization: 'Bearer owner', body: JSON.stringify({ text }) })).body as never
  return { service, post }
}

describe('what a previous process left is settled before the API opens, and only that', () => {
  it('awaited, then a mention posted as soon as the API answers is never cancelled', async () => {
    const { service, post } = await leftOver()
    const warned: string[] = []
    const startedAt = new Date().toISOString()
    // The gateway opens the API on this promise only.
    await reconcileInterrupted(service, startedAt, (m) => { warned.push(m) }, (m) => { warned.push(`FAIL ${m}`) })
    const fresh = ((await post('@alpha le point ?')) as unknown as { message: Message }).message
    const state = await service.snapshot()
    expect(state.messages?.find(m => m.id === 'msg_old')?.turns?.[0]).toMatchObject({ status: 'cancelled', reason: 'interrompu par un redémarrage' })
    expect(state.missions.find(m => m.id === 'mis_old')?.status).toBe('failed')
    expect(state.messages?.find(m => m.id === fresh.id)?.turns?.[0]?.status).toBe('queued')
    expect(warned).toEqual([
      'mndt: 1 mission(s) left running by a previous process were marked failed',
      'mndt: 1 turn(s) running and 0 queued, left by a previous process, were cancelled',
    ])
  })

  it('the belt: even raced by a mention posted meanwhile, only what predates the start is cancelled', async () => {
    const { service, post } = await leftOver()
    const startedAt = new Date().toISOString()
    // A mention posted while the reconciliation runs (as if the API had opened too early).
    const [, posted] = await Promise.all([
      reconcileInterrupted(service, startedAt, () => undefined, () => undefined),
      post('@alpha tout de suite'),
    ])
    const freshId = (posted as unknown as { message: Message }).message.id
    // And once more, as a later start of the same process would.
    await reconcileInterrupted(service, startedAt, () => undefined, () => undefined)
    const fresh = (await service.snapshot()).messages?.find(m => m.id === freshId)
    expect(fresh?.turns?.[0]?.status).toBe('queued')
  })

  it('a fault is said with its cause, and the API still opens (the promise resolves)', async () => {
    const service = { listMissions: async () => { throw new Error('state.json unreadable') } } as unknown as WorkbenchService
    const failed: string[] = []
    const settled = reconcileInterrupted(service, new Date().toISOString(), () => undefined, (m) => { failed.push(m) })
    await expect(settled).resolves.toBeUndefined()
    expect(failed).toEqual(['mndt: could not reconcile what a previous process left: state.json unreadable'])
  })
})

describe('the start time also bounds the helps', () => {
  it('a help asked after the start is left open', async () => {
    const store = new MemoryStore()
    const now = new Date().toISOString()
    await store.save({
      version: 1, missions: [], briefs: [], memories: [], approvals: [], events: [],
      messages: [{
        id: 'msg_1', channelId: 'chn_1', author: { kind: 'human', email: owner }, text: '@alpha ?', mentions: ['agt_a'], createdAt: now, updatedAt: now,
        turns: [{
          id: 'trn_1', agentId: 'agt_a', status: 'running', startedAt: now,
          help: { state: 'advising', request: { task: 't', tried: 't', blocker: 'b', options: ['o'], need: 'fact' }, peerIds: ['agt_b'], advices: [], capEur: 0.2, skipped: [], askedAt: now },
        }],
      }],
    } as unknown as WorkbenchState)
    const service = new WorkbenchService({ store })
    expect(await service.closeInterruptedHelps(old)).toBe(0)
    expect(await service.cancelInterruptedTurns(old)).toEqual({ running: 0, queued: 0 })
    expect((await service.snapshot()).messages?.[0]?.turns?.[0]?.help?.state).toBe('advising')
  })
})
