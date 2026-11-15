import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import { emptyState } from '../src/core/types.ts'
import { createMndtApi } from '../src/api.ts'
import { fileGrants } from '../src/grants.ts'
import { identityOf } from '../src/identity.ts'

const SECRET = 'gateway-secret-for-tests'

/** @returns the API behind the gateway, its role file naming the owner in lower case. */
function bench(service = new WorkbenchService({ store: new MemoryStore() }), rows: unknown[] = [
  { subject: 'stephane.masson@datanalysis.re', role: 'owner', name: 'Stéphane Masson' },
  { subject: 'sophie.marion@datanalysis.re', role: 'viewer' },
]) {
  const file = join(mkdtempSync(join(tmpdir(), 'grants-')), 'grants.json')
  writeFileSync(file, JSON.stringify({ grants: rows }))
  return createMndtApi({
    service,
    runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
    identity: { proxyUserHeader: 'x-forwarded-email', gatewaySecret: SECRET },
    grants: fileGrants(file),
  })
}
/** @param email - as Entra spells it. @returns the headers the gateway relays. */
const as = (email: string) => ({ 'x-forwarded-email': email, 'x-mndt-gateway': SECRET })

describe('one spelling of a person, whatever case Entra uses', () => {
  it('keeps the role and the name of Prenom.Nom@ as of prenom.nom@', async () => {
    const api = bench()
    const me = await api({ method: 'GET', path: '/me', headers: as('Stephane.Masson@Datanalysis.re') })
    // Team instance, no x-mndt-shell from the gateway: no shell.
    expect(me.body).toEqual({ you: 'stephane.masson@datanalysis.re', name: 'Stéphane Masson', role: 'owner', shell: false })
  })

  it('makes one member of an e-mail written in capitals, who reads the channel and is removed by any spelling', async () => {
    const service = new WorkbenchService({ store: new MemoryStore() })
    const api = bench(service)
    const created = await api({ method: 'POST', path: '/channels', headers: as('Stephane.Masson@datanalysis.re'), body: JSON.stringify({ title: 'Compta', members: ['Sophie.Marion@DATANALYSIS.re', 'sophie.marion@datanalysis.re'] }) })
    const channel = (created.body as { channel: { id: string; members: string[] } }).channel
    expect(channel.members).toEqual(['stephane.masson@datanalysis.re', 'sophie.marion@datanalysis.re'])
    expect((await api({ method: 'GET', path: `/channels/${channel.id}`, headers: as('SOPHIE.MARION@datanalysis.re') })).status).toBe(200)
    const removed = await api({ method: 'POST', path: `/channels/${channel.id}/members`, headers: as('stephane.masson@datanalysis.re'), body: JSON.stringify({ remove: ['Sophie.Marion@datanalysis.re'] }) })
    expect((removed.body as { channel: { members: string[] } }).channel.members).toEqual(['stephane.masson@datanalysis.re'])
  })

  it('signs a message and a card with the lower-case identity, so no filter is bypassed by case', async () => {
    const service = new WorkbenchService({ store: new MemoryStore() })
    const api = bench(service)
    const channel = await service.createChannel({ title: 'Direction', members: ['stephane.masson@datanalysis.re'] }, 'stephane.masson@datanalysis.re')
    const posted = await api({ method: 'POST', path: `/channels/${channel.id}/messages`, headers: as('Stephane.Masson@datanalysis.re'), body: JSON.stringify({ text: 'point' }) })
    expect(JSON.stringify(posted.body)).not.toContain('Stephane.Masson')
    await api({ method: 'POST', path: '/approvals', headers: as('Stephane.Masson@datanalysis.re'), body: JSON.stringify({ kind: 'spend', title: 'Achat' }) })
    const [card] = await service.listApprovals('all')
    expect(card?.requestedBy).toBe('stephane.masson@datanalysis.re')
    // A viewer spelled in capitals still sees no card outside a channel they did not ask.
    const read = await api({ method: 'GET', path: '/approvals', query: { state: 'all' }, headers: as('Sophie.MARION@datanalysis.re') })
    expect((read.body as { approvals: unknown[] }).approvals).toEqual([])
  })

  it('reads members stored with capitals before this change as their lower-case identity', async () => {
    const store = new MemoryStore()
    await store.save({ ...emptyState, channels: [{ id: 'chn_old', name: 'ancien', title: 'Ancien', kind: 'team', members: ['Sophie.Marion@datanalysis.re'], agents: [], connectors: [], createdBy: 'x', createdAt: '2026-11-01T00:00:00Z' }] })
    const api = bench(new WorkbenchService({ store }))
    expect((await api({ method: 'GET', path: '/channels/chn_old', headers: as('sophie.marion@datanalysis.re') })).status).toBe(200)
  })

  it('lower-cases a provisioned token user too', () => {
    expect(identityOf({ authorization: 'Bearer t' }, { tokens: { t: { user: 'Duke@Datanalysis.re' } } })).toBe('duke@datanalysis.re')
  })
})

describe('the role file names', () => {
  it('refuses a name with a control character or a line break, and keeps __proto__ a plain key', async () => {
    for (const name of ['Line\nbreak', 'Bell\u0007', 'Sep x']) {
      const api = bench(undefined, [{ subject: 'stephane.masson@datanalysis.re', role: 'owner', name }])
      expect((await api({ method: 'GET', path: '/people', headers: as('stephane.masson@datanalysis.re') })).status, JSON.stringify(name)).toBe(503)
    }
    const api = bench(undefined, [{ subject: 'stephane.masson@datanalysis.re', role: 'owner' }, { subject: '__proto__', role: 'viewer', name: 'Polluter' }])
    const people = await api({ method: 'GET', path: '/people', headers: as('stephane.masson@datanalysis.re') })
    expect(people.status).toBe(200)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
  })
})
