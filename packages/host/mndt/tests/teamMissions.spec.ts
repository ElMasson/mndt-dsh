import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import { fileGrants } from '../src/grants.ts'
import { automationMayRun } from '../src/gateway.ts'
import type { Automation } from '../src/automations.ts'

const owner = 'duke@datanalysis.re'
const admin = 'smarion@datanalysis.re'
const operator = 'jdoe@datanalysis.re'
const SECRET = 'gateway-secret-for-tests'

/** @returns a team API whose runner counts the missions it ran. */
function teamApi(): { api: ReturnType<typeof createMndtApi>; ran: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'grants-'))
  const path = join(dir, 'grants.json')
  writeFileSync(path, JSON.stringify({ grants: [
    { subject: owner, role: 'owner' }, { subject: admin, role: 'admin' }, { subject: operator, role: 'operator' },
  ] }))
  const ran: string[] = []
  const api = createMndtApi({
    service: new WorkbenchService({ store: new MemoryStore() }),
    runner: { run: async (mission) => { ran.push(mission.createdBy); return { title: 't', markdown: 'm', sources: [] } } },
    identity: { proxyUserHeader: 'x-forwarded-email', gatewaySecret: SECRET },
    grants: fileGrants(path),
    automationsPath: join(dir, 'automations.json'),
    schedulePath: join(dir, 'briefing-schedule.json'),
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

  it('cannot be reached through automations by anyone but the owner', async () => {
    const { api, ran } = teamApi()
    const automation = { name: 'Lecture', kind: 'custom', prompt: 'lis tout', at: '07:00', enabled: true }
    const routes = [
      { path: '/automations', body: automation },
      { path: '/automations/auto_briefing/run', body: {} },
      { path: '/automations/auto_briefing/toggle', body: { enabled: true } },
      { path: '/schedule', body: { at: '06:00' } },
    ]
    for (const route of routes) {
      const answer = await api({ method: 'POST', path: route.path, headers: as(admin), body: JSON.stringify(route.body) })
      expect(answer.status, route.path).toBe(404)
    }
    expect(ran).toEqual([])
    // The owner still has them: the run route starts the briefing's mission.
    const run = await api({ method: 'POST', path: '/automations/auto_briefing/run', headers: as(owner), body: '{}' })
    expect(run.status).not.toBe(404)
    expect(ran).toEqual(['scheduler'])
  })

  it('the scheduler runs, on a team instance, the system\'s automations and the owner\'s only', () => {
    const grants = [{ subject: owner, role: 'owner' }, { subject: admin, role: 'admin' }]
    const item = (createdBy: string): Automation => ({ id: 'a', name: 'n', kind: 'custom', prompt: 'p', at: '07:00', enabled: true, createdBy })
    expect(automationMayRun(item('scheduler'), true, grants)).toBe(true)
    expect(automationMayRun(item(owner), true, grants)).toBe(true)
    expect(automationMayRun(item('Duke@Datanalysis.re'), true, grants)).toBe(true)
    expect(automationMayRun(item(admin), true, grants)).toBe(false)
    expect(automationMayRun(item(owner), true, undefined)).toBe(false)
    expect(automationMayRun(item(admin), false, undefined)).toBe(true)
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
