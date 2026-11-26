/**
 * The automations' scheduler after « dernière : 2026-11-15 » (26/11): on the
 * instance, auto_briefing stopped starting, with nothing in the operator's log.
 * The pass's logic was proven sound on a kept rehearsal; what was missing is a
 * way to see the scheduler alive, its lines in the log, the instance's zone, a
 * catch-up, and an API that an unloaded plugin could leave open. These tests
 * pin those.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import { fileGrants } from '../src/grants.ts'
import { defaultAutomations, dueAutomations, runAutomation, writeAutomations } from '../src/automations.ts'
import type { Automation } from '../src/automations.ts'
import { automationRefusal, serveUntilUnloaded } from '../src/gateway.ts'

const owner = 'duke@datanalysis.re'
const SECRET = 'gateway-secret-for-tests'
const as = (who: string) => ({ 'x-forwarded-email': who, 'x-mndt-gateway': SECRET })

/** @returns a closable server, and how many times it was closed. */
function fakeServer() {
  const server = { closed: 0, close: () => { server.closed += 1 } }
  return server
}

describe('the product API lives as long as its plugin, not one moment longer', () => {
  it('unloaded before it listens: closed as soon as it does, and said', async () => {
    const server = fakeServer()
    let listen!: (value: typeof server) => void
    const said: string[] = []
    const dispose = serveUntilUnloaded(new Promise((resolve) => { listen = resolve }), (message) => { said.push(message) })
    dispose()
    listen(server)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(server.closed).toBe(1)
    expect(said).toEqual(['mndt: the product API started after its plugin was unloaded: closed at once'])
  })

  it('unloaded after it listens: closed then; a start that fails is said by its shape', async () => {
    const server = fakeServer()
    const said: string[] = []
    const dispose = serveUntilUnloaded(Promise.resolve(server), (message) => { said.push(message) })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(server.closed).toBe(0)
    dispose()
    expect(server.closed).toBe(1)
    const failed = Object.assign(new Error('listen EADDRINUSE: address already in use 0.0.0.0:8795'), { code: 'EADDRINUSE' })
    serveUntilUnloaded(Promise.reject(failed), (message) => { said.push(message) })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(said.at(-1)).toMatch(/^mndt: the API did not start: .*EADDRINUSE/)
  })
})

/** @returns a team API with an automation registry, and what it needs. */
function teamApi(options: { schedulerAt?: string; run?: () => Promise<void> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'automations-'))
  const grants = join(dir, 'grants.json')
  writeFileSync(grants, JSON.stringify({ grants: [{ subject: owner, role: 'owner' }] }))
  const automationsPath = join(dir, 'automations.json')
  const service = new WorkbenchService({ store: new MemoryStore(), briefingsInLane: true })
  const api = createMndtApi({
    service,
    runner: { run: async () => { await options.run?.(); return { title: 't', markdown: 'le rapport', sources: [] } } },
    identity: { proxyUserHeader: 'x-forwarded-email', gatewaySecret: SECRET },
    grants: fileGrants(grants),
    automationsPath,
    timeZone: 'Indian/Reunion',
    ...(options.schedulerAt === undefined ? {} : { schedulerAt: () => options.schedulerAt }),
  })
  return { api, service, automationsPath }
}

const relance: Automation = {
  id: 'auto_relance', name: 'Relance des devis', kind: 'custom', prompt: 'liste les devis sans réponse',
  at: '09:00', enabled: true, createdBy: owner, enabledBy: owner,
}

describe('GET /automations', () => {
  it('serves when each starts next, the instance\'s zone, and the scheduler\'s last pass', async () => {
    const { api, automationsPath } = teamApi({ schedulerAt: '2026-11-26T07:30:00.000Z' })
    await writeAutomations(automationsPath, [relance, { ...relance, id: 'auto_off', enabled: false }])
    const answer = await api({ method: 'GET', path: '/automations', headers: as(owner) })
    const body = answer.body as { items: (Automation & { nextRunAt?: string })[]; timeZone: string; schedulerAt?: string }
    expect(body.timeZone).toBe('Indian/Reunion')
    expect(body.schedulerAt).toBe('2026-11-26T07:30:00.000Z')
    const next = body.items.find(item => item.id === 'auto_relance')?.nextRunAt ?? ''
    // 09:00 at La Réunion is 05:00 UTC.
    expect(next).toMatch(/T05:00:00\.000Z$/)
    expect(Date.parse(next)).toBeGreaterThan(Date.now() - (15 * 60_000))
    expect(body.items.find(item => item.id === 'auto_off')?.nextRunAt).toBeUndefined()
  })

  it('without a scheduler in this process (a test, an API alone), no schedulerAt', async () => {
    const { api, automationsPath } = teamApi()
    await writeAutomations(automationsPath, [relance])
    const body = (await api({ method: 'GET', path: '/automations', headers: as(owner) })).body as { schedulerAt?: string }
    expect(body.schedulerAt).toBeUndefined()
  })
})

