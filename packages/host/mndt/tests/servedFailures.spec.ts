/**
 * What is served of a failure is the host's words (coordination, 25/11, on
 * #157): a turn's reason and its kind, another service's answer, a role table
 * that cannot be read, someone else's mission. The words the host did not write
 * go to the operator's log only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryStore, Refusal, TURN_FAILURE_SENTENCE, WorkbenchService } from '../src/core/index.ts'
import type { TurnFailureKind } from '../src/core/index.ts'
import { turnFailure } from '../src/public-failure.ts'
import type { Message, PriceGrid } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import { TurnBudgetReached, TurnScheduler } from '../src/turns.ts'
import type { TurnEngine, TurnInput, TurnOutput } from '../src/turns.ts'

const owner = 'duke@datanalysis.re'
const member = 'smarion@datanalysis.re'
const noMissions = { run: async () => ({ title: 't', markdown: 'm', sources: [] }) }

afterEach(() => { vi.unstubAllGlobals() })

describe('a failed turn', () => {
  it('serves the host\'s sentence and its kind; the engine\'s words go to the operator\'s log only', async () => {
    const warned: string[] = []
    const service = new WorkbenchService({ store: new MemoryStore() })
    const engine: TurnEngine = {
      run: async (_input: TurnInput): Promise<TurnOutput> => { throw new Error('the agent turn failed: 429 from upstream req_51 shard eu-3') },
    }
    const prices: PriceGrid = { 'route-a/*': { input: 1, output: 2 } }
    const turns = new TurnScheduler({ service, engine, prices, dataDir: '/data/mndt', warn: (line) => { warned.push(line) } })
    const api = createMndtApi({
      service, runner: noMissions, turns,
      identity: { tokens: { owner: { user: owner } } },
      grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }] }) },
    })
    const call = async (method: string, path: string, body?: unknown) =>
      (await api({ method, path, authorization: 'Bearer owner', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).body as Record<string, unknown>
    const alpha = ((await call('POST', '/agents', { handle: 'alpha', name: 'alpha', provider: 'route-a', model: 'm', eurPerMonth: 5 })).agent as { id: string }).id
    const channel = ((await call('POST', '/channels', { name: 'compta', agents: [alpha], members: [] })).channel as { id: string }).id
    await call('POST', `/channels/${channel}/messages`, { text: '@alpha bonjour' })
    await turns.settled()
    const messages = (await call('GET', `/channels/${channel}/messages`)).messages as Message[]
    const turn = messages.flatMap(message => message.turns ?? [])[0]
    expect(turn).toMatchObject({ status: 'failed', reason: 'Erreur pendant l’exécution.', reasonKind: 'failed' })
    expect(JSON.stringify(messages)).not.toContain('req_51')
    expect(JSON.stringify(await service.snapshot())).not.toContain('req_51')
    expect(warned.join('\n')).toContain('req_51')
  })
})

/** A bench whose engine fails as `fail` says, priced or not. */
function turnBench(fail: (input: TurnInput) => TurnOutput | Promise<TurnOutput>, prices: PriceGrid = { 'route-a/*': { input: 1, output: 2 } }) {
  const warned: string[] = []
  const service = new WorkbenchService({ store: new MemoryStore() })
  const turns = new TurnScheduler({ service, engine: { run: async (input: TurnInput) => fail(input) }, prices, dataDir: '/data/mndt', warn: (line) => { warned.push(line) } })
  const api = createMndtApi({
    service, runner: noMissions, turns,
    identity: { tokens: { owner: { user: owner } } },
    grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }] }) },
  })
  const call = async (method: string, path: string, body?: unknown) =>
    (await api({ method, path, authorization: 'Bearer owner', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).body as Record<string, unknown>
  const turnOf = async (text: string, provider = 'route-a') => {
    const alpha = ((await call('POST', '/agents', { handle: 'alpha', name: 'alpha', provider, model: 'm', eurPerMonth: 5 })).agent as { id: string }).id
    const channel = ((await call('POST', '/channels', { name: 'compta', agents: [alpha], members: [] })).channel as { id: string }).id
    await call('POST', `/channels/${channel}/messages`, { text })
    await turns.settled()
    const messages = (await call('GET', `/channels/${channel}/messages`)).messages as Message[]
    return { turn: messages.flatMap(message => message.turns ?? [])[0], messages, service }
  }
  return { turnOf, warned, service }
}

/** The host's sentences: what a turn's reason may be once it carries a kind (plus a refusal's own words). */
const HOST_SENTENCES = new Set(Object.values(TURN_FAILURE_SENTENCE))

describe('every end of a turn carries its kind, and its reason is the host\'s sentence', () => {
  it('max-tokens is « cut »', async () => {
    const b = turnBench(() => { throw new Error('the agent turn ended max-tokens') })
    const { turn } = await b.turnOf('@alpha un long rapport')
    expect(turn).toMatchObject({ status: 'failed', reasonKind: 'cut', reason: 'Réponse coupée (limite de longueur atteinte).' })
  })

  it('tools not ready keep the host\'s own words, servers named: « outils indisponibles : approvals … »', async () => {
    const b = turnBench(() => { throw new Refusal('outils indisponibles : approvals (démarrage en cours ou connecteur en panne) ; le tour n’a pas été lancé') })
    const { turn } = await b.turnOf('@alpha bonjour')
    expect(turn).toMatchObject({ status: 'failed', reasonKind: 'tools', reason: 'outils indisponibles : approvals (démarrage en cours ou connecteur en panne) ; le tour n’a pas été lancé' })
  })

  it('a model without a price is « refused », in the host\'s words', async () => {
    const b = turnBench(() => ({ text: 'x' }), {})
    const { turn } = await b.turnOf('@alpha bonjour')
    expect(turn?.status).toBe('refused')
    expect(turn?.reasonKind).toBe('refused')
    expect(turn?.reason).toMatch(/^Prix du modèle non configuré/)
  })

  it('a restart closes a running turn as « restart »', async () => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    const b = turnBench(async () => { await held; return { text: 'x' } })
    const pending = b.turnOf('@alpha bonjour')
    await new Promise(resolve => setTimeout(resolve, 30))
    await b.service.cancelInterruptedTurns(new Date(Date.now() + 1000).toISOString())
    release()
    const { turn } = await pending
    expect(turn).toMatchObject({ status: 'cancelled', reasonKind: 'restart', reason: 'interrompu par un redémarrage' })
  })

  it('the twelve kinds: each one\'s reason is the host\'s sentence, never the text it came from', async () => {
    // Nine come from what failed (an engine's end, a refusal of the host)…
    const fromFailure: [TurnFailureKind, unknown][] = [
      ['no-answer', new Error('the agent returned no text (settled: {"secret":1})')],
      ['cut', new Error('the agent turn ended max-tokens')],
      ['cancelled', new Error('cancelled by duke@datanalysis.re')],
      ['tools', new Refusal('outils indisponibles : qonto (démarrage en cours ou connecteur en panne) ; le tour n’a pas été lancé')],
      ['failed', new Error('the agent turn failed: 500 from upstream req_99')],
      ['budget', new TurnBudgetReached({ input: 1, output: 1 })],
      ['blocked', new Error('the agent turn ended blocked')],
      ['aborted', new Error('the agent turn ended aborted')],
      ['interrupted', new Error('the agent turn ended interrupted')],
    ]
    const log: string[] = []
    for (const [kind, error] of fromFailure) {
      const served = turnFailure(error, line => log.push(line), 'a turn')
      expect(served.kind).toBe(kind)
      const own = error instanceof Refusal ? error.message : TURN_FAILURE_SENTENCE[kind]
      expect(served.reason).toBe(own)
      if (!(error instanceof Refusal)) expect(served.reason).not.toBe((error as Error).message)
    }
    // … and three from the turn's life: a refusal before it ran, a turn gone stale, a restart.
    const refused = (await turnBench(() => ({ text: 'x' }), {}).turnOf('@alpha bonjour')).turn
    expect([refused?.reasonKind, refused?.reason?.startsWith('Prix du modèle non configuré')]).toEqual(['refused', true])
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    const b = turnBench(async () => { await held; return { text: 'x' } })
    const pending = b.turnOf('@alpha bonjour')
    await new Promise(resolve => setTimeout(resolve, 30))
    const asked = ((await b.service.snapshot()).messages ?? []).find(message => message.author.kind === 'human')
    await b.service.deleteMessage(asked?.channelId ?? '', asked?.id ?? '', owner)
    release()
    await pending
    // A deleted message is served without its turns: read the turn as stored.
    const stale = ((await b.service.snapshot()).messages ?? []).find(message => message.id === asked?.id)?.turns?.[0]
    expect([stale?.reasonKind, stale?.reason]).toEqual(['stale', 'Message supprimé par son auteur.'])
    // restart: the test above (« a restart closes a running turn as « restart » »).
    const kinds: TurnFailureKind[] = [...fromFailure.map(([kind]) => kind), 'refused', 'stale', 'restart']
    expect(new Set(kinds).size).toBe(12)
    expect(Object.keys(TURN_FAILURE_SENTENCE).sort()).toEqual([...kinds].sort())
  })

  it('whatever the engine says, a failed turn\'s reason is one of the host\'s sentences', async () => {
    for (const raw of ['the agent turn failed: 500 req_9 from upstream', 'the agent turn ended blocked', 'the agent turn ended aborted', 'the agent returned no text (settled: {"k":1})', 'TypeError: x is not a function']) {
      const b = turnBench(() => { throw new Error(raw) })
      const { turn, messages } = await b.turnOf('@alpha bonjour')
      expect(turn?.reasonKind).toBeDefined()
      expect(HOST_SENTENCES.has(turn?.reason ?? '')).toBe(true)
      expect(JSON.stringify(messages)).not.toContain(raw)
    }
  })
})

