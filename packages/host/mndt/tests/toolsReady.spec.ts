import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { REQUIRED_TOOLS, ToolsReadiness } from '../src/tools-ready.ts'

/** @returns a registry the test fills, with the change listeners it calls. */
/** The approvals' card tools, all registered. */
const APPROVALS = REQUIRED_TOOLS.approvals!.map(tool => `mcp__approvals__${tool}`)

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
    for (const name of APPROVALS) r.add(name)
    const started = Date.now()
    expect(await new ToolsReadiness(r.read, r.onChange, () => undefined, 1000).waitFor(['approvals'])).toEqual({ missing: [] })
    expect(Date.now() - started).toBeLessThan(25)
  })

  it('registered while it waits: the turn goes on as soon as the registry says so', async () => {
    const r = registry()
    const waiting = new ToolsReadiness(r.read, r.onChange, () => undefined, 5000).waitFor(['approvals', 'dolibarr'])
    setTimeout(() => { for (const name of APPROVALS) r.add(name) }, 20)
    setTimeout(() => { r.add('mcp__dolibarr__get_invoices') }, 40)
    const started = Date.now()
    expect(await waiting).toEqual({ missing: [] })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(r.listeners.size).toBe(0)
  })

  it('still absent at the bound: missing, said once; the next turn does not wait for it; it is back once registered', async () => {
    const r = registry()
    for (const name of APPROVALS) r.add(name)
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

  it('the approvals are ready only with every card tool; the list is the catalog\'s allow-list', async () => {
    const catalog = JSON.parse(readFileSync(new URL('../deploy/connectors/catalog.json', import.meta.url), 'utf8')) as { approvals: { allow: string[] } }
    expect([...REQUIRED_TOOLS.approvals!].sort()).toEqual([...catalog.approvals.allow].sort())
    const r = registry()
    const readiness = new ToolsReadiness(r.read, r.onChange, () => undefined, 5000)
    const waiting = readiness.waitFor(['approvals'])
    for (const tool of REQUIRED_TOOLS.approvals!.slice(0, -1)) r.add(`mcp__approvals__${tool}`)
    let settled = false
    void waiting.then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(settled).toBe(false)
    r.add(`mcp__approvals__${REQUIRED_TOOLS.approvals!.at(-1)!}`)
    expect(await waiting).toEqual({ missing: [] })
  })

  it('stopped while it waits: it leaves at once, and marks nothing unavailable', async () => {
    const r = registry()
    const warned: string[] = []
    const readiness = new ToolsReadiness(r.read, r.onChange, (m) => { warned.push(m) }, 60_000)
    const controller = new AbortController()
    setTimeout(() => { controller.abort() }, 20)
    const started = Date.now()
    expect(await readiness.waitFor(['dolibarr'], controller.signal)).toEqual({ missing: ['dolibarr'] })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(warned).toEqual([])
    expect(r.listeners.size).toBe(0)
  })

  it('a server whose name only starts like another one is not taken for it', async () => {
    const r = registry()
    r.add('mcp__approvals2__request_approval')
    expect((await new ToolsReadiness(r.read, r.onChange, () => undefined, 30).waitFor(['approvals'])).missing).toEqual(['approvals'])
  })
})

describe('a server configured for the space', () => {
  it('is one whose descriptor mount-connector.sh wrote, beside state.json', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { configuredInSpace } = await import('../src/gateway.ts')
    const dir = mkdtempSync(join(tmpdir(), 'mndt-space-'))
    const configured = configuredInSpace(dir)
    expect(configured('approvals')).toBe(false)
    mkdirSync(join(dir, 'connectors'))
    writeFileSync(join(dir, 'connectors', 'approvals.json'), '{}')
    expect(configured('approvals')).toBe(true)
    expect(configured('workbench_facts')).toBe(false)
  })
})
