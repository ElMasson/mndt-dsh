import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import { fileGrants } from '../src/grants.ts'

const owner = 'duke@datanalysis.re'
const viewer = 'smarion@datanalysis.re'
const stranger = 'other@datanalysis.re'

/** @returns the API over a role file naming the owner, a viewer without a name. */
function bench(rows: unknown[] = [{ subject: owner, role: 'owner', name: 'Stéphane Masson' }, { subject: viewer, role: 'viewer' }]) {
  const dir = mkdtempSync(join(tmpdir(), 'grants-'))
  const file = join(dir, 'grants.json')
  writeFileSync(file, JSON.stringify({ grants: rows }))
  const api = createMndtApi({
    service: new WorkbenchService({ store: new MemoryStore() }),
    runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
    identity: { tokens: { 'tok-owner': { user: owner }, 'tok-viewer': { user: viewer }, 'tok-stranger': { user: stranger } } },
    grants: fileGrants(file),
    org: { name: 'DATANALYSIS', slug: 'datanalysis', env: 'preprod' },
  })
  return api
}
const get = async (api: ReturnType<typeof bench>, token: string, path: string) => {
  const answer = await api({ method: 'GET', path, authorization: `Bearer ${token}` })
  return { status: answer.status, body: answer.body as Record<string, unknown> }
}

describe('who the person is, for the team screen', () => {
  it('/me gives the e-mail, the role and the name the role file declares', async () => {
    const api = bench()
    expect((await get(api, 'tok-owner', '/me')).body).toEqual({ you: owner, name: 'Stéphane Masson', role: 'owner' })
    expect((await get(api, 'tok-viewer', '/me')).body).toEqual({ you: viewer, role: 'viewer' })
    // Someone without a role is told who they are, nothing more.
    expect((await get(api, 'tok-stranger', '/me')).body).toEqual({ you: stranger })
  })

  it('/org names the organisation, its slug and its environment', async () => {
    expect((await get(bench(), 'tok-viewer', '/org')).body).toEqual({ name: 'DATANALYSIS', slug: 'datanalysis', env: 'preprod' })
  })

  it('/people lists the team with its names, to someone of the team only', async () => {
    const api = bench()
    expect((await get(api, 'tok-viewer', '/people')).body).toEqual({
      people: [{ email: owner, role: 'owner', name: 'Stéphane Masson' }, { email: viewer, role: 'viewer' }],
    })
    expect((await get(api, 'tok-stranger', '/people')).status).toBe(403)
  })

  it('refuses a role file whose name is not a short text, and a name never grants anything', async () => {
    const api = bench([{ subject: owner, role: 'owner', name: 42 }])
    expect((await get(api, 'tok-owner', '/people')).status).toBe(503)
    const named = bench([{ subject: owner, role: 'owner' }, { subject: stranger, name: 'Without a role' }])
    expect((await get(named, 'tok-owner', '/people')).status).toBe(503)
  })
})

describe('create-tenant.sh', { timeout: 30_000 }, () => {
  it('writes the organisation and its environment into the compose', () => {
    const root = mkdtempSync(join(tmpdir(), 'tenant-'))
    mkdirSync(join(root, 'root'), { recursive: true })
    writeFileSync(join(root, 'root', 'secret'), 'entra-secret')
    const create = (...extra: string[]) => execFileSync('bash', [join(import.meta.dirname, '..', 'deploy', 'create-tenant.sh'), 'datanalysis', 'equipe.datanalysis.re',
      '--owner', owner, '--client-id', 'app-1234', '--client-secret-file', '/root/secret', '--no-docker', ...extra], { env: { ...process.env, MNDT_ROOT: root } })
    create()
    let compose = readFileSync(join(root, 'opt/mndt/datanalysis/docker-compose.yml'), 'utf8')
    expect(compose).toContain('DSH_MNDT_ORG_SLUG: datanalysis')
    expect(compose).toContain('DSH_MNDT_ORG_NAME: "DATANALYSIS"')
    expect(compose).toContain('DSH_MNDT_ENV: ""')
    create('--org-name', 'Datanalysis Réunion', '--env', 'preprod')
    compose = readFileSync(join(root, 'opt/mndt/datanalysis/docker-compose.yml'), 'utf8')
    expect(compose).toContain('DSH_MNDT_ORG_NAME: "Datanalysis Réunion"')
    expect(compose).toContain('DSH_MNDT_ENV: "preprod"')
    expect(() => create('--env', 'staging')).toThrow()
    expect(() => create('--org-name', 'a|b')).toThrow()
  })
})
