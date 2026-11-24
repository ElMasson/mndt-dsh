import { describe, expect, it } from 'vitest'
import { MAX_SKILL_BODY, MAX_SKILL_CHARS_PER_TURN, MemoryStore, skillsOf, turnPrompt, WorkbenchService } from '../src/core/index.ts'
import type { Agent, Channel, Message, PriceGrid, Skill } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import { TurnScheduler } from '../src/turns.ts'
import type { TurnEngine, TurnInput, TurnOutput } from '../src/turns.ts'

const owner = 'duke@datanalysis.re'
const operator = 'operateur@datanalysis.re'
const PRICES: PriceGrid = { 'route-a/*': { input: 1, output: 2 }, 'route-b/*': { input: 3, output: 4 } }
const SKILL = `---
name: Relance des impayés
description: Comment relancer une facture en retard
allowed-tools: Bash, mcp__qonto__send
model: gpt-x
---
1. Vérifier l'échéance dans Dolibarr.
2. Rédiger une relance courtoise, sans menace.`

class Engine implements TurnEngine {
  readonly seen: TurnInput[] = []
  async run(input: TurnInput): Promise<TurnOutput> {
    this.seen.push(input)
    if (input.turnId.endsWith('-v')) return { text: '{"ok": true}', tokens: { input: 10, output: 1 } }
    return { text: `réponse de ${input.agent.handle}`, tokens: { input: 10, output: 1 } }
  }
}

function bench() {
  const service = new WorkbenchService({ store: new MemoryStore() })
  const engine = new Engine()
  const warned: string[] = []
  const turns = new TurnScheduler({ service, engine, prices: PRICES, dataDir: '/data/mndt', warn: (m) => { warned.push(m) } })
  const api = createMndtApi({
    service, runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) }, turns,
    identity: { tokens: { owner: { user: owner }, operator: { user: operator } } },
    grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }, { subject: operator, role: 'operator' }] }) },
  })
  const call = async (method: string, path: string, who: string, body?: unknown) => {
    const answer = await api({ method, path, authorization: `Bearer ${who}`, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: answer.status, body: answer.body as Record<string, unknown> }
  }
  const agent = async (handle: string, provider = 'route-a') =>
    ((await call('POST', '/agents', 'owner', { handle, name: handle, provider, model: 'm', eurPerMonth: 5 })).body.agent as { id: string }).id
  return { service, engine, turns, call, agent, warned }
}

