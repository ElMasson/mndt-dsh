import { describe, expect, it } from 'vitest'
import { MemoryStore, spentThisMonth, WorkbenchService } from '../src/core/index.ts'
import type { Message, PriceGrid, Turn } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import type { MissionRunner } from '../src/api.ts'
import { TurnScheduler } from '../src/turns.ts'
import type { TurnEngine, TurnInput, TurnOutput } from '../src/turns.ts'

const owner = 'duke@datanalysis.re'
const operator = 'operateur@datanalysis.re'
const admin = 'jadmin@datanalysis.re'
const PRICES: PriceGrid = { 'route-a/*': { input: 1, output: 2 }, 'route-b/*': { input: 3, output: 4 } }
const noMissions: MissionRunner = { run: async () => ({ title: 't', markdown: 'm', sources: [] }) }
type Call = (
  method: string, path: string, who: string, body?: unknown, headers?: Record<string, string>,
) => Promise<{ status: number; body: Record<string, unknown> }>

/**
 * The asker's first call asks for help through the API, as the approvals
 * connector does (x-mndt-run); peers answer « avis de <handle> »; the reading
 * answers what `reading` says.
 */
class HelpEngine implements TurnEngine {
  readonly seen: TurnInput[] = []
  call?: Call
  helpBody: Record<string, unknown> = {}
  helpAnswer?: { status: number; body: Record<string, unknown> }
  reading = 'Je retiens l’avis A : le montant est HT.\n{"retained": "A", "why": "il cite la facture", "verdict": "unblocked"}'
  tokens = { input: 1000, output: 100 }
  /** The channel's servers the engine reports not ready, on an ordinary turn. */
  unavailable?: string[]
  before?: (input: TurnInput) => Promise<void> | void
  async run(input: TurnInput): Promise<TurnOutput> {
    this.seen.push(input)
    await this.before?.(input)
    if (input.turnId === input.runId && input.agent.handle === 'alpha' && this.call !== undefined) {
      this.helpAnswer = await this.call('POST', '/help', 'owner', this.helpBody, { 'x-mndt-run': input.runId })
      return { text: 'J’ai demandé l’avis de deux agents.', tokens: this.tokens }
    }
    if (/-hr\d$/.test(input.turnId)) return { text: this.reading, tokens: this.tokens }
    if (/-h\d[ab]$/.test(input.turnId)) return { text: `avis de ${input.agent.handle}`, tokens: this.tokens }
    return { text: `réponse de ${input.agent.handle}`, tokens: this.tokens, ...(this.unavailable === undefined ? {} : { toolsUnavailable: this.unavailable }) }
  }
}

