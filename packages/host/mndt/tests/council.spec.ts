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

/** Answers by the call's suffix: framing (-cf), positions (-cp<x>), critiques (-cc<x>), synthesis (-cs). */
class CouncilEngine implements TurnEngine {
  readonly seen: TurnInput[] = []
  framing = '{"question": "HT ou TTC ?", "options": ["HT", "TTC"]}'
  /** The choice each member's handle gives, in its position then its critique. */
  positions: Record<string, number | string> = { alpha: 1, beta: 1, gamma: 2 }
  critiques: Record<string, number | string> = {}
  synthesis = 'Le conseil retient TTC.\n{"chosen": 2, "dissent": [{"slot": "A", "why": "préfère HT"}, {"slot": "Z", "why": "inconnu"}]}'
  before?: (input: TurnInput) => Promise<void> | void
  async run(input: TurnInput): Promise<TurnOutput> {
    this.seen.push(input)
    await this.before?.(input)
    const tokens = { input: 1000, output: 100 }
    const h = input.agent.handle
    if (input.turnId.endsWith('-cf')) return { text: this.framing, tokens }
    if (/-cp[a-d]$/.test(input.turnId)) return { text: `position de ${h}\n{"choice": ${JSON.stringify(this.positions[h])}}`, tokens }
    if (/-cc[a-d]$/.test(input.turnId)) {
      const choice = this.critiques[h] ?? this.positions[h]
      return { text: `critique de ${h}\n{"choice": ${JSON.stringify(choice)}}`, tokens }
    }
    if (input.turnId.endsWith('-cs')) return { text: this.synthesis, tokens }
    return { text: `réponse de ${h}`, tokens }
  }
}

function bench() {
  const service = new WorkbenchService({ store: new MemoryStore() })
  const engine = new CouncilEngine()
  const turns = new TurnScheduler({ service, engine, prices: PRICES, dataDir: '/data/mndt' })
  const api = createMndtApi({
    service, runner: noMissions, turns,
    identity: { tokens: { owner: { user: owner }, operator: { user: operator }, admin: { user: admin } } },
    grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }, { subject: operator, role: 'operator' }, { subject: admin, role: 'admin' }] }) },
  })
  const call = async (method: string, path: string, who: string, body?: unknown) => {
    const answer = await api({ method, path, authorization: `Bearer ${who}`, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: answer.status, body: answer.body as Record<string, unknown> }
  }
  return { service, engine, turns, call }
}

async function team(b: ReturnType<typeof bench>, coordination: Record<string, unknown> = {}) {
  const agent = async (handle: string, provider: string) =>
    ((await b.call('POST', '/agents', 'owner', { handle, name: handle, provider, model: 'm', eurPerMonth: 5 })).body.agent as { id: string }).id
  const alpha = await agent('alpha', 'route-a')
  const beta = await agent('beta', 'route-b')
  const gamma = await agent('gamma', 'route-b')
  const judge = await agent('juge', 'route-a')
  const channel = ((await b.call('POST', '/channels', 'owner', { name: 'compta', agents: [alpha, beta, gamma, judge], members: [operator] })).body.channel as { id: string }).id
  const set = await b.call('POST', `/channels/${channel}/coordination`, 'owner', { mode: 'council', members: [alpha, beta, gamma], ...coordination })
  return { alpha, beta, gamma, judge, channel, set }
}

async function ask(b: ReturnType<typeof bench>, channel: string, text: string) {
  const posted = await b.call('POST', `/channels/${channel}/messages`, 'owner', { text })
  await b.turns.settled()
  const messages = (await b.service.messages(channel)) as readonly Message[]
  const asked = messages.find(m => m.id === (posted.body.message as { id: string }).id)
  return { turn: asked?.turns?.[0] as Turn, replies: messages.filter(m => m.author.kind === 'agent' && m.replyTo === asked?.id) }
}

