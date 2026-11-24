import { describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import type { Message, PriceGrid } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import { TurnScheduler } from '../src/turns.ts'
import type { TurnEngine, TurnInput, TurnOutput } from '../src/turns.ts'

const owner = 'duke@datanalysis.re'
const PRICES: PriceGrid = { 'route-a/*': { input: 1, output: 2 } }

/** An engine whose first turn's servers are slow to be ready, until released (or stopped). */
class Engine implements TurnEngine {
  readonly ran: string[] = []
  readonly runs: string[] = []
  readonly asked: (readonly string[])[] = []
  #release = (): void => undefined
  readonly #first = new Promise<void>((resolve) => { this.#release = resolve })
  #calls = 0
  release(): void { this.#release() }
  async ready(servers: readonly string[], signal: AbortSignal): Promise<void> {
    this.asked.push(servers)
    if (this.#calls++ > 0) return
    await new Promise<void>((resolve) => {
      void this.#first.then(resolve)
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
  }
  async run(input: TurnInput): Promise<TurnOutput> {
    this.ran.push(input.channel.name)
    this.runs.push(input.turnId)
    return { text: `réponse dans ${input.channel.name}`, tokens: { input: 10, output: 1 } }
  }
}

function bench() {
  const service = new WorkbenchService({ store: new MemoryStore() })
  const engine = new Engine()
  const turns = new TurnScheduler({ service, engine, prices: PRICES, dataDir: '/data/mndt' })
  const api = createMndtApi({
    service, runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) }, turns,
    identity: { tokens: { owner: { user: owner } } },
    grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }] }) },
  })
  const call = async (method: string, path: string, body?: unknown) => {
    const answer = await api({ method, path, authorization: 'Bearer owner', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: answer.status, body: answer.body as Record<string, unknown> }
  }
  return { service, engine, turns, call }
}

async function channelWithAgent(b: ReturnType<typeof bench>, name: string): Promise<string> {
  const agent = ((await b.call('POST', '/agents', { handle: `a-${name}`, name, provider: 'route-a', model: 'm', eurPerMonth: 5 })).body.agent as { id: string }).id
  return ((await b.call('POST', '/channels', { name, agents: [agent], members: [] })).body.channel as { id: string }).id
}

const until = async (check: () => Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 200 && !(await check()); i++) await new Promise(resolve => setTimeout(resolve, 5))
}

describe('a turn waits for its servers before the queue, not in it', () => {
  it('a turn whose servers are slow stays queued, and does not hold another channel\'s turn', async () => {
    const b = bench()
    const compta = await channelWithAgent(b, 'compta')
    const ventes = await channelWithAgent(b, 'ventes')
    const slow = (await b.call('POST', `/channels/${compta}/messages`, { text: '@a-compta bonjour' })).body.message as Message
    await b.call('POST', `/channels/${ventes}/messages`, { text: '@a-ventes bonjour' })
    await until(async () => b.engine.ran.includes('ventes'))
    expect(b.engine.ran).toEqual(['ventes'])
    expect((await b.service.message(slow.id))?.turns?.[0]?.status).toBe('queued')
    expect(b.engine.asked[0]).toEqual([])
    b.engine.release()
    await b.turns.settled()
    expect(b.engine.ran).toEqual(['ventes', 'compta'])
    expect((await b.service.message(slow.id))?.turns?.[0]?.status).toBe('done')
  })

  it('two messages of one channel keep their order when the first waits; the other channels go on', async () => {
    const b = bench()
    const compta = await channelWithAgent(b, 'compta')
    const ventes = await channelWithAgent(b, 'ventes')
    const first = (await b.call('POST', `/channels/${compta}/messages`, { text: '@a-compta un' })).body.message as Message
    const second = (await b.call('POST', `/channels/${compta}/messages`, { text: '@a-compta deux' })).body.message as Message
    await b.call('POST', `/channels/${ventes}/messages`, { text: '@a-ventes trois' })
    await until(async () => b.engine.ran.includes('ventes'))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(b.engine.ran).toEqual(['ventes'])
    expect((await b.service.message(second.id))?.turns?.[0]?.status).toBe('queued')
    b.engine.release()
    await b.turns.settled()
    expect(b.engine.runs.slice(1)).toEqual([first.turns![0]!.id, second.turns![0]!.id])
  })

  it('a turn stop() was called for never starts, even if the state shows no cause', async () => {
    const b = bench()
    const compta = await channelWithAgent(b, 'compta')
    const posted = (await b.call('POST', `/channels/${compta}/messages`, { text: '@a-compta bonjour' })).body.message as Message
    await until(async () => b.engine.asked.length > 0)
    b.turns.stop({ messageId: posted.id })
    await b.turns.settled()
    expect(b.engine.ran).toEqual([])
    const turn = (await b.service.message(posted.id))?.turns?.[0]
    expect([turn?.status, turn?.reason]).toEqual(['cancelled', 'Tour arrêté avant son départ.'])
  })

  it('a message deleted while its turn waits: the wait ends at once, and the turn never starts', async () => {
    const b = bench()
    const compta = await channelWithAgent(b, 'compta')
    const posted = (await b.call('POST', `/channels/${compta}/messages`, { text: '@a-compta bonjour' })).body.message as Message
    await until(async () => b.engine.asked.length > 0)
    expect((await b.call('POST', `/channels/${compta}/messages/${posted.id}/delete`)).status).toBe(200)
    await b.turns.settled()
    expect(b.engine.ran).toEqual([])
    expect((await b.service.message(posted.id))?.turns?.[0]?.status).toBe('cancelled')
  })
})
