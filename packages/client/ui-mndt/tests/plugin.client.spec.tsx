// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import type { MndtFace } from '../src/client/face.ts'

interface Registration {
  readonly options: {
    readonly inject?: () => { readonly api: MndtFace }
    readonly label?: () => string
  }
  readonly component: unknown
}

interface Bench {
  readonly ctx: Context
  readonly registrations: Registration[]
  readonly disposers: (() => void)[]
}

/**
 * @param mounted - the Remote face, when the bench has one.
 * @returns a client context that records what the plugin registers.
 */
function bench(mounted?: Record<string, (...args: never[]) => unknown>): Bench {
  const ctx = new Context()
  const registrations: Registration[] = []
  const disposers: (() => void)[] = []
  Object.defineProperty(ctx, 'get', { value: (name: string) => (name === 'remote.mndt' ? mounted : undefined) })
  Object.defineProperty(ctx, 'effect', {
    value: (run: () => unknown) => {
      const dispose = run()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
      return () => undefined
    },
  })
  ctx.provide('locale', { register: () => () => undefined, bind: () => (key: string) => key } as never)
  ctx.provide('slots', {
    inject: (_name: string, callback: () => unknown) => {
      callback()
      return () => undefined
    },
    register: (options: Registration['options'], component: unknown) => {
      registrations.push({ options, component })
      return () => undefined
    },
  } as never)
  return { ctx, registrations, disposers }
}

/** @param bench - the bench to read. @returns the face the page would receive. */
function faceOf(bench: Bench): MndtFace {
  const registration = bench.registrations[0]
  expect(registration?.options.inject).toBeTruthy()
  return (registration?.options.inject as () => { api: MndtFace })().api
}

afterEach(() => { vi.unstubAllGlobals() })