describe('another service\'s answer is never relayed as it came', () => {
  it('the role authority refusing: its status and the host\'s sentence, its body in the operator\'s log', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'db at 10.0.3.7 down', trace: 'xyz' }), { status: 500 }))
    const warned: string[] = []
    const api = createMndtApi({
      service: new WorkbenchService({ store: new MemoryStore() }),
      runner: noMissions,
      identity: { tokens: { owner: { user: owner } } },
      grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }] }) },
      authority: { baseUrl: 'http://authority.test', token: 'deployment-token' },
      warn: (line) => { warned.push(line) },
    })
    const answer = await api({ method: 'POST', path: '/members/grant', authorization: 'Bearer owner', body: JSON.stringify({ subject: member, role: 'viewer' }) })
    expect(answer.status).toBe(500)
    expect(answer.body).toEqual({ error: 'the authority refused the change: the role is unchanged', code: 'authority-refused' })
    expect(warned.join('\n')).toContain('10.0.3.7')
  })

  it('the machine service refusing to start a desktop: a fixed sentence and a code', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'quota exceeded on node gpu-7', host: 'gpu-7.internal' }), { status: 429 }))
    const api = createMndtApi({
      service: new WorkbenchService({ store: new MemoryStore() }),
      runner: noMissions,
      identity: { tokens: { owner: { user: owner } } },
      grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }] }) },
      machines: { baseUrl: 'http://machines.test', token: 'machine-token' },
    })
    const answer = await api({ method: 'POST', path: '/machines/desktop/act', authorization: 'Bearer owner', body: JSON.stringify({ op: 'screenshot' }) })
    expect(answer.status).toBe(502)
    expect(answer.body).toEqual({ error: 'the machine service could not start the desktop', code: 'machine-start-failed' })
  })
})

