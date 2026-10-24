import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthority } from '@deepseek-ai/dsh-host-governance/src/authority.ts'
import { JsonFileRbacStorage } from '@deepseek-ai/dsh-host-governance/src/storage.ts'
import { MemoryRbacStorage } from '@deepseek-ai/dsh-client-ui-governance/src/governance.ts'

const tokens = {
  'token-owner': { user: 'stephane' },
  'token-viewer': { user: 'sara' },
} as const

const created: string[] = []

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-authority-'))
  created.push(dir)
  return join(dir, name)
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

describe('authentication', () => {
  it('answers health without a token, so a probe can reach it', async () => {
    const handle = createAuthority({ tokens })

    await expect(handle({ method: 'GET', path: '/health' })).resolves.toEqual({
      status: 200,
      body: { ok: true },
    })
  })

  it('refuses a request with no token', async () => {
    const handle = createAuthority({ tokens })

    const response = await handle({ method: 'GET', path: '/governance/snapshot' })

    expect(response.status).toBe(401)
  })

  it('refuses a token it does not know', async () => {
    const handle = createAuthority({ tokens })

    const response = await handle({
      method: 'GET',
      path: '/governance/snapshot',
      authorization: 'Bearer not-a-token',
    })

    expect(response.status).toBe(401)
  })

  it('refuses a malformed authorization header', async () => {
    const handle = createAuthority({ tokens })

    const response = await handle({
      method: 'GET',
      path: '/governance/snapshot',
      authorization: 'token-owner',
    })

    expect(response.status).toBe(401)
  })
})

describe('decisions', () => {
  it('bootstraps the first owner from the authenticated identity only', async () => {
    const handle = createAuthority({ tokens })
    const auth = { authorization: 'Bearer token-owner' }

    const response = await handle({ method: 'POST', path: '/governance/bootstrap', ...auth })

    expect(response.status).toBe(200)
    const snapshot = await handle({ method: 'GET', path: '/governance/snapshot', ...auth })
    expect(snapshot.body).toMatchObject({ grants: [{ subject: 'stephane', role: 'owner' }] })
  })

  it('lets the owner grant a role and refuses the same request from a viewer', async () => {
    const storage = new MemoryRbacStorage()
    const handle = createAuthority({ tokens, storage })
    await handle({ method: 'POST', path: '/governance/bootstrap', authorization: 'Bearer token-owner' })

    const byOwner = await handle({
      method: 'POST',
      path: '/governance/grant',
      authorization: 'Bearer token-owner',
      body: JSON.stringify({ subject: 'sara', role: 'operator' }),
    })
    expect(byOwner.status).toBe(200)

    const byViewer = await handle({
      method: 'POST',
      path: '/governance/grant',
      authorization: 'Bearer token-viewer',
      body: JSON.stringify({ subject: 'sara', role: 'owner' }),
    })
    expect(byViewer.status).toBe(403)
    const snapshot = await handle({
      method: 'GET',
      path: '/governance/snapshot',
      authorization: 'Bearer token-owner',
    })
    expect(snapshot.body).toMatchObject({
      grants: [
        { subject: 'stephane', role: 'owner' },
        { subject: 'sara', role: 'operator' },
      ],
    })
  })

  it('rejects a grant with an unknown role', async () => {
    const handle = createAuthority({ tokens })
    await handle({ method: 'POST', path: '/governance/bootstrap', authorization: 'Bearer token-owner' })

    const response = await handle({
      method: 'POST',
      path: '/governance/grant',
      authorization: 'Bearer token-owner',
      body: JSON.stringify({ subject: 'sara', role: 'root' }),
    })

    expect(response.status).toBe(400)
  })

  it('refuses to remove the last owner', async () => {
    const handle = createAuthority({ tokens })
    await handle({ method: 'POST', path: '/governance/bootstrap', authorization: 'Bearer token-owner' })

    const response = await handle({
      method: 'POST',
      path: '/governance/revoke',
      authorization: 'Bearer token-owner',
      body: JSON.stringify({ subject: 'stephane' }),
    })

    expect(response.status).toBe(403)
    expect(JSON.stringify(response.body)).toContain('last owner')
  })

  it('answers 404 for an unknown route', async () => {
    const handle = createAuthority({ tokens })

    const response = await handle({
      method: 'GET',
      path: '/governance/unknown',
      authorization: 'Bearer token-owner',
    })

    expect(response.status).toBe(404)
  })
})

