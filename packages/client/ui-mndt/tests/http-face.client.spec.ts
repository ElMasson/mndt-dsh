import { afterEach, describe, expect, it, vi } from 'vitest'
import { available, createHttpFace } from '../src/client/httpFace.ts'

/** @param body - JSON body. @param status - HTTP status. @returns a Response-like object. */
function answer(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

/** @param routes - path to body. @returns the recorded calls. */
function stubFetch(routes: Record<string, unknown>): { readonly calls: string[] } {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(path)
    const key = path.replace('/mndt-api', '')
    const body = routes[key]
    if (body === undefined) return answer({ error: `no route ${key}` }, 404)
    return answer(body)
  }))
  return { calls }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('HTTP face', () => {
  it('reads the page state and the plain collections', async () => {
    stubFetch({
      '/state': { page: { you: 'duke@datanalysis.re', missions: [], briefs: [], approvals: [], memories: [] } },
      '/search?q=revue': { hits: [{ id: 'mis_1', kind: 'mission', label: 'revue', detail: 'x' }] },
      '/members': { members: [{ subject: 'duke@datanalysis.re', role: 'owner' }] },
      '/connectors': { connectors: [{ module: 'mcp-attio', server: 'attio', enabled: true }] },
      '/usage': { mine: { user: 'duke@datanalysis.re', missions: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, team: [], canAdmin: false },
      '/schedule': { at: '07:30' },
      '/journal?format=csv': { format: 'csv', text: 'a,b' },
      '/automations': { items: [], canAdmin: true },
    })
    const face = createHttpFace()
    expect((await face.state()).you).toBe('duke@datanalysis.re')
    expect(await face.members()).toHaveLength(1)
    expect(await face.connectors()).toHaveLength(1)
    expect((await face.usage()).canAdmin).toBe(false)
    expect(await face.schedule()).toEqual({ at: '07:30' })
    expect(await face.search('revue')).toHaveLength(1)
    expect((await face.journal('csv')).format).toBe('csv')
    expect((await face.automations()).canAdmin).toBe(true)
  })

  it('turns every action into an outcome instead of throwing', async () => {
    stubFetch({
      '/missions': { mission: { id: 'mis_1' }, brief: { id: 'brf_1' } },
      '/approvals/apr_1/decide': { approval: { id: 'apr_1' } },
      '/briefs/brf_1/approve': { brief: { id: 'brf_1' } },
      '/memory': { memory: { id: 'mem_1' } },
      '/members/grant': {},
      '/members/revoke': {},
      '/machines/capture': { ok: true, bytes: 10, seconds: 1, png: 'x' },
      '/machines/browser/act': { ok: true },
      '/machines/browser/stop': { ok: true },
      '/machines/desktop/act': { ok: true },
      '/machines/desktop/stop': { ok: true },
      '/mandates': { id: 'mnd_1' },
      '/mandates/mnd_1/sign': { id: 'mnd_1', state: 'active' },
      '/mandates/mnd_1/retire': { id: 'mnd_1', state: 'retired' },
      '/missions/mis_1/visibility': { mission: { id: 'mis_1', visibility: 'team' } },
      '/missions/mis_1/cancel': { id: 'mis_1', status: 'failed' },
      '/missions/mis_1/retry': { mission: { id: 'mis_9', status: 'done' } },
      '/memory/mem_1/scope': { memory: { id: 'mem_1', scope: 'team' } },
      '/automations/auto_1/toggle': { automation: { id: 'auto_1', enabled: true } },
      '/automations/auto_1/run': { outcome: 'done', mission: { id: 'mis_2' } },
      '/automations': { id: 'auto_2', name: 'Test' },
      '/schedule': { at: '08:00' },
    })
    const face = createHttpFace()
    expect((await face.runMission('custom', 'x')).ok).toBe(true)
    expect((await face.decide('apr_1', 'approved', 'ok')).ok).toBe(true)
    expect((await face.approveBrief('brf_1')).ok).toBe(true)
    expect((await face.remember('team', 'fact', 'x')).ok).toBe(true)
    expect((await face.grantMember('smarion@datanalysis.re', 'viewer')).ok).toBe(true)
    expect((await face.revokeMember('smarion@datanalysis.re')).ok).toBe(true)
    expect((await face.machineCapture('https://example.com')).ok).toBe(true)
    expect((await face.browserAct({ action: 'goto' })).ok).toBe(true)
    expect((await face.browserStop()).ok).toBe(true)
    expect((await face.desktopAct({ action: 'goto' })).ok).toBe(true)
    expect((await face.desktopStop()).ok).toBe(true)
    expect((await face.createMandate({ purpose: 'x' })).value).toEqual({ id: 'mnd_1' })
    expect((await face.signMandate('mnd_1')).ok).toBe(true)
    expect((await face.retireMandate('mnd_1')).ok).toBe(true)
    expect((await face.shareMission('mis_1', 'team')).ok).toBe(true)
    expect((await face.cancelMission('mis_1')).ok).toBe(true)
    expect((await face.retryMission('mis_1')).ok).toBe(true)
    expect((await face.shareMemory('mem_1', 'team')).ok).toBe(true)
    expect((await face.saveAutomation({ name: 'Test' })).ok).toBe(true)
    expect((await face.toggleAutomation('auto_1', true)).value).toEqual({ id: 'auto_1', enabled: true })
    expect((await face.runAutomationNow('auto_1')).value).toEqual({ outcome: 'done', mission: { id: 'mis_2' } })
    expect(await face.setSchedule('08:00')).toEqual({ at: '08:00' })
  })

  it('answers an empty collection when the Host omits it', async () => {
    stubFetch({ '/connectors': {}, '/members': {}, '/automations/auto_1/run': { outcome: 'done' } })
    const face = createHttpFace()
    expect(await face.connectors()).toEqual([])
    expect(await face.members()).toEqual([])
    expect((await face.runAutomationNow('auto_1')).value).toEqual({ outcome: 'done' })
  })

  it('reports a refusal with the reason the Host gives', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer({ error: 'not allowed' }, 403)))
    const face = createHttpFace()
    const outcome = await face.decide('apr_1', 'approved')
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('not allowed')
    expect(await available()).toBe(false)
  })

  it('falls back to a readable reason when the refusal carries none', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new Error('bad json') } }) as unknown as Response))
    const face = createHttpFace()
    const outcome = await face.approveBrief('brf_1')
    expect(outcome.error).toContain('502')
  })

  it('reports an unreachable API as a failure without crashing the page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed') }))
    const face = createHttpFace()
    expect((await face.shareMission('mis_1', 'team')).error).toBe('fetch failed')
    vi.stubGlobal('fetch', vi.fn(async () => { throw 'texte brut' }))
    expect((await face.shareMemory('mem_1', 'team')).error).toBe('texte brut')
    expect(await available()).toBe(false)
  })
})
