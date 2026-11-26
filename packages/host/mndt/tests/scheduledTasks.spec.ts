/**
 * Scheduled tasks, PR 1 (design of 25/11): an agent proposes a recurring task
 * as a card (propose_schedule), a decider approves it from a screen that shows
 * it whole, the task is created exactly as proposed; it is read where it
 * publishes, and paused, resumed or deleted by who may. Nothing runs yet.
 */
import { describe, expect, it } from 'vitest'
import { checkedCadence, checkedScheduleProposal, MemoryStore, nextRuns, runsThisMonth, ScheduleRefusal, WorkbenchService } from '../src/core/index.ts'
import type { Channel } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import type { TurnScheduler } from '../src/turns.ts'

const owner = 'duke@datanalysis.re'
const operator = 'operateur@datanalysis.re'
const viewer = 'smarion@datanalysis.re'
const outsider = 'contact@datanalysis.re'
const admin = 'jadmin@datanalysis.re'
const ZONE = 'Indian/Reunion'

describe('a cadence and its runs, in the instance\'s zone', () => {
  it('a week, a day, a month, a cron: the next three runs', () => {
    const from = new Date('2026-11-25T10:00:00Z') // a Wednesday, 14:00 at La Réunion
    const runs = (cadence: unknown) => nextRuns(checkedCadence(cadence), from, ZONE).map(run => run.toISOString())
    expect(runs({ every: 'week', days: [1], at: '08:00' })).toEqual(['2026-11-30T04:00:00.000Z', '2026-12-07T04:00:00.000Z', '2026-12-14T04:00:00.000Z'])
    expect(runs({ every: 'day', at: '07:30' })).toEqual(['2026-11-26T03:30:00.000Z', '2026-11-27T03:30:00.000Z', '2026-11-28T03:30:00.000Z'])
    expect(runs({ every: 'month', monthDay: 1, at: '09:00' })).toEqual(['2026-12-01T05:00:00.000Z', '2027-01-01T05:00:00.000Z', '2027-02-01T05:00:00.000Z'])
    expect(runs({ cron: '30 7 * * 1-5' })).toEqual(['2026-11-26T03:30:00.000Z', '2026-11-27T03:30:00.000Z', '2026-11-30T03:30:00.000Z'])
    expect(runsThisMonth(checkedCadence({ cron: '30 7 * * 1-5' }), from, ZONE)).toBe(21)
  })

  it('a change of offset never runs one instant twice (02:00 and 03:00 on the day summer time starts)', () => {
    const start = new Date('2027-03-27T12:00:00Z')
    const twice = nextRuns(checkedCadence({ cron: '0 2,3 * * *' }), start, 'Europe/Paris', 4).map(run => run.getTime())
    expect(new Set(twice).size).toBe(twice.length)
    const hourly = nextRuns(checkedCadence({ cron: '0 * * * *' }), start, 'Europe/Paris', 48).map(run => run.getTime())
    expect(new Set(hourly).size).toBe(hourly.length)
    expect(hourly.every((at, index) => index === 0 || at > (hourly[index - 1] ?? 0))).toBe(true)
  })

  it('a month of an hourly cron builds no formatter once its zone has one (building one is what cost 0.7 s)', () => {
    const cadence = checkedCadence({ cron: '0 * * * *' })
    runsThisMonth(cadence, new Date('2026-11-25T10:00:00Z'), ZONE)
    const Real = Intl.DateTimeFormat
    let built = 0
    const counting = function (this: unknown, ...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
      built += 1
      return new Real(...args)
    } as unknown as typeof Intl.DateTimeFormat
    Intl.DateTimeFormat = counting
    try {
      expect(runsThisMonth(cadence, new Date('2026-11-25T10:00:00Z'), ZONE)).toBe(720)
    } finally {
      Intl.DateTimeFormat = Real
    }
    expect(built).toBe(0)
  })

  it('a zone with summer time keeps the wall-clock time', () => {
    const runs = nextRuns(checkedCadence({ every: 'day', at: '08:00' }), new Date('2027-03-27T12:00:00Z'), 'Europe/Paris').map(run => run.toISOString())
    expect(runs).toEqual(['2027-03-28T06:00:00.000Z', '2027-03-29T06:00:00.000Z', '2027-03-30T06:00:00.000Z'])
  })

  it('refuses a cadence that is malformed, or runs more than once an hour', () => {
    const code = (cadence: unknown): string => {
      try { checkedCadence(cadence); return 'accepted' } catch (error) { return error instanceof ScheduleRefusal ? error.code : 'other' }
    }
    expect(code({ cron: '*/5 * * * *' })).toBe('cadence-too-frequent')
    expect(code({ cron: '0,30 * * * *' })).toBe('cadence-too-frequent')
    expect(code({ cron: '0 * * * *' })).toBe('accepted')
    expect(code({ every: 'week', days: [], at: '08:00' })).toBe('schedule-invalid')
    expect(code({ every: 'month', monthDay: 31, at: '08:00' })).toBe('schedule-invalid')
    expect(code({ every: 'day', at: '8h' })).toBe('schedule-invalid')
    expect(code({ cron: '0 25 * * *' })).toBe('schedule-invalid')
  })

  it('a proposal: its agent and destination are the host\'s; its bounds are checked', () => {
    const destination = { kind: 'channel' as const, channelId: 'chn_1' }
    const checked = checkedScheduleProposal({ title: '  Relance\n des   impayés ', instructions: 'Fais le point.', cadence: { every: 'day', at: '08:00' }, agentId: 'agt_other' }, 'agt_turn', destination)
    expect(checked).toMatchObject({ title: 'Relance des impayés', agentId: 'agt_turn', destination, eurPerRun: 0.5 })
    for (const eurPerRun of [50, 5.01, 0.005, 0, -1, Number.NaN]) {
      const asked = { title: 'x', instructions: 'y', cadence: { every: 'day', at: '08:00' }, eurPerRun }
      expect(() => checkedScheduleProposal(asked, 'a', destination)).toThrow(ScheduleRefusal)
    }
    for (const eurPerRun of [0.01, 5]) {
      expect(checkedScheduleProposal({ title: 'x', instructions: 'y', cadence: { every: 'day', at: '08:00' }, eurPerRun }, 'a', destination).eurPerRun).toBe(eurPerRun)
    }
    expect(() => checkedScheduleProposal({ title: '', instructions: 'y', cadence: { every: 'day', at: '08:00' } }, 'a', destination)).toThrow(ScheduleRefusal)
  })
})

