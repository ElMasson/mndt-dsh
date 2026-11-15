import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import { fileGrants } from '../src/grants.ts'
import { automationRefusal, ownersOf } from '../src/gateway.ts'
import type { Automation } from '../src/automations.ts'

const owner = 'duke@datanalysis.re'
const admin = 'smarion@datanalysis.re'
const operator = 'jdoe@datanalysis.re'
const SECRET = 'gateway-secret-for-tests'

/** @returns a team API whose runner counts the missions it ran. */
function teamApi(): { api: ReturnType<typeof createMndtApi>; ran: string[]; service: WorkbenchService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'grants-'))
  const path = join(dir, 'grants.json')
  writeFileSync(path, JSON.stringify({ grants: [
    { subject: owner, role: 'owner' }, { subject: admin, role: 'admin' }, { subject: operator, role: 'operator' },
  ] }))
  const ran: string[] = []
  const service = new WorkbenchService({ store: new MemoryStore() })
  const api = createMndtApi({
    service,
    runner: { run: async (mission) => { ran.push(mission.createdBy); return { title: 't', markdown: 'm', sources: [] } } },
    identity: { proxyUserHeader: 'x-forwarded-email', gatewaySecret: SECRET },
    grants: fileGrants(path),
    automationsPath: join(dir, 'automations.json'),
    schedulePath: join(dir, 'briefing-schedule.json'),
  })
  return { api, ran, service, dir }
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
    // The run is the owner's and private: it reads every mounted connector.
    expect(ran).toEqual([owner])
  })

  it('the scheduler runs, on a team instance, only what an owner enabled, and says what to do otherwise', () => {
    const item = (createdBy: string, enabledBy?: string): Automation => ({
      id: 'a', name: 'n', kind: 'custom', prompt: 'p', at: '07:00', enabled: true, createdBy, ...(enabledBy === undefined ? {} : { enabledBy }),
    })
    const one = ownersOf([{ subject: owner, role: 'owner' }, { subject: admin, role: 'admin' }])
    expect([...one]).toEqual([owner])
    // Two owners: the same rule as the API, any of them.
    const two = ownersOf([{ subject: owner, role: 'owner' }, { subject: 'Second@Datanalysis.re', role: 'owner' }])
    expect(automationRefusal(item('scheduler', 'second@datanalysis.re'), true, two)).toBeUndefined()
    // The deployment default, enabled by nobody: it does not run, and the reason says how to.
    expect(automationRefusal(item('scheduler'), true, one)).toMatch(/an owner checks its prompt and enables it/)
    expect(automationRefusal(item('scheduler', owner), true, one)).toBeUndefined()
    expect(automationRefusal(item(owner, owner), true, one)).toBeUndefined()
    expect(automationRefusal(item('Duke@Datanalysis.re', 'Duke@Datanalysis.re'), true, one)).toBeUndefined()
    // A member's, even enabled by the owner: the owner takes it over by saving it.
    expect(automationRefusal(item(admin, owner), true, one)).toMatch(new RegExp(`created by ${admin}.*saves it to take it over`))
    expect(automationRefusal(item('scheduler', admin), true, one)).toBeDefined()
    expect(automationRefusal(item('scheduler', owner), true, new Set())).toBeDefined()
    expect(automationRefusal(item(admin), false, new Set())).toBeUndefined()
  })

  it('gives an automation to the owner who saves it, and keeps the registry and the hour from the rest', async () => {
    const { api, dir } = teamApi()
    // An automation an admin created before this rule.
    writeFileSync(join(dir, 'automations.json'), JSON.stringify({ items: [
      { id: 'auto_admin', name: 'A', kind: 'custom', prompt: 'lis tout', at: '09:00', enabled: true, createdBy: admin },
    ] }))
    const saved = await api({ method: 'POST', path: '/automations', headers: as(owner),
      body: JSON.stringify({ id: 'auto_admin', name: 'A', kind: 'custom', prompt: 'relu', at: '09:00', enabled: true }) })
    const automation = (saved.body as { automation: Automation }).automation
    expect(automation.createdBy).toBe(owner)
    expect(automation.enabledBy).toBe(owner)
    for (const route of ['/automations', '/schedule']) {
      expect((await api({ method: 'GET', path: route, headers: as(admin) })).status, route).toBe(404)
      expect((await api({ method: 'GET', path: route, headers: as(owner) })).status, route).not.toBe(404)
    }
  })

  it('records who enabled an automation itself, never what a request claims', async () => {
    const { api } = teamApi()
    const created = await api({ method: 'POST', path: '/automations', headers: as(owner),
      body: JSON.stringify({ name: 'L', kind: 'custom', prompt: 'p', at: '07:00', enabled: true, enabledBy: admin }) })
    expect((created.body as { automation: Automation }).automation.enabledBy).toBe(owner)
    const off = await api({ method: 'POST', path: '/automations/auto_briefing/toggle', headers: as(owner), body: JSON.stringify({ enabled: false }) })
    expect((off.body as { automation: Automation }).automation.enabledBy).toBeUndefined()
    const on = await api({ method: 'POST', path: '/automations/auto_briefing/toggle', headers: as(owner), body: JSON.stringify({ enabled: true }) })
    expect((on.body as { automation: Automation }).automation.enabledBy).toBe(owner)
  })

  it('serves an automation\'s mission and brief to the owner alone, old shared ones included', async () => {
    const { api, service } = teamApi()
    // A brief stored by an earlier briefing, shared with the team under « scheduler ».
    const old = await service.createMission({ kind: 'briefing', prompt: 'ancien', createdBy: 'scheduler', visibility: 'team' })
    await service.startMission(old.id, 'scheduled')
    await service.completeMission(old.id, { title: 'Brief', markdown: '# Ancien brief', sources: [] })
    await api({ method: 'POST', path: '/automations/auto_briefing/run', headers: as(owner), body: '{}' })
    for (const who of [admin, operator]) {
      const missions = await api({ method: 'GET', path: '/missions', headers: as(who) })
      const briefs = await api({ method: 'GET', path: '/briefs', headers: as(who) })
      expect((missions.body as { missions: unknown[] }).missions, who).toEqual([])
      expect((briefs.body as { briefs: unknown[] }).briefs, who).toEqual([])
      expect((await api({ method: 'GET', path: `/missions/${old.id}`, headers: as(who) })).status, who).toBe(404)
    }
    const ownerMissions = await api({ method: 'GET', path: '/missions', headers: as(owner) })
    expect((ownerMissions.body as { missions: unknown[] }).missions).toHaveLength(2)
  })

  it('says in /me who has the shell: the one the gateway names, not every owner of the role file', async () => {
    const { api } = teamApi()
    const me = async (headers: Record<string, string>) => (await api({ method: 'GET', path: '/me', headers })).body as { shell: boolean; role?: string }
    expect((await me({ ...as(owner), 'x-mndt-shell': '1' })).shell).toBe(true)
    // An owner the gateway does not name (a second owner) has no shell.
    expect(await me(as(owner))).toMatchObject({ role: 'owner', shell: false })
    expect((await me(as(admin))).shell).toBe(false)
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
