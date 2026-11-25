import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import { authorityGrants, fileGrants } from '../src/grants.ts'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

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

  it('refuses a file it cannot read, with its reason, after reading it twice', async () => {
    const missing = await fileGrants('/nonexistent/grants.json').grants()
    expect(missing).toEqual({ ok: false, reason: 'the role file /nonexistent/grants.json is missing' })
    const broken = roleFile([])
    writeFileSync(broken, '{ grants: ')
    expect((await fileGrants(broken).grants()).ok).toBe(false)
    writeFileSync(broken, '{"other": []}')
    const noList = await fileGrants(broken).grants()
    expect(!noList.ok && noList.reason.includes('no "grants" list')).toBe(true)
  })

  it('says « no grants list », not « not JSON », for a file that is JSON but not an object', async () => {
    for (const text of ['null', '[]', '42']) {
      const path = roleFile([])
      writeFileSync(path, text)
      const table = await fileGrants(path).grants()
      expect(!table.ok && table.reason, text).toContain('has no "grants" list')
    }
  })

  it('treats the authority\'s rows as the role file\'s: an invalid row set aside, said once', async () => {
    const warned: string[] = []
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ grants: [{ subject: owner, role: 'owner' }, { subject: 'du\u212Ae@datanalysis.re', role: 'admin' }] }))
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const { port } = server.address() as AddressInfo
    try {
      const source = authorityGrants({ baseUrl: `http://127.0.0.1:${port}`, token: 't' }, (message) => { warned.push(message) })
      expect(await source.grants()).toEqual({ ok: true, grants: [{ subject: owner, role: 'owner' }], skipped: [{ row: 2, reason: 'the subject is not a plain ASCII e-mail' }] })
      await source.grants()
      expect(warned).toEqual(['mndt: the team authority, row 2, is set aside and grants nothing: the subject is not a plain ASCII e-mail'])
    } finally {
      server.close()
    }
  })

  it('reads a file caught in the middle of a rewrite on its second read', async () => {
    const path = roleFile([])
    writeFileSync(path, '{ "grants": [ { "subject": "duke@datan')
    setTimeout(() => { writeFileSync(path, JSON.stringify({ grants: [{ subject: owner, role: 'owner' }] })) }, 10)
    expect(await fileGrants(path).grants()).toEqual({ ok: true, grants: [{ subject: owner, role: 'owner' }] })
  })

  it('sets an invalid row aside, says which and why once, and serves the others', async () => {
    const warned: string[] = []
    const path = roleFile([{ subject: owner, role: 'owner' }, { subject: member, role: 'boss' }, { role: 'admin' },
      { subject: 'du\u212Ae@datanalysis.re', role: 'admin' }, { subject: 'x@datanalysis.re', role: 'viewer', name: 'a\u2028b' },
      { subject: 'jadmin@datanalysis.re', role: 'admin' }])
    const source = fileGrants(path, (message) => { warned.push(message) })
    const table = await source.grants()
    expect(table).toEqual({
      ok: true,
      grants: [{ subject: owner, role: 'owner' }, { subject: 'jadmin@datanalysis.re', role: 'admin' }],
      skipped: [
        { row: 2, reason: 'a subject (e-mail) and a role among owner, admin, operator, viewer are required' },
        { row: 3, reason: 'a subject (e-mail) and a role among owner, admin, operator, viewer are required' },
        { row: 4, reason: 'the subject is not a plain ASCII e-mail' },
        { row: 5, reason: 'a name is one line of 80 characters at most, without control characters' },
      ],
    })
    await source.grants()
    expect(warned).toHaveLength(4) // once per change of the file, not per request
    expect(warned[0]).toContain('row 2, is set aside and grants nothing')
  })

  it('gives the team its rights through the API, and a change applies without a restart', async () => {
    const path = roleFile([{ subject: owner, role: 'owner' }, { subject: member, role: 'viewer' }])
    const api = createMndtApi({
      service: new WorkbenchService({ store: new MemoryStore() }),
      runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
      identity: { proxyUserHeader: 'x-forwarded-email', gatewaySecret: 'gateway-secret-for-tests' },
      grants: fileGrants(path),
    })
    const create = async (who: string, title: string) =>
      api({ method: 'POST', path: '/channels', headers: { 'x-forwarded-email': who, 'x-mndt-gateway': 'gateway-secret-for-tests' }, body: JSON.stringify({ title }) })
    expect((await create(owner, 'Équipe')).status).toBe(201)
    const refused = await create(member, 'Pas encore')
    expect(refused.status).toBe(403)
    expect((refused.body as { error: string }).error).toContain('is viewer and does not hold workflows.write')
    writeFileSync(path, JSON.stringify({ grants: [{ subject: owner, role: 'owner' }, { subject: member, role: 'operator' }] }))
    expect((await create(member, 'Maintenant')).status).toBe(201)
    writeFileSync(path, '{ broken')
    const down = await create(owner, 'Fichier cassé')
    expect(down.status).toBe(503)
    // One sentence for the client; the file and its error are the operator's log's.
    expect(down.body).toEqual({ code: 'grants-unreadable', error: 'la table des rôles est illisible' })
  })
})