describe('a success of the machine service serves its route\'s fields only', () => {
  const machinesApi = () => createMndtApi({
    service: new WorkbenchService({ store: new MemoryStore() }),
    runner: noMissions,
    identity: { tokens: { owner: { user: owner } } },
    grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }] }) },
    machines: { baseUrl: 'http://machines.test', token: 'machine-token' },
  })

  it('a 200 that carries an error is a refusal: « db at » is served nowhere', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'db at 10.0.3.7 down', sessions: [] }), { status: 200 }))
    const answer = await machinesApi()({ method: 'GET', path: '/machines', authorization: 'Bearer owner' })
    expect(answer.body).toEqual({ error: 'the machine service refused the request', code: 'machine-refused' })
    expect(JSON.stringify(answer.body)).not.toContain('db at')
  })

  it('GET /machines serves the sessions\' names and states, never a host or a token', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      sessions: [{ name: 'mndt-browser-1', status: 'Up 3 minutes', host: '10.0.3.9', token: 'agent-token-x' }],
      token: 'service-token', debug: 'node gpu-7',
    }), { status: 200 }))
    const answer = await machinesApi()({ method: 'GET', path: '/machines', authorization: 'Bearer owner' })
    expect(answer.body).toEqual({ sessions: [{ name: 'mndt-browser-1', status: 'Up 3 minutes' }] })
  })

  it('an action serves what the page reads (ok, png, text, url, title), nothing of the agent', async () => {
    vi.stubGlobal('fetch', async (url: string) => (String(url).endsWith('/desktops/start')
      ? new Response(JSON.stringify({ ok: true, host: 'desk-1.internal', token: 'agent-token-y' }), { status: 200 })
      : new Response(JSON.stringify({ ok: true, png: 'iVBOR', title: 'Bureau', token: 'agent-token-y', cwd: '/root' }), { status: 200 })))
    const answer = await machinesApi()({ method: 'POST', path: '/machines/desktop/act', authorization: 'Bearer owner', body: JSON.stringify({ op: 'screenshot' }) })
    expect(answer.body).toEqual({ ok: true, png: 'iVBOR', title: 'Bureau' })
  })
})

describe('the host\'s own refusals that named another', () => {
  it('/state serves nothing of a role table that cannot be read: no write, and its detail in the operator\'s log', async () => {
    const warned: string[] = []
    const api = createMndtApi({
      service: new WorkbenchService({ store: new MemoryStore() }),
      runner: noMissions,
      identity: { tokens: { owner: { user: owner } } },
      grants: { grants: async () => ({ ok: false, reason: 'the role file /state/grants.json, row 3: role « boss » unknown' }) },
      warn: (line) => { warned.push(line) },
    })
    const state = await api({ method: 'GET', path: '/state', authorization: 'Bearer owner' })
    expect(JSON.stringify(state.body)).not.toContain('/state/grants.json')
    expect((state.body as { page: { canWrite: boolean } }).page.canWrite).toBe(false)
    expect(warned.join('\n')).toContain('row 3')
  })

  it('cancelling someone else\'s mission does not name its author', async () => {
    const service = new WorkbenchService({ store: new MemoryStore() })
    const mission = await service.createMission({ kind: 'briefing', prompt: 'Briefing', createdBy: owner })
    await expect(service.cancelMission(mission.id, member, false)).rejects.toThrow(`mission ${mission.id} belongs to someone else`)
  })
})
