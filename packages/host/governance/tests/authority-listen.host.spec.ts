import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { startAuthority } from '@deepseek-ai/dsh-host-governance/src/authority.ts'
import { MemoryRbacStorage } from '@deepseek-ai/dsh-client-ui-governance/src/governance.ts'

/**
 * Boot the real HTTP adapter on an ephemeral loopback port and talk to it with
 * the real fetch. The handler unit tests prove the decisions; this one proves the
 * process actually serves them over the wire.
 */
describe('authority over http', () => {
  it('answers health, refuses an anonymous read, and serves an authenticated one', async () => {
    const server = startAuthority({
      tokens: { 'token-owner': { user: 'stephane' } },
      storage: new MemoryRbacStorage(),
      port: 0,
      host: '127.0.0.1',
    })
    await once(server, 'listening')
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    expect(port).toBeGreaterThan(0)
    const base = `http://127.0.0.1:${port}`

    try {
      const health = await fetch(`${base}/health`)
      expect(health.status).toBe(200)

      const anonymous = await fetch(`${base}/governance/snapshot`)
      expect(anonymous.status).toBe(401)

      const authorised = await fetch(`${base}/governance/snapshot`, {
        headers: { authorization: 'Bearer token-owner' },
      })
      expect(authorised.status).toBe(200)
      expect(await authorised.json()).toMatchObject({ grants: [], you: 'stephane' })
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    }
  })
})
