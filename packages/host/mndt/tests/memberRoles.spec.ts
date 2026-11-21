import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import type { MissionRunner } from '../src/api.ts'
import { roleChangeRefusal } from '../src/policy.ts'
import { emptyState } from '../src/core/index.ts'
import { canReadEvent } from '../src/visibility.ts'

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

  it('two owners removing each other at once: one is applied, the team keeps an owner', async () => {
    // A live table the authority changes, answering after a delay so the two requests overlap.
    const table = [{ subject: owner, role: 'owner' as const }, { subject: second, role: 'owner' as const }]
    const service = new WorkbenchService({ store: new MemoryStore() })
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const { subject } = JSON.parse(init.body) as { subject: string }
      await new Promise(resolve => setTimeout(resolve, 20))
      const at = table.findIndex(grant => grant.subject === subject)
      if (at >= 0) table.splice(at, 1)
      return new Response(JSON.stringify({ allowed: true, reason: 'ok' }), { status: 200 })
    })
    const api = createMndtApi({
      service, runner: noMissions,
      identity: { tokens: { [owner]: { user: owner }, [second]: { user: second } } },
      grants: { grants: async () => ({ ok: true, grants: [...table] }) },
      authority: { baseUrl: 'http://authority.test', token: 'deployment-token' },
    })
    const revoke = (who: string, subject: string) =>
      api({ method: 'POST', path: '/members/revoke', authorization: `Bearer ${who}`, body: JSON.stringify({ subject }) })
    const [a, b] = await Promise.all([revoke(owner, second), revoke(second, owner)])
    expect([a.status, b.status].sort()).toEqual([200, 403])
    expect(table.filter(grant => grant.role === 'owner')).toHaveLength(1)
  })

  it('refuses a subject that is not plain ASCII', async () => {
    const b = bench()
    // The Kelvin sign folds onto k under toLowerCase().
    const answer = await b.call('/members/grant', owner, { subject: 'admin@\u212Aey.re', role: 'viewer' })
    expect(answer.status).toBe(400)
    expect(answer.body.error).toBe('the subject is not a plain ASCII e-mail')
    expect(b.forwarded).toHaveLength(0)
  })

  it('the role journal is read by those who administer rights, and only them', () => {
    const event = { at: '2026-11-21T00:00:00Z', actor: admin, action: 'member.role', subject: viewer, detail: 'viewer -> operator: applied' }
    const reader = (decider: boolean) => ({ identity: operator, channels: new Set<string>(), decider })
    expect(canReadEvent(reader(true), event, emptyState)).toBe(true)
    expect(canReadEvent(reader(false), event, emptyState)).toBe(false)
  })

  it('an authority that does not answer times out with a clear 504, and does not hold the next change', async () => {
    const service = new WorkbenchService({ store: new MemoryStore() })
    let hang = true
    vi.stubGlobal('fetch', (_url: string, init: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
      if (!hang) {
        resolve(new Response(JSON.stringify({ allowed: true, reason: 'ok' }), { status: 200 }))
        return
      }
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    const api = createMndtApi({
      service, runner: noMissions,
      identity: { tokens: { [owner]: { user: owner } } },
      grants: { grants: async () => ({ ok: true, grants: TABLE }) },
      authority: { baseUrl: 'http://authority.test', token: 'deployment-token', timeoutMs: 50 },
    })
    const grant = (subject: string) =>
      api({ method: 'POST', path: '/members/grant', authorization: `Bearer ${owner}`, body: JSON.stringify({ subject, role: 'operator' }) })
    const first = grant(viewer)
    const answer = await first
    expect(answer.status).toBe(504)
    expect((answer.body as { error: string }).error).toMatch(/did not answer within 0.05 s: the role is unchanged/)
    hang = false
    expect((await grant('new@datanalysis.re')).status).toBe(200)
    const journal = (await service.events()).filter(event => event.action === 'member.role').map(event => event.detail)
    expect(journal).toContain('viewer -> operator: not applied: authority did not answer in time')
  })
})