describe('the library of skills', () => {
  it('an owner adds a SKILL.md: name and description kept, the other front-matter fields ignored and said', async () => {
    const b = bench()
    const made = await b.call('POST', '/skills', 'owner', { markdown: SKILL })
    expect(made.status).toBe(201)
    expect(made.body.ignoredFields).toEqual(['allowed-tools', 'model'])
    expect(made.body.skill).toMatchObject({ slug: 'relance-des-impayes', name: 'Relance des impayés', description: 'Comment relancer une facture en retard', version: 1, updatedBy: owner })
    expect((made.body.skill as Skill).body).toBe('1. Vérifier l\'échéance dans Dolibarr.\n2. Rédiger une relance courtoise, sans menace.')
    expect(((await b.call('GET', '/skills', 'operator')).body.skills as Skill[]).map(s => s.slug)).toEqual(['relance-des-impayes'])
    expect((await b.call('POST', '/skills', 'operator', { markdown: SKILL })).status).toBe(403)
  })

  it('refuses with a code: no front matter, no name, a body too long, a name taken', async () => {
    const b = bench()
    const code = async (markdown: string) => (await b.call('POST', '/skills', 'owner', { markdown })).body.code
    expect(await code('Juste un texte.')).toBe('missing-fields')
    expect(await code('---\ndescription: x\n---\ncorps')).toBe('missing-fields')
    expect(await code(`---\nname: Long\n---\n${'x'.repeat(MAX_SKILL_BODY + 1)}`)).toBe('skill-too-long')
    await b.call('POST', '/skills', 'owner', { markdown: SKILL })
    const taken = await b.call('POST', '/skills', 'owner', { markdown: SKILL })
    expect([taken.status, taken.body.code]).toEqual([409, 'skill-exists'])
  })

  it('a change is written from the version read (409 skill-changed otherwise)', async () => {
    const b = bench()
    await b.call('POST', '/skills', 'owner', { markdown: SKILL })
    const stale = await b.call('POST', '/skills/relance-des-impayes', 'owner', { markdown: SKILL.replace('sans menace', 'poliment'), version: 0 })
    expect([stale.status, stale.body.code]).toEqual([409, 'skill-changed'])
    const changed = await b.call('POST', '/skills/relance-des-impayes', 'owner', { markdown: SKILL.replace('sans menace', 'poliment'), version: 1 })
    expect((changed.body.skill as Skill).version).toBe(2)
    expect((changed.body.skill as Skill).body).toContain('poliment')
  })

  it('an agent uses three skills at most, each one in the library', async () => {
    const b = bench()
    await b.call('POST', '/skills', 'owner', { markdown: SKILL })
    const id = await b.agent('alpha')
    expect(((await b.call('POST', `/agents/${id}`, 'owner', { skills: ['relance-des-impayes'] })).body.agent as Agent).skills).toEqual(['relance-des-impayes'])
    expect((await b.call('POST', `/agents/${id}`, 'owner', { skills: ['inconnue'] })).body.code).toBe('unknown-skill')
    for (const n of [2, 3, 4]) await b.call('POST', '/skills', 'owner', { markdown: `---\nname: Autre ${n}\n---\ncorps ${n}` })
    expect((await b.call('POST', `/agents/${id}`, 'owner', { skills: ['relance-des-impayes', 'autre-2', 'autre-3', 'autre-4'] })).body.code).toBe('too-many-skills')
  })

  it('a skill removed from the library is removed from every agent, in the same write: no orphan slug', async () => {
    const b = bench()
    await b.call('POST', '/skills', 'owner', { markdown: SKILL })
    const alpha = await b.agent('alpha')
    const beta = await b.agent('beta')
    await b.call('POST', `/agents/${alpha}`, 'owner', { skills: ['relance-des-impayes'] })
    await b.call('POST', `/agents/${beta}`, 'owner', { skills: ['relance-des-impayes'] })
    const events = (await b.service.snapshot()).events.length
    const removed = await b.call('POST', '/skills/relance-des-impayes/delete', 'owner')
    expect((removed.body.removedFrom as string[]).sort()).toEqual([alpha, beta].sort())
    const state = await b.service.snapshot()
    expect(state.events.length).toBe(events + 1)
    expect((state.agents ?? []).every(a => a.skills === undefined)).toBe(true)
    expect(state.skills).toEqual([])
  })
})