describe('a run by hand', () => {
  it('is written (lastRunAt), and keeps what the scheduler wrote during the run', async () => {
    let path = ''
    const { api, automationsPath } = teamApi({
      // While the run goes on, the scheduler stamps the registry.
      run: async () => {
        const items = JSON.parse(readFileSync(path, 'utf8')) as { items: Automation[] }
        writeFileSync(path, JSON.stringify({ items: items.items.map(item => ({ ...item, lastFiredDate: '2026-11-26' })) }))
      },
    })
    path = automationsPath
    await writeAutomations(automationsPath, [relance])
    const run = await api({ method: 'POST', path: '/automations/auto_relance/run', headers: as(owner), body: '{}' })
    expect(run.status).toBe(200)
    const stored = (JSON.parse(readFileSync(automationsPath, 'utf8')) as { items: Automation[] }).items[0]
    expect(stored?.lastRunAt).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(stored?.lastFiredDate).toBe('2026-11-26')
    expect(stored?.lastOutcome).toBe('done')
  })
})

describe('every automation of the owner is published in their lane', () => {
  it('a custom automation, under its name; a mission started otherwise is not', async () => {
    const { service } = teamApi()
    const runner = { run: async () => ({ title: 't', markdown: 'trois devis sans réponse', sources: [] }) }
    await runAutomation(service, runner, relance, owner)
    const plain = await service.createMission({ kind: 'custom', prompt: 'autre chose', createdBy: owner })
    const started = await service.startMission(plain.id, 'manual')
    await service.completeMission(started.id, { title: 't', markdown: 'autre', sources: [] })
    const messages = (await service.snapshot()).messages ?? []
    const published = messages.filter(message => message.mission !== undefined)
    expect(published).toHaveLength(1)
    expect(published[0]?.mission).toMatchObject({ title: 'Relance des devis', kind: 'custom', status: 'done' })
    expect(published[0]?.text).toContain('trois devis sans réponse')
  })
})

describe('changing an automation\'s time (the page\'s « heure », #165)', () => {
  const shipped = defaultAutomations().find(item => item.id === 'auto_briefing')
  const briefing: Automation = { ...(shipped as Automation), enabled: true, enabledBy: owner }
  const stored = (path: string): Automation[] => (JSON.parse(readFileSync(path, 'utf8')) as { items: Automation[] }).items

  it('a time that is not one is refused (bad-time), never turned into 07:30', async () => {
    const { api, automationsPath } = teamApi()
    await writeAutomations(automationsPath, [briefing])
    for (const at of ['25:00', '7h30', '', 730]) {
      const answer = await api({ method: 'POST', path: '/automations', headers: as(owner), body: JSON.stringify({ id: 'auto_briefing', at }) })
      expect(answer, String(at)).toMatchObject({ status: 400, body: { code: 'bad-time' } })
    }
    expect(stored(automationsPath)[0]?.at).toBe('07:30')
  })

  it('the system briefing keeps its author and who enabled it, stays as shipped, and starts at its new time', async () => {
    const { api, automationsPath } = teamApi()
    await writeAutomations(automationsPath, [briefing])
    const answer = await api({ method: 'POST', path: '/automations', headers: as(owner), body: JSON.stringify({ id: 'auto_briefing', at: '06:45' }) })
    expect(answer.status).toBe(200)
    const saved = stored(automationsPath)[0] as Automation
    expect(saved).toMatchObject({ at: '06:45', enabled: true, createdBy: 'scheduler', enabledBy: owner })
    // Neither switched off by the scheduler's guard, nor taken over: still « as shipped ».
    expect(automationRefusal(saved, true, new Set([owner]))).toBeUndefined()
    expect(saved.prompt).toBe(shipped?.prompt)
    // 06:45 at La Réunion is 02:45 UTC.
    expect(dueAutomations([saved], new Date(Date.UTC(2026, 10, 27, 2, 45)), 'Indian/Reunion')).toHaveLength(1)
  })

  it('a save that changes what it runs still takes it over (the owner read its prompt)', async () => {
    const { api, automationsPath } = teamApi()
    await writeAutomations(automationsPath, [briefing])
    await api({ method: 'POST', path: '/automations', headers: as(owner), body: JSON.stringify({ id: 'auto_briefing', at: '06:45', prompt: 'Briefing court.' }) })
    expect(stored(automationsPath)[0]).toMatchObject({ createdBy: owner, prompt: 'Briefing court.' })
  })
})
