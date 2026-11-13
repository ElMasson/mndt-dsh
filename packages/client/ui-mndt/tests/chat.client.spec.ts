import { describe, expect, it } from 'vitest'
import { completeMention, mentionAt, mentionChoices } from '../src/client/mention.ts'
import { authorName, mergeThread, personName, settledTurns } from '../src/client/thread.ts'
import { createHttpChat } from '../src/client/httpChat.ts'
import { createMockChat } from '../src/client/mockChat.ts'
import { ChatRefusal } from '../src/client/chat.ts'
import type { ChatAgent, ChatChannel, ChatMessage } from '../src/client/chat.ts'
import { reasonOf } from '../src/client/ChannelView.tsx'
import { chatFr } from '../src/client/chatLocales.ts'
import type { ChatKey } from '../src/client/chatLocales.ts'

/** @param key - the message. @returns its French copy, as the page shows it. */
const chatFrench = (key: ChatKey): string => chatFr[key]

const AT = '2026-11-12T09:00:00.000Z'

/** @param over - fields to change. @returns one declared agent. */
function agent(over: Partial<ChatAgent> = {}): ChatAgent {
  return {
    id: 'agt_1', handle: 'assistant', name: 'Assistant', provider: 'scaleway-genapi', model: 'glm-5.3',
    connectors: [], eurPerMonth: 5, createdBy: 'a@datanalysis.re', createdAt: AT, ...over,
  }
}

/** @param over - fields to change. @returns one channel. */
function channel(over: Partial<ChatChannel> = {}): ChatChannel {
  return {
    id: 'chn_1', name: 'compta', title: 'Compta', kind: 'team', members: ['me@datanalysis.re'],
    agents: ['agt_1'], connectors: [], createdBy: 'me@datanalysis.re', createdAt: AT, ...over,
  }
}

/** @param over - fields to change. @returns one message. */
function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg_1', channelId: 'chn_1', author: { kind: 'human', email: 'me@datanalysis.re' }, text: 'bonjour',
    mentions: [], createdAt: AT, updatedAt: AT, ...over,
  }
}

describe('@ completion: the handles of this channel\'s agents', () => {
  const agents = [
    agent(),
    agent({ id: 'agt_2', handle: 'analyste', name: 'Analyste' }),
    agent({ id: 'agt_3', handle: 'archiviste', name: 'Archiviste', retiredAt: AT }),
    agent({ id: 'agt_4', handle: 'ailleurs', name: 'Ailleurs' }),
  ]

  it('finds the @word the caret is in, at the start or after a space only', () => {
    expect(mentionAt('@as', 3)).toEqual({ start: 0, prefix: 'as' })
    expect(mentionAt('bonjour @an', 11)).toEqual({ start: 8, prefix: 'an' })
    expect(mentionAt('bonjour @', 9)).toEqual({ start: 8, prefix: '' })
    expect(mentionAt('mail@datanalysis', 16)).toBeNull()
    expect(mentionAt('bonjour', 7)).toBeNull()
  })

  it('offers only this channel\'s agents, not retired, by handle or name', () => {
    const offered = mentionChoices({ start: 0, prefix: 'a' }, ['agt_1', 'agt_2', 'agt_3'], agents)
    expect(offered.map(a => a.handle)).toEqual(['analyste', 'assistant'])
    expect(mentionChoices({ start: 0, prefix: 'ANA' }, ['agt_1', 'agt_2'], agents).map(a => a.handle)).toEqual(['analyste'])
  })

  it('writes the chosen handle in place of the word, with one space after', () => {
    const q = mentionAt('voir @as la facture', 8)!
    expect(completeMention('voir @as la facture', q, 8, 'assistant')).toEqual({ text: 'voir @assistant la facture', caret: 16 })
    const end = mentionAt('@a', 2)!
    expect(completeMention('@a', end, 2, 'analyste')).toEqual({ text: '@analyste ', caret: 10 })
  })
})