describe('client plugin wiring', () => {
  it('declares the services it needs and registers the two contributions once', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote'])
    const b = bench()
    apply(b.ctx)
    expect(b.registrations).toHaveLength(2)
    expect(b.registrations.map(entry => entry.component)).toBeTruthy()
    expect((b.registrations[1]?.options.label as () => string)()).toBe('title')
    expect(document.querySelector('#mndt-workbench-styles')).toBeTruthy()
    for (const dispose of b.disposers) dispose()
    expect(document.querySelector('#mndt-workbench-styles')).toBeNull()
  })

  it('uses the HTTP face when the per-user API answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (path.endsWith('/health')) return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response
      return {
        ok: true, status: 200, json: async () => ({ page: { you: 'duke@datanalysis.re', missions: [], briefs: [], approvals: [], memories: [] } }),
      } as unknown as Response
    }))
    const b = bench()
    apply(b.ctx)
    const page = await faceOf(b).state()
    expect(page.you).toBe('duke@datanalysis.re')
  })

  it('drives the Remote face, unwrapping its envelopes', async () => {
    const calls: string[] = []
    const wrap = (value: unknown) => { calls.push('call'); return Promise.resolve({ ok: true, value: JSON.stringify(value) }) }
    const mounted = {
      state: () => Promise.resolve({ ok: true, value: JSON.stringify({ page: { you: 'remote', missions: [], briefs: [], approvals: [], memories: [] } }) }),
      runMission: () => wrap({ mission: { id: 'mis_1' } }),
      cancelMission: () => wrap({ id: 'mis_1', status: 'failed' }),
      search: () => wrap({ hits: [{ id: 'mis_1', kind: 'mission', label: 'revue', detail: 'x' }] }),
      retryMission: () => wrap({ mission: { id: 'mis_9' } }),
      decide: () => wrap({ approval: { id: 'apr_1' } }),
      approveBrief: () => wrap({ brief: { id: 'brf_1' } }),
      remember: () => wrap({ memory: { id: 'mem_1' } }),
      shareMission: () => wrap({ mission: { id: 'mis_1' } }),
      shareMemory: () => wrap({ memory: { id: 'mem_1' } }),
      members: () => wrap([{ subject: 'duke@datanalysis.re', role: 'owner' }]),
      grantMember: () => wrap({ subject: 'x', role: 'viewer' }),
      revokeMember: () => wrap({ subject: 'x', role: 'none' }),
      usage: () => wrap({ mine: { user: 'x', missions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, team: [], canAdmin: false }),
      schedule: () => wrap({ at: '07:30' }),
      setSchedule: () => wrap({ at: '08:00' }),
      machineCapture: () => wrap({ ok: true, bytes: 1, seconds: 1, png: 'x' }),
      browserAct: () => wrap({ ok: true }),
      browserStop: () => wrap({ ok: true }),
      desktopAct: () => wrap({ ok: true }),
      desktopStop: () => wrap({ ok: true }),
      createMandate: () => wrap({ id: 'mnd_1' }),
      signMandate: () => wrap({ id: 'mnd_1' }),
      retireMandate: () => wrap({ id: 'mnd_1' }),
      journal: () => wrap({ format: 'json', entries: [] }),
      automations: () => wrap({ items: [], canAdmin: true }),
      saveAutomation: () => wrap({ id: 'auto_1' }),
      toggleAutomation: () => wrap({ id: 'auto_1', enabled: true }),
      runAutomationNow: () => wrap({ outcome: 'done' }),
      connectors: () => Promise.resolve({ ok: true, value: [{ module: 'mcp-attio', server: 'attio', enabled: true }] }),
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no HTTP face') }))
    const b = bench(mounted)
    apply(b.ctx)
    const api = faceOf(b)
    expect((await api.state()).you).toBe('remote')
    expect(await api.runMission('custom', 'x')).toBeTruthy()
    expect(await api.cancelMission('mis_1')).toBeTruthy()
    expect(await api.search('revue')).toHaveLength(1)
    expect(await api.retryMission('mis_1')).toBeTruthy()
    expect(await api.decide('apr_1', 'approved')).toBeTruthy()
    expect(await api.approveBrief('brf_1')).toBeTruthy()
    expect(await api.remember('team', 'fact', 'x')).toBeTruthy()
    expect(await api.shareMission('mis_1', 'team')).toBeTruthy()
    expect(await api.shareMemory('mem_1', 'team')).toBeTruthy()
    expect(await api.members()).toHaveLength(1)
    expect(await api.grantMember('x', 'viewer')).toBeTruthy()
    expect(await api.revokeMember('x')).toBeTruthy()
    expect((await api.usage()).canAdmin).toBe(false)
    expect(await api.schedule()).toEqual({ at: '07:30' })
    expect(await api.setSchedule('08:00')).toEqual({ at: '08:00' })
    expect((await api.machineCapture('https://example.com')).png).toBe('x')
    expect((await api.browserAct({})).ok).toBe(true)
    expect((await api.browserStop()).ok).toBe(true)
    expect((await api.desktopAct({})).ok).toBe(true)
    expect((await api.desktopStop()).ok).toBe(true)
    expect(await api.createMandate({})).toBeTruthy()
    expect(await api.signMandate('mnd_1')).toBeTruthy()
    expect(await api.retireMandate('mnd_1')).toBeTruthy()
    expect(await api.journal('json')).toBeTruthy()
    expect((await api.automations()).canAdmin).toBe(true)
    expect(await api.saveAutomation({})).toBeTruthy()
    expect(await api.toggleAutomation('auto_1', true)).toBeTruthy()
    expect(await api.runAutomationNow('auto_1')).toBeTruthy()
    expect(await api.connectors()).toHaveLength(1)
    expect(calls.length).toBeGreaterThan(5)
  })

  it('covers the remaining Remote envelopes and effect disposals', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no HTTP face') }))
    const b = bench({
      state: () => Promise.resolve({ ok: false }),
      connectors: () => Promise.resolve([{ module: 'direct', server: 's', enabled: true }]),
      browserAct: () => Promise.resolve(null),
    })
    apply(b.ctx)
    const api = faceOf(b)
    await expect(api.state()).rejects.toThrow('the Host refused the call')
    expect(await api.connectors()).toEqual([{ module: 'direct', server: 's', enabled: true }])
  })

  it('handles answers that are not envelopes, or carry no reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no HTTP face') }))
    const b = bench({
      state: () => Promise.resolve('{"ok":false}'),
      decide: () => Promise.resolve({ ok: false }),
      runMission: () => Promise.resolve({ notAnEnvelope: true }),
      connectors: () => Promise.resolve(null),
    })
    apply(b.ctx)
    const api = faceOf(b)
    await expect(api.state()).rejects.toThrow('the Host refused the call')
    await expect(api.decide('apr_1', 'approved')).rejects.toThrow('the Host refused the call')
    await expect(api.runMission('custom', 'x')).rejects.toThrow()
    expect(await api.connectors()).toEqual([])
  })

  it('keeps the reason when the parsed answer carries one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no HTTP face') }))
    const b = bench({ state: () => Promise.resolve('{"ok":false,"error":"motif du Host"}') })
    apply(b.ctx)
    await expect(faceOf(b).state()).rejects.toThrow('motif du Host')
  })

  it('reports a Remote refusal with its own reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no HTTP face') }))
    const b = bench({
      state: () => Promise.resolve({ ok: false, error: 'refus du Host' }),
      connectors: () => Promise.resolve({ ok: true, value: JSON.stringify({ notAnArray: true }) }),
      runMission: () => Promise.resolve('{"direct":true}'),
    })
    apply(b.ctx)
    const api = faceOf(b)
    await expect(api.state()).rejects.toThrow('refus du Host')
    expect(await api.connectors()).toEqual([])
    expect(await api.runMission('custom', 'x')).toEqual({ direct: true })
  })

  it('refuses every call when neither transport is mounted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    const b = bench()
    apply(b.ctx)
    await expect(faceOf(b).state()).rejects.toThrow(/neither the product API/)
  })
})
