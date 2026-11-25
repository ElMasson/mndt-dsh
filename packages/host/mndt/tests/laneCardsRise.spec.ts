/**
 * A card nobody in its channel may decide rises to the deciders (decision of
 * 24/11, the narrow reading): an operator's lane, a channel with no owner nor
 * admin. The card alone — never the channel, its messages nor its documents. A
 * channel that already has a decider among its members keeps its cards.
 */
import { describe, expect, it } from 'vitest'
import { MemoryStore, UnreadableApproval, WorkbenchService } from '../src/core/index.ts'
import { RISEN_CARD_DETAIL } from '../src/visibility.ts'
import { createMndtApi } from '../src/api.ts'

const owner = 'duke@datanalysis.re'
const admin = 'jadmin@datanalysis.re'
const operator = 'smarion@datanalysis.re'
const other = 'contact@datanalysis.re'

function bench() {
  const service = new WorkbenchService({ store: new MemoryStore() })
  const api = createMndtApi({
    service,
    runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
    identity: { tokens: { owner: { user: owner }, admin: { user: admin }, operator: { user: operator }, other: { user: other } } },
    grants: {
      grants: async () => ({
        ok: true,
        grants: [{ subject: owner, role: 'owner' }, { subject: admin, role: 'admin' }, { subject: operator, role: 'operator' }, { subject: other, role: 'operator' }],
      }),
    },
  })
  const call = async (method: string, path: string, who: string, body?: unknown, query: Record<string, string> = {}) => {
    const answer = await api({ method, path, query, authorization: `Bearer ${who}`, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: answer.status, body: answer.body as Record<string, unknown> }
  }
  const pending = async (who: string) => (((await call('GET', '/approvals', who, undefined, { state: 'pending', mine: '1' })).body.approvals ?? []) as { id: string; title: string; canDecide?: boolean }[])
  return { service, call, pending }
}

describe('a card no member of its channel may decide rises to the deciders', () => {
  it('a card in an operator\'s lane: the owner and the admin read it and decide it, without reading the lane', async () => {
    const b = bench()
    const lane = await b.service.laneOf(operator)
    await b.service.postMessage(lane.id, operator, 'Note privée de la lane')
    const card = await b.service.requestApproval({ kind: 'send-email', title: 'Relance Orange', payload: { to: 'x@example.com' }, requestedBy: operator, channelId: lane.id })
    for (const decider of ['owner', 'admin']) {
      const seen = await b.pending(decider)
      expect(seen.map(c => c.title)).toEqual(['Relance Orange'])
      expect(seen[0]?.canDecide).toBe(true)
      // The lane itself stays the operator's: its messages are not served to a decider.
      expect((await b.call('GET', `/channels/${lane.id}/messages`, decider)).status).not.toBe(200)
    }
    // The operator follows where their card stands.
    expect((await b.call('GET', '/approvals', 'operator')).body.approvals).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Relance Orange' })]))
    const decided = await b.call('POST', `/approvals/${card.id}/decide`, 'owner', { decision: 'approved' })
    expect(decided.status).toBe(200)
    expect(((await b.call('GET', '/approvals', 'operator', undefined, { state: 'all' })).body.approvals as { id: string; state: string }[]).find(c => c.id === card.id)?.state).toBe('approved')
  })

  it('the journal follows: the decider reads the card\'s lines, never the lane\'s messages; another operator reads neither', async () => {
    const b = bench()
    const lane = await b.service.laneOf(operator)
    const note = await b.service.postMessage(lane.id, operator, 'Note privée de la lane')
    const card = await b.service.requestApproval({ kind: 'spend', title: 'Achat', payload: {}, requestedBy: operator, channelId: lane.id })
    const subjects = async (who: string) => ((await b.call('GET', '/events', who)).body.events as { subject?: string }[]).map(event => event.subject)
    const owners = await subjects('owner')
    expect(owners).toContain(card.id)
    expect(owners).not.toContain(note.id)
    expect(owners).not.toContain(lane.id)
    const others = await subjects('other')
    expect(others).not.toContain(card.id)
    expect(others).not.toContain(note.id)
  })

  it('a risen card\'s journal lines carry nothing of its channel for a decider outside it; its members read them whole', async () => {
    const b = bench()
    const lane = await b.service.laneOf(operator)
    const card = await b.service.requestApproval({ kind: 'spend', title: 'Achat', payload: {}, requestedBy: operator, channelId: lane.id })
    expect((await b.call('POST', `/approvals/${card.id}/decide`, 'owner', { decision: 'rejected', reason: 'trop cher' })).status).toBe(200)
    const lines = async (who: string) => ((await b.call('GET', '/events', who)).body.events as { action: string; subject?: string; detail?: string }[])
      .filter(event => event.subject === card.id)
    const outside = await lines('owner')
    expect(outside.map(event => event.action)).toEqual(['approval.requested', 'approval.rejected'])
    expect(outside.every(event => event.detail === RISEN_CARD_DETAIL)).toBe(true)
    expect((await lines('operator')).map(event => event.detail)).toEqual(['spend', 'trop cher'])
  })

  it('the decision reads the card again inside its own write: a card its decider can no longer read is not decided', async () => {
    const b = bench()
    const lane = await b.service.laneOf(operator)
    const card = await b.service.requestApproval({ kind: 'spend', title: 'Achat', payload: {}, requestedBy: operator, channelId: lane.id })
    await expect(b.service.decideApproval(card.id, owner, 'approved', undefined, () => false)).rejects.toBeInstanceOf(UnreadableApproval)
    expect((await b.service.listApprovals('all')).find(c => c.id === card.id)?.state).toBe('pending')
    // The guard is given the state of the write, the card included.
    let seen: string | undefined
    await b.service.decideApproval(card.id, owner, 'approved', undefined, (state, approval) => {
      seen = `${state.approvals.length} ${approval.id}`
      return true
    })
    expect(seen).toBe(`1 ${card.id}`)
  })

  it('a context card never rises, even one born before the refusal: a decider from outside does not write a channel they do not read', async () => {
    const b = bench()
    const lane = await b.service.laneOf(operator)
    await b.service.requestApproval({
      kind: 'propose_context', title: 'Contexte du canal', payload: {}, requestedBy: operator, channelId: lane.id,
      contextProposal: { text: 'Client : Orange.', baseVersion: 0 },
    })
    expect(await b.pending('owner')).toEqual([])
    expect(await b.pending('admin')).toEqual([])
  })

  it('a risen card says where it comes from, a lane or a channel, and nothing else of it; a member reads it without origin', async () => {
    const b = bench()
    const lane = await b.service.laneOf(operator)
    await b.service.requestApproval({ kind: 'spend', title: 'Depuis la lane', payload: {}, requestedBy: operator, channelId: lane.id })
    const field = await b.service.createChannel({ title: 'Terrain', members: [operator, other] }, operator)
    await b.service.requestApproval({ kind: 'publish', title: 'Depuis le canal', payload: {}, requestedBy: other, channelId: field.id })
    const cards = (await b.call('GET', '/approvals', 'owner')).body.approvals as { title: string; origin?: unknown }[]
    expect(Object.fromEntries(cards.map(card => [card.title, card.origin]))).toEqual({
      'Depuis la lane': { kind: 'lane' },
      'Depuis le canal': { kind: 'channel' },
    })
    expect(JSON.stringify(cards)).not.toContain('Terrain')
    const theirs = (await b.call('GET', '/approvals', 'operator')).body.approvals as { origin?: unknown }[]
    expect(theirs.map(card => card.origin)).toEqual([undefined, undefined])
  })

  it('the search serves a risen card with its origin and nothing of its channel; a member finds it without origin', async () => {
    const b = bench()
    const field = await b.service.createChannel({ title: 'Terrain secret', members: [operator, other] }, operator)
    await b.service.requestApproval({ kind: 'publish', title: 'Publier le compte rendu', payload: {}, requestedBy: other, channelId: field.id })
    const lane = await b.service.laneOf(operator)
    await b.service.requestApproval({ kind: 'spend', title: 'Publier la facture', payload: {}, requestedBy: operator, channelId: lane.id })
    const hits = async (who: string) => ((await b.call('GET', '/search', who, undefined, { q: 'publier' })).body.hits as { label: string; origin?: unknown }[])
    const owners = await hits('owner')
    expect(Object.fromEntries(owners.map(hit => [hit.label, hit.origin]))).toEqual({
      'Publier le compte rendu': { kind: 'channel' },
      'Publier la facture': { kind: 'lane' },
    })
    expect(JSON.stringify(owners)).not.toContain('Terrain secret')
    expect((await hits('operator')).map(hit => hit.origin)).toEqual([undefined, undefined])
  })

  it('another operator never sees it, nor can decide it', async () => {
    const b = bench()
    const lane = await b.service.laneOf(operator)
    const card = await b.service.requestApproval({ kind: 'spend', title: 'Achat', payload: {}, requestedBy: operator, channelId: lane.id })
    expect(await b.pending('other')).toEqual([])
    expect(((await b.call('GET', '/approvals', 'other')).body.approvals as unknown[]).length).toBe(0)
    expect((await b.call('POST', `/approvals/${card.id}/decide`, 'other', { decision: 'approved' })).status).toBe(404)
  })

  it('a channel with a decider among its members keeps its card: an admin outside it does not see it', async () => {
    const b = bench()
    const channel = await b.service.createChannel({ title: 'Compta', members: [owner, operator] }, owner)
    await b.service.requestApproval({ kind: 'send-email', title: 'Relance interne', payload: {}, requestedBy: operator, channelId: channel.id })
    expect((await b.pending('owner')).map(c => c.title)).toEqual(['Relance interne'])
    expect(await b.pending('admin')).toEqual([])
  })

  it('a channel with no owner nor admin among its members: its cards rise too', async () => {
    const b = bench()
    const channel = await b.service.createChannel({ title: 'Terrain', members: [operator, other] }, operator)
    await b.service.requestApproval({ kind: 'publish', title: 'Publier le compte rendu', payload: {}, requestedBy: other, channelId: channel.id })
    expect((await b.pending('admin')).map(c => c.title)).toEqual(['Publier le compte rendu'])
    expect((await b.call('GET', `/channels/${channel.id}/messages`, 'admin')).status).not.toBe(200)
  })
})