describe('the thread: what the Host served, merged', () => {
  it('keeps the last copy of each message and orders by creation', () => {
    const first = message({ id: 'msg_1', turns: [{ id: 'trn_1', agentId: 'agt_1', status: 'queued' }] })
    const later = message({ id: 'msg_2', createdAt: '2026-11-12T09:01:00.000Z', updatedAt: '2026-11-12T09:01:00.000Z' })
    const moved = message({ id: 'msg_1', updatedAt: '2026-11-12T09:02:00.000Z', turns: [{ id: 'trn_1', agentId: 'agt_1', status: 'done' }] })
    const merged = mergeThread([first, later], [moved])
    expect(merged.map(m => m.id)).toEqual(['msg_1', 'msg_2'])
    expect(merged[0]!.turns![0]!.status).toBe('done')
    // An older copy served again never replaces a newer one.
    expect(mergeThread(merged, [first])[0]!.turns![0]!.status).toBe('done')
  })

  it('counts the turns a page brings to an end, once each', () => {
    const queued = message({ turns: [{ id: 'trn_1', agentId: 'agt_1', status: 'queued' }] })
    const done = message({ updatedAt: '2026-11-12T09:02:00.000Z', turns: [{ id: 'trn_1', agentId: 'agt_1', status: 'done' }] })
    const running = message({ turns: [{ id: 'trn_1', agentId: 'agt_1', status: 'running' }] })
    expect(settledTurns([queued], [running])).toBe(0)
    expect(settledTurns([queued], [done])).toBe(1)
    // The cursor is inclusive: the same closed turn served again does not end twice.
    expect(settledTurns([done], [done])).toBe(0)
    // A turn first seen closed has ended for this reader too.
    expect(settledTurns([], [message({ turns: [{ id: 'trn_2', agentId: 'agt_1', status: 'refused' }] })])).toBe(1)
  })

  it('names a person by the part before the @, an agent by its handle, the system by nothing', () => {
    expect(personName('smasson@datanalysis.re')).toBe('smasson')
    const byId = new Map([['agt_1', agent()]])
    expect(authorName(message(), byId)).toBe('me')
    expect(authorName(message({ author: { kind: 'agent', agentId: 'agt_1' } }), byId)).toBe('@assistant')
    expect(authorName(message({ author: { kind: 'system' } }), byId)).toBeNull()
  })
})

describe('the HTTP face: the lot 1 routes', () => {
  /** @returns a fetch that records each call and answers from a table. */
  function recorder(answers: Record<string, { status?: number; body: unknown }>) {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, ...(init ? { init } : {}) })
      const key = `${init?.method ?? 'GET'} ${url}`
      const a = answers[key]
      if (!a) return new Response(JSON.stringify({ error: `unexpected ${key}` }), { status: 599 })
      return new Response(JSON.stringify(a.body), { status: a.status ?? 200 })
    }
    return { calls, fetcher }
  }

  it('reads changes since a cursor, posts a message and keeps the credentials', async () => {
    const { calls, fetcher } = recorder({
      'GET /mndt-api/channels/chn_1/messages?since=2026-11-12T09%3A00%3A00.000Z': { body: { messages: [message()], cursor: '2026-11-12T09:00:02.000Z' } },
      'POST /mndt-api/channels/chn_1/messages': { status: 201, body: { message: message({ id: 'msg_9' }) } },
    })
    const face = createHttpChat(fetcher)
    expect((await face.changes('chn_1', AT)).cursor).toBe('2026-11-12T09:00:02.000Z')
    expect((await face.post('chn_1', '@assistant bonjour')).id).toBe('msg_9')
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({ text: '@assistant bonjour' })
    expect(calls.every(c => c.init?.credentials === 'include')).toBe(true)
  })

  it('a refusal throws with the Host\'s reason, never reads as empty', async () => {
    const { fetcher } = recorder({ 'GET /mndt-api/channels': { status: 403, body: { error: 'forbidden' } } })
    await expect(createHttpChat(fetcher).channels()).rejects.toThrow('forbidden')
  })

  it('the first page comes with its cursor, kept as served', async () => {
    const { fetcher } = recorder({
      'GET /mndt-api/channels/chn_1/messages': { body: { messages: [message()], cursor: '2026-11-12T09:05:00.000Z' } },
    })
    expect((await createHttpChat(fetcher).messages('chn_1')).cursor).toBe('2026-11-12T09:05:00.000Z')
  })

  it('the cards are read with the decided ones, who and when', async () => {
    const { calls, fetcher } = recorder({
      'GET /mndt-api/approvals?state=all': { body: { approvals: [{
        id: 'apr_1', kind: 'send-email', title: 'Relance', requestedBy: 'assistant', requestedAt: '2026-11-13T08:39:00.000Z',
        channelId: 'chn_1', messageId: 'msg_1', state: 'approved', decidedBy: 'stephane@datanalysis.re', decidedAt: '2026-11-13T08:40:00.000Z',
      }] } },
    })
    const [card] = await createHttpChat(fetcher).cards()
    expect(calls[0]!.url).toBe('/mndt-api/approvals?state=all')
    expect(card).toMatchObject({ state: 'approved', decidedBy: 'stephane@datanalysis.re', messageId: 'msg_1' })
  })

  it('a channel is created from its title alone', async () => {
    const { calls, fetcher } = recorder({
      'POST /mndt-api/channels': { status: 201, body: { channel: channel({ name: 'compta-orange', title: 'Compta Orange' }) } },
    })
    expect((await createHttpChat(fetcher).createChannel({ title: 'Compta Orange' })).name).toBe('compta-orange')
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ title: 'Compta Orange' })
  })

  it('a refused right is said in the page\'s words; any other refusal as the Host served it', async () => {
    const { fetcher } = recorder({
      'POST /mndt-api/channels': { status: 403, body: { error: 'me@datanalysis.re is viewer and does not hold workflows.write' } },
      'GET /mndt-api/channels/chn_9/messages': { status: 404, body: { error: 'channel_not_found' } },
    })
    const face = createHttpChat(fetcher)
    const refused = await face.createChannel({ title: 'Essai' }).catch((failure: unknown) => failure)
    expect(refused).toBeInstanceOf(ChatRefusal)
    expect((refused as ChatRefusal).status).toBe(403)
    expect(reasonOf(refused, chatFrench)).toBe('Votre rôle ne le permet pas : demandez à un owner ou un admin.')
    const missing = await face.messages('chn_9').catch((failure: unknown) => failure)
    expect(reasonOf(missing, chatFrench)).toBe('channel_not_found')
  })
})

