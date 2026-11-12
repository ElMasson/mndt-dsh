import { describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import type { Message, PriceGrid } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import type { MissionRunner } from '../src/api.ts'
import { TurnScheduler } from '../src/turns.ts'
import type { TurnEngine, TurnInput, TurnOutput } from '../src/turns.ts'
import { mcpServerOf } from '../src/runner.ts'
import { eurOf, parsePrices, priceOf } from '../src/core/index.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const owner = 'duke@datanalysis.re'
const admin = 'smarion@datanalysis.re'
const viewer = 'contact@datanalysis.re'
const asOwner = { authorization: 'Bearer tok-owner' }
const asAdmin = { authorization: 'Bearer tok-admin' }
const asViewer = { authorization: 'Bearer tok-viewer' }

const PRICES: PriceGrid = {
  'scaleway-genapi/deepseek-v4.1-flash': { input: 100, output: 100 },
  'scaleway-genapi/glm-5.3': null, // to be provided: refused, never free
  'vllm-qwen/*': { input: 0, output: 0 },
}

/** An engine that records what each turn was given and answers at once, or when released. */
class FakeEngine implements TurnEngine {
  readonly seen: TurnInput[] = []
  tokens: TurnOutput['tokens'] = { input: 100, output: 0 }
  hold: Promise<void> | undefined
  honourAbort = true
  async run(input: TurnInput): Promise<TurnOutput> {
    this.seen.push(input)
    if (this.hold !== undefined) await this.hold
    if (this.honourAbort && input.signal.aborted) throw new Error('aborted')
    return {
      text: `réponse de @${input.agent.handle}`,
      sessionId: `ses-${input.turnId}`,
      ...(this.tokens === undefined ? {} : { tokens: this.tokens }),
    }
  }
}

const noMissions: MissionRunner = {
  run: async () => ({ title: 't', markdown: 'm', sources: [] }),
}

/** An API with a real service in memory, a fake engine and three people. */
function bench(prices: PriceGrid = PRICES) {
  const service = new WorkbenchService({ store: new MemoryStore() })
  const engine = new FakeEngine()
  const turns = new TurnScheduler({
    service,
    engine,
    prices,
    dataDir: '/data/mndt',
  })
  const api = createMndtApi({
    service,
    runner: noMissions,
    turns,
    identity: {
      tokens: {
        'tok-owner': { user: owner },
        'tok-admin': { user: admin },
        'tok-viewer': { user: viewer },
      },
    },
    grants: {
      grants: async () => ({
        ok: true,
        grants: [
          { subject: owner, role: 'owner' },
          { subject: admin, role: 'admin' },
          { subject: viewer, role: 'viewer' },
        ],
      }),
    },
    connectors: async () =>
      ['office365', 'qonto', 'dolibarr', 'swing'].map(server => ({
        module: `mcp-${server}`,
        server,
        enabled: true,
      })),
  })
  const call = async (
    method: string,
    path: string,
    who: { authorization: string },
    body?: unknown,
  ) =>
    api({
      method,
      path,
      ...who,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return { api, service, engine, turns, call }
}

type Bench = ReturnType<typeof bench>

async function agent(
  b: Bench,
  handle: string,
  model = 'deepseek-v4.1-flash',
  provider = 'scaleway-genapi',
  connectors = ['office365', 'qonto', 'dolibarr'],
) {
  const created = await b.call('POST', '/agents', asOwner, {
    handle,
    name: handle,
    provider,
    model,
    connectors,
  })
  expect(created.status).toBe(201)
  return (created.body as { agent: { id: string } }).agent.id
}

async function channel(
  b: Bench,
  name: string,
  agents: string[],
  connectors: string[],
  members: string[] = [admin],
) {
  const created = await b.call('POST', '/channels', asOwner, {
    name,
    agents,
    connectors,
    members,
  })
  expect(created.status).toBe(201)
  return (created.body as { channel: { id: string } }).channel.id
}

async function say(b: Bench, channelId: string, text: string, who = asOwner) {
  const posted = await b.call('POST', `/channels/${channelId}/messages`, who, {
    text,
  })
  expect(posted.status).toBe(201)
  return (posted.body as { message: Message }).message
}

async function thread(b: Bench, channelId: string): Promise<Message[]> {
  const listed = await b.call(
    'GET',
    `/channels/${channelId}/messages`,
    asOwner,
  )
  return (listed.body as { messages: Message[] }).messages
}

describe('channels, mentions and agent turns', () => {
  it('a turn never sees another channel: its text, its folder or its connectors', async () => {
    const b = bench()
    const assistant = await agent(b, 'assistant')
    const compta = await channel(
      b,
      'compta',
      [assistant],
      ['qonto', 'dolibarr'],
    )
    const ventes = await channel(b, 'ventes', [assistant], ['office365'])
    await say(b, compta, 'Le solde secret est SECRET-COMPTA-42.')
    await say(b, ventes, 'Le client secret est SECRET-VENTES-7.')
    await say(b, ventes, '@assistant résume ce canal')
    await say(b, compta, '@assistant résume ce canal')
    await b.turns.settled()
    const [inVentes, inCompta] = b.engine.seen
    expect(inVentes?.prompt).toContain('SECRET-VENTES-7')
    expect(inVentes?.prompt).not.toContain('SECRET-COMPTA-42')
    expect(inVentes?.cwd).toContain(ventes)
    expect(inVentes?.cwd).not.toContain(compta)
    expect(inVentes?.servers).toEqual(['office365'])
    expect(inCompta?.prompt).toContain('SECRET-COMPTA-42')
    expect(inCompta?.prompt).not.toContain('SECRET-VENTES-7')
    expect(inCompta?.cwd).toContain(compta)
    expect(inCompta?.servers).toEqual(['dolibarr', 'qonto'])
  })

  it('a turn runs on the agent model, never the default one, and answers in the thread', async () => {
    const b = bench()
    const qwen = await agent(b, 'qwen', 'qwen3.5', 'vllm-qwen', [])
    const docs = await channel(b, 'docs', [qwen], [])
    const asked = await say(b, docs, '@qwen bonjour')
    expect(asked.turns?.map(t => t.status)).toEqual(['queued'])
    await b.turns.settled()
    expect(b.engine.seen[0]?.agent).toMatchObject({
      provider: 'vllm-qwen',
      model: 'qwen3.5',
    })
    const messages = await thread(b, docs)
    const answer = messages.find(m => m.replyTo === asked.id)
    expect(answer?.author).toEqual({ kind: 'agent', agentId: qwen })
    const turn = messages.find(m => m.id === asked.id)?.turns?.[0]
    expect(turn).toMatchObject({ status: 'done', eur: 0 })
    expect(typeof turn?.sessionId).toBe('string')
  })

  it('the monthly ceiling refuses a turn before any call to the model', async () => {
    const b = bench()
    const assistant = await agent(b, 'assistant')
    const general = await channel(b, 'general', [assistant], [])
    b.engine.tokens = { input: 49_900, output: 0 } // 4.99 euros at 100 per million
    await say(b, general, '@assistant un')
    await b.turns.settled()
    b.engine.tokens = { input: 100, output: 0 } // 0.01: the month reaches 5.00
    await say(b, general, '@assistant deux')
    await b.turns.settled()
    expect(b.engine.seen).toHaveLength(2)
    const refused = await say(b, general, '@assistant trois')
    await b.turns.settled()
    expect(b.engine.seen).toHaveLength(2) // never called
    const messages = await thread(b, general)
    expect(messages.find(m => m.id === refused.id)?.turns?.[0]?.status).toBe(
      'refused',
    )
    expect(messages.find(m => m.replyTo === refused.id)).toMatchObject({
      author: { kind: 'system' },
    })
    expect(messages.find(m => m.replyTo === refused.id)?.text).toContain(
      'Plafond mensuel atteint',
    )
    const listed = await b.call('GET', '/agents', asViewer)
    expect(
      (listed.body as { agents: { eurThisMonth: number }[] }).agents[0]
        ?.eurThisMonth,
    ).toBe(5)
  })

  it('a model priced 0 is never refused, a model without a price always is', async () => {
    const b = bench()
    const qwen = await agent(b, 'qwen', 'qwen3.5', 'vllm-qwen', [])
    const glm = await agent(b, 'analyste', 'glm-5.3', 'scaleway-genapi', [])
    const general = await channel(b, 'general', [qwen, glm], [])
    b.engine.tokens = { input: 10_000_000, output: 10_000_000 }
    for (let i = 0; i < 3; i += 1) await say(b, general, `@qwen tour ${i}`)
    const priceless = await say(b, general, '@analyste combien ?')
    await b.turns.settled()
    expect(b.engine.seen.map(s => s.agent.handle)).toEqual([
      'qwen',
      'qwen',
      'qwen',
    ])
    const messages = await thread(b, general)
    expect(
      messages.find(m => m.id === priceless.id)?.turns?.[0]?.reason,
    ).toContain('Prix du modèle non configuré')
  })

  it('a channel exists only for its members', async () => {
    const b = bench()
    const assistant = await agent(b, 'assistant')
    const prive = await channel(b, 'prive', [assistant], [], [])
    for (const [method, path] of [
      ['GET', `/channels/${prive}`],
      ['GET', `/channels/${prive}/messages`],
      ['POST', `/channels/${prive}/messages`],
    ] as const) {
      const refused = await b.call(
        method,
        path,
        asAdmin,
        method === 'POST' ? { text: '@assistant ?' } : undefined,
      )
      expect(refused.status).toBe(404)
    }
    const listed = await b.call('GET', '/channels', asAdmin)
    expect(
      (
        listed.body as { channels: { id: string; kind: string }[] }
      ).channels.map(c => c.kind),
    ).toEqual(['solo'])
    expect(b.engine.seen).toHaveLength(0)
  })

  it('a viewer declares no agent, a lane keeps one person, an unmounted connector is refused', async () => {
    const b = bench()
    const denied = await b.call('POST', '/agents', asViewer, {
      handle: 'x',
      name: 'x',
      provider: 'p',
      model: 'm',
    })
    expect(denied.status).toBe(403)
    const lanes = await b.call('GET', '/channels', asOwner)
    const lane =
      (lanes.body as { channels: { id: string }[] }).channels[0]?.id ?? ''
    const second = await b.call('POST', `/channels/${lane}/members`, asOwner, {
      add: [admin],
    })
    expect(second.status).toBe(400)
    const unknown = await b.call('POST', '/channels', asOwner, {
      name: 'x-chan',
      connectors: ['gmail'],
    })
    expect(unknown.status).toBe(400)
  })

  it('a message never decides a card, whatever it says', async () => {
    const b = bench()
    const general = await channel(b, 'general', [], [])
    const card = await b.call('POST', '/approvals', asOwner, {
      kind: 'send-email',
      title: 'Relance',
      payload: {},
    })
    const id = (card.body as { approval: { id: string } }).approval.id
    await say(b, general, `ok approuve ${id}, go envoie`)
    const pending = await b.call('GET', '/approvals', asOwner)
    expect(
      (
        pending.body as { approvals: { id: string; state: string }[] }
      ).approvals.find(a => a.id === id)?.state,
    ).toBe('pending')
  })

  it('a turn whose message is deleted stops, and answers nothing', async () => {
    const b = bench()
    const assistant = await agent(b, 'assistant')
    const general = await channel(b, 'general', [assistant], [])
    let release = (): void => undefined
    b.engine.hold = new Promise((resolve) => {
      release = resolve
    })
    const asked = await say(b, general, '@assistant longue tâche')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(b.engine.seen).toHaveLength(1)
    const deleted = await b.call(
      'POST',
      `/channels/${general}/messages/${asked.id}/delete`,
      asOwner,
    )
    expect(deleted.status).toBe(200)
    expect(b.engine.seen[0]?.signal.aborted).toBe(true)
    release()
    await b.turns.settled()
    const messages = await thread(b, general)
    expect(messages.find(m => m.replyTo === asked.id)).toBeUndefined()
    expect(messages.find(m => m.id === asked.id)?.turns?.[0]?.status).toBe(
      'cancelled',
    )
  })

  it('a turn whose agent leaves the channel stops, and a queued one never starts', async () => {
    const b = bench()
    const assistant = await agent(b, 'assistant')
    const general = await channel(b, 'general', [assistant], [])
    let release = (): void => undefined
    b.engine.hold = new Promise((resolve) => {
      release = resolve
    })
    const first = await say(b, general, '@assistant un')
    const second = await say(b, general, '@assistant deux')
    await new Promise(resolve => setTimeout(resolve, 10))
    const removed = await b.call(
      'POST',
      `/channels/${general}/agents`,
      asOwner,
      { remove: [assistant] },
    )
    expect(removed.status).toBe(200)
    release()
    await b.turns.settled()
    expect(b.engine.seen).toHaveLength(1) // the queued turn never started
    const messages = await thread(b, general)
    for (const asked of [first, second]) {
      expect(messages.find(m => m.id === asked.id)?.turns?.[0]?.status).toBe(
        'cancelled',
      )
      expect(messages.find(m => m.replyTo === asked.id)).toBeUndefined()
    }
  })


  it('an answer that comes back after its agent left is never written', async () => {
    const b = bench()
    const assistant = await agent(b, 'assistant')
    const general = await channel(b, 'general', [assistant], [])
    let release = (): void => undefined
    b.engine.hold = new Promise((resolve) => {
      release = resolve
    })
    b.engine.honourAbort = false // an engine that answers even once stopped
    const asked = await say(b, general, '@assistant un')
    await new Promise(resolve => setTimeout(resolve, 10))
    const removed = await b.call('POST', `/channels/${general}/agents`, asOwner, { remove: [assistant] })
    expect(removed.status).toBe(200)
    release()
    await b.turns.settled()
    const messages = await thread(b, general)
    expect(messages.find(m => m.replyTo === asked.id)).toBeUndefined()
    expect(messages.find(m => m.id === asked.id)?.turns?.[0]?.status).toBe('cancelled')
  })

  it('a card asked during a turn is filed in that turn thread', async () => {
    const b = bench()
    const assistant = await agent(b, 'assistant')
    const general = await channel(b, 'general', [assistant], [])
    let release = (): void => undefined
    b.engine.hold = new Promise((resolve) => {
      release = resolve
    })
    const asked = await say(b, general, '@assistant prépare la relance')
    await new Promise(resolve => setTimeout(resolve, 10))
    const turnId = b.engine.seen[0]?.turnId ?? ''
    const card = await b.api({
      method: 'POST',
      path: '/approvals',
      ...asOwner,
      headers: { 'x-mndt-run': turnId },
      body: JSON.stringify({
        kind: 'send-email',
        title: 'Relance',
        payload: {},
      }),
    })
    expect((card.body as { approval: object }).approval).toMatchObject({
      channelId: general,
      messageId: asked.id,
    })
    release()
    await b.turns.settled()
  })


  it('one poll with since returns the new messages and those whose turn moved on', async () => {
    const b = bench()
    const assistant = await agent(b, 'assistant')
    const general = await channel(b, 'general', [assistant], [])
    const since = new Date(Date.now() - 1000).toISOString()
    const asked = await say(b, general, '@assistant bonjour')
    await b.turns.settled()
    const polled = await b.api({ method: 'GET', path: `/channels/${general}/messages`, query: { since: since }, ...asOwner })
    expect(polled.status).toBe(200)
    const body = polled.body as { messages: Message[]; cursor: string }
    const origin = body.messages.find(m => m.id === asked.id)
    expect(origin?.turns?.[0]?.status).toBe('done') // the turn moved on: the origin comes back
    expect(origin?.updatedAt).toBeDefined()
    expect(body.messages.some(m => m.replyTo === asked.id)).toBe(true)
    expect(body.cursor >= since).toBe(true)
    const later = await b.api({ method: 'GET', path: `/channels/${general}/messages`, query: { since: new Date(Date.now() + 60_000).toISOString() }, ...asOwner })
    expect((later.body as { messages: Message[] }).messages).toEqual([])
    const bad = await b.api({ method: 'GET', path: `/channels/${general}/messages`, query: { since: 'hier' }, ...asOwner })
    expect(bad.status).toBe(400)
  })


  it('reads the price grid of the adapters lane: exact keys, route wildcards and null', () => {
    // The content of deploy/llm/prices.json (lane C, 05f63ce120), verbatim but for its comment.
    const grid = parsePrices(JSON.stringify({
      version: 'scaleway-2026-11',
      currency: 'EUR',
      unit: 'per_million_tokens',
      models: {
        'scaleway-genapi/deepseek-v4.1-flash': { input: 0.60, cacheRead: 0.12, output: 1.80 },
        'scaleway-genapi/glm-5.3': null,
        'vllm-qwen/*': { input: 0, cacheRead: 0, output: 0 },
      },
    }))
    expect(priceOf(grid, { provider: 'scaleway-genapi', model: 'deepseek-v4.1-flash' })?.output).toBe(1.8)
    expect(priceOf(grid, { provider: 'vllm-qwen', model: 'Qwen/Qwen3.5-35B-A3B' })?.input).toBe(0)
    expect(priceOf(grid, { provider: 'scaleway-genapi', model: 'glm-5.3' })).toBeUndefined()
    expect(priceOf(grid, { provider: 'scaleway-genapi', model: 'another' })).toBeUndefined()
    expect(() => parsePrices('{"models": {"x/y": {"input": -1, "output": 0}}}')).toThrow()
    expect(parsePrices(undefined)).toEqual({})
  })


  it('a channel is created from its title alone; its name is derived and kept free', async () => {
    const b = bench()
    const created = async (body: object) => b.call('POST', '/channels', asOwner, body)
    const first = await created({ title: 'Compta Orange — Été 2026' })
    expect(first.status).toBe(201)
    expect((first.body as { channel: { name: string; title: string } }).channel).toMatchObject({ name: 'compta-orange-ete-2026', title: 'Compta Orange — Été 2026' })
    const again = await created({ title: 'Compta  Orange, été 2026 !' })
    expect((again.body as { channel: { name: string } }).channel.name).toBe('compta-orange-ete-2026-2')
    const odd = await created({ title: '!!!' })
    expect((odd.body as { channel: { name: string } }).channel.name).toBe('canal')
    expect((await created({ name: 'compta-orange-ete-2026' })).status).toBe(409) // a chosen name stays the person's
    expect((await created({})).status).toBe(400)
  })


  it('the first page carries the cursor of the next poll: the channel last change', async () => {
    const b = bench()
    const general = await channel(b, 'general', [], [])
    const empty = await b.call('GET', `/channels/${general}/messages`, asOwner)
    expect((empty.body as { cursor: string }).cursor).toBe(new Date(0).toISOString())
    await say(b, general, 'un')
    const second = await say(b, general, 'deux')
    const page = await b.api({ method: 'GET', path: `/channels/${general}/messages`, query: { limit: '1' }, ...asOwner })
    expect((page.body as { messages: Message[]; cursor: string }).cursor).toBe(second.updatedAt)
  })

  it('the deployed grid prices every lot 1 model, so no agent turn is refused for a missing price', () => {
    const grid = parsePrices(readFileSync(join(import.meta.dirname, '..', 'deploy', 'llm', 'prices.json'), 'utf8'))
    for (const model of ['deepseek-v4.1-flash', 'glm-5.3']) {
      expect(priceOf(grid, { provider: 'scaleway-genapi', model })).toBeDefined()
    }
    expect(priceOf(grid, { provider: 'vllm-qwen', model: 'qwen3.5-35b-a3b' })?.output).toBe(0)
    // Qwen is the H100's only: an API Qwen has no price, so its turn would be refused, never run.
    expect(priceOf(grid, { provider: 'scaleway-genapi', model: 'qwen3.8-27b' })).toBeUndefined()
    // 1M tokens in and 1M out on glm-5.3: 1.80 + 5.50 euros.
    expect(eurOf({ input: 1_000_000, output: 1_000_000 }, priceOf(grid, { provider: 'scaleway-genapi', model: 'glm-5.3' })!)).toBe(7.3)
  })

  it('names the MCP server of a tool', () => {
    expect(mcpServerOf('mcp__qonto__list_transactions')).toBe('qonto')
    expect(mcpServerOf('read_file')).toBeUndefined()
  })
})
