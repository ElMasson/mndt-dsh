import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import { teamRemoteRefusal } from '../src/gateway.ts'

const owner = 'duke@datanalysis.re'
const member = 'smarion@datanalysis.re'
const outsider = 'contact@datanalysis.re'
const admin = 'admin@datanalysis.re'
const SECRET = 'Virement Orange 48 200 euros confidentiel'

/** @returns the API with a private channel (owner and member) holding one card, and the card. */
async function bench() {
  const service = new WorkbenchService({ store: new MemoryStore() })
  const api = createMndtApi({
    service,
    runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
    identity: { tokens: { 'tok-owner': { user: owner }, 'tok-member': { user: member }, 'tok-outsider': { user: outsider }, 'tok-admin': { user: admin } } },
    grants: {
      grants: async () => ({
        ok: true,
        grants: [{ subject: owner, role: 'owner' }, { subject: member, role: 'viewer' }, { subject: outsider, role: 'viewer' }, { subject: admin, role: 'admin' }],
      }),
    },
  })
  const channel = await service.createChannel({ title: 'Direction', members: [owner, member] }, owner)
  await service.postMessage(channel.id, owner, 'point trésorerie')
  const card = await service.requestApproval({ kind: 'spend', title: SECRET, payload: { amount: 48200 }, requestedBy: owner, channelId: channel.id })
  return { api, card, channel }
}
const call = (api: Awaited<ReturnType<typeof bench>>['api'], token: string, method: string, path: string, query: Record<string, string> = {}, body?: unknown) =>
  api({ method, path, query, authorization: `Bearer ${token}`, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

describe('a card of a private channel never reaches a person outside it', () => {
  it('/state: neither among the cards nor in the journal', async () => {
    const { api, card } = await bench()
    const page = JSON.stringify((await call(api, 'tok-outsider', 'GET', '/state')).body)
    expect(page).not.toContain(card.id)
    expect(page).not.toContain(SECRET)
    expect(JSON.stringify((await call(api, 'tok-member', 'GET', '/state')).body)).toContain(SECRET)
  })

  it('/search: not found by its title', async () => {
    const { api } = await bench()
    expect(JSON.stringify((await call(api, 'tok-outsider', 'GET', '/search', { q: 'Orange' })).body)).not.toContain(SECRET)
    expect(JSON.stringify((await call(api, 'tok-member', 'GET', '/search', { q: 'Orange' })).body)).toContain(SECRET)
  })

  it('/events: no line about the card, the channel or its messages', async () => {
    const { api, card, channel } = await bench()
    const events = JSON.stringify((await call(api, 'tok-outsider', 'GET', '/events')).body)
    expect(events).not.toContain(card.id)
    expect(events).not.toContain(channel.id)
    expect(JSON.stringify((await call(api, 'tok-member', 'GET', '/events')).body)).toContain(card.id)
  })

  it('decide: a decider outside the channel gets 404, as if the card did not exist; a member decider decides', async () => {
    const { api, card, channel } = await bench()
    const refused = await call(api, 'tok-admin', 'POST', `/approvals/${card.id}/decide`, {}, { decision: 'approved' })
    expect(refused.status).toBe(404)
    expect(JSON.stringify(refused.body)).not.toContain(SECRET)
    expect((await call(api, 'tok-admin', 'POST', '/approvals/no-such-card/decide', {}, { decision: 'approved' })).status).toBe(404)
    // A viewer member reads it but may not decide it.
    expect((await call(api, 'tok-member', 'POST', `/approvals/${card.id}/decide`, {}, { decision: 'approved' })).status).toBe(403)
    expect(channel.members).toContain(owner)
    expect((await call(api, 'tok-owner', 'POST', `/approvals/${card.id}/decide`, {}, { decision: 'approved' })).status).toBe(200)
  })

  it('sweep: no GET route gives its id or its title to a person outside the channel', async () => {
    const { api, card } = await bench()
    const routes: [string, Record<string, string>][] = [
      ['/me', {}], ['/state', {}], ['/search', { q: 'Orange' }], ['/search', { q: card.id }], ['/metrics', {}], ['/mandates', {}],
      ['/journal', {}], ['/missions', {}], ['/briefs', {}], ['/approvals', {}], ['/approvals', { state: 'all' }],
      ['/approvals', { state: 'pending', mine: '1' }], ['/memory', {}], ['/machines', {}], ['/schedule', {}], ['/automations', {}],
      ['/connectors', {}], ['/agents', {}], ['/channels', {}], ['/events', {}], ['/events', { limit: '1000' }],
    ]
    for (const [path, query] of routes) {
      const body = JSON.stringify((await call(api, 'tok-outsider', 'GET', path, query)).body)
      expect(body, `GET ${path} ${JSON.stringify(query)}`).not.toContain(card.id)
      expect(body, `GET ${path} ${JSON.stringify(query)}`).not.toContain(SECRET)
    }
  })
})

describe('the workstation Remote on a team workbench', () => {
  it('is closed when a proxy proves each person, open on a workstation of one', () => {
    expect(teamRemoteRefusal('x-forwarded-email')).toContain('the workstation Remote is closed')
    expect(teamRemoteRefusal(undefined)).toBeUndefined()
    expect(teamRemoteRefusal('')).toBeUndefined()
  })

  it('guards every method that reads or acts as the workstation identity', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'gateway.ts'), 'utf8')
    const methods = [...source.matchAll(/@Remote\('([a-zA-Z]+)'\)\n {2}(?:async )?([a-zA-Z]+)\([^)]*\)[^{]*\{\n(.*)\n/g)]
    expect(methods.length).toBeGreaterThanOrEqual(8)
    for (const [, name, , firstLine] of methods) {
      // connectors only lists mounted server names, which /mndt-api/connectors serves to everyone.
      if (name === 'connectors') continue
      expect(firstLine, `@Remote('${name}')`).toContain('this.closedToTeam()')
    }
  })
})