describe('the double plays the Host: turns, answers, the ceiling', () => {
  it('a mention queues a turn, then runs it, then answers in the thread with its cost', async () => {
    const face = createMockChat({ you: 'me@datanalysis.re', agents: [agent()], channels: [channel()] }, () => Date.parse(AT))
    const sent = await face.post('chn_1', '@assistant que dit la facture ?')
    expect(sent.mentions).toEqual(['agt_1'])
    expect(sent.turns![0]!.status).toBe('queued')
    face.tick()
    face.tick()
    const thread = (await face.messages('chn_1')).messages
    const asked = thread.find(m => m.id === sent.id)!
    expect(asked.turns![0]).toMatchObject({ status: 'done', eur: 0.01 })
    expect(thread.find(m => m.replyTo === sent.id)?.author).toEqual({ kind: 'agent', agentId: 'agt_1' })
  })

  it('past the monthly ceiling the turn is refused and the thread says so', async () => {
    const face = createMockChat({ you: 'me@datanalysis.re', agents: [agent({ eurThisMonth: 5 })], channels: [channel()] }, () => Date.parse(AT))
    const sent = await face.post('chn_1', '@assistant encore')
    face.tick()
    const thread = (await face.messages('chn_1')).messages
    expect(thread.find(m => m.id === sent.id)!.turns![0]!.status).toBe('refused')
    expect(thread.some(m => m.author.kind === 'system' && m.text.startsWith('Plafond mensuel atteint pour @assistant'))).toBe(true)
  })

  it('an agent this channel does not name is not mentioned; the solo lane comes first', async () => {
    const face = createMockChat({
      you: 'me@datanalysis.re',
      agents: [agent(), agent({ id: 'agt_2', handle: 'analyste' })],
      channels: [channel(), channel({ id: 'chn_0', name: 'me', title: 'Ma lane', kind: 'solo', createdAt: '2026-11-12T10:00:00.000Z' })],
    }, () => Date.parse(AT))
    expect((await face.post('chn_1', '@analyste bonjour')).mentions).toEqual([])
    expect((await face.channels()).map(c => c.kind)).toEqual(['solo', 'team'])
  })
})
