import { describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import type { PriceGrid } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import type { MndtApi } from '../src/api.ts'
import { TurnScheduler } from '../src/turns.ts'
import type { TurnEngine, TurnInput, TurnOutput } from '../src/turns.ts'
import { createHttpChat } from '../../../client/ui-mndt/src/client/httpChat.ts'
import type { ChatFace } from '../../../client/ui-mndt/src/client/chat.ts'

/**
 * Lane B's screen client against the real API handler, in memory: what the
 * page sends is what the Host serves, call by call, with no mock in between.
 */

const owner = 'duke@datanalysis.re'
const viewer = 'contact@datanalysis.re'
const PRICES: PriceGrid = { 'scaleway-genapi/deepseek-v4.1-flash': { input: 0.6, output: 1.8 } }

/** An engine that answers at once. */
class Engine implements TurnEngine {
  async run(input: TurnInput): Promise<TurnOutput> {
    return { text: `réponse de @${input.agent.handle}`, sessionId: `ses-${input.turnId}`, tokens: { input: 1000, output: 100 } }
  }
}

/**
 * The browser's fetch, as the gateway would carry it: /mndt-api stripped, the
 * proven identity set, the query and the body passed through.
 * @param api - the handler.
 * @param token - who calls.
 * @returns a fetch for createHttpChat.
 */
function fetchThrough(api: MndtApi, token: string) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    expect(input.startsWith('/mndt-api/')).toBe(true)
    const url = new URL(input.slice('/mndt-api'.length), 'http://gateway')
    const answer = await api({
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      authorization: `Bearer ${token}`,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    })
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } })
  }
}

function bench(): { chat: ChatFace; asViewer: ChatFace; turns: TurnScheduler; service: WorkbenchService } {
  const service = new WorkbenchService({ store: new MemoryStore() })
  const turns = new TurnScheduler({ service, engine: new Engine(), prices: PRICES, dataDir: '/data/mndt' })
  const api = createMndtApi({
    service,
    runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
    turns,
    identity: { tokens: { 'tok-owner': { user: owner }, 'tok-viewer': { user: viewer } } },
    grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }, { subject: viewer, role: 'viewer' }] }) },
  })
  return { chat: createHttpChat(fetchThrough(api, 'tok-owner')), asViewer: createHttpChat(fetchThrough(api, 'tok-viewer')), turns, service }
}

describe('the screen client against the real routes', () => {
  it('walks the lot 1 path: lane, channel from its title, agent, mention, answer, poll', async () => {
    const { chat, turns, service } = bench()
    const [lane] = await chat.channels()
    expect(lane?.kind).toBe('solo')
    const created = await chat.createChannel({ title: 'Compta Orange' })
    expect(created.name).toBe('compta-orange')
    const agent = await service.createAgent({ handle: 'assistant', name: 'Assistant', provider: 'scaleway-genapi', model: 'deepseek-v4.1-flash' }, owner)
    const withAgent = await chat.addAgents(created.id, [agent.id])
    expect(withAgent.agents).toEqual([agent.id])
    const first = await chat.messages(created.id)
    expect(first.messages).toEqual([])
    const asked = await chat.post(created.id, '@assistant bonjour')
    expect(asked.turns?.[0]?.status).toBe('queued')
    await turns.settled()
    const changes = await chat.changes(created.id, first.cursor)
    expect(changes.messages.find(m => m.id === asked.id)?.turns?.[0]?.status).toBe('done')
    expect(changes.messages.find(m => m.replyTo === asked.id)?.author).toEqual({ kind: 'agent', agentId: agent.id })
    const nothing = await chat.changes(created.id, new Date(Date.parse(changes.cursor) + 1).toISOString())
    expect(nothing.messages).toEqual([])
    const [listed] = await chat.agents()
    expect(listed?.eurThisMonth).toBeGreaterThan(0)
    const removed = await chat.remove(created.id, asked.id)
    expect(removed.deletedAt).toBeDefined()
  })

  it('surfaces each refusal with the Host reason, never as an empty answer', async () => {
    const { chat, asViewer } = bench()
    const created = await chat.createChannel({ title: 'Privé' })
    await expect(asViewer.messages(created.id)).rejects.toThrow(/no channel/) // not a member: 404
    await expect(asViewer.createChannel({ title: 'Autre' })).rejects.toThrow(/viewer and does not hold workflows.write/)
    await expect(chat.post(created.id, '   ')).rejects.toThrow(/needs text/)
  })
})