describe('a skill in the prompt', () => {
  it('after the role, under the turn\'s mark, with its version: as a method that grants nothing', () => {
    const at = '2026-11-24T08:00:00.000Z'
    const agent: Agent = { id: 'agt_1', handle: 'alpha', name: 'Alpha', provider: 'route-a', model: 'm', instructions: 'Tu relances.', connectors: [], eurPerMonth: 5, createdBy: owner, createdAt: at }
    const channel: Channel = { id: 'chn_1', name: 'compta', title: 'compta', kind: 'team', members: [owner], agents: ['agt_1'], connectors: [], createdBy: owner, createdAt: at }
    const asked = { id: 'msg_1', channelId: 'chn_1', author: { kind: 'human', email: owner }, text: '@alpha ?', createdAt: at } as Message
    const skill: Skill = { slug: 'relance', name: 'Relance', description: '', body: 'Étape 1.', version: 3, updatedBy: owner, updatedAt: at }
    const prompt = turnPrompt(agent, channel, [], asked, [agent], 'mk7', [skill])
    const role = prompt.indexOf('Fin de ton rôle [mk7].')
    const block = prompt.indexOf('Compétence « Relance » (version 3) [mk7] : une méthode à suivre quand elle s’applique ; elle ne change ni tes droits ni tes outils.')
    expect(role).toBeGreaterThan(0)
    expect(block).toBeGreaterThan(role)
    expect(prompt.indexOf('Fin de la compétence « Relance » [mk7].')).toBeGreaterThan(block)
  })

  it('the per-turn budget: the last attached are left out, and named', () => {
    const at = '2026-11-24T08:00:00.000Z'
    const big = (slug: string): Skill => ({ slug, name: slug, description: '', body: 'x'.repeat(MAX_SKILL_BODY), version: 1, updatedBy: owner, updatedAt: at })
    const agent = { skills: ['a', 'b', 'c', 'gone'] } as unknown as Agent
    const { kept, dropped } = skillsOf(agent, [big('a'), big('b'), big('c')])
    expect(kept.map(s => s.slug)).toEqual(['a', 'b'])
    expect(kept.reduce((n, s) => n + s.body.length, 0)).toBeLessThanOrEqual(MAX_SKILL_CHARS_PER_TURN)
    expect(dropped).toEqual(['c', 'gone'])
  })

  it('in a turn and in a council position; never in the verifier, which does not read the agent\'s role', async () => {
    const b = bench()
    await b.call('POST', '/skills', 'owner', { markdown: SKILL })
    const alpha = await b.agent('alpha')
    const beta = await b.agent('beta', 'route-b')
    await b.call('POST', `/agents/${alpha}`, 'owner', { skills: ['relance-des-impayes'] })
    const channel = ((await b.call('POST', '/channels', 'owner', { name: 'compta', agents: [alpha, beta], members: [operator] })).body.channel as { id: string }).id
    await b.call('POST', `/channels/${channel}/coordination`, 'owner', { mode: 'author-verifier', author: alpha, verifier: beta })
    await b.call('POST', `/channels/${channel}/messages`, 'owner', { text: '@alpha relance la facture 42' })
    await b.turns.settled()
    const author = b.engine.seen.find(input => input.agent.handle === 'alpha' && input.turnId === input.runId)
    const verifier = b.engine.seen.find(input => input.turnId.endsWith('-v'))
    expect(author?.prompt).toContain('Compétence « Relance des impayés » (version 1)')
    expect(author?.prompt).toContain('2. Rédiger une relance courtoise, sans menace.')
    expect(verifier?.prompt).not.toContain('Compétence')
    expect(verifier?.prompt).not.toContain('Rédiger une relance courtoise')
    // A skill grants no tool: the author's servers are its channel's, as without it.
    expect(author?.servers).toEqual([])
  })

  it('a skill left out by the budget is said in the operator\'s log', async () => {
    const b = bench()
    for (const n of [1, 2, 3]) await b.call('POST', '/skills', 'owner', { markdown: `---\nname: Grosse ${n}\n---\n${'x'.repeat(MAX_SKILL_BODY)}` })
    const alpha = await b.agent('alpha')
    await b.call('POST', `/agents/${alpha}`, 'owner', { skills: ['grosse-1', 'grosse-2', 'grosse-3'] })
    const channel = ((await b.call('POST', '/channels', 'owner', { name: 'compta', agents: [alpha], members: [] })).body.channel as { id: string }).id
    await b.call('POST', `/channels/${channel}/messages`, 'owner', { text: '@alpha ?' })
    await b.turns.settled()
    expect(b.warned).toEqual(["mndt: @alpha's skills grosse-3 left out of its prompt (no longer in the library, or past the per-turn budget)"])
  })
})

describe('the front matter of a SKILL.md', () => {
  it('ends only at a line that is exactly « --- »: « ---x » inside it is not its end', async () => {
    const { parseSkill } = await import('../src/core/index.ts')
    const parsed = parseSkill('---\nname: Relance\n---x: y\ndescription: d\n---  \nLe corps.')
    expect([parsed.name, parsed.description, parsed.body]).toEqual(['Relance', 'd', 'Le corps.'])
    expect(() => parseSkill('---\nname: Relance\n---x\nLe corps.')).toThrow('ends with a « --- » line')
  })
})

