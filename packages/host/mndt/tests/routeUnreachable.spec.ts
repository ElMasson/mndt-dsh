/**
 * An agent whose model route could not be reached (routeUnreachable, eighth
 * jump): marked by the host for ten minutes after two consecutive steps that
 * failed for its route (the engine's TRANSPORT, TIMEOUT or SERVER, as
 * RouteUnreachable), whatever role the agent played; one failure alone marks
 * nothing; lifted by its next step that succeeds.
 * Meanwhile it is not proposed as a peer (the prompt's list leaves it out,
 * ask_peers refuses it, saying why), and a mention of it still goes. Served on
 * GET /agents only while it lasts.
 */
import { describe, expect, it } from 'vitest'
import { HelpRefusal, MemoryStore, ROUTE_UNREACHABLE_MS, WorkbenchService } from '../src/core/index.ts'
import type { PriceGrid } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import { RouteUnreachable, TurnScheduler } from '../src/turns.ts'
import type { TurnEngine, TurnInput, TurnOutput } from '../src/turns.ts'

const owner = 'duke@datanalysis.re'
const PRICES: PriceGrid = { 'route-a/*': { input: 1, output: 2 } }

/** An engine whose answer is set per agent: a text, or a failure. */
class Engine implements TurnEngine {
  readonly seen: TurnInput[] = []
  readonly fail = new Map<string, Error>()
  async run(input: TurnInput): Promise<TurnOutput> {
    this.seen.push(input)
    const failure = this.fail.get(input.agent.handle)
    if (failure !== undefined) throw failure
    return { text: `réponse de ${input.agent.handle}`, tokens: { input: 10, output: 1 } }
  }
}

