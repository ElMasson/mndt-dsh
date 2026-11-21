import { describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import type { MissionRunner, ModelChoice } from '../src/api.ts'
import { modelChoices } from '../src/gateway.ts'

const owner = 'duke@datanalysis.re'
const admin = 'jadmin@datanalysis.re'
const operator = 'operateur@datanalysis.re'
const viewer = 'smarion@datanalysis.re'
const noMissions: MissionRunner = {
  run: async () => ({ title: 't', markdown: 'm', sources: [] }),
}

/** @returns the API over a team of four roles, with two priced models. */
function bench() {
  const models: ModelChoice[] = [
    {
      provider: 'scaleway-genapi',
      model: 'deepseek-v4.1-flash',
      label: 'Rapide',
      kind: 'rapide',
      eur: { input: 0.6, output: 1.8 },
    },
  ]
  const api = createMndtApi({
    service: new WorkbenchService({ store: new MemoryStore() }),
    runner: noMissions,
    identity: {
      tokens: {
        owner: { user: owner },
        admin: { user: admin },
        operator: { user: operator },
        viewer: { user: viewer },
      },
    },
    grants: {
      grants: async () => ({
        ok: true,
        grants: [
          { subject: owner, role: 'owner' },
          { subject: admin, role: 'admin' },
          { subject: operator, role: 'operator' },
          { subject: viewer, role: 'viewer' },
        ],
      }),
    },
    models: async () => models,
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
  return { call, models }
}

const draft = {
  handle: 'recouvrement',
  name: 'Recouvrement',
  provider: 'scaleway-genapi',
  model: 'deepseek-v4.1-flash',
  eurPerMonth: 5,
}

describe('the models an agent may be given (GET /models)', () => {
  it('serves the priced routes to any member of the team', async () => {
    const { call, models } = bench()
    for (const who of ['owner', 'viewer']) {
      const answer = await call('GET', '/models', who)
      expect(answer.status).toBe(200)
      expect(answer.body.models).toEqual(models)
    }
  })

  it('reads them from the price grid: three buttons, the H100 model from its environment, a null price kept null', () => {
    const grid = {
      'scaleway-genapi/deepseek-v4.1-flash': {
        input: 0.6,
        cacheRead: 0.12,
        output: 1.8,
      },
      'scaleway-genapi/glm-5.3': { input: 1.8, output: 5.5 },
      'vllm-qwen/*': { input: 0, output: 0 },
      'scaleway-genapi/new-model': null,
    }
    expect(modelChoices(grid, 'Qwen/Qwen3.8-27B')).toEqual([
      {
        provider: 'scaleway-genapi',
        model: 'deepseek-v4.1-flash',
        label: 'Rapide',
        kind: 'rapide',
        eur: { input: 0.6, output: 1.8 },
      },
      {
        provider: 'scaleway-genapi',
        model: 'glm-5.3',
        label: 'Analyse',
        kind: 'analyse',
        eur: { input: 1.8, output: 5.5 },
      },
      {
        provider: 'vllm-qwen',
        model: 'Qwen/Qwen3.8-27B',
        label: 'Qwen local',
        kind: 'local',
        eur: { input: 0, output: 0 },
      },
      {
        provider: 'scaleway-genapi',
        model: 'new-model',
        label: 'new-model',
        kind: 'other',
        eur: null,
      },
    ])
    // Without its model in model.env, the H100 route is not offered at all.
    expect(
      modelChoices(grid, undefined).map(choice => choice.provider),
    ).not.toContain('vllm-qwen')
    expect(
      modelChoices(grid, '  ').map(choice => choice.provider),
    ).not.toContain('vllm-qwen')
  })
})

describe('creating, changing and retiring an agent: owners and admins only', () => {
  it('refuses an operator and a viewer, serves an owner and an admin', async () => {
    const { call } = bench()
    for (const who of ['operator', 'viewer']) {
      const refused = await call('POST', '/agents', who, draft)
      expect(refused.status, who).toBe(403)
      expect(String(refused.body.error), who).toContain('rights.write')
    }
    const created = await call('POST', '/agents', 'admin', draft)
    expect(created.status).toBe(201)
    const id = (created.body.agent as { id: string }).id
    expect(
      (await call('POST', `/agents/${id}`, 'operator', { name: 'Autre' }))
        .status,
    ).toBe(403)
    expect(
      (
        await call('POST', `/agents/${id}`, 'owner', {
          name: 'Recouvrement clients',
        })
      ).status,
    ).toBe(200)
  })

  it('retires an agent: kept for the record, gone from the list, never added again, said in the journal', async () => {
    const { call } = bench()
    const id = (
      (await call('POST', '/agents', 'owner', draft)).body.agent as {
        id: string
      }
    ).id
    expect(
      (await call('POST', `/agents/${id}/retire`, 'operator')).status,
    ).toBe(403)
    const retired = await call('POST', `/agents/${id}/retire`, 'admin')
    expect(retired.status).toBe(200)
    expect(retired.body.agent).toMatchObject({ id, retiredBy: admin })
    expect(
      typeof (retired.body.agent as { retiredAt?: unknown }).retiredAt,
    ).toBe('string')
    const listed = (await call('GET', '/agents', 'owner')).body.agents as {
      id: string
    }[]
    expect(listed.map(agent => agent.id)).not.toContain(id)
    // Retiring twice is refused; a channel cannot take it back.
    expect((await call('POST', `/agents/${id}/retire`, 'admin')).status).toBe(
      400,
    )
    const channel = await call('POST', '/channels', 'owner', {
      name: 'relances',
      agents: [id],
    })
    expect(channel.status).toBeGreaterThanOrEqual(400)
    const events = (await call('GET', '/events', 'owner')).body.events as {
      action: string
      subject: string
      actor: string
    }[]
    expect(
      events.find(event => event.action === 'agent.retired'),
    ).toMatchObject({ subject: id, actor: admin })
    expect(
      (await call('POST', '/agents/agt_nobody/retire', 'admin')).status,
    ).toBe(404)
  })
})

describe('the ceiling and the framing of a new agent', () => {
  it('gives a ceiling above 5 € to the owner only, and 50 € a month at most to anyone', async () => {
    const { call } = bench()
    const above = await call('POST', '/agents', 'admin', { ...draft, handle: 'cher', eurPerMonth: 20 })
    expect(above.status).toBe(400)
    expect(String(above.body.error)).toContain('only the owner gives an agent a ceiling above 5')
    expect((await call('POST', '/agents', 'admin', { ...draft, handle: 'borne', eurPerMonth: 5 })).status).toBe(201)
    expect((await call('POST', '/agents', 'admin', { ...draft, handle: 'petit', eurPerMonth: 2 })).status).toBe(201)
    expect((await call('POST', '/agents', 'owner', { ...draft, handle: 'vingt', eurPerMonth: 20 })).status).toBe(201)
    for (const who of ['owner', 'admin']) {
      const tooMuch = await call('POST', '/agents', who, { ...draft, handle: `trop-${who}`, eurPerMonth: 10000 })
      expect(tooMuch.status, who).toBe(400)
      expect(String(tooMuch.body.error), who).toContain('50 € at most')
    }
    // A change keeps the same bound.
    const id = ((await call('POST', '/agents', 'owner', { ...draft, handle: 'change' })).body.agent as { id: string }).id
    expect((await call('POST', `/agents/${id}`, 'owner', { eurPerMonth: 51 })).status).toBe(400)
  })

  it('bounds the instructions at 2,000 characters, added to every turn', async () => {
    const { call } = bench()
    expect((await call('POST', '/agents', 'owner', { ...draft, handle: 'long', instructions: 'x'.repeat(2000) })).status).toBe(201)
    const tooLong = await call('POST', '/agents', 'owner', { ...draft, handle: 'trop-long', instructions: 'x'.repeat(2001) })
    expect(tooLong.status).toBe(400)
    expect(String(tooLong.body.error)).toContain('2000 characters at most')
    const id = ((await call('POST', '/agents', 'owner', { ...draft, handle: 'court' })).body.agent as { id: string }).id
    expect((await call('POST', `/agents/${id}`, 'owner', { instructions: 'y'.repeat(2001) })).status).toBe(400)
  })
})

describe('an agent proposed on a card (propose_agent), created when an owner or an admin approves it', () => {
  const proposal = { name: 'Recouvrement', handle: 'recouvrement', provider: 'scaleway-genapi', model: 'deepseek-v4.1-flash', instructions: 'Suit les impayés.' }
  const propose = (call: ReturnType<typeof bench>['call'], body: Record<string, unknown>, who = 'owner') =>
    call('POST', '/approvals', who, { kind: 'propose_agent', payload: {}, ...body })

  it('records the proposal, titled, and creates nothing before the approval', async () => {
    const { call } = bench()
    const card = await propose(call, { proposal })
    expect(card.status).toBe(201)
    expect(card.body.approval).toMatchObject({ kind: 'propose_agent', title: "Créer l'agent Recouvrement", state: 'pending', proposal })
    expect(((await call('GET', '/agents', 'owner')).body.agents as unknown[]).length).toBe(0)
  })

  it('checks the proposal when the card is made, with the rules of POST /agents', async () => {
    const { call } = bench()
    for (const bad of [{ ...proposal, handle: 'Pas Un Slug' }, { ...proposal, instructions: 'x'.repeat(2001) }, { ...proposal, eurPerMonth: 51 }, { ...proposal, model: '' }]) {
      expect((await propose(call, { proposal: bad })).status, JSON.stringify(bad)).toBe(400)
    }
    expect((await propose(call, {})).status).toBe(400)
  })

  it('creates the agent from the recorded proposal, never from what the approver sends, in one write', async () => {
    const { call } = bench()
    const id = ((await propose(call, { proposal })).body.approval as { id: string }).id
    const approved = await call('POST', `/approvals/${id}/decide`, 'admin', { decision: 'approved', proposal: { ...proposal, handle: 'autre', eurPerMonth: 40 } })
    expect(approved.status).toBe(200)
    const agent = approved.body.agent as { id: string; handle: string; eurPerMonth: number; createdBy: string; instructions?: string }
    expect(agent).toMatchObject({ handle: 'recouvrement', eurPerMonth: 5, createdBy: admin, instructions: 'Suit les impayés.' })
    expect(approved.body.approval).toMatchObject({ state: 'approved', decidedBy: admin, agentId: agent.id })
    const listed = (await call('GET', '/agents', 'owner')).body.agents as { handle: string }[]
    expect(listed.map(a => a.handle)).toEqual(['recouvrement'])
    // Decided once.
    expect((await call('POST', `/approvals/${id}/decide`, 'owner', { decision: 'approved' })).status).toBe(400)
  })

  it('is decided by owners and admins only; a ceiling above 5 € needs the owner; a refusal leaves the card pending', async () => {
    const { call } = bench()
    const id = ((await propose(call, { proposal: { ...proposal, handle: 'cher', eurPerMonth: 20 } })).body.approval as { id: string }).id
    // An operator neither reads nor decides it: unreadable reads as absent.
    expect((await call('POST', `/approvals/${id}/decide`, 'operator', { decision: 'approved' })).status).toBe(404)
    const byAdmin = await call('POST', `/approvals/${id}/decide`, 'admin', { decision: 'approved' })
    expect(byAdmin.status).toBe(400)
    expect(String(byAdmin.body.error)).toContain('only the owner gives an agent a ceiling above 5')
    const pending = (await call('GET', '/approvals', 'owner')).body.approvals as { id: string; state: string }[]
    expect(pending.find(card => card.id === id)?.state).toBe('pending')
    expect(((await call('GET', '/agents', 'owner')).body.agents as unknown[]).length).toBe(0)
    const byOwner = await call('POST', `/approvals/${id}/decide`, 'owner', { decision: 'approved' })
    expect(byOwner.status).toBe(200)
    expect((byOwner.body.agent as { eurPerMonth: number }).eurPerMonth).toBe(20)
  })

  it('refuses a handle taken in the meantime, and a rejection creates nothing', async () => {
    const { call } = bench()
    const first = ((await propose(call, { proposal })).body.approval as { id: string }).id
    const second = ((await propose(call, { proposal })).body.approval as { id: string }).id
    expect((await call('POST', `/approvals/${first}/decide`, 'owner', { decision: 'approved' })).status).toBe(200)
    const taken = await call('POST', `/approvals/${second}/decide`, 'owner', { decision: 'approved' })
    expect(taken.status).toBe(400)
    expect(String(taken.body.error)).toContain('@recouvrement is taken')
    const rejected = await call('POST', `/approvals/${second}/decide`, 'owner', { decision: 'rejected', reason: 'doublon' })
    expect(rejected.status).toBe(200)
    expect(((await call('GET', '/agents', 'owner')).body.agents as unknown[]).length).toBe(1)
  })
})
