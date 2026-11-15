import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import { fileGrants } from '../src/grants.ts'

const owner = 'duke@datanalysis.re'
const viewer = 'smarion@datanalysis.re'
const kelvin = 'duKe@datanalysis.re'

/** @returns an API with an owner (who shares) and a viewer, by bearer token. */
function bench() {
  const api = createMndtApi({
    service: new WorkbenchService({ store: new MemoryStore() }),
    runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
    identity: { tokens: { 'tok-owner': { user: owner }, 'tok-viewer': { user: viewer } } },
    grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }, { subject: viewer, role: 'operator' }] }) },
  })
  const as = (token: string) => ({ authorization: `Bearer ${token}` })
  return { api, as }
}

describe('one spelling of a person: plain ASCII everywhere', { timeout: 30_000 }, () => {
  it('refuses a role file whose subject is not plain ASCII, with the row', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'grants-')), 'grants.json')
    writeFileSync(path, JSON.stringify({ grants: [{ subject: owner, role: 'owner' }, { subject: kelvin, role: 'viewer' }] }))
    const table = await fileGrants(path).grants()
    expect(table.ok).toBe(false)
    expect(!table.ok && table.reason).toContain('row 2: the subject is not a plain ASCII e-mail')
  })

  it('refuses a channel member who is not plain ASCII, at creation and when added', async () => {
    const { api, as } = bench()
    const refused = await api({ method: 'POST', path: '/channels', ...as('tok-owner'), body: JSON.stringify({ title: 'Compta', members: [kelvin] }) })
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect(refused.status).toBeLessThan(500)
    const created = await api({ method: 'POST', path: '/channels', ...as('tok-owner'), body: JSON.stringify({ title: 'Compta' }) })
    const id = (created.body as { channel: { id: string } }).channel.id
    const added = await api({ method: 'POST', path: `/channels/${id}/members`, ...as('tok-owner'), body: JSON.stringify({ add: [kelvin] }) })
    expect(added.status).toBeGreaterThanOrEqual(400)
    expect(added.status).toBeLessThan(500)
    const fine = await api({ method: 'POST', path: `/channels/${id}/members`, ...as('tok-owner'), body: JSON.stringify({ add: [viewer] }) })
    expect((fine.body as { channel: { members: string[] } }).channel.members).toContain(viewer)
  })

  it('create-tenant.sh refuses an owner who is not plain ASCII', () => {
    const root = mkdtempSync(join(tmpdir(), 'tenant-'))
    mkdirSync(join(root, 'etc', 'oauth2-proxy'), { recursive: true })
    writeFileSync(join(root, 'etc', 'oauth2-proxy', 'governance.cfg'), 'client_id = "app-1234"\n')
    writeFileSync(join(root, 'etc', 'oauth2-proxy', 'client_secret'), 'entra-secret')
    const script = join(import.meta.dirname, '..', 'deploy', 'create-tenant.sh')
    expect(() => execFileSync('bash', [script, 'datanalysis', 'equipe.datanalysis.re', '--owner', kelvin, '--no-docker'],
      { env: { ...process.env, MNDT_ROOT: root }, encoding: 'utf8', stdio: 'pipe' })).toThrow(/plain ASCII/)
  })

  it('the gateway says at start that a non-ASCII OWNER leaves the shell closed', async () => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'deploy', 'gateway', 'server.mjs')], {
      env: { ...process.env, PORT: '0', API: 'http://127.0.0.1:9', WORKBENCH: 'http://127.0.0.1:9', TOKEN_FILE: '/nonexistent', OWNER: kelvin },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    // Until the gateway says it listens (it says the OWNER warning before), at most 20 s.
    await new Promise<void>((resolve) => {
      const done = setTimeout(resolve, 20_000)
      const read = (chunk: unknown): void => {
        output += String(chunk)
        if (output.includes('listening')) { clearTimeout(done); resolve() }
      }
      child.stdout.on('data', read)
      child.stderr.on('data', read)
    })
    child.kill()
    expect(output).toContain('OWNER is not a plain ASCII e-mail')
  })
})

describe('a private note is its author\'s', () => {
  it('cannot be published by someone who holds sharing.write but cannot read it', async () => {
    const { api, as } = bench()
    const created = await api({ method: 'POST', path: '/memory', ...as('tok-viewer'), body: JSON.stringify({ kind: 'fact', text: 'note privee' }) })
    const id = (created.body as { memory: { id: string } }).memory.id
    const published = await api({ method: 'POST', path: `/memory/${id}/scope`, ...as('tok-owner'), body: JSON.stringify({ scope: 'team' }) })
    expect(published.status).toBe(404)
    expect(JSON.stringify(published.body)).not.toContain('note privee')
    const own = await api({ method: 'POST', path: `/memory/${id}/scope`, ...as('tok-viewer'), body: JSON.stringify({ scope: 'team' }) })
    expect(own.status).toBe(200)
  })
})

