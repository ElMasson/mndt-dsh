import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import type { MissionRunner } from '../src/api.ts'
import { roleChangeRefusal } from '../src/policy.ts'

const owner = 'owner@datanalysis.re'
const second = 'second@datanalysis.re'
const admin = 'admin@datanalysis.re'
const operator = 'operateur@datanalysis.re'
const viewer = 'lecteur@datanalysis.re'
const TABLE = [
  { subject: owner, role: 'owner' as const },
  { subject: admin, role: 'admin' as const },
  { subject: operator, role: 'operator' as const },
  { subject: viewer, role: 'viewer' as const },
]
const noMissions: MissionRunner = { run: async () => ({ title: 't', markdown: 'm', sources: [] }) }

/** @returns the API over a fixed table, and what reached the authority. */
function bench(table = TABLE) {
  const service = new WorkbenchService({ store: new MemoryStore() })
  const forwarded: { url: string; body: unknown }[] = []
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    forwarded.push({ url, body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ allowed: true, reason: 'ok' }), { status: 200 })
  })
  const tokens = Object.fromEntries([owner, second, admin, operator, viewer].map(user => [user, { user }]))
  const api = createMndtApi({
    service,
    runner: noMissions,
    identity: { tokens },
    grants: { grants: async () => ({ ok: true, grants: table }) },
    authority: { baseUrl: 'http://authority.test', token: 'deployment-token' },
  })
  const call = async (path: string, who: string, body: unknown) => {
    const answer = await api({ method: 'POST', path, authorization: `Bearer ${who}`, body: JSON.stringify(body) })
    return { status: answer.status, body: answer.body as Record<string, unknown> }
  }
  return { service, forwarded, call }
}

describe('who may change whose role (members routes)', () => {
  beforeEach(() => { vi.unstubAllGlobals() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('an admin only touches roles strictly below their own', async () => {
    const peer = 'pair@datanalysis.re'
    const b = bench([...TABLE, { subject: peer, role: 'admin' }])
    expect((await b.call('/members/grant', admin, { subject: viewer, role: 'owner' })).status).toBe(403)
    expect((await b.call('/members/grant', admin, { subject: 'new@datanalysis.re', role: 'owner' })).status).toBe(403)
    expect((await b.call('/members/grant', admin, { subject: viewer, role: 'admin' })).status).toBe(403)
    expect((await b.call('/members/grant', admin, { subject: peer, role: 'viewer' })).status).toBe(403)
    expect((await b.call('/members/revoke', admin, { subject: peer })).status).toBe(403)
    expect((await b.call('/members/grant', admin, { subject: viewer, role: 'operator' })).status).toBe(200)
    expect((await b.call('/members/revoke', admin, { subject: operator })).status).toBe(200)
    expect((await b.call('/members/grant', owner, { subject: peer, role: 'viewer' })).status).toBe(200)
    expect(b.forwarded.map(f => f.body)).toEqual([
      { subject: viewer, role: 'operator' },
      { subject: operator },
      { subject: peer, role: 'viewer' },
    ])
  })

  it('nobody changes their own role, the owner included', async () => {
    const b = bench()
    expect((await b.call('/members/grant', admin, { subject: admin, role: 'owner' })).status).toBe(403)
    expect((await b.call('/members/grant', owner, { subject: owner, role: 'admin' })).status).toBe(403)
    expect((await b.call('/members/revoke', admin, { subject: admin })).status).toBe(403)
    expect(b.forwarded).toHaveLength(0)
  })

  it('only an owner changes or removes an owner', async () => {
    const b = bench([...TABLE, { subject: second, role: 'owner' }])
    expect((await b.call('/members/grant', admin, { subject: owner, role: 'viewer' })).status).toBe(403)
    expect((await b.call('/members/revoke', admin, { subject: owner })).status).toBe(403)
    expect((await b.call('/members/grant', owner, { subject: second, role: 'admin' })).status).toBe(200)
    expect((await b.call('/members/revoke', owner, { subject: second })).status).toBe(200)
  })

  it('no allowed change, by anyone, leaves the team without an owner', () => {
    const roles = ['viewer', 'operator', 'admin', 'owner', undefined] as const
    const people = [owner, admin, operator, viewer, 'new@datanalysis.re']
    for (const table of [TABLE, [...TABLE, { subject: second, role: 'owner' as const }]]) {
      for (const actor of [...people, second]) {
        for (const subject of [...people, second]) {
          for (const next of roles) {
            if (roleChangeRefusal(table, actor, subject, next) !== undefined) continue
            const after = [...table.filter(grant => grant.subject !== subject), ...(next === undefined ? [] : [{ subject, role: next }])]
            expect(after.some(grant => grant.role === 'owner'), `${actor} sets ${subject} to ${String(next)}`).toBe(true)
          }
        }
      }
    }
  })

  it('an operator or a viewer changes nobody', async () => {
    const b = bench()
    expect((await b.call('/members/grant', operator, { subject: viewer, role: 'operator' })).status).toBe(403)
    expect((await b.call('/members/revoke', viewer, { subject: operator })).status).toBe(403)
    expect(b.forwarded).toHaveLength(0)
  })

  it('journals every role change asked: who, for whom, before, after, outcome', async () => {
    const b = bench()
    await b.call('/members/grant', admin, { subject: viewer, role: 'operator' })
    await b.call('/members/grant', admin, { subject: viewer, role: 'owner' })
    await b.call('/members/revoke', owner, { subject: operator })
    const events = (await b.service.events()).filter(event => event.action === 'member.role')
    expect(events.map(event => ({ actor: event.actor, subject: event.subject, detail: event.detail }))).toEqual(expect.arrayContaining([
      { actor: admin, subject: viewer, detail: 'viewer -> operator: applied' },
      { actor: admin, subject: viewer, detail: 'viewer -> owner: refused: only an owner grants the owner role' },
      { actor: owner, subject: operator, detail: 'operator -> none: applied' },
    ]))
    expect(events).toHaveLength(3)
  })

  it('without a team authority (the team tenant reads grants.json), the routes stay closed', async () => {
    const service = new WorkbenchService({ store: new MemoryStore() })
    const api = createMndtApi({
      service, runner: noMissions, identity: { tokens: { [owner]: { user: owner } } },
      grants: { grants: async () => ({ ok: true, grants: TABLE }) },
    })
    const answer = await api({ method: 'POST', path: '/members/grant', authorization: `Bearer ${owner}`, body: JSON.stringify({ subject: viewer, role: 'admin' }) })
    expect(answer.status).toBe(503)
  })
})