describe('« conseil »: setting it', () => {
  it('refuses with a code: too few, too many, a synthesizer that is a member or missing, an unknown decision, a bound out of range', async () => {
    const b = bench()
    const t = await team(b)
    expect(t.set.status).toBe(200)
    expect((t.set.body.channel as { coordination: unknown }).coordination).toEqual({ mode: 'council', memberIds: [t.alpha, t.beta, t.gamma], decision: 'vote', maxEurPerTurn: 1 })
    const code = async (body: Record<string, unknown>) => (await b.call('POST', `/channels/${t.channel}/coordination`, 'owner', { mode: 'council', ...body })).body.code
    expect(await code({ members: [t.alpha] })).toBe('too-few-members')
    expect(await code({ members: [t.alpha, t.beta, t.gamma, t.judge, 'agt_x'] })).toBe('too-many-members')
    expect(await code({ members: [t.alpha, t.beta], decision: 'synthesis', synthesizer: t.beta })).toBe('synthesizer-is-member')
    expect(await code({ members: [t.alpha, t.beta], decision: 'synthesis' })).toBe('missing-fields')
    expect(await code({ members: [t.alpha, t.beta], decision: 'tirage' })).toBe('unknown-decision')
    expect(await code({ members: [t.alpha, t.beta], maxEurPerTurn: 9 })).toBe('budget-out-of-range')
    expect(await code({ members: [t.alpha, 'agt_none'] })).toBe('not-member')
  })
})

