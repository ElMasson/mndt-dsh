import { describe, expect, it } from 'vitest'
import { AuthorityClient } from '@deepseek-ai/dsh-host-governance/src/authority-client.ts'

/** @param status - HTTP status. @param body - JSON payload. @returns a Response. */
function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('snapshot', () => {
  it('sends the bearer token and returns the grants', async () => {
    let seenUrl = ''
    let seenAuth = ''
    const client = new AuthorityClient({
      baseUrl: 'https://authority.example',
      token: 'token-owner',
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seenUrl = String(input)
        seenAuth = String((init?.headers as Record<string, string> | undefined)?.authorization)
        return answer(200, { grants: [{ subject: 'sara', role: 'admin' }] })
      }) as typeof globalThis.fetch,
    })

    const result = await client.snapshot()

    expect(seenUrl).toBe('https://authority.example/governance/snapshot')
    expect(seenAuth).toBe('Bearer token-owner')
    expect(result).toEqual({ ok: true, grants: [{ subject: 'sara', role: 'admin' }] })
  })

  it('reports a 401 as a refusal, not as an empty table', async () => {
    const client = new AuthorityClient({
      baseUrl: 'https://authority.example',
      token: 'stale',
      fetch: (async () => answer(401, { error: 'a bearer token is required' })) as typeof globalThis.fetch,
    })

    const result = await client.snapshot()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(401)
      expect(result.reason).toContain('bearer token')
    }
  })

  it('reports an unreachable authority instead of pretending success', async () => {
    const client = new AuthorityClient({
      baseUrl: 'https://authority.example',
      token: 'token-owner',
      fetch: (async () => { throw new Error('connect ECONNREFUSED') }) as typeof globalThis.fetch,
    })

    const result = await client.snapshot()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(0)
      expect(result.reason).toContain('unreachable')
    }
  })
})

describe('mutations', () => {
  it('posts a grant with its scope and returns the authority decision', async () => {
    let seenBody = ''
    const client = new AuthorityClient({
      baseUrl: 'https://authority.example/',
      token: 'token-owner',
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenBody = String(init?.body)
        return answer(200, { allowed: true, reason: 'sara is now admin' })
      }) as typeof globalThis.fetch,
    })

    const result = await client.grant('sara', 'admin', 'session-42')

    expect(JSON.parse(seenBody)).toEqual({ subject: 'sara', role: 'admin', scope: 'session-42' })
    expect(result).toMatchObject({ ok: true, reason: 'sara is now admin' })
  })

  it('maps a 403 to a refusal carrying the authority reason', async () => {
    const client = new AuthorityClient({
      baseUrl: 'https://authority.example',
      token: 'token-viewer',
      fetch: (async () => answer(403, { allowed: false, reason: 'sara does not hold rights.write' })) as typeof globalThis.fetch,
    })

    const result = await client.revoke('stephane')

    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
    expect(result.reason).toContain('rights.write')
  })

  it('times out rather than hanging a page', async () => {
    const client = new AuthorityClient({
      baseUrl: 'https://authority.example',
      token: 'token-owner',
      timeoutMs: 10,
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        })) as unknown as typeof globalThis.fetch,
    })

    const result = await client.grant('sara', 'viewer')

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('did not answer')
  })
})
