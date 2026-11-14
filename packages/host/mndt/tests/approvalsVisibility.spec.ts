import { describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'

const owner = 'duke@datanalysis.re'
const member = 'smarion@datanalysis.re'
const outsider = 'contact@datanalysis.re'

/** @returns the API over a fresh service: an owner (decides), a viewer member, a viewer outside. */
function bench() {
  const service = new WorkbenchService({ store: new MemoryStore() })
  const api = createMndtApi({
    service,
    runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
    identity: { tokens: { 'tok-owner': { user: owner }, 'tok-member': { user: member }, 'tok-outsider': { user: outsider } } },
    grants: {
      grants: async () => ({
        ok: true,
        grants: [{ subject: owner, role: 'owner' }, { subject: member, role: 'viewer' }, { subject: outsider, role: 'viewer' }],
      }),
    },
  })
  return { api, service }
}

type Card = { id: string; title: string; canDecide: boolean }
const read = async (api: ReturnType<typeof bench>['api'], token: string, query: Record<string, string> = {}): Promise<Card[]> => {
  const response = await api({ method: 'GET', path: '/approvals', query, authorization: `Bearer ${token}` })
  expect(response.status).toBe(200)
  return (response.body as { approvals: Card[] }).approvals
}

describe('the approval cards a person reads', () => {
  it('shows a channel card to its members only, never to a viewer outside the channel', async () => {
    const { api, service } = bench()
    const channel = await service.createChannel({ title: 'Compta', members: [owner, member] }, owner)
    await service.requestApproval({ kind: 'send-email', title: 'Relance facture Orange', payload: { to: 'x@example.com' }, requestedBy: owner, channelId: channel.id })
    expect((await read(api, 'tok-member')).map(card => card.title)).toEqual(['Relance facture Orange'])
    expect(await read(api, 'tok-outsider')).toEqual([])
    expect((await read(api, 'tok-owner')).map(card => card.title)).toEqual(['Relance facture Orange'])
  })

  it('shows a card outside any channel to the one who asked and to those who may decide', async () => {
    const { api, service } = bench()
    await service.requestApproval({ kind: 'spend', title: 'Achat licence', payload: {}, requestedBy: member })
    expect((await read(api, 'tok-member')).map(card => card.title)).toEqual(['Achat licence'])
    expect((await read(api, 'tok-owner')).map(card => card.title)).toEqual(['Achat licence'])
    expect(await read(api, 'tok-outsider')).toEqual([])
  })

  it('says per card whether the reader may decide it, and mine=1 is the « À traiter » queue', async () => {
    const { api, service } = bench()
    const channel = await service.createChannel({ title: 'Compta', members: [owner, member] }, owner)
    await service.requestApproval({ kind: 'send-email', title: 'Relance', payload: {}, requestedBy: owner, channelId: channel.id })
    expect((await read(api, 'tok-owner'))[0]?.canDecide).toBe(true)
    expect((await read(api, 'tok-member'))[0]?.canDecide).toBe(false)
    expect((await read(api, 'tok-owner', { state: 'pending', mine: '1' })).map(card => card.title)).toEqual(['Relance'])
    expect(await read(api, 'tok-member', { state: 'pending', mine: '1' })).toEqual([])
  })
})
