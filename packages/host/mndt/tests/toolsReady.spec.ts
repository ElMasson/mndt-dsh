import { describe, expect, it } from 'vitest'
import { ToolsReadiness } from '../src/tools-ready.ts'

/** @returns a registry the test fills, with the change listeners it calls. */
function registry() {
  const names: string[] = []
  const listeners = new Set<() => void>()
  return {
    names,
    add: (name: string) => { names.push(name); for (const listener of listeners) listener() },
    read: () => ({ schemas: () => names.map(name => ({ name })) }),
    onChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    listeners,
  }
}

describe('a turn waits for its servers\' tools, bounded', () => {
  it('already registered: no wait, nothing missing', async () => {
    const r = registry()
    r.add('mcp__approvals__request_approval')
    const started = Date.now()
    expect(await new ToolsReadiness(r.read, r.onChange, () => undefined, 1000).waitFor(['approvals'])).toEqual({ missing: [] })
    expect(Date.now() - started).toBeLessThan(25)
  })

  it('registered while it waits: the turn goes on as soon as the registry says so', async () => {
    const r = registry()
    const waiting = new ToolsReadiness(r.read, r.onChange, () => undefined, 5000).waitFor(['approvals', 'dolibarr'])
    setTimeout(() => { r.add('mcp__approvals__read_approval') }, 20)
    setTimeout(() => { r.add('mcp__dolibarr__get_invoices') }, 40)
    const started = Date.now()
    expect(await waiting).toEqual({ missing: [] })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(r.listeners.size).toBe(0)
  })

  it('still absent at the bound: missing, said once; the next turn does not wait for it; it is back once registered', async () => {
    const r = registry()
    r.add('mcp__approvals__request_approval')
    const warned: string[] = []
    const readiness = new ToolsReadiness(r.read, r.onChange, (m) => { warned.push(m) }, 60)
    expect(await readiness.waitFor(['approvals', 'dolibarr'])).toEqual({ missing: ['dolibarr'] })
    expect(warned).toEqual(['mndt: the tools of dolibarr are not registered after 0 s: its turns run without them until it registers'])
    const started = Date.now()
    expect(await readiness.waitFor(['approvals', 'dolibarr'])).toEqual({ missing: ['dolibarr'] })
    expect(Date.now() - started).toBeLessThan(25)
    expect(warned).toHaveLength(1)
    r.add('mcp__dolibarr__get_invoices')
    expect(await readiness.waitFor(['dolibarr'])).toEqual({ missing: [] })
    // Unavailable again later: said again, once.
    r.names.splice(0)
    expect((await readiness.waitFor(['dolibarr'])).missing).toEqual(['dolibarr'])
    expect(warned).toHaveLength(2)
  })

  it('a server whose name only starts like another one is not taken for it', async () => {
    const r = registry()
    r.add('mcp__approvals2__request_approval')
    expect((await new ToolsReadiness(r.read, r.onChange, () => undefined, 30).waitFor(['approvals'])).missing).toEqual(['approvals'])
  })
})
