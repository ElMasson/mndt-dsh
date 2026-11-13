import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatRefusal } from '../src/client/chat.ts'
import { isHostDown } from '../src/client/hostDown.ts'
import { FaceRefusal, createHttpFace } from '../src/client/httpFace.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('the workspace not answering, told apart from a refusal', () => {
  it('a gateway status or a network failure means it is down; a refused right or a missing route does not', () => {
    expect(isHostDown(new FaceRefusal('the Host refused the call (502)', 502))).toBe(true)
    expect(isHostDown(new ChatRefusal('the Host refused the call (504)', 504))).toBe(true)
    expect(isHostDown(new TypeError('Failed to fetch'))).toBe(true)
    expect(isHostDown(new FaceRefusal('x is viewer and does not hold workflows.write', 403))).toBe(false)
    expect(isHostDown(new ChatRefusal('channel_not_found', 404))).toBe(false)
    expect(isHostDown(new Error('anything else'))).toBe(false)
  })

  it('the legacy face throws a refusal that carries its status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('html') } }) as unknown as Response))
    const failure = await createHttpFace().state().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(FaceRefusal)
    expect((failure as FaceRefusal).status).toBe(502)
  })
})
