import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import { fileGrants } from '../src/grants.ts'

const owner = 'duke@datanalysis.re'
const member = 'smarion@datanalysis.re'

/** @param grants - the table to write. @returns a role file holding it. */
function roleFile(grants: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'grants-')), 'grants.json')
  writeFileSync(path, JSON.stringify({ grants }))
  return path
}

describe('the tenant role file', () => {
  it('reads the table, lowercases the subjects, and rereads it on every request', async () => {
    const path = roleFile([{ subject: 'Duke@Datanalysis.re', role: 'owner' }, { subject: member, role: 'viewer' }])
    const source = fileGrants(path)
    expect(await source.grants()).toEqual({ ok: true, grants: [{ subject: owner, role: 'owner' }, { subject: member, role: 'viewer' }] })
    writeFileSync(path, JSON.stringify({ grants: [{ subject: owner, role: 'owner' }, { subject: member, role: 'operator' }] }))
    expect(await source.grants()).toEqual({ ok: true, grants: [{ subject: owner, role: 'owner' }, { subject: member, role: 'operator' }] })
  })

  it('refuses the whole table, with its reason, rather than read part of it', async () => {
    const missing = await fileGrants('/nonexistent/grants.json').grants()
    expect(missing).toEqual({ ok: false, reason: 'the role file /nonexistent/grants.json is missing' })
    const broken = roleFile([])
    writeFileSync(broken, '{ grants: ')
    expect((await fileGrants(broken).grants()).ok).toBe(false)
    const unknownRole = await fileGrants(roleFile([{ subject: owner, role: 'owner' }, { subject: member, role: 'boss' }])).grants()
    expect(!unknownRole.ok && unknownRole.reason.includes('row 2')).toBe(true)
    const noSubject = await fileGrants(roleFile([{ role: 'admin' }])).grants()
    expect(noSubject.ok).toBe(false)
    writeFileSync(broken, '{"other": []}')
    const noList = await fileGrants(broken).grants()
    expect(!noList.ok && noList.reason.includes('no "grants" list')).toBe(true)
  })

  it('gives the team its rights through the API, and a change applies without a restart', async () => {
    const path = roleFile([{ subject: owner, role: 'owner' }, { subject: member, role: 'viewer' }])
    const api = createMndtApi({
      service: new WorkbenchService({ store: new MemoryStore() }),
      runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
      identity: { proxyUserHeader: 'x-forwarded-email' },
      grants: fileGrants(path),
    })
    const create = async (who: string, title: string) =>
      api({ method: 'POST', path: '/channels', headers: { 'x-forwarded-email': who }, body: JSON.stringify({ title }) })
    expect((await create(owner, 'Équipe')).status).toBe(201)
    const refused = await create(member, 'Pas encore')
    expect(refused.status).toBe(403)
    expect((refused.body as { error: string }).error).toContain('is viewer and does not hold workflows.write')
    writeFileSync(path, JSON.stringify({ grants: [{ subject: owner, role: 'owner' }, { subject: member, role: 'operator' }] }))
    expect((await create(member, 'Maintenant')).status).toBe(201)
    writeFileSync(path, '{ broken')
    const down = await create(owner, 'Fichier cassé')
    expect(down.status).toBe(503)
    expect((down.body as { error: string }).error).toContain('cannot read the grant table: the role file')
  })
})
