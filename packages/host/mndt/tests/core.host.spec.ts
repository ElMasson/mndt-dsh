import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/core/store.ts'
import { WorkbenchService } from '../src/core/service.ts'

/** A service with a predictable clock and ids. */
function bench(): WorkbenchService {
  let counter = 0
  return new WorkbenchService({
    store: new MemoryStore(),
    now: () => new Date('2026-10-24T08:00:00.000Z'),
    nextId: prefix => `${prefix}_${(counter += 1)}`,
  })
}

const owner = 'duke@datanalysis.re'

describe('missions', () => {
  it('queues a mission with the requester and its instruction', async () => {
    const workbench = bench()
    const mission = await workbench.createMission({ kind: 'briefing', prompt: 'Prepare the morning briefing', createdBy: owner })

    expect(mission).toMatchObject({ id: 'mis_1', kind: 'briefing', status: 'queued', createdBy: owner, visibility: 'team' })
  })

  it('refuses a mission without an instruction', async () => {
    const workbench = bench()
    await expect(workbench.createMission({ kind: 'briefing', prompt: '   ', createdBy: owner }))
      .rejects.toThrow('a mission needs an instruction')
  })

  it('refuses an unknown kind', async () => {
    const workbench = bench()
    await expect(workbench.createMission({ kind: 'horoscope' as never, prompt: 'x', createdBy: 'a' }))
      .rejects.toThrow('unknown mission kind')
  })

  it('runs a mission through a session and produces a brief', async () => {
    const workbench = bench()
    const mission = await workbench.createMission({ kind: 'briefing', prompt: 'Morning', createdBy: owner })
    await workbench.startMission(mission.id, 'session-1')
    const { mission: finished, brief } = await workbench.completeMission(mission.id, {
      title: 'Morning briefing',
      markdown: 'Three things matter today.',
      sources: [{ connector: 'mail', ref: 'm-1', label: 'Mail, 08:01' }],
      tokens: { input: 1200, output: 80 },
    })

    expect(finished).toMatchObject({ status: 'done', briefId: brief.id, tokens: { input: 1200, output: 80 } })
    expect(brief).toMatchObject({ status: 'draft', missionId: mission.id, createdBy: owner })
    expect(await workbench.listBriefs()).toHaveLength(1)
  })

  it('turns an empty result into an honest failure, never an empty success', async () => {
    const workbench = bench()
    const mission = await workbench.createMission({ kind: 'briefing', prompt: 'Morning', createdBy: owner })
    await workbench.startMission(mission.id, 'session-1')

    await expect(workbench.completeMission(mission.id, { title: 'Brief', markdown: '  ' }))
      .rejects.toThrow('produced no usable content')

    const stored = await workbench.getMission(mission.id)
    expect(stored?.status).toBe('failed')
    expect(stored?.error).toContain('no usable content')
    expect(await workbench.listBriefs()).toHaveLength(0)
  })

  it('records the runtime reason when a run fails', async () => {
    const workbench = bench()
    const mission = await workbench.createMission({ kind: 'account-review', prompt: 'Review', createdBy: owner })
    await workbench.startMission(mission.id, 'session-1')
    const failed = await workbench.failMission(mission.id, 'the agent turn failed: model refused')

    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('the agent turn failed: model refused')
  })

  it('refuses to finish a mission that never started', async () => {
    const workbench = bench()
    const mission = await workbench.createMission({ kind: 'briefing', prompt: 'Morning', createdBy: owner })
    await expect(workbench.completeMission(mission.id, { title: 'T', markdown: 'M' }))
      .rejects.toThrow('only a running mission can finish')
  })
})

describe('approvals', () => {
  it('holds an external action until a person decides', async () => {
    const workbench = bench()
    const approval = await workbench.requestApproval({
      kind: 'send-email',
      title: 'Relance facture 2026-014',
      payload: { to: 'client@example.com', subject: 'Facture échue' },
      requestedBy: owner,
    })

    expect(approval.state).toBe('pending')
    expect(await workbench.listApprovals('pending')).toHaveLength(1)

    const decided = await workbench.decideApproval(approval.id, owner, 'approved')
    expect(decided).toMatchObject({ state: 'approved', decidedBy: owner })
    expect(await workbench.listApprovals('pending')).toHaveLength(0)
  })

  it('needs a reason to reject, and only decides once', async () => {
    const workbench = bench()
    const approval = await workbench.requestApproval({ kind: 'publish', title: 'Publier le brief', requestedBy: 'a@b.c' })

    await expect(workbench.decideApproval(approval.id, 'a@b.c', 'rejected')).rejects.toThrow('a rejection needs a reason')
    await workbench.decideApproval(approval.id, 'a@b.c', 'rejected', 'trop tôt')
    await expect(workbench.decideApproval(approval.id, 'a@b.c', 'approved')).rejects.toThrow('already rejected')
  })
})

describe('memory and history', () => {
  it('keeps notes by scope and reads them newest first', async () => {
    const workbench = bench()
    await workbench.remember({ scope: 'team', kind: 'decision', text: 'Le point quotidien est à 8h30.', createdBy: owner })
    await workbench.remember({ scope: 'user', kind: 'preference', text: 'Tutoiement dans les mails internes.', createdBy: owner })

    const team = await workbench.recall({ scope: 'team' })
    expect(team).toHaveLength(1)
    expect(team[0]?.text).toContain('8h30')
  })

  it('writes the history of what happened', async () => {
    const workbench = bench()
    const mission = await workbench.createMission({ kind: 'briefing', prompt: 'Morning', createdBy: owner })
    await workbench.startMission(mission.id, 'session-1')
    await workbench.completeMission(mission.id, { title: 'B', markdown: 'M' })

    expect((await workbench.events()).map(event => event.action)).toEqual(['mission.queued', 'mission.started', 'mission.done'])
  })
})