describe('the counts of /metrics on a team instance', () => {
  it('count what the reader may read: the owner\'s automation run is not in a member\'s numbers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metrics-'))
    writeFileSync(join(dir, 'grants.json'), JSON.stringify({ grants: [{ subject: owner, role: 'owner' }, { subject: viewer, role: 'admin' }] }))
    const api = createMndtApi({
      service: new WorkbenchService({ store: new MemoryStore() }),
      runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
      identity: { proxyUserHeader: 'x-forwarded-email', gatewaySecret: 'secret' },
      grants: fileGrants(join(dir, 'grants.json')),
      automationsPath: join(dir, 'automations.json'),
      schedulePath: join(dir, 'briefing-schedule.json'),
    })
    const as = (who: string) => ({ 'x-forwarded-email': who, 'x-mndt-gateway': 'secret' })
    // The owner's schedule routes still answer on a team instance.
    expect((await api({ method: 'POST', path: '/schedule', headers: as(owner), body: JSON.stringify({ at: '06:15' }) })).status).toBe(200)
    expect(((await api({ method: 'GET', path: '/schedule', headers: as(owner) })).body as { at?: string }).at).toBe('06:15')
    await api({ method: 'POST', path: '/automations/auto_briefing/run', headers: as(owner), body: '{}' })
    type Metrics = { missions: { done: number }; briefs: number; automationsEnabled: number }
    const ofOwner = (await api({ method: 'GET', path: '/metrics', headers: as(owner) })).body as Metrics
    const ofAdmin = (await api({ method: 'GET', path: '/metrics', headers: as(viewer) })).body as Metrics
    expect(ofOwner.missions.done).toBe(1)
    expect(ofOwner.briefs).toBe(1)
    expect(ofAdmin.missions.done).toBe(0)
    expect(ofAdmin.briefs).toBe(0)
    expect(ofAdmin.automationsEnabled).toBe(0)
  })
})

describe('part 2: names and parties', () => {
  it('a taken channel name is refused in neutral words: no « exists » about a channel one is not in', async () => {
    const { api, as } = bench()
    await api({ method: 'POST', path: '/channels', ...as('tok-owner'), body: JSON.stringify({ name: 'direction' }) })
    const refused = await api({ method: 'POST', path: '/channels', ...as('tok-viewer'), body: JSON.stringify({ name: 'direction' }) })
    expect(refused.status).toBe(409)
    expect((refused.body as { error: string }).error).toBe('the name #direction is not available')
  })

  it('reads the parties of a mandate stored with capitals as the lower-case e-mail', async () => {
    const store = new MemoryStore()
    const service = new WorkbenchService({ store })
    const state = await store.load()
    await store.save({ ...state, mandates: [{
      id: 'mnd_old', delegant: 'Duke@Datanalysis.re', delegataire: ' SMarion@Datanalysis.re ', purpose: 'p', connectors: [],
      missionKinds: ['briefing'], dailyCap: 1, expiresOn: '2099-01-01', state: 'active', createdAt: '2026-11-01T00:00:00Z',
    }] })
    const mandate = await service.mandate('mnd_old')
    expect(mandate?.delegant).toBe('duke@datanalysis.re')
    expect(mandate?.delegataire).toBe('smarion@datanalysis.re')
  })
})

describe('a person without a role on a team instance', () => {
  it('is served who they are and nothing else, until a role is given; the change applies on the next request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'norole-'))
    const path = join(dir, 'grants.json')
    writeFileSync(path, JSON.stringify({ grants: [{ subject: owner, role: 'owner' }] }))
    const api = createMndtApi({
      service: new WorkbenchService({ store: new MemoryStore() }),
      runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
      identity: { proxyUserHeader: 'x-forwarded-email', gatewaySecret: 'secret' },
      grants: fileGrants(path),
    })
    const as = (who: string) => ({ 'x-forwarded-email': who, 'x-mndt-gateway': 'secret' })
    const stranger = 'nobody@datanalysis.re'
    expect((await api({ method: 'GET', path: '/me', headers: as(stranger) })).status).toBe(200)
    expect((await api({ method: 'GET', path: '/org', headers: as(stranger) })).status).toBe(200)
    for (const route of ['/channels', '/agents', '/approvals', '/missions', '/briefs', '/memory', '/people', '/state', '/metrics', '/events', '/search']) {
      const answer = await api({ method: 'GET', path: route, headers: as(stranger), query: { q: 'x' } })
      expect(answer.status, route).toBe(403)
    }
    expect((await api({ method: 'POST', path: '/channels', headers: as(stranger), body: JSON.stringify({ title: 'X' }) })).status).toBe(403)
    writeFileSync(path, JSON.stringify({ grants: [{ subject: owner, role: 'owner' }, { subject: stranger, role: 'viewer' }] }))
    expect((await api({ method: 'GET', path: '/channels', headers: as(stranger) })).status).toBe(200)
  })
})
