import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import { fileGrants } from '../src/grants.ts'

const owner = 'duke@datanalysis.re'
const admin = 'smarion@datanalysis.re'
const operator = 'jdoe@datanalysis.re'
const SECRET = 'gateway-secret-for-tests'

/** @returns a team API whose runner counts the missions it ran. */
function teamApi(): { api: ReturnType<typeof createMndtApi>; ran: string[] } {
  const path = join(mkdtempSync(join(tmpdir(), 'grants-')), 'grants.json')
  writeFileSync(path, JSON.stringify({ grants: [
    { subject: owner, role: 'owner' }, { subject: admin, role: 'admin' }, { subject: operator, role: 'operator' },
  ] }))
  const ran: string[] = []
  const api = createMndtApi({
    service: new WorkbenchService({ store: new MemoryStore() }),
    runner: { run: async (mission) => { ran.push(mission.createdBy); return { title: 't', markdown: 'm', sources: [] } } },
    identity: { proxyUserHeader: 'x-forwarded-email', gatewaySecret: SECRET },
    grants: fileGrants(path),
  })
  return { api, ran }
}

const as = (who: string) => ({ 'x-forwarded-email': who, 'x-mndt-gateway': SECRET })

describe('missions on a team instance', () => {
  it('are started by the owner alone; any other role reads them as absent and nothing runs', async () => {
    const { api, ran } = teamApi()
    for (const who of [admin, operator]) {
      const answer = await api({ method: 'POST', path: '/missions', headers: as(who), body: JSON.stringify({ kind: 'custom', prompt: 'lis tout' }) })
      expect(answer.status, who).toBe(404)
      const retry = await api({ method: 'POST', path: '/missions/msn_x/retry', headers: as(who), body: '{}' })
      expect(retry.status, who).toBe(404)
    }
    expect(ran).toEqual([])
    const started = await api({ method: 'POST', path: '/missions', headers: as(owner), body: JSON.stringify({ kind: 'custom', prompt: 'brief' }) })
    expect(started.status).toBe(201)
    expect(ran).toEqual([owner])
  })

  it('stay open on a solo workstation, an admin included', async () => {
    const api = createMndtApi({
      service: new WorkbenchService({ store: new MemoryStore() }),
      runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
      identity: { tokens: { 'tok-owner': { user: owner }, 'tok-admin': { user: admin } } },
      grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }, { subject: admin, role: 'admin' }] }) },
    })
    for (const token of ['tok-owner', 'tok-admin']) {
      const answer = await api({ method: 'POST', path: '/missions', authorization: `Bearer ${token}`, body: JSON.stringify({ kind: 'custom', prompt: 'brief' }) })
      expect(answer.status, token).toBe(201)
    }
  })
})