describe('« conseil »: a vote on the options\' indexes', () => {
  it('frames, positions alone and without tools, critiques without names, decides; each call counts for its member', async () => {
    const b = bench()
    const t = await team(b)
    const { turn, replies } = await ask(b, t.channel, '@alpha HT ou TTC ? (fil secret 4410)')
    const council = turn.council
    expect(council?.state).toBe('done')
    expect(council?.question).toBe('HT ou TTC ?')
    expect(council?.options).toEqual(['HT', 'TTC', 'aucune de ces options'])
    expect(council?.positions.map(p => p.slot).sort()).toEqual(['A', 'B', 'C'])
    expect(council?.decision).toEqual({ kind: 'vote', tally: { 1: 2, 2: 1 }, chosen: 1 })
    expect(council?.dissent).toHaveLength(1)
    expect(replies.at(-1)?.text)
      .toMatch(/^Décision du conseil \(vote\) : option 1, « HT »\. Décompte : option 1 : 2, option 2 : 1\. Ne suivent pas : [ABC]\.$/)
    // No member has a tool or a server, in any call of the council.
    const calls = b.engine.seen.filter(input => /-c[fpcs][a-d]?$/.test(input.turnId))
    expect(calls).toHaveLength(1 + 3 + 3)
    expect(calls.every(input => input.servers.length === 0 && input.tools === 'none')).toBe(true)
    // A position sees neither the channel's discussion nor another position.
    const positions = b.engine.seen.filter(input => /-cp[a-d]$/.test(input.turnId))
    expect(positions.every(input => !input.prompt.includes('fil secret 4410') && !input.prompt.includes('position de'))).toBe(true)
    // A critique reads the others without their names.
    const critiques = b.engine.seen.filter(input => /-cc[a-d]$/.test(input.turnId))
    const blocks = critiques.flatMap(input => [...input.prompt.matchAll(/Position [A-D] \[[^\]]+\] :\n([\s\S]*?)\nFin de la position/g)].map(m => m[1] ?? ''))
    expect(blocks.length).toBe(6)
    expect(blocks.every(block => !/@|agt_/.test(block))).toBe(true)
    // Each call for its own member; the chair also pays the framing.
    const messages = (await b.service.snapshot()).messages ?? []
    const now = new Date().toISOString()
    const each = [t.alpha, t.beta, t.gamma].map(id => spentThisMonth(messages, id, now))
    expect(each.every(eur => eur > 0)).toBe(true)
    // Exactly the sum of each member's own calls; the chair's includes the framing.
    const own = (id: string): number => [council?.framing, ...(council?.positions ?? []), ...(council?.critiques ?? [])]
      .reduce((sum, entry) => sum + (entry?.agentId === id ? (entry.eur ?? 0) : 0), 0)
    expect(each.map((eur, i) => Math.abs(eur - own([t.alpha, t.beta, t.gamma][i] as string)) < 1e-9)).toEqual([true, true, true])
    expect(council?.framing?.agentId).toBe(t.alpha)
    expect(spentThisMonth(messages, t.judge, now)).toBe(0)
  })

  it('counts the choice after the critique', async () => {
    const b = bench()
    const t = await team(b)
    b.engine.critiques = { beta: 2 }
    const { turn } = await ask(b, t.channel, '@alpha HT ou TTC ?')
    expect(turn.council?.decision).toEqual({ kind: 'vote', tally: { 1: 1, 2: 2 }, chosen: 2 })
  })

  it('a tie escalates: listed for the members, answered by a reply, and the council is not convened again', async () => {
    const b = bench()
    const t = await team(b)
    b.engine.positions = { alpha: 1, beta: 2, gamma: 3 }
    const { turn, replies } = await ask(b, t.channel, '@alpha HT ou TTC ?')
    expect(turn.council?.decision).toEqual({ kind: 'vote', tally: { 1: 1, 2: 1, 3: 1 } })
    expect(turn.council?.escalation?.summary).toContain('Pourquoi : égalité.')
    const question = replies.at(-1) as Message
    expect(turn.council?.escalation?.messageId).toBe(question.id)
    const listed = (await b.call('GET', '/escalations', 'operator')).body.escalations as { kind: string; turnId: string }[]
    expect(listed).toEqual([expect.objectContaining({ kind: 'council', turnId: turn.id, questionMessageId: question.id })])
    expect((await b.call('GET', '/escalations', 'admin')).body.escalations).toEqual([])
    const before = b.engine.seen.length
    const reply = await b.call('POST', `/channels/${t.channel}/messages`, 'operator', { text: 'HT.', replyTo: question.id })
    await b.turns.settled()
    expect(b.engine.seen.length).toBe(before)
    expect((reply.body.message as Message).turns ?? []).toEqual([])
    const answered = (await b.service.message(question.replyTo as string))?.turns?.[0]?.council?.escalation
    expect(answered).toMatchObject({ answeredBy: operator })
  })

  it('a majority on « aucune de ces options » escalates, with the critiques in the summary', async () => {
    const b = bench()
    const t = await team(b)
    b.engine.positions = { alpha: 3, beta: 3, gamma: 1 }
    const { turn } = await ask(b, t.channel, '@alpha HT ou TTC ?')
    expect(turn.council?.decision).toMatchObject({ kind: 'vote', chosen: 3 })
    expect(turn.council?.escalation?.summary).toContain('aucune de ces options')
    expect(turn.council?.escalation?.summary).toContain('Critiques : ')
  })

  it('a choice outside the options is not counted (skipped « choix illisible »); fewer than two counted escalates', async () => {
    const b = bench()
    const t = await team(b)
    b.engine.positions = { alpha: 1, beta: 9, gamma: '"HT"' }
    const { turn } = await ask(b, t.channel, '@alpha HT ou TTC ?')
    expect(turn.council?.skipped.filter(s => s.reason === 'choix illisible')).toHaveLength(2)
    expect(turn.council?.escalation?.summary).toContain('quorum manqué')
    expect(turn.council?.critiques).toEqual([])
  })

  it('an unreadable framing escalates, no option invented', async () => {
    const b = bench()
    const t = await team(b)
    b.engine.framing = 'Je propose HT ou TTC.'
    const { turn } = await ask(b, t.channel, '@alpha HT ou TTC ?')
    expect(turn.council?.options).toEqual([])
    expect(turn.council?.escalation?.summary).toContain('cadrage illisible')
  })

  it('only the chair\'s turn convenes it: a mention of another member is an ordinary turn', async () => {
    const b = bench()
    const t = await team(b)
    const { turn, replies } = await ask(b, t.channel, '@beta un mot ?')
    expect(turn.council).toBeUndefined()
    expect(replies.at(-1)?.text).toBe('réponse de beta')
  })
})