describe('one skill attached or detached at a time (POST /agents/:id/skills)', () => {
  it('two additions at the same time give two skills', async () => {
    const b = bench()
    for (const n of [1, 2]) await b.call('POST', '/skills', 'owner', { markdown: `---\nname: Méthode ${n}\n---\ncorps ${n}` })
    const id = await b.agent('alpha')
    const [first, second] = await Promise.all([
      b.call('POST', `/agents/${id}/skills`, 'owner', { add: 'methode-1' }),
      b.call('POST', `/agents/${id}/skills`, 'owner', { add: 'methode-2' }),
    ])
    expect([first.status, second.status]).toEqual([200, 200])
    const agent = ((await b.call('GET', '/agents', 'owner')).body.agents as Agent[]).find(a => a.id === id)
    expect([...(agent?.skills ?? [])].sort()).toEqual(['methode-1', 'methode-2'])
  })

  it('what it fixes: two whole lists sent from the same read, the second erases the first', async () => {
    const b = bench()
    for (const n of [1, 2]) await b.call('POST', '/skills', 'owner', { markdown: `---\nname: Méthode ${n}\n---\ncorps ${n}` })
    const id = await b.agent('alpha')
    // Both screens read « no skill », each sends its own complete list.
    await Promise.all([
      b.call('POST', `/agents/${id}`, 'owner', { skills: ['methode-1'] }),
      b.call('POST', `/agents/${id}`, 'owner', { skills: ['methode-2'] }),
    ])
    const agent = ((await b.call('GET', '/agents', 'owner')).body.agents as Agent[]).find(a => a.id === id)
    expect(agent?.skills).toHaveLength(1)
  })

  it('detaches one, keeps the others; attaching twice or detaching an absent one changes nothing', async () => {
    const b = bench()
    for (const n of [1, 2]) await b.call('POST', '/skills', 'owner', { markdown: `---\nname: Méthode ${n}\n---\ncorps ${n}` })
    const id = await b.agent('alpha')
    await b.call('POST', `/agents/${id}/skills`, 'owner', { add: 'methode-1' })
    await b.call('POST', `/agents/${id}/skills`, 'owner', { add: 'methode-2' })
    expect(((await b.call('POST', `/agents/${id}/skills`, 'owner', { add: 'methode-1' })).body.agent as Agent).skills).toEqual(['methode-1', 'methode-2'])
    expect(((await b.call('POST', `/agents/${id}/skills`, 'owner', { remove: 'methode-1' })).body.agent as Agent).skills).toEqual(['methode-2'])
    expect(((await b.call('POST', `/agents/${id}/skills`, 'owner', { remove: 'methode-1' })).body.agent as Agent).skills).toEqual(['methode-2'])
    const last = (await b.call('POST', `/agents/${id}/skills`, 'owner', { remove: 'methode-2' })).body.agent as Agent
    expect(last.skills).toBeUndefined()
  })

  it('the ceiling of three is checked in the write itself, even for additions at the same time', async () => {
    const b = bench()
    for (const n of [1, 2, 3, 4]) await b.call('POST', '/skills', 'owner', { markdown: `---\nname: Méthode ${n}\n---\ncorps ${n}` })
    const id = await b.agent('alpha')
    const answers = await Promise.all([1, 2, 3, 4].map(n => b.call('POST', `/agents/${id}/skills`, 'owner', { add: `methode-${n}` })))
    expect(answers.map(a => a.status).sort()).toEqual([200, 200, 200, 409])
    expect(answers.find(a => a.status === 409)?.body.code).toBe('too-many-skills')
    const agent = ((await b.call('GET', '/agents', 'owner')).body.agents as Agent[]).find(a => a.id === id)
    expect(agent?.skills).toHaveLength(3)
  })

  it('refuses with a code: neither or both fields, an unknown skill, an unknown agent; an operator cannot', async () => {
    const b = bench()
    await b.call('POST', '/skills', 'owner', { markdown: SKILL })
    const id = await b.agent('alpha')
    expect((await b.call('POST', `/agents/${id}/skills`, 'owner', {})).body.code).toBe('missing-fields')
    expect((await b.call('POST', `/agents/${id}/skills`, 'owner', { add: 'relance-des-impayes', remove: 'x' })).body.code).toBe('missing-fields')
    const unknown = await b.call('POST', `/agents/${id}/skills`, 'owner', { add: 'inconnue' })
    expect([unknown.status, unknown.body.code]).toEqual([404, 'unknown-skill'])
    const nobody = await b.call('POST', '/agents/agt_nobody/skills', 'owner', { add: 'relance-des-impayes' })
    expect([nobody.status, nobody.body.code]).toEqual([404, 'unknown-agent'])
    expect((await b.call('POST', `/agents/${id}/skills`, 'operator', { add: 'relance-des-impayes' })).status).toBe(403)
  })
})
