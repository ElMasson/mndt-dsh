/**
 * A finished briefing is published in the lane of the one who ran it (decision
 * of 24/11): the team page has no other place where the owner reads it. A
 * system message carrying the mission: its text is the model's report when it
 * is done, the host's short line when it failed. The lane is private: no other
 * member reads it. Off on a solo workstation.
 */
import { describe, expect, it } from 'vitest'
import { MemoryStore, WorkbenchService } from '../src/core/index.ts'
import type { Message } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import { runAutomation } from '../src/automations.ts'

const owner = 'duke@datanalysis.re'
const member = 'smarion@datanalysis.re'

function bench(briefingsInLane = true) {
  const service = new WorkbenchService({ store: new MemoryStore(), briefingsInLane })
  const api = createMndtApi({
    service,
    runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
    identity: { tokens: { owner: { user: owner }, member: { user: member } } },
    grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }, { subject: member, role: 'operator' }] }) },
  })
  const read = async (who: string, channelId: string) => {
    const answer = await api({ method: 'GET', path: `/channels/${channelId}/messages`, query: {}, authorization: `Bearer ${who}` })
    return { status: answer.status, messages: ((answer.body as { messages?: Message[] }).messages ?? []) }
  }
  const missionMessages = async () => ((await service.snapshot()).messages ?? []).filter(message => message.mission !== undefined)
  return { service, read, missionMessages }
}

async function briefing(service: WorkbenchService, createdBy = owner, kind: 'briefing' | 'custom' = 'briefing') {
  const mission = await service.createMission({ kind, prompt: 'Briefing du jour', createdBy, visibility: 'private' })
  return service.startMission(mission.id, 'sess')
}

describe('a finished briefing in its owner\'s lane', () => {
  it('done: the report, as a system message carrying the mission, in the owner\'s lane only', async () => {
    const b = bench()
    const started = await briefing(b.service)
    await b.service.completeMission(started.id, {
      title: 'Briefing', markdown: '## Priorités\n- Relancer Orange', sources: [],
      tokens: { input: 1000, output: 200 }, eur: 0.0123, toolsUnavailable: ['workbench_facts'],
    })
    const lane = await b.service.laneOf(owner)
    const seen = await b.read('owner', lane.id)
    expect(seen.status).toBe(200)
    const published = seen.messages.filter(message => message.mission !== undefined)
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      author: { kind: 'system' },
      text: '## Priorités\n- Relancer Orange',
      mentions: [],
      mission: { id: started.id, kind: 'briefing', title: 'Briefing', status: 'done', eur: 0.0123, toolsUnavailable: ['workbench_facts'] },
    })
    expect(published[0]?.turns).toBeUndefined()
    // Another member reads neither the owner's lane nor the report in their own.
    expect((await b.read('member', lane.id)).status).not.toBe(200)
    const theirs = await b.service.laneOf(member)
    expect((await b.read('member', theirs.id)).messages.filter(message => message.mission !== undefined)).toEqual([])
  })

  it('failed: the host\'s sentence and its kind, never the runtime\'s words; those are journaled only', async () => {
    const b = bench()
    const started = await briefing(b.service)
    const raw = 'the agent turn ended max-tokens (provider req_8f2c internal shard eu-3)'
    await b.service.failMission(started.id, raw)
    const [published] = await b.missionMessages()
    expect(published).toMatchObject({
      author: { kind: 'system' },
      text: 'Le briefing n’a pas abouti : réponse coupée (limite de longueur atteinte).',
      mission: { id: started.id, status: 'failed', title: 'Briefing', reasonKind: 'cut' },
    })
    expect(JSON.stringify(published)).not.toContain('req_8f2c')
    expect(published?.mission?.eur).toBeUndefined()
    expect(published?.channelId).toBe((await b.service.laneOf(owner)).id)
    // The runtime's words stay in the journal, for the operator.
    expect((await b.service.snapshot()).events.find(event => event.action === 'mission.failed')?.detail).toBe(raw)
  })

  it('each kind of failure gets its sentence: no answer, tools, a restart, anything else', async () => {
    const cases: [string, string, string][] = [
      ['the agent returned no text (settled: {})', 'no-answer', 'le modèle n’a pas répondu.'],
      ['outils indisponibles : workbench_facts (démarrage en cours ou connecteur en panne) ; la mission n’a pas été lancée', 'tools', 'des outils n’étaient pas disponibles ; il n’a pas été lancé.'],
      ['interrupted by a workbench restart; no result was produced', 'failed', 'interrompu par un redémarrage.'],
      ['the agent turn failed: 502 Bad Gateway from upstream 10.0.3.7', 'failed', 'erreur pendant l’exécution.'],
    ]
    for (const [raw, kind, sentence] of cases) {
      const b = bench()
      const started = await briefing(b.service)
      await b.service.failMission(started.id, raw)
      const [published] = await b.missionMessages()
      expect([published?.mission?.reasonKind, published?.text]).toEqual([kind, `Le briefing n’a pas abouti : ${sentence}`])
    }
  })

  it('an empty answer fails the mission, and the lane says so: never an empty report', async () => {
    const b = bench()
    const started = await briefing(b.service)
    await expect(b.service.completeMission(started.id, { title: 'Briefing', markdown: '  ', sources: [] })).rejects.toThrow('no usable content')
    const published = await b.missionMessages()
    expect(published.map(message => [message.mission?.status, message.mission?.reasonKind, message.text]))
      .toEqual([['failed', 'no-answer', 'Le briefing n’a pas abouti : le modèle n’a pas répondu.']])
  })

  it('a cancelled briefing says who cancelled it', async () => {
    const b = bench()
    const started = await briefing(b.service)
    await b.service.cancelMission(started.id, owner, true)
    expect((await b.missionMessages()).map(message => [message.mission?.reasonKind, message.text]))
      .toEqual([['cancelled', `Le briefing n’a pas abouti : annulé par ${owner}.`]])
  })

  it('an automation\'s briefing carries its name, in the lane of the owner it ran for (the lane created if absent)', async () => {
    const b = bench()
    const runner = { run: async () => ({ title: 'Briefing', markdown: 'Rien d’urgent ce matin.', sources: [] }) }
    const item = { id: 'auto_briefing', name: 'Briefing du matin', kind: 'briefing' as const, prompt: 'Briefing', at: '07:30', enabled: true, createdBy: 'scheduler' }
    const outcome = await runAutomation(b.service, runner, item as never, owner)
    expect(outcome.outcome).toBe('done')
    const [published] = await b.missionMessages()
    expect(published).toMatchObject({ text: 'Rien d’urgent ce matin.', mission: { title: 'Briefing du matin', status: 'done' } })
    expect(published?.channelId).toBe((await b.service.laneOf(owner)).id)
  })

  it('nothing for another kind of mission, for a run under no person, nor on a solo workstation', async () => {
    const team = bench()
    const custom = await briefing(team.service, owner, 'custom')
    await team.service.completeMission(custom.id, { title: 'Point', markdown: 'ok', sources: [] })
    const scheduled = await briefing(team.service, 'scheduler')
    await team.service.completeMission(scheduled.id, { title: 'Briefing', markdown: 'ok', sources: [] })
    expect(await team.missionMessages()).toEqual([])
    const solo = bench(false)
    const run = await briefing(solo.service)
    await solo.service.completeMission(run.id, { title: 'Briefing', markdown: 'ok', sources: [] })
    expect(await solo.missionMessages()).toEqual([])
  })
})