describe('« conseil »: decided by a synthesizer', () => {
  it('the synthesizer decides on an index; its dissent kept to the slots that exist', async () => {
    const b = bench()
    const t = await team(b)
    await b.call('POST', `/channels/${t.channel}/coordination`, 'owner', { mode: 'council', members: [t.alpha, t.beta, t.gamma], decision: 'synthesis', synthesizer: t.judge })
    const { turn, replies } = await ask(b, t.channel, '@alpha HT ou TTC ?')
    expect(turn.council?.decision).toMatchObject({ kind: 'synthesis', chosen: 2, text: 'Le conseil retient TTC.', agentId: t.judge })
    expect(turn.council?.dissent).toEqual([{ slot: 'A', why: 'préfère HT' }])
    expect(replies.at(-1)?.text).toBe('Le conseil retient TTC.')
    const synthesis = b.engine.seen.find(input => input.turnId.endsWith('-cs'))
    expect(synthesis?.tools).toBe('none')
  })

  it('a synthesis that does not decide escalates', async () => {
    const b = bench()
    const t = await team(b)
    await b.call('POST', `/channels/${t.channel}/coordination`, 'owner', { mode: 'council', members: [t.alpha, t.beta, t.gamma], decision: 'synthesis', synthesizer: t.judge })
    b.engine.synthesis = 'Rien ne permet de trancher.\n{"chosen": null, "dissent": []}'
    const { turn } = await ask(b, t.channel, '@alpha HT ou TTC ?')
    expect(turn.council?.escalation?.summary).toContain('la synthèse ne tranche pas')
  })
})

describe('« conseil »: anonymous until the decision, in the core', () => {
  it('while critiquing: no member, model nor cost per call served; the total instead', async () => {
    const b = bench()
    const t = await team(b)
    b.engine.positions = { alpha: 1, beta: 9, gamma: 2 }
    let served: Turn | undefined
    b.engine.before = async (input) => {
      if (!/-cc[a-d]$/.test(input.turnId) || served !== undefined) return
      const page = await b.call('GET', `/channels/${t.channel}/messages`, 'operator')
      served = ((page.body.messages as Message[]).find(m => m.turns?.[0]?.council !== undefined))?.turns?.[0]
    }
    await ask(b, t.channel, '@alpha HT ou TTC ?')
    expect(served?.council?.state).toBe('critiquing')
    expect(served?.council?.positions.every(p =>
      p.agentId === undefined && p.model === undefined && p.eur === undefined && p.tokens === undefined)).toBe(true)
    expect(served?.council?.framing?.eur).toBeUndefined()
    expect(served?.council?.eur).toBeGreaterThan(0)
    expect(served?.council?.skipped).toEqual([{ slot: expect.stringMatching(/^[A-D]$/), reason: 'avis non obtenu : choix illisible' }])
    expect(JSON.stringify(served)).not.toMatch(new RegExp(`${t.beta}|${t.gamma}`))
  })
})