function bench() {
  // The wall clock: GET /agents serves a mark while it lasts by the wall clock.
  let clock = new Date()
  const service = new WorkbenchService({ store: new MemoryStore(), now: () => clock })
  const engine = new Engine()
  const turns = new TurnScheduler({ service, engine, prices: PRICES, dataDir: '/tmp/mndt-route', timeZone: 'Indian/Reunion' })
  const api = createMndtApi({
    service, runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) }, turns,
    identity: { tokens: { owner: { user: owner } } },
    grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }] }) },
  })
  const call = async (method: string, path: string, body?: unknown) =>
    (await api({ method, path, authorization: 'Bearer owner', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).body as Record<string, unknown>
  const agent = async (handle: string, model = 'm') => (await service.createAgent({ handle, name: handle, provider: 'route-a', model, eurPerMonth: 5 }, owner)).id
  const agentOf = async (id: string) => ((await service.snapshot()).agents ?? []).find(candidate => candidate.id === id)
  const served = async (id: string) => ((await call('GET', '/agents')).agents as { id: string; routeUnreachable?: unknown }[]).find(candidate => candidate.id === id)
  const set = (date: Date): void => { clock = date }
  // Two consecutive failures: what marks an agent.
  const mark = async (id: string): Promise<void> => { await service.noteRouteFailure(id); await service.noteRouteFailure(id) }
  const channel = async (agents: string[]) => ((await call('POST', '/channels', { name: 'compta', agents, members: [] })).channel as { id: string })
  const post = async (channelId: string, text: string) => {
    await call('POST', `/channels/${channelId}/messages`, { text })
    await turns.settled()
  }
  return { service, engine, turns, call, agent, agentOf, served, set, mark, channel, post, now: () => clock }
}

describe('an agent whose model route could not be reached', () => {
  it('is marked for ten minutes after two consecutive failed turns (one alone marks nothing), served on GET /agents, and lifted by its next turn that succeeds', async () => {
    const b = bench()
    const qwen = await b.agent('qwen')
    const channel = await b.channel([qwen])
    b.engine.fail.set('qwen', new RouteUnreachable('connect ECONNREFUSED 10.0.0.5:8000'))
    const first = b.now().toISOString()
    await b.post(channel.id, '@qwen bonjour')
    // One failure: a blip, nothing marked, nothing served.
    expect((await b.agentOf(qwen))?.routeUnreachable).toBeUndefined()
    expect((await b.served(qwen))?.routeUnreachable).toBeUndefined()
    expect(JSON.stringify(await b.served(qwen))).not.toContain('routeFailedAt')
    b.set(new Date(b.now().getTime() + 30_000))
    await b.post(channel.id, '@qwen tu es là ?')
    const marked = await b.agentOf(qwen)
    expect(marked?.routeUnreachable).toEqual({ since: first, until: new Date(b.now().getTime() + ROUTE_UNREACHABLE_MS).toISOString() })
    expect((await b.served(qwen))?.routeUnreachable).toEqual(marked?.routeUnreachable)
    // The turn failed with the host's sentence, never the engine's words (the address).
    const failed = (await b.service.messages(channel.id)).flatMap(message => message.turns ?? []).find(turn => turn.agentId === qwen)
    expect(failed?.status).toBe('failed')
    expect(JSON.stringify(failed)).not.toContain('10.0.0.5')
    // A mention still goes, and a turn that reaches the route lifts the mark.
    b.engine.fail.delete('qwen')
    await b.post(channel.id, '@qwen et maintenant ?')
    expect((await b.agentOf(qwen))?.routeUnreachable).toBeUndefined()
    expect((await b.agentOf(qwen))?.routeFailedAt).toBeUndefined()
    expect((await b.served(qwen))?.routeUnreachable).toBeUndefined()
  })

  it('a success between two failures resets the count: failure, success, failure marks nothing', async () => {
    const b = bench()
    const qwen = await b.agent('qwen')
    const channel = await b.channel([qwen])
    b.engine.fail.set('qwen', new RouteUnreachable('connect ETIMEDOUT'))
    await b.post(channel.id, '@qwen un')
    b.engine.fail.delete('qwen')
    await b.post(channel.id, '@qwen deux')
    b.engine.fail.set('qwen', new RouteUnreachable('connect ETIMEDOUT'))
    await b.post(channel.id, '@qwen trois')
    expect((await b.agentOf(qwen))?.routeUnreachable).toBeUndefined()
    expect((await b.agentOf(qwen))?.routeFailedAt).toBeDefined()
  })

  it('a failure that is not the route\'s marks nothing; a mark past its time is not served', async () => {
    const b = bench()
    const qwen = await b.agent('qwen')
    const channel = await b.channel([qwen])
    b.engine.fail.set('qwen', new Error('the agent turn failed: 400 invalid request'))
    await b.post(channel.id, '@qwen bonjour')
    expect((await b.agentOf(qwen))?.routeUnreachable).toBeUndefined()
    expect((await b.agentOf(qwen))?.routeFailedAt).toBeUndefined()
    await b.mark(qwen)
    expect((await b.served(qwen))?.routeUnreachable).toBeDefined()
    // Served by the API only while it lasts (GET /agents reads the wall clock).
    await b.service.clearRouteUnreachable(qwen)
    b.set(new Date(Date.now() - ROUTE_UNREACHABLE_MS - 60_000))
    await b.mark(qwen)
    expect((await b.served(qwen))?.routeUnreachable).toBeUndefined()
  })

  it('a second failure while marked keeps its first moment and pushes its end', async () => {
    const b = bench()
    const qwen = await b.agent('qwen')
    b.set(new Date('2026-11-26T10:00:00.000Z'))
    await b.mark(qwen)
    b.set(new Date('2026-11-26T10:04:00.000Z'))
    await b.service.noteRouteFailure(qwen)
    expect((await b.agentOf(qwen))?.routeUnreachable).toEqual({ since: '2026-11-26T10:00:00.000Z', until: '2026-11-26T10:14:00.000Z' })
  })
})

describe('meanwhile it is not proposed as a peer', () => {
  it('the turn\'s list of the other agents leaves it out, until its mark ends', async () => {
    const b = bench()
    const asker = await b.agent('asker')
    const qwen = await b.agent('qwen')
    const other = await b.agent('other')
    const channel = await b.channel([asker, qwen, other])
    b.set(new Date())
    await b.mark(qwen)
    await b.post(channel.id, '@asker bonjour')
    const peers = (b.engine.seen.at(-1)?.prompt ?? '').split('\n').find(line => line.startsWith('Autres agents de ce canal'))
    expect(peers).toContain('@other')
    expect(peers).not.toContain('@qwen')
  })

  it('ask_peers refuses it, saying why and naming it; once its mark ends, it can be asked', async () => {
    const b = bench()
    const asker = await b.agent('asker')
    const qwen = await b.agent('qwen')
    const channel = await b.channel([asker, qwen])
    const message = await b.service.postMessage(channel.id, owner, '@asker bonjour')
    const turn = message.turns?.[0]
    await b.service.updateTurn(message.id, turn?.id ?? '', { status: 'running' })
    await b.mark(qwen)
    const request = { task: 't', tried: 't', blocker: 'b', options: ['a'], need: 'fact' as const }
    const refused = await b.service.askPeers(message.id, turn?.id ?? '', asker, request, [qwen]).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(HelpRefusal)
    expect((refused as HelpRefusal).code).toBe('peer-unreachable')
    expect((refused as HelpRefusal).message).toContain('route du modèle injoignable pour @qwen')
    b.set(new Date(b.now().getTime() + ROUTE_UNREACHABLE_MS + 1000))
    const help = await b.service.askPeers(message.id, turn?.id ?? '', asker, request, [qwen])
    expect(help.peerIds).toEqual([qwen])
  })

  it('a peer whose advice could not reach its route is marked too: the role does not matter', async () => {
    const b = bench()
    const qwen = await b.agent('qwen')
    // The verifier runs another model than the author.
    const verifier = await b.agent('verif', 'm2')
    const channel = await b.channel([qwen, verifier])
    await b.service.setCoordination(channel.id, { mode: 'author-verifier', authorId: qwen, verifierId: verifier }, owner)
    b.engine.fail.set('verif', new RouteUnreachable('connect ETIMEDOUT'))
    await b.post(channel.id, '@qwen rédige')
    await b.post(channel.id, '@qwen rédige encore')
    expect((await b.agentOf(verifier))?.routeUnreachable).toBeDefined()
    expect((await b.agentOf(qwen))?.routeUnreachable).toBeUndefined()
  })
})