function bench() {
  const service = new WorkbenchService({ store: new MemoryStore() })
  const engine = new HelpEngine()
  const turns = new TurnScheduler({ service, engine, prices: PRICES, dataDir: '/data/mndt' })
  const api = createMndtApi({
    service, runner: noMissions, turns,
    identity: { tokens: { owner: { user: owner }, operator: { user: operator }, admin: { user: admin } } },
    grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }, { subject: operator, role: 'operator' }, { subject: admin, role: 'admin' }] }) },
  })
  const call: Call = async (method, path, who, body, headers) => {
    const answer = await api({
      method, path, authorization: `Bearer ${who}`,
      ...(headers === undefined ? {} : { headers }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: answer.status, body: answer.body as Record<string, unknown> }
  }
  engine.call = call
  return { service, engine, turns, call }
}

/** @returns a channel of three agents: alpha asks, beta and gamma (another model) advise. */
async function team(b: ReturnType<typeof bench>) {
  const agent = async (handle: string, provider: string) =>
    ((await b.call('POST', '/agents', 'owner', { handle, name: handle, provider, model: 'm', eurPerMonth: 5 })).body.agent as { id: string }).id
  const alpha = await agent('alpha', 'route-a')
  const beta = await agent('beta', 'route-b')
  const gamma = await agent('gamma', 'route-b')
  const outsider = await agent('dehors', 'route-a')
  const channel = ((await b.call('POST', '/channels', 'owner', { name: 'compta', agents: [alpha, beta, gamma], members: [operator] })).body.channel as { id: string }).id
  const request = { task: 'Le point du trimestre', tried: 'La facture 42', blocker: 'HT ou TTC ?', options: ['HT', 'TTC'], need: 'fact', peers: [beta, gamma] }
  b.engine.helpBody = request
  return { alpha, beta, gamma, outsider, channel, request }
}

async function ask(b: ReturnType<typeof bench>, channel: string, text: string, who = 'owner') {
  const posted = await b.call('POST', `/channels/${channel}/messages`, who, { text })
  await b.turns.settled()
  const messages = (await b.service.messages(channel)) as readonly Message[]
  const asked = messages.find(m => m.id === (posted.body.message as { id: string }).id)
  return { asked, turn: asked?.turns?.[0] as Turn, replies: messages.filter(m => m.author.kind === 'agent' && m.replyTo === asked?.id) }
}

describe('ask_peers: two peers, alone and without tools, then the asker reads them without their names', () => {
  it('unblocks: the advices, the reading, the published answer, and the cost on the asker only', async () => {
    const b = bench()
    const t = await team(b)
    const { turn, replies } = await ask(b, t.channel, '@alpha le point HT ou TTC ? (fil secret 7731)')
    expect(b.engine.helpAnswer?.status).toBe(201)
    expect(turn.status).toBe('done')
    expect(turn.help?.state).toBe('done')
    expect(turn.help?.reading).toEqual({ retained: 'A', why: 'il cite la facture', verdict: 'unblocked' })
    expect(turn.help?.advices.map(advice => advice.slot).sort()).toEqual(['A', 'B'])
    // After the reading, each advice names its agent and its model.
    expect(turn.help?.advices.every(advice => advice.agentId !== undefined && advice.model === 'route-b/m')).toBe(true)
    expect(replies.at(-1)?.text).toBe('Je retiens l’avis A : le montant est HT.')
    // Peers: no tool, no server, no discussion of the channel, not the other advice.
    const peers = b.engine.seen.filter(input => /-h1[ab]$/.test(input.turnId))
    expect(peers).toHaveLength(2)
    expect(peers.every(input => input.servers.length === 0 && input.tools === 'none')).toBe(true)
    expect(peers.every(input => !input.prompt.includes('fil secret 7731') && !input.prompt.includes('avis de'))).toBe(true)
    expect(peers.every(input => input.prompt.includes('Blocage : HT ou TTC ?'))).toBe(true)
    // The reading: anonymous advices, the asker's usual tools.
    const reading = b.engine.seen.find(input => input.turnId.endsWith('-hr1'))
    expect(reading?.prompt).toContain('Avis A')
    // The advice blocks carry no author (the channel's agents are named elsewhere, to choose from).
    const blocks = [...(reading?.prompt ?? '').matchAll(/Avis [AB] \[[^\]]+\] :\n([\s\S]*?)\nFin de l'avis/g)].map(m => m[1])
    expect(blocks).toHaveLength(2)
    expect(blocks.every(block => !/@|agt_/.test(block ?? ''))).toBe(true)
    expect(reading?.tools).toBeUndefined()
    // Five calls (ask, two peers, reading): all counted for alpha, nothing for its peers.
    const all = (await b.service.snapshot()).messages ?? []
    const now = new Date().toISOString()
    expect(spentThisMonth(all, t.beta, now)).toBe(0)
    expect(spentThisMonth(all, t.alpha, now)).toBeCloseTo(turn.eur ?? 0, 6)
    expect(turn.help?.eur).toBeGreaterThan(0)
    expect(turn.eur).toBeGreaterThan(turn.help?.eur ?? 0)
  })

  it('serves the advices without their authors while the asker has not read them', async () => {
    const b = bench()
    const t = await team(b)
    let served: Turn | undefined
    b.engine.before = async (input) => {
      if (!input.turnId.endsWith('-hr1')) return
      const page = await b.call('GET', `/channels/${t.channel}/messages`, 'operator')
      served = ((page.body.messages as Message[]).find(m => m.turns?.[0]?.help !== undefined))?.turns?.[0]
    }
    await ask(b, t.channel, '@alpha le point ?')
    expect(served?.help?.state).toBe('reading')
    expect(served?.help?.advices).toHaveLength(2)
    expect(served?.help?.peerIds).toEqual([])
    expect(served?.help?.advices.every(advice => advice.agentId === undefined && advice.model === undefined)).toBe(true)
    // Each advice's cost would name its model with the price grid: only the help's total is served.
    expect(served?.help?.advices.every(advice => advice.eur === undefined && advice.tokens === undefined)).toBe(true)
    expect(served?.help?.eur).toBeGreaterThan(0)
    expect(JSON.stringify(served)).not.toContain(t.beta)
  })

  it('a message deleted during the advices is answered without the peers nor their costs', async () => {
    const b = bench()
    const t = await team(b)
    let origin = ''
    let deleted: Message | undefined
    b.engine.before = async (input) => {
      if (input.turnId === input.runId) origin = (await b.service.snapshot()).messages?.at(-1)?.id ?? ''
      // During the second advice: the first one is recorded, with its peer and its cost.
      if (/-h1[ab]$/.test(input.turnId) && b.engine.seen.filter(seen => /-h1[ab]$/.test(seen.turnId)).length === 2) {
        const stored = (await b.service.message(origin))?.turns?.[0]?.help
        expect(stored?.state).toBe('advising')
        expect(stored?.advices[0]?.agentId).toBeDefined()
        deleted = (await b.call('POST', `/channels/${t.channel}/messages/${origin}/delete`, 'owner')).body.message as Message
      }
    }
    await ask(b, t.channel, '@alpha le point ?')
    const help = deleted?.turns?.[0]?.help
    expect(help?.advices).toHaveLength(1)
    expect(help?.peerIds).toEqual([])
    expect(help?.advices.every(advice => advice.agentId === undefined && advice.model === undefined
      && advice.eur === undefined && advice.tokens === undefined)).toBe(true)
    expect(JSON.stringify(deleted)).not.toContain(t.beta)
    expect(JSON.stringify(deleted)).not.toContain(t.gamma)
  })

  it('serves a skipped reason by kind until the reading, then in full', async () => {
    const b = bench()
    const t = await team(b)
    let served: Turn | undefined
    const original = b.engine.run.bind(b.engine)
    b.engine.run = async (input: TurnInput): Promise<TurnOutput> => {
      if (input.turnId.endsWith('-h1a') || input.turnId.endsWith('-h1b')) {
        if (b.engine.seen.filter(seen => /-h1[ab]$/.test(seen.turnId)).length === 0) {
          b.engine.seen.push(input)
          throw new Error(`@${input.agent.handle} : le moteur a refusé`)
        }
      }
      if (input.turnId.endsWith('-hr1')) {
        const page = await b.call('GET', `/channels/${t.channel}/messages`, 'operator')
        served = ((page.body.messages as Message[]).find(m => m.turns?.[0]?.help !== undefined))?.turns?.[0]
      }
      return original(input)
    }
    const { turn } = await ask(b, t.channel, '@alpha le point ?')
    // By kind before the reading: the words a reader may see, and the kind the screen says in its own words.
    expect(served?.help?.skipped).toEqual([{ slot: expect.stringMatching(/^[AB]$/) as unknown, reason: 'avis non obtenu : erreur', reasonKind: 'failed' }])
    expect(JSON.stringify(served)).not.toMatch(/@beta|@gamma/)
    // After the reading, the peer named and the host's sentence: the engine's words go to the operator's log.
    expect(turn.help?.skipped[0]?.reason).toBe('Erreur pendant l’exécution.')
    expect(JSON.stringify(turn)).not.toContain('le moteur a refusé')
    expect(turn.help?.skipped[0]?.agentId).toBeDefined()
  })
})

describe('a turn whose connector was not ready', () => {
  it('records the servers it ran without, for the screen', async () => {
    const b = bench()
    const t = await team(b)
    b.engine.unavailable = ['dolibarr']
    const { turn } = await ask(b, t.channel, '@beta un mot ?')
    expect(turn.status).toBe('done')
    expect(turn.toolsUnavailable).toEqual(['dolibarr'])
  })
})

describe('ask_peers: what the core refuses', () => {
  it('a missing field, the asker itself, a non-member, three peers, a second request in the same turn', async () => {
    const b = bench()
    const t = await team(b)
    const tries: Record<string, unknown>[] = [
      { ...t.request, blocker: '' },
      { ...t.request, need: 'vote' },
      { ...t.request, peers: [t.alpha] },
      { ...t.request, peers: [t.outsider] },
      { ...t.request, peers: [t.beta, t.gamma, t.outsider] },
    ]
    const codes: unknown[] = []
    for (const body of tries) {
      b.engine.helpBody = body
      const { turn } = await ask(b, t.channel, '@alpha le point ?')
      codes.push(b.engine.helpAnswer?.body.code)
      expect(turn.help).toBeUndefined()
    }
    expect(codes).toEqual(['missing-fields', 'missing-fields', 'self', 'no-peer', 'too-many-peers'])
  })

  it('outside a turn: 400 not-running', async () => {
    const b = bench()
    const t = await team(b)
    expect((await b.call('POST', '/help', 'owner', t.request, { 'x-mndt-run': 'trn_none' })).body.code).toBe('not-running')
  })

  it('not in a coordinated channel', async () => {
    const b = bench()
    const t = await team(b)
    await b.call('POST', `/channels/${t.channel}/coordination`, 'owner', { mode: 'author-verifier', author: t.beta, verifier: t.alpha })
    await ask(b, t.channel, '@alpha le point ?')
    expect(b.engine.helpAnswer?.body.code).toBe('coordinated-channel')
  })
})

describe('ask_peers: escalation, answered by a member', () => {
  it('a question to the people: listed for the channel\'s members only, answered by a reply, the asker relaunched', async () => {
    const b = bench()
    const t = await team(b)
    b.engine.reading = 'Les avis divergent.\n{"retained": "aucun", "why": "ils se contredisent", "verdict": "escalate", "question": "La facture 42 est-elle HT ?"}'
    const { turn, replies } = await ask(b, t.channel, '@alpha le point ?')
    expect(turn.help?.escalation).toMatchObject({ question: 'La facture 42 est-elle HT ?' })
    // Only what the advices add to the question (no « Blocage : » repeating it).
    expect(turn.help?.escalation?.summary).toBe('Avis reçus : 2.')
    // Each sentence ended once: never « ?. » nor « .. ».
    expect(turn.help?.escalation?.summary).not.toMatch(/\?\.|\.\./)
    const question = replies.at(-1) as Message
    // The question is the escalation's (shown under the message), not repeated in the text.
    expect(question.text).not.toContain('Question à l’équipe')
    const listed = (await b.call('GET', '/escalations', 'operator')).body.escalations as { turnId: string; question: string }[]
    expect(turn.help?.escalation?.messageId).toBe(question.id)
    expect(listed).toEqual([expect.objectContaining({
      turnId: turn.id, question: 'La facture 42 est-elle HT ?', channelId: t.channel, messageId: question.replyTo, questionMessageId: question.id,
    })])
    // An admin who is not a member sees nothing.
    expect((await b.call('GET', '/escalations', 'admin')).body.escalations).toEqual([])
    // A member's reply answers it and gives alpha a turn on that reply.
    b.engine.helpBody = {}
    const reply = await b.call('POST', `/channels/${t.channel}/messages`, 'operator', { text: 'Oui, HT.', replyTo: question.id })
    await b.turns.settled()
    const answered = (await b.service.message(turn.id === '' ? '' : (question.replyTo as string)))?.turns?.[0]
    expect(answered?.help?.escalation).toMatchObject({ answeredBy: operator })
    const relaunched = (await b.service.message((reply.body.message as { id: string }).id))?.turns ?? []
    expect(relaunched.map(r => r.agentId)).toEqual([t.alpha])
    expect((await b.call('GET', '/escalations', 'operator')).body.escalations).toEqual([])
    // The question, out of the text, is given back to the next turns' history.
    const relaunchedPrompt = b.engine.seen.at(-1)?.prompt ?? ''
    expect(relaunchedPrompt).toContain('Question à l’équipe : La facture 42 est-elle HT ?')
  })

  it('an escalated help keeps its peers withheld until a person answers', async () => {
    const b = bench()
    const t = await team(b)
    b.engine.reading = 'Les avis divergent.\n{"retained": "aucun", "why": "ils se contredisent", "verdict": "escalate", "question": "HT ?"}'
    const { replies } = await ask(b, t.channel, '@alpha le point ?')
    const served = async (): Promise<Turn | undefined> => (((await b.call('GET', `/channels/${t.channel}/messages`, 'operator')).body.messages as Message[])
      .find(m => m.turns?.[0]?.help !== undefined))?.turns?.[0]
    const open = await served()
    expect(open?.help?.reading).toBeDefined()
    expect(open?.help?.peerIds).toEqual([])
    expect(open?.help?.advices.every(advice => advice.agentId === undefined && advice.eur === undefined)).toBe(true)
    b.engine.helpBody = {}
    await b.call('POST', `/channels/${t.channel}/messages`, 'operator', { text: 'Oui, HT.', replyTo: (replies.at(-1) as Message).id })
    await b.turns.settled()
    expect((await served())?.help?.advices.every(advice => advice.agentId !== undefined)).toBe(true)
  })

  it('a deleted request withdraws its question: no longer listed, and a reply answers nothing', async () => {
    const b = bench()
    const t = await team(b)
    b.engine.reading = 'Les avis divergent.\n{"retained": "aucun", "why": "ils se contredisent", "verdict": "escalate", "question": "HT ?"}'
    const { turn, replies } = await ask(b, t.channel, '@alpha le point ?')
    expect(((await b.call('GET', '/escalations', 'operator')).body.escalations as unknown[]).length).toBe(1)
    const origin = (replies.at(-1) as Message).replyTo as string
    expect((await b.call('POST', `/channels/${t.channel}/messages/${origin}/delete`, 'owner')).status).toBe(200)
    expect((await b.call('GET', '/escalations', 'operator')).body.escalations).toEqual([])
    b.engine.helpBody = {}
    const reply = await b.call('POST', `/channels/${t.channel}/messages`, 'operator', { text: 'HT.', replyTo: (replies.at(-1) as Message).id })
    await b.turns.settled()
    expect((reply.body.message as Message).turns ?? []).toEqual([])
    expect((await b.service.message(origin))?.turns?.find(x => x.id === turn.id)?.help?.escalation?.answeredAt).toBeUndefined()
  })

  it('« card » without a card is an escalation', async () => {
    const b = bench()
    const t = await team(b)
    b.engine.reading = 'Il faut valider.\n{"retained": "B", "why": "il faut une validation", "verdict": "card"}'
    const { turn } = await ask(b, t.channel, '@alpha le point ?')
    expect(turn.help?.reading?.verdict).toBe('escalate')
    expect(turn.help?.reading?.why).toContain('aucune carte posée')
  })

  it('an unreadable verdict is an escalation, never a guess', async () => {
    const b = bench()
    const t = await team(b)
    b.engine.reading = 'Je pense que c’est HT.'
    const { turn } = await ask(b, t.channel, '@alpha le point ?')
    expect(turn.help?.reading).toMatchObject({ verdict: 'escalate', why: 'verdict illisible' })
  })
})

describe('ask_peers: bounds', () => {
  it('a person who answers in the thread meanwhile ends the help, without reading', async () => {
    const b = bench()
    const t = await team(b)
    let origin = ''
    b.engine.before = async (input) => {
      if (input.turnId === input.runId) origin = (await b.service.snapshot()).messages?.at(-1)?.id ?? ''
      if (input.turnId.endsWith('-h1a') || input.turnId.endsWith('-h1b')) {
        if ((await b.service.snapshot()).messages?.some(m => m.replyTo === origin && m.author.kind === 'human')) return
        await b.service.postMessage(t.channel, operator, 'Je réponds : HT.', origin)
      }
    }
    const { turn, replies } = await ask(b, t.channel, '@alpha le point ?')
    expect(turn.help?.state).toBe('done')
    expect(turn.help?.closedBy).toMatchObject({ by: operator })
    expect(turn.help?.reading).toBeUndefined()
    expect(turn.help?.advices).toHaveLength(1)
    // The person answered: the asker publishes nothing beside them.
    expect(replies).toHaveLength(0)
  })

  it('a person who answers during the LAST advice: no reading, no publication, done, closedBy', async () => {
    const b = bench()
    const t = await team(b)
    let origin = ''
    b.engine.before = async (input) => {
      if (input.turnId === input.runId) origin = (await b.service.snapshot()).messages?.at(-1)?.id ?? ''
      // The second advice is the last call before the reading.
      if (/-h1[ab]$/.test(input.turnId) && b.engine.seen.filter(seen => /-h1[ab]$/.test(seen.turnId)).length === 2) {
        await b.service.postMessage(t.channel, operator, 'Je tranche : HT.', origin)
      }
    }
    const { turn, replies } = await ask(b, t.channel, '@alpha le point ?')
    expect(b.engine.seen.some(input => /-hr\d$/.test(input.turnId))).toBe(false)
    expect(replies).toHaveLength(0)
    expect(turn.status).toBe('done')
    expect(turn.help).toMatchObject({ state: 'done', closedBy: { by: operator } })
    expect(turn.help?.advices).toHaveLength(2)
    expect(turn.help?.reading).toBeUndefined()
    expect(turn.help?.escalation).toBeUndefined()
  })

  it('a person who answers during the reading: the reading is kept, nothing is published', async () => {
    const b = bench()
    const t = await team(b)
    let origin = ''
    b.engine.before = async (input) => {
      if (input.turnId === input.runId) origin = (await b.service.snapshot()).messages?.at(-1)?.id ?? ''
      if (input.turnId.endsWith('-hr1')) await b.service.postMessage(t.channel, operator, 'Je tranche : HT.', origin)
    }
    const { turn, replies } = await ask(b, t.channel, '@alpha le point ?')
    expect(replies).toHaveLength(0)
    expect(turn.help).toMatchObject({ state: 'done', closedBy: { by: operator } })
  })

  it('the cost bound: a peer that would pass it is skipped with the reason, and no advice escalates', async () => {
    const b = bench()
    const t = await team(b)
    b.engine.tokens = { input: 100_000, output: 0 }
    const { turn } = await ask(b, t.channel, '@alpha le point ?')
    // 100 000 tokens at 3 €/M = 0.30 €: the first advice passes the 0.20 € bound.
    expect(turn.help?.skipped.some(skip => /borne \(0\.2 €\)/.test(skip.reason))).toBe(true)
    expect(turn.help?.escalation).toBeDefined()
    // The summary, served by GET /escalations while the question waits, says the reason by kind.
    // The summary only says what the advices add; the peer without an advice is served by kind.
    expect(turn.help?.escalation?.summary ?? '').not.toMatch(/Sans avis|Blocage|@|€|agt_|route-/)
    expect(turn.help?.skipped.some(skip => skip.reasonKind !== undefined)).toBe(true)
  })

  it('a reading the bound refuses is said by kind in the published text: no € nor handle', async () => {
    const b = bench()
    const t = await team(b)
    // Two advices at 3 €/M of 32 000 tokens (0.096 € each): the reading's reservation passes the 0.20 € bound.
    b.engine.tokens = { input: 32_000, output: 0 }
    const { turn, replies } = await ask(b, t.channel, '@alpha le point ?')
    expect(turn.help?.advices).toHaveLength(2)
    expect(turn.help?.reading).toBeUndefined()
    expect(turn.help?.escalation).toBeDefined()
    const published = replies.at(-1)?.text ?? ''
    expect(published).toContain('Lecture des avis impossible (avis non obtenu : borne)')
    expect(published).not.toMatch(/€|@beta|@gamma/)
  })

  it('two requests per thread at most, and a peer asked once per thread by the same asker', async () => {
    const b = bench()
    const t = await team(b)
    b.engine.helpBody = { ...t.request, peers: [t.beta] }
    const first = await ask(b, t.channel, '@alpha le point ?')
    const question = first.replies.at(-1) as Message
    b.engine.helpBody = { ...t.request, peers: [t.beta] }
    await b.call('POST', `/channels/${t.channel}/messages`, 'owner', { text: '@alpha et maintenant ?', replyTo: question.id })
    await b.turns.settled()
    expect(b.engine.helpAnswer?.body.code).toBe('pair-already-asked')
  })
})