describe('« conseil »: what C\'s review of 616afddc4a asked', () => {
  it('a decided council that escalates keeps its members withheld until a person answers', async () => {
    const b = bench()
    const t = await team(b)
    b.engine.positions = { alpha: 1, beta: 2, gamma: 3 }
    const { turn, replies } = await ask(b, t.channel, '@alpha HT ou TTC ?')
    expect(turn.council?.decision).toBeDefined()
    const served = async (): Promise<Turn | undefined> => (((await b.call('GET', `/channels/${t.channel}/messages`, 'operator')).body.messages as Message[])
      .find(m => m.turns?.[0]?.council !== undefined))?.turns?.[0]
    const open = await served()
    expect(open?.council?.positions.every(p => p.agentId === undefined && p.eur === undefined)).toBe(true)
    expect(JSON.stringify(open)).not.toMatch(new RegExp(`${t.beta}|${t.gamma}`))
    await b.call('POST', `/channels/${t.channel}/messages`, 'operator', { text: 'HT.', replyTo: (replies.at(-1) as Message).id })
    await b.turns.settled()
    expect((await served())?.council?.positions.every(p => p.agentId !== undefined)).toBe(true)
  })

  it('the served eurThisMonth of no member moves while the council deliberates and critiques; once over, in one block', async () => {
    const b = bench()
    const t = await team(b)
    const counters = async (): Promise<number[]> => {
      const agents = (await b.call('GET', '/agents', 'owner')).body.agents as { id: string; eurThisMonth: number }[]
      return [t.alpha, t.beta, t.gamma].map(id => agents.find(a => a.id === id)?.eurThisMonth ?? -1)
    }
    const seen: number[][] = []
    b.engine.before = async (input) => { if (/-c[pc][a-d]$/.test(input.turnId)) seen.push(await counters()) }
    await ask(b, t.channel, '@alpha HT ou TTC ?')
    expect(seen.length).toBe(6)
    expect(seen.every(row => row.every(eur => eur === 0))).toBe(true)
    expect((await counters()).every(eur => eur > 0)).toBe(true)
  })

  it('an absolute majority is needed: 2-1-1 out of 4 does not decide (« pas de majorité »)', async () => {
    const b = bench()
    const t = await team(b)
    await b.call('POST', `/channels/${t.channel}/coordination`, 'owner', { mode: 'council', members: [t.alpha, t.beta, t.gamma, t.judge] })
    b.engine.positions = { alpha: 1, beta: 1, gamma: 2, juge: 3 }
    const { turn } = await ask(b, t.channel, '@alpha HT ou TTC ?')
    expect(turn.council?.decision).toEqual({ kind: 'vote', tally: { 1: 2, 2: 1, 3: 1 } })
    expect(turn.council?.escalation?.summary).toContain('Pourquoi : pas de majorité.')
  })

  it('a member mentioned during the council reads no position nor critique in its history', async () => {
    const b = bench()
    const t = await team(b)
    let mentioned = false
    b.engine.before = async (input) => {
      if (input.turnId.endsWith('-cpa') && !mentioned) {
        mentioned = true
        await b.call('POST', `/channels/${t.channel}/messages`, 'owner', { text: '@beta autre chose ?' })
      }
    }
    await ask(b, t.channel, '@alpha HT ou TTC ?')
    const ordinary = b.engine.seen.find(input => input.agent.handle === 'beta' && input.turnId === input.runId)
    expect(ordinary).toBeDefined()
    expect(ordinary?.prompt).not.toMatch(/position de|critique de/)
  })

  it('a call stopped at the bound counts for the agent that made it, on its skipped entry', async () => {
    const b = bench()
    const t = await team(b)
    const { TurnBudgetReached } = await import('../src/turns.ts')
    b.engine.before = (input) => { if (input.turnId.endsWith('-cpb')) throw new TurnBudgetReached({ input: 50_000, output: 0 }) }
    const { turn } = await ask(b, t.channel, '@alpha HT ou TTC ?')
    const stopped = turn.council?.skipped.find(s => s.slot === 'B')
    expect(stopped?.eur).toBeGreaterThan(0)
    const messages = (await b.service.snapshot()).messages ?? []
    const c = turn.council
    const own = [c?.framing, ...(c?.positions ?? []), ...(c?.critiques ?? []), ...(c?.skipped ?? [])]
      .filter(e => e?.agentId === stopped?.agentId).reduce((sum, e) => sum + (e?.eur ?? 0), 0)
    expect(spentThisMonth(messages, stopped?.agentId ?? '', new Date().toISOString())).toBeCloseTo(own, 9)
  })
})