/** @returns the API over four people, an agent, and a turn the test makes « running ». */
async function bench() {
  let running: { turnId: string; channelId: string; messageId: string; agent: { id: string; handle: string } } | undefined
  const turns = { current: () => running, launch: () => undefined, stop: () => undefined } as unknown as TurnScheduler
  const service = new WorkbenchService({ store: new MemoryStore() })
  const api = createMndtApi({
    service,
    runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
    turns,
    timeZone: ZONE,
    identity: {
      tokens: {
        owner: { user: owner }, operator: { user: operator }, viewer: { user: viewer },
        outsider: { user: outsider }, admin: { user: admin },
      },
    },
    grants: {
      grants: async () => ({
        ok: true,
        grants: [
          { subject: owner, role: 'owner' }, { subject: operator, role: 'operator' }, { subject: viewer, role: 'viewer' },
          { subject: outsider, role: 'viewer' }, { subject: admin, role: 'admin' },
        ],
      }),
    },
  })
  type Query = Record<string, string>
  const call = async (method: string, path: string, who: string, body?: unknown, headers?: Record<string, string>, query: Query = {}) => {
    const answer = await api({ method, path, query, authorization: `Bearer ${who}`, ...(headers === undefined ? {} : { headers }), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: answer.status, body: answer.body as Record<string, unknown> }
  }
  const agent = ((await call('POST', '/agents', 'owner', { handle: 'compta', name: 'Compta', provider: 'scaleway-genapi', model: 'deepseek-v4.1-flash', eurPerMonth: 5 })).body.agent as { id: string })
  const channel = (await call('POST', '/channels', 'owner', { name: 'finances', members: [operator, viewer] })).body.channel as Channel
  const run = (channelId: string): void => { running = { turnId: 'run_1', channelId, messageId: 'msg_1', agent: { id: agent.id, handle: 'compta' } } }
  const propose = (schedule: unknown, who = 'operator') => call('POST', '/approvals', who, { kind: 'propose_schedule', payload: {}, schedule }, { 'x-mndt-run': 'run_1' })
  return { service, call, agent, channel, run, propose }
}

const WEEKLY = { title: 'Relance des impayés', instructions: 'Fais le point des factures impayées.', cadence: { every: 'week', days: [1], at: '08:00' }, eurPerRun: 0.4 }

describe('a propose_schedule card', () => {
  it('is asked from a channel turn only; the host names its agent, its destination and its title', async () => {
    const b = await bench()
    expect((await b.propose(WEEKLY)).status).toBe(400)
    b.run(b.channel.id)
    const card = await b.propose({ ...WEEKLY, agentId: 'agt_forged', destination: { kind: 'channel', channelId: 'chn_forged' } })
    expect(card.status).toBe(201)
    expect(card.body.approval).toMatchObject({
      kind: 'propose_schedule', title: 'Tâche : Relance des impayés', channelId: b.channel.id,
      scheduleProposal: { agentId: b.agent.id, destination: { kind: 'channel', channelId: b.channel.id }, eurPerRun: 0.4 },
    })
    // Pending, it says its next three runs and the zone they are in.
    const cards = (await b.call('GET', '/approvals', 'owner')).body.approvals as Record<string, unknown>[]
    const runs = [expect.stringMatching(/T04:00:00/), expect.any(String), expect.any(String)]
    expect(cards[0]).toMatchObject({ nextRuns: runs, timeZone: ZONE })
  })

  it('a turn in a lane proposes a task for that lane\'s person', async () => {
    const b = await bench()
    const lane = await b.service.laneOf(operator)
    b.run(lane.id)
    const card = await b.propose(WEEKLY)
    expect((card.body.approval as { scheduleProposal: unknown }).scheduleProposal).toMatchObject({ destination: { kind: 'lane', member: operator } })
  })

  it('a malformed or too frequent cadence is refused with its code, nothing is asked', async () => {
    const b = await bench()
    b.run(b.channel.id)
    const tooFrequent = await b.propose({ ...WEEKLY, cadence: { cron: '*/10 * * * *' } })
    expect(tooFrequent).toMatchObject({ status: 400, body: { code: 'cadence-too-frequent' } })
    expect((await b.propose({ ...WEEKLY, cadence: { every: 'week', days: [9], at: '08:00' } })).body.code).toBe('schedule-invalid')
    expect(((await b.call('GET', '/approvals', 'owner')).body.approvals as unknown[]).length).toBe(0)
  })

  it('is approved from a screen that shows it whole: without the header, 409 shows-proposal-required', async () => {
    const b = await bench()
    b.run(b.channel.id)
    const id = ((await b.propose(WEEKLY)).body.approval as { id: string }).id
    const blind = await b.call('POST', `/approvals/${id}/decide`, 'owner', { decision: 'approved' })
    expect(blind).toMatchObject({ status: 409, body: { code: 'shows-proposal-required' } })
    const approved = await b.call('POST', `/approvals/${id}/decide`, 'owner', { decision: 'approved' }, { 'x-mndt-shows-proposal': '1' })
    expect(approved.status).toBe(200)
    expect(approved.body.schedule).toMatchObject({
      title: 'Relance des impayés', state: 'active', agentId: b.agent.id, requestedBy: operator, approvedBy: owner,
      destination: { kind: 'channel', channelId: b.channel.id }, timeZone: ZONE, missed: 0, eurThisMonth: 0,
    })
  })
})

describe('a task, once approved', () => {
  async function approved() {
    const b = await bench()
    b.run(b.channel.id)
    const id = ((await b.propose(WEEKLY)).body.approval as { id: string }).id
    const schedule = (await b.call('POST', `/approvals/${id}/decide`, 'owner', { decision: 'approved' }, { 'x-mndt-shows-proposal': '1' })).body.schedule as { id: string }
    return { ...b, scheduleId: schedule.id }
  }
  const list = async (b: Awaited<ReturnType<typeof approved>>, who: string, query: Record<string, string> = {}) =>
    ((await b.call('GET', '/schedules', who, undefined, undefined, query)).body.schedules as Record<string, unknown>[])

  it('is read where it publishes and by its requester, never by someone else; its gestures follow the reader', async () => {
    const b = await approved()
    expect((await list(b, 'owner', { channelId: b.channel.id })).map(s => s.id)).toEqual([b.scheduleId])
    const [asRequester] = await list(b, 'operator')
    expect(asRequester).toMatchObject({ can: { pause: true, resume: false, delete: true } })
    const [asMember] = await list(b, 'viewer')
    expect(asMember).toMatchObject({ can: { pause: false, resume: false, delete: false } })
    expect(await list(b, 'outsider')).toEqual([])
    const [served] = await list(b, 'owner', { agentId: b.agent.id })
    expect(served?.nextRuns).toHaveLength(3)
    expect(served?.eurPerMonthMax).toBeGreaterThan(0)
    expect(served?.approvalId).toBeUndefined()
  })

  it('its requester pauses it; only a decider resumes it; who may deletes it', async () => {
    const b = await approved()
    const paused = await b.call('POST', `/schedules/${b.scheduleId}/pause`, 'operator')
    expect(paused.body.schedule).toMatchObject({ state: 'paused', pausedBecause: 'owner', nextRuns: [], can: { resume: false } })
    expect(await b.call('POST', `/schedules/${b.scheduleId}/resume`, 'operator')).toMatchObject({ status: 403, body: { code: 'not-allowed' } })
    expect((await b.call('POST', `/schedules/${b.scheduleId}/resume`, 'owner')).body.schedule).toMatchObject({ state: 'active' })
    expect(await b.call('POST', `/schedules/${b.scheduleId}/pause`, 'viewer')).toMatchObject({ status: 403, body: { code: 'not-allowed' } })
    expect((await b.call('DELETE', `/schedules/${b.scheduleId}`, 'outsider')).status).toBe(404)
    expect((await b.call('DELETE', `/schedules/${b.scheduleId}`, 'operator')).body).toEqual({ deleted: b.scheduleId })
    expect(await list(b, 'owner')).toEqual([])
  })

  it('its journal lines are read by its destination\'s members, never by someone else', async () => {
    const b = await approved()
    const lines = async (who: string) => ((await b.call('GET', '/events', who)).body.events as { action: string }[]).filter(event => event.action.startsWith('schedule.'))
    expect((await lines('viewer')).map(event => event.action)).toEqual(['schedule.created'])
    expect(await lines('outsider')).toEqual([])
  })
})

describe('the readers of a task and of its journal lines are one rule', () => {
  /** @returns a task approved from a turn in the lane of `who`, and the bench. */
  async function laneTask(who: string) {
    const b = await bench()
    const lane = await b.service.laneOf(who)
    b.run(lane.id)
    const card = await b.propose(WEEKLY, who === operator ? 'operator' : who === admin ? 'admin' : 'owner')
    const id = (card.body.approval as { id: string }).id
    const approved = await b.call('POST', `/approvals/${id}/decide`, 'owner', { decision: 'approved' }, { 'x-mndt-shows-proposal': '1' })
    return { ...b, lane, approved, scheduleId: (approved.body.schedule as { id: string } | undefined)?.id }
  }
  const lines = async (b: Awaited<ReturnType<typeof bench>>, who: string) =>
    ((await b.call('GET', '/events', who)).body.events as { action: string; subject?: string }[]).filter(event => event.action.startsWith('schedule.'))
  const tasks = async (b: Awaited<ReturnType<typeof bench>>, who: string) => ((await b.call('GET', '/schedules', who)).body.schedules as unknown[]).length

  it('an operator\'s lane (no decider in it): its person, the owner and an admin read it; another member does not', async () => {
    const b = await laneTask(operator)
    expect(b.approved.status).toBe(200)
    for (const who of ['operator', 'owner', 'admin']) {
      expect(await tasks(b, who)).toBe(1)
      expect((await lines(b, who)).map(event => event.action)).toEqual(['schedule.created'])
    }
    for (const who of ['viewer', 'outsider']) {
      expect(await tasks(b, who)).toBe(0)
      expect(await lines(b, who)).toEqual([])
    }
  })

  it('a decider\'s own lane: only that decider reads it, never another decider, the owner included', async () => {
    const b = await bench()
    const lane = await b.service.laneOf(admin)
    b.run(lane.id)
    const card = await b.propose(WEEKLY, 'admin')
    const id = (card.body.approval as { id: string }).id
    // Its card does not rise to the owner either (the lane has a decider: its person).
    expect((await b.call('POST', `/approvals/${id}/decide`, 'owner', { decision: 'approved' }, { 'x-mndt-shows-proposal': '1' })).status).toBe(404)
    expect((await b.call('POST', `/approvals/${id}/decide`, 'admin', { decision: 'approved' }, { 'x-mndt-shows-proposal': '1' })).status).toBe(200)
    expect(await tasks(b, 'admin')).toBe(1)
    expect(await tasks(b, 'owner')).toBe(0)
    expect(await lines(b, 'owner')).toEqual([])
  })

  it('a channel with a decider among its members: an admin outside it reads neither the task nor its lines', async () => {
    const b = await bench()
    b.run(b.channel.id)
    const id = ((await b.propose(WEEKLY)).body.approval as { id: string }).id
    await b.call('POST', `/approvals/${id}/decide`, 'owner', { decision: 'approved' }, { 'x-mndt-shows-proposal': '1' })
    expect(await tasks(b, 'admin')).toBe(0)
    expect(await lines(b, 'admin')).toEqual([])
    expect(await tasks(b, 'viewer')).toBe(1)
  })

  it('a deleted task: its readers at the time still read the line that says so; it is served nowhere', async () => {
    const b = await laneTask(operator)
    expect((await b.call('DELETE', `/schedules/${b.scheduleId}`, 'operator')).status).toBe(200)
    expect((await lines(b, 'operator')).map(event => event.action)).toEqual(['schedule.created', 'schedule.deleted'])
    expect((await lines(b, 'owner')).map(event => event.action)).toEqual(['schedule.created', 'schedule.deleted'])
    expect(await lines(b, 'viewer')).toEqual([])
    expect(await tasks(b, 'operator')).toBe(0)
    expect((await b.call('POST', `/schedules/${b.scheduleId}/pause`, 'operator')).status).toBe(404)
  })

  it('a lane task names its person no more than its card already does (requestedBy, served by #153)', async () => {
    const b = await laneTask(operator)
    // The card risen to the owner already names who asked it; in a lane, that is its only member.
    const card = ((await b.call('GET', '/approvals', 'owner', undefined, undefined, { state: 'all' })).body.approvals as Record<string, unknown>[])
      .find(row => row.kind === 'propose_schedule') as { requestedBy: string; scheduleProposal: { destination: { member?: string } } }
    expect(card.scheduleProposal.destination.member).toBe(card.requestedBy)
    const [task] = (await b.call('GET', '/schedules', 'owner')).body.schedules as { requestedBy: string; destination: { member?: string } }[]
    expect(task?.destination.member).toBe(task?.requestedBy)
    expect(task?.requestedBy).toBe(operator)
  })

  it('the card risen from a lane serves its own content, nothing of the lane', async () => {
    const b = await bench()
    const lane = await b.service.laneOf(operator)
    await b.service.postMessage(lane.id, operator, 'Note privée sur les impayés de Martin')
    b.run(lane.id)
    await b.propose(WEEKLY)
    const served = JSON.stringify((await b.call('GET', '/approvals', 'owner', undefined, undefined, { state: 'pending', mine: '1' })).body)
    expect(served).toContain('Relance des impayés')
    expect(served).not.toContain(lane.title)
    expect(served).not.toContain('Note privée')
    expect(served).not.toContain(lane.name)
  })
})

describe('a pause of the host is never covered by a person\'s', () => {
  it('a task paused after three failures stays so, with its reason, when its requester pauses it', async () => {
    const store = new MemoryStore()
    const service = new WorkbenchService({ store })
    const lane = await service.laneOf(operator)
    const schedule = {
      id: 'sch_1', title: 'Relance', instructions: 'Point', cadence: { every: 'day' as const, at: '08:00' }, agentId: 'agt_1',
      destination: { kind: 'lane' as const, member: operator }, eurPerRun: 0.5, state: 'paused' as const, pausedBecause: 'failures' as const,
      requestedBy: operator, approvedBy: owner, approvedAt: '2026-11-25T00:00:00.000Z', approvalId: 'apr_1', failures: 3,
    }
    await store.save({ ...(await service.snapshot()), schedules: [schedule] })
    const fresh = new WorkbenchService({ store })
    expect(lane.id).toBeDefined()
    const kept = await fresh.changeSchedule('sch_1', 'pause', operator)
    expect(kept).toMatchObject({ state: 'paused', pausedBecause: 'failures' })
    expect(((await fresh.snapshot()).events).filter(event => event.action === 'schedule.paused')).toEqual([])
  })
})

describe('the other proposals say their code too', () => {
  it('propose_agent without the header: 409 shows-proposal-required', async () => {
    const b = await bench()
    const card = await b.call('POST', '/approvals', 'owner', { kind: 'propose_agent', payload: {}, proposal: { name: 'Veille', handle: 'veille', provider: 'scaleway-genapi', model: 'deepseek-v4.1-flash' } })
    const id = (card.body.approval as { id: string }).id
    expect(await b.call('POST', `/approvals/${id}/decide`, 'owner', { decision: 'approved' })).toMatchObject({ status: 409, body: { code: 'shows-proposal-required' } })
  })
})
