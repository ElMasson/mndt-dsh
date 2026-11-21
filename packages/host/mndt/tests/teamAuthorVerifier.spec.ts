import { describe, expect, it } from 'vitest'
import {
  MemoryStore,
  WorkbenchService,
  parseVerdict,
  spentThisMonth,
} from '../src/core/index.ts'
import type { Message, PriceGrid } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import type { MissionRunner } from '../src/api.ts'
import { TurnScheduler } from '../src/turns.ts'
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

/** An engine whose answers are scripted by role: the draft, the verdict, the revision. */
class ScriptedEngine implements TurnEngine {
  readonly seen: TurnInput[] = []
  verdict = '{"ok": true}'
  async run(input: TurnInput): Promise<TurnOutput> {
    this.seen.push(input)
    const role = input.turnId.endsWith('-v')
      ? 'verifier'
      : input.turnId.endsWith('-r')
        ? 'revision'
        : 'author'
    const text =
      role === 'verifier'
        ? this.verdict
        : role === 'revision'
          ? 'réponse corrigée'
          : 'premier brouillon'
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

/** @returns a channel with an author on route-a and a verifier on route-b, coordinated. */
async function team(b: ReturnType<typeof bench>, verifierRoute = 'route-b') {
  const agent = async (handle: string, provider: string) =>
    (
      (
        await b.call('POST', '/agents', 'owner', {
          handle,
          name: handle,
          provider,
          model: 'm',
          eurPerMonth: 5,
        })
      ).body.agent as { id: string }
    ).id
  const author = await agent('auteur', 'route-a')
  const verifier = await agent('verif', verifierRoute)
  const channel = (
    (
      await b.call('POST', '/channels', 'owner', {
        name: 'equipe',
        agents: [author, verifier],
        members: [operator],
      })
    ).body.channel as { id: string }
  ).id
  return { author, verifier, channel }
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

describe("« auteur puis vérificateur »: a host script, not a model's choice", () => {
  it('is set by owners and admins, with two active agents of the channel running different models', async () => {
    const b = bench()
    const { author, verifier, channel } = await team(b)
    expect(
      (
        await b.call('POST', `/channels/${channel}/coordination`, 'operator', {
          mode: 'author-verifier',
          author,
          verifier,
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await b.call('POST', `/channels/${channel}/coordination`, 'owner', {
          mode: 'author-verifier',
          author,
          verifier: author,
        })
      ).status,
    ).toBe(400)
    const set = await b.call(
      'POST',
      `/channels/${channel}/coordination`,
      'owner',
      { mode: 'author-verifier', author, verifier },
    )
    expect(set.status).toBe(200)
    expect(
      (set.body.channel as { coordination: unknown }).coordination,
    ).toEqual({
      mode: 'author-verifier',
      authorId: author,
      verifierId: verifier,
    })
    const solo = await b.call(
      'POST',
      `/channels/${channel}/coordination`,
      'owner',
      { mode: 'solo' },
    )
    expect(
      (solo.body.channel as { coordination?: unknown }).coordination,
    ).toBeUndefined()
  })

  it('refuses a verifier of the same model: a model rarely catches its own mistakes', async () => {
    const b = bench()
    const { author, verifier, channel } = await team(b, 'route-a')
    const refused = await b.call(
      'POST',
      `/channels/${channel}/coordination`,
      'owner',
      { mode: 'author-verifier', author, verifier },
    )
    expect(refused.status).toBe(400)
    expect(String(refused.body.error)).toContain(
      'another model than the author',
    )
  })

  it('posts the draft when the verifier finds nothing, each step priced for its own agent', async () => {
    const b = bench()
    const { author, verifier, channel } = await team(b)
    await b.call('POST', `/channels/${channel}/coordination`, 'owner', {
      mode: 'author-verifier',
      author,
      verifier,
    })
    const { asked, replies } = await ask(b, channel, '@auteur fais le point')
    expect(replies.map(m => m.text)).toEqual(['premier brouillon'])
    const turn = asked?.turns?.[0]
    expect(
      turn?.steps?.map(step => [
        step.role,
        step.agentId,
        step.verdict ?? null,
      ]),
    ).toEqual([
      ['author', author, null],
      ['verifier', verifier, 'ok'],
    ])
    // One million input tokens: 1 € on route-a for the author, 3 € on route-b for the verifier.
    expect(turn?.eur).toBe(4)
    const messages = (await b.service.snapshot()).messages ?? []
    const now = new Date().toISOString()
    expect([
      spentThisMonth(messages, author, now),
      spentThisMonth(messages, verifier, now),
    ]).toEqual([1, 3])
  })

  it("has the author correct once, from the verifier's points, and posts the correction only", async () => {
    const b = bench()
    const { author, verifier, channel } = await team(b)
    await b.call('POST', `/channels/${channel}/coordination`, 'owner', {
      mode: 'author-verifier',
      author,
      verifier,
    })
    b.engine.verdict =
      'Voici: {"ok": false, "issues": ["le montant de mars manque"]}'
    const { asked, replies } = await ask(b, channel, '@auteur fais le point')
    expect(replies.map(m => m.text)).toEqual(['réponse corrigée'])
    expect(asked?.turns?.[0]?.steps?.map(step => step.role)).toEqual([
      'author',
      'verifier',
      'revision',
    ])
    expect(asked?.turns?.[0]?.steps?.[1]?.notes).toEqual([
      'le montant de mars manque',
    ])
    const revisionPrompt =
      b.engine.seen.find(input => input.turnId.endsWith('-r'))?.prompt ?? ''
    expect(revisionPrompt).toContain('- le montant de mars manque')
    expect(revisionPrompt).toContain('premier brouillon')
    expect(b.engine.seen).toHaveLength(3)
  })

  it('says an unreadable verdict and keeps the draft; a mention of the verifier alone is a plain turn', async () => {
    const b = bench()
    const { author, verifier, channel } = await team(b)
    await b.call('POST', `/channels/${channel}/coordination`, 'owner', {
      mode: 'author-verifier',
      author,
      verifier,
    })
    b.engine.verdict = 'Tout me semble correct.'
    const first = await ask(b, channel, '@auteur fais le point')
    expect(first.asked?.turns?.[0]?.steps?.[1]?.verdict).toBe('unreadable')
    expect(first.replies.map(m => m.text)).toEqual(['premier brouillon'])
    const plain = await ask(b, channel, '@verif un avis ?')
    expect(plain.asked?.turns?.[0]?.steps).toBeUndefined()
  })

  it('ends when the verifier leaves the channel', async () => {
    const b = bench()
    const { author, verifier, channel } = await team(b)
    await b.call('POST', `/channels/${channel}/coordination`, 'owner', {
      mode: 'author-verifier',
      author,
      verifier,
    })
    const left = await b.call('POST', `/channels/${channel}/agents`, 'owner', {
      remove: [verifier],
    })
    expect(
      (left.body.channel as { coordination?: unknown }).coordination,
    ).toBeUndefined()
  })
})

describe("the verifier's own ceiling", () => {
  it('skips the check when the verifier reached its ceiling, says why, and posts the draft', async () => {
    const b = bench()
    const { author, verifier, channel } = await team(b)
    await b.call('POST', `/agents/${verifier}`, 'owner', { eurPerMonth: 2 })
    await b.call('POST', `/channels/${channel}/coordination`, 'owner', { mode: 'author-verifier', author, verifier })
    await ask(b, channel, '@auteur premier point') // the verifier spends 3 € of its 2 €
    const second = await ask(b, channel, '@auteur second point')
    const step = second.asked?.turns?.[0]?.steps?.[1]
    expect(step?.verdict).toBe('skipped')
    expect(step?.notes?.[0]).toBeTruthy()
    expect(second.replies.at(-1)?.text).toBe('premier brouillon')
  })
})

describe('reading a verdict: structure only', () => {
  it('reads ok, issues, and anything else as unreadable', () => {
    expect(parseVerdict('{"ok": true}')).toEqual({ kind: 'ok' })
    expect(
      parseVerdict('```json\n{"ok": false, "issues": ["a", "", 3, "b"]}\n```'),
    ).toEqual({ kind: 'issues', issues: ['a', 'b'] })
    expect(parseVerdict('{"ok": false}')).toEqual({ kind: 'unreadable' })
    expect(parseVerdict('oui')).toEqual({ kind: 'unreadable' })
    expect(parseVerdict('{ cassé')).toEqual({ kind: 'unreadable' })
  })
})
