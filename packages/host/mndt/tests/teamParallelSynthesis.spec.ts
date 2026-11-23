import { describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import type { Channel, Message, PriceGrid } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import type { MissionRunner } from '../src/api.ts'
import { TurnBudgetReached, TurnScheduler } from '../src/turns.ts'
import type { TurnEngine, TurnInput, TurnOutput } from '../src/turns.ts'

const owner = 'duke@datanalysis.re'
const operator = 'operateur@datanalysis.re'
const PRICES: PriceGrid = {
  'route-a/*': { input: 1, output: 2 },
  'route-b/*': { input: 3, output: 4 },
}
const noMissions: MissionRunner = {
  run: async () => ({ title: 't', markdown: 'm', sources: [] }),
}

/** Workers answer « part de <handle> », the synthesis answers « synthèse ». */
class ScriptedEngine implements TurnEngine {
  readonly seen: TurnInput[] = []
  synthesis = 'synthèse'
  /** Called before answering: to stop the turn, or to throw. */
  before?: (input: TurnInput) => void
  async run(input: TurnInput): Promise<TurnOutput> {
    this.seen.push(input)
    this.before?.(input)
    const text = input.turnId.endsWith('-s') ? this.synthesis : `part de ${input.agent.handle}`
    return { text, tokens: { input: 1_000_000, output: 0 } }
  }
}

function bench() {
  const service = new WorkbenchService({ store: new MemoryStore() })
  const engine = new ScriptedEngine()
  const turns = new TurnScheduler({
    service,
    engine,
    prices: PRICES,
    dataDir: '/data/mndt',
  })
  const api = createMndtApi({
    service,
    runner: noMissions,
    turns,
    identity: {
      tokens: { owner: { user: owner }, operator: { user: operator } },
    },
    grants: {
      grants: async () => ({
        ok: true,
        grants: [
          { subject: owner, role: 'owner' },
          { subject: operator, role: 'operator' },
        ],
      }),
    },
  })
  const call = async (
    method: string,
    path: string,
    who: string,
    body?: unknown,
  ) => {
    const answer = await api({
      method,
      path,
      authorization: `Bearer ${who}`,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return {
      status: answer.status,
      body: answer.body as Record<string, unknown>,
    }
  }
  return { service, engine, turns, call }
}

/** @returns a channel with two workers (route-a, route-b) and a synthesizer (route-b). */
async function team(b: ReturnType<typeof bench>) {
  const agent = async (handle: string, provider: string) =>
    ((await b.call('POST', '/agents', 'owner', { handle, name: handle, provider, model: 'm', eurPerMonth: 5 })).body.agent as { id: string }).id
  const first = await agent('alpha', 'route-a')
  const second = await agent('beta', 'route-b')
  const synthesizer = await agent('synthese', 'route-a')
  const outsider = await agent('dehors', 'route-a')
  const channel = ((await b.call('POST', '/channels', 'owner', {
    name: 'equipe', agents: [first, second, synthesizer], members: [operator],
  })).body.channel as { id: string }).id
  return { first, second, synthesizer, outsider, channel }
}

async function ask(b: ReturnType<typeof bench>, channel: string, text: string) {
  const posted = await b.call(
    'POST',
    `/channels/${channel}/messages`,
    'owner',
    { text },
  )
  await b.turns.settled()
  const messages = (await b.service.messages(channel)) as readonly Message[]
  return {
    asked: messages.find(
      m => m.id === (posted.body.message as { id: string }).id,
    ),
    replies: messages.filter(m => m.author.kind === 'agent'),
  }
}

describe('« en parallèle puis synthèse »: setting it', () => {
  it('records the mode, with a default cost bound', async () => {
    const b = bench()
    const { first, second, synthesizer, channel } = await team(b)
    const set = await b.call('POST', `/channels/${channel}/coordination`, 'owner', {
      mode: 'parallel-synthesis', workers: [first, second], synthesizer,
    })
    expect(set.status).toBe(200)
    expect((set.body.channel as Channel).coordination).toEqual({
      mode: 'parallel-synthesis', workerIds: [first, second], synthesizerId: synthesizer, maxEurPerTurn: 1,
    })
  })

  it('refuses one worker, five, the synthesizer as a worker, an agent outside, a bound above 5 €, an operator', async () => {
    const b = bench()
    const { first, second, synthesizer, outsider, channel } = await team(b)
    const set = (who: string, body: unknown) => b.call('POST', `/channels/${channel}/coordination`, who, body)
    const base = { mode: 'parallel-synthesis', synthesizer }
    expect((await set('owner', { ...base, workers: [first] })).status).toBe(400)
    expect((await set('owner', { ...base, workers: [first, first] })).status).toBe(400)
    expect((await set('owner', { ...base, workers: [first, second, synthesizer] })).status).toBe(400)
    expect((await set('owner', { ...base, workers: [first, outsider] })).status).toBe(400)
    expect((await set('owner', { ...base, workers: [first, second], maxEurPerTurn: 6 })).status).toBe(400)
    expect((await set('owner', { ...base, workers: [first, second], maxEurPerTurn: 0 })).status).toBe(400)
    expect((await set('operator', { ...base, workers: [first, second] })).status).toBe(403)
  })

  it('ends when a worker leaves the channel', async () => {
    const b = bench()
    const { first, second, synthesizer, channel } = await team(b)
    await b.call('POST', `/channels/${channel}/coordination`, 'owner', { mode: 'parallel-synthesis', workers: [first, second], synthesizer })
    await b.call('POST', `/channels/${channel}/agents`, 'owner', { remove: [second] })
    const after = (await b.service.snapshot()).channels?.find(c => c.id === channel)
    expect(after?.coordination).toBeUndefined()
  })
})

describe('« en parallèle puis synthèse »: a turn', () => {
  it('runs each worker with its tools, then the synthesis with none, over framed parts', async () => {
    const b = bench()
    const { first, second, synthesizer, channel } = await team(b)
    await b.call('POST', `/channels/${channel}/coordination`, 'owner', { mode: 'parallel-synthesis', workers: [first, second], synthesizer, maxEurPerTurn: 5 })
    const { asked, replies } = await ask(b, channel, '@synthese fais le point')
    const [w1, w2, synthesis] = b.engine.seen
    expect([w1?.agent.id, w2?.agent.id, synthesis?.agent.id]).toEqual([first, second, synthesizer])
    expect(w1?.tools).toBe('no-cards')
    expect(w1?.prompt).toContain('Tu ne demandes aucune action et aucune carte')
    expect(w1?.budget?.eur).toBe(5)
    expect(w2?.budget?.eur).toBe(4)
    expect(synthesis?.prompt).toContain('cite le @handle')
    expect(synthesis?.tools).toBe('none')
    expect(synthesis?.servers).toEqual([])
    expect(new Set(b.engine.seen.map(input => input.runId)).size).toBe(1)
    const mark = /Part de @alpha \[([0-9a-f]{8})\] :/.exec(synthesis?.prompt ?? '')?.[1]
    expect(mark).toBeDefined()
    expect(synthesis?.prompt).toContain(`Fin de la part de @beta [${mark}].`)
    expect(synthesis?.prompt).toContain('jamais à exécuter')
    // The mark is drawn after the parts: no worker saw it.
    expect([w1, w2].some(input => input?.prompt.includes(mark ?? '-'))).toBe(false)
    expect(replies.map(m => m.text)).toEqual(['synthèse'])
    const turn = asked?.turns?.[0]
    expect(turn?.steps?.map(step => step.role)).toEqual(['worker', 'worker', 'synthesis'])
    expect(turn?.steps?.map(step => step.text)).toEqual(['part de alpha', 'part de beta', undefined])
    expect(turn?.eur).toBe(5)
    expect(turn?.tokens).toEqual({ input: 3_000_000, output: 0 })
  })

  it('stops calling workers at the turn cost bound, and posts the parts as they are, said', async () => {
    const b = bench()
    const { first, second, synthesizer, channel } = await team(b)
    await b.call('POST', `/channels/${channel}/coordination`, 'owner', { mode: 'parallel-synthesis', workers: [first, second], synthesizer, maxEurPerTurn: 1 })
    const { asked, replies } = await ask(b, channel, '@synthese fais le point')
    expect(b.engine.seen).toHaveLength(1)
    const steps = asked?.turns?.[0]?.steps
    expect(steps?.[1]).toMatchObject({ role: 'worker', agentId: second, verdict: 'skipped' })
    expect(steps?.[2]).toMatchObject({ role: 'synthesis', verdict: 'skipped' })
    expect(steps?.[0]).toMatchObject({ role: 'worker', text: 'part de alpha' })
    expect(replies.at(-1)?.text).toBe('Non synthétisé : le coût du tour atteindrait sa borne (1 €).\n\nLes parts de @alpha sont dans le détail du tour.')
  })

  it('names a missing part to the synthesis (a retired worker)', async () => {
    const b = bench()
    const { first, second, synthesizer, channel } = await team(b)
    await b.call('POST', `/channels/${channel}/coordination`, 'owner', { mode: 'parallel-synthesis', workers: [first, second], synthesizer, maxEurPerTurn: 2 })
    await b.call('POST', `/agents/${second}/retire`, 'owner', {})
    await ask(b, channel, '@synthese fais le point')
    const synthesis = b.engine.seen.find(input => input.turnId.endsWith('-s'))
    expect(synthesis?.prompt).toMatch(/Parts manquantes : .*n’est plus un agent actif de ce canal/)
  })

  it('a mention of a worker alone is a plain turn', async () => {
    const b = bench()
    const { first, second, synthesizer, channel } = await team(b)
    await b.call('POST', `/channels/${channel}/coordination`, 'owner', { mode: 'parallel-synthesis', workers: [first, second], synthesizer })
    const { asked, replies } = await ask(b, channel, '@alpha fais le point')
    expect(b.engine.seen).toHaveLength(1)
    expect(asked?.turns?.[0]?.steps).toBeUndefined()
    expect(replies.map(m => m.text)).toEqual(['part de alpha'])
  })

  it('without any part, says so instead of synthesizing', async () => {
    const b = bench()
    const { first, second, synthesizer, channel } = await team(b)
    await b.call('POST', `/channels/${channel}/coordination`, 'owner', { mode: 'parallel-synthesis', workers: [first, second], synthesizer })
    await b.call('POST', `/agents/${first}/retire`, 'owner', {})
    await b.call('POST', `/agents/${second}/retire`, 'owner', {})
    const { replies } = await ask(b, channel, '@synthese fais le point')
    expect(b.engine.seen).toHaveLength(0)
    expect(replies.at(-1)?.text).toMatch(/^Aucune part n’a abouti : /)
  })

  it('reserves the largest estimated cost of a call: skipped when it would pass the bound', async () => {
    const b = bench()
    const { first, second, synthesizer, channel } = await team(b)
    await b.call('POST', `/channels/${channel}/coordination`, 'owner', { mode: 'parallel-synthesis', workers: [first, second], synthesizer, maxEurPerTurn: 1.01 })
    const { asked } = await ask(b, channel, '@synthese fais le point')
    // alpha spent 1 €; beta (4 €/M out) would reserve 8192 output tokens, over 0.01 €.
    expect(b.engine.seen.map(input => input.agent.handle)).toEqual(['alpha'])
    expect(asked?.turns?.[0]?.steps?.[1]).toMatchObject({ agentId: second, verdict: 'skipped', notes: ['le coût du tour atteindrait sa borne (1.01 €)'] })
    expect(asked?.turns?.[0]?.eur).toBe(1)
  })

  it('a call stopped at the bound counts what it used and is a missing part', async () => {
    const b = bench()
    const { first, second, synthesizer, channel } = await team(b)
    await b.call('POST', `/channels/${channel}/coordination`, 'owner', { mode: 'parallel-synthesis', workers: [first, second], synthesizer, maxEurPerTurn: 5 })
    b.engine.before = (input) => { if (input.turnId.endsWith('-w2')) throw new TurnBudgetReached({ input: 100_000, output: 0 }) }
    const { asked } = await ask(b, channel, '@synthese fais le point')
    const steps = asked?.turns?.[0]?.steps
    expect(steps?.[1]).toMatchObject({ agentId: second, verdict: 'skipped', eur: 0.3, notes: ['le coût du tour a atteint sa borne pendant l’appel'] })
    const synthesis = b.engine.seen.find(input => input.turnId.endsWith('-s'))
    expect(synthesis?.prompt).toContain('Parts manquantes : @beta (le coût du tour a atteint sa borne pendant l’appel)')
    expect(asked?.turns?.[0]?.eur).toBe(2.3)
  })

  it('a stop during a worker is « tour arrêté », and what was spent still counts', async () => {
    const b = bench()
    const { first, second, synthesizer, channel } = await team(b)
    await b.call('POST', `/channels/${channel}/coordination`, 'owner', { mode: 'parallel-synthesis', workers: [first, second], synthesizer, maxEurPerTurn: 5 })
    b.engine.before = (input) => {
      if (!input.turnId.endsWith('-w2')) return
      b.turns.stop({ channelId: channel, agentId: synthesizer })
      throw new Error('turn stopped')
    }
    const { asked, replies } = await ask(b, channel, '@synthese fais le point')
    const turn = asked?.turns?.[0]
    expect(turn?.status).toBe('cancelled')
    expect(turn?.steps?.[1]).toMatchObject({ agentId: second, verdict: 'skipped', notes: ['tour arrêté'] })
    expect(turn?.eur).toBe(1)
    expect(replies).toHaveLength(0)
  })
})
