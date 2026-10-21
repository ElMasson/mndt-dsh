import { describe, expect, it } from 'vitest'
import { loadTableView, toSnapshot } from '@deepseek-ai/dsh-host-governance/src/cache.ts'
import { MemoryRbacStorage } from '@deepseek-ai/dsh-client-ui-governance/src/governance.ts'

describe('toSnapshot', () => {
  it('keeps known roles and scopes', () => {
    const { snapshot, dropped } = toSnapshot([
      { subject: 'stephane', role: 'owner' },
      { subject: 'client', role: 'viewer', scope: 'session-42' },
    ])

    expect(dropped).toBe(0)
    expect(snapshot.grants).toEqual([
      { subject: 'stephane', role: 'owner' },
      { subject: 'client', role: 'viewer', scope: 'session-42' },
    ])
  })

  it('drops a role the rules do not know instead of caching it', () => {
    const { snapshot, dropped } = toSnapshot([
      { subject: 'stephane', role: 'owner' },
      { subject: 'ghost', role: 'root' },
    ])

    expect(dropped).toBe(1)
    expect(snapshot.grants).toEqual([{ subject: 'stephane', role: 'owner' }])
  })
})

describe('local mode', () => {
  it('reads the local table and does not mark it stale', async () => {
    const storage = new MemoryRbacStorage()
    await storage.save({ grants: [{ subject: 'stephane', role: 'owner' }] })

    const view = await loadTableView({ authority: undefined, storage })

    expect(view.stale).toBe(false)
    expect(view.source).toBe('local')
    expect(view.grants).toEqual([{ subject: 'stephane', role: 'owner' }])
  })
})

describe('team mode', () => {
  it('serves the authority answer and caches it', async () => {
    const storage = new MemoryRbacStorage()
    const authority = {
      snapshot: async () => ({ ok: true as const, grants: [{ subject: 'sara', role: 'admin' }] }),
    }

    const view = await loadTableView({ authority, storage })

    expect(view).toMatchObject({ stale: false, source: 'authority' })
    expect(view.grants).toEqual([{ subject: 'sara', role: 'admin' }])
    expect(await storage.load()).toEqual({ grants: [{ subject: 'sara', role: 'admin' }] })
  })

  it('falls back to the cached table and says it is stale', async () => {
    const storage = new MemoryRbacStorage()
    await storage.save({ grants: [{ subject: 'stephane', role: 'owner' }] })
    const authority = {
      snapshot: async () => ({ ok: false as const, reason: 'authority unreachable', status: 0 }),
    }

    const view = await loadTableView({ authority, storage })

    expect(view.stale).toBe(true)
    expect(view.source).toBe('cache')
    expect(view.detail).toContain('unreachable')
    expect(view.grants).toEqual([{ subject: 'stephane', role: 'owner' }])
  })

  it('treats a throwing authority as unreachable rather than as an empty table', async () => {
    const storage = new MemoryRbacStorage()
    await storage.save({ grants: [{ subject: 'stephane', role: 'owner' }] })
    const authority = {
      snapshot: async (): Promise<never> => { throw new Error('socket hang up') },
    }

    const view = await loadTableView({ authority, storage })

    expect(view.stale).toBe(true)
    expect(view.detail).toContain('socket hang up')
    expect(view.grants).toHaveLength(1)
  })

  it('does not overwrite the cache with an empty table when the authority refuses', async () => {
    const storage = new MemoryRbacStorage()
    await storage.save({ grants: [{ subject: 'stephane', role: 'owner' }] })
    const authority = {
      snapshot: async () => ({ ok: false as const, reason: 'a bearer token is required', status: 401 }),
    }

    await loadTableView({ authority, storage })

    expect(await storage.load()).toEqual({ grants: [{ subject: 'stephane', role: 'owner' }] })
  })
})