describe('audit', () => {
  it('records every mutation with the authenticated identity', async () => {
    const auditPath = await tempFile('audit.jsonl')
    const handle = createAuthority({ tokens, auditPath, now: () => new Date('2026-10-18T12:00:00.000Z') })
    await handle({ method: 'POST', path: '/governance/bootstrap', authorization: 'Bearer token-owner' })
    await handle({
      method: 'POST',
      path: '/governance/grant',
      authorization: 'Bearer token-owner',
      body: JSON.stringify({ subject: 'sara', role: 'viewer' }),
    })

    const lines = (await readFile(auditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {
      user: string
      action: string
      allowed: boolean
    })

    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ user: 'stephane', action: 'bootstrap', allowed: true })
    expect(lines[1]).toMatchObject({ user: 'stephane', action: 'grant', allowed: true })
  })

  it('writes nothing when no audit path is configured', async () => {
    const handle = createAuthority({ tokens })
    const response = await handle({
      method: 'POST',
      path: '/governance/bootstrap',
      authorization: 'Bearer token-owner',
    })

    expect(response.status).toBe(200)
  })
})

describe('durable authority', () => {
  it('serves the same table across two handler instances over one file', async () => {
    const path = await tempFile('rbac.json')
    const first = createAuthority({ tokens, storage: new JsonFileRbacStorage(path) })
    await first({ method: 'POST', path: '/governance/bootstrap', authorization: 'Bearer token-owner' })
    await first({
      method: 'POST',
      path: '/governance/grant',
      authorization: 'Bearer token-owner',
      body: JSON.stringify({ subject: 'sara', role: 'admin' }),
    })

    const second = createAuthority({ tokens, storage: new JsonFileRbacStorage(path) })
    const snapshot = await second({
      method: 'GET',
      path: '/governance/snapshot',
      authorization: 'Bearer token-owner',
    })

    expect(snapshot.body).toMatchObject({
      grants: [
        { subject: 'stephane', role: 'owner' },
        { subject: 'sara', role: 'admin' },
      ],
    })
  })
})

describe('authority behind an authenticating proxy', () => {
  it('accepts the identity the proxy proved, without a bearer token', async () => {
    const handle = createAuthority({ tokens, storage: new MemoryRbacStorage(), proxyUserHeader: 'x-auth-request-email' })
    const bootstrap = await handle({
      method: 'POST',
      path: '/governance/bootstrap',
      body: JSON.stringify({ user: 'stephane', role: 'owner' }),
      headers: { 'x-auth-request-email': 'stephane@duke-analytics.com' },
    })

    expect(bootstrap.status).toBe(200)
    expect(bootstrap.body).toMatchObject({ allowed: true })
  })

  it('ignores the header when the deployment does not trust a proxy', async () => {
    const handle = createAuthority({ tokens, storage: new MemoryRbacStorage() })
    const response = await handle({
      method: 'GET',
      path: '/governance/snapshot',
      headers: { 'x-auth-request-email': 'stephane@duke-analytics.com' },
    })

    expect(response.status).toBe(401)
  })

  it('never lets the header rescue a bad bearer token', async () => {
    const handle = createAuthority({ tokens, storage: new MemoryRbacStorage(), proxyUserHeader: 'x-auth-request-email' })
    const response = await handle({
      method: 'GET',
      path: '/governance/snapshot',
      authorization: 'Bearer not-a-token',
      headers: { 'x-auth-request-email': 'stephane@duke-analytics.com' },
    })

    expect(response.status).toBe(401)
  })
})

describe('authority root', () => {
  it('answers the signed-in person at the root', async () => {
    const handle = createAuthority({ tokens, storage: new MemoryRbacStorage(), proxyUserHeader: 'x-auth-request-email' })
    const response = await handle({
      method: 'GET',
      path: '/',
      headers: { 'x-auth-request-email': 'stephane@duke-analytics.com' },
    })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ service: 'dsh governance authority', you: 'stephane@duke-analytics.com' })
  })
})

describe('snapshot identity', () => {
  it('names the reader of the table', async () => {
    const handle = createAuthority({ tokens, storage: new MemoryRbacStorage() })
    const response = await handle({
      method: 'GET',
      path: '/governance/snapshot',
      authorization: 'Bearer token-viewer',
    })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ you: 'sara' })
  })
})
