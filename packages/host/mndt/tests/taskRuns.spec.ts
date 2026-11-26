/**
 * Scheduled tasks, run (tasks PR 2): the slots of a task in the instance's
 * zone, the latest run within 15 minutes and the older ones missed; a run as a
 * turn of its agent, acting as its requester, its connectors as its
 * destination allows, bounded by its euros per run and its agent's ceiling;
 * the result published in its destination and recorded on the task; the
 * pauses the host makes; the deleted tasks forgotten after 90 days.
 */
import { describe, expect, it } from 'vitest'
import { isLaneOf, MemoryStore, spentThisMonth, WorkbenchService } from '../src/core/index.ts'
import type { Message, PriceGrid, Schedule, ScheduleProposal } from '../src/core/index.ts'
import { createMndtApi, scheduleSpentThisMonth } from '../src/api.ts'
import { CUT_BY_RESTART_TEXT, NO_RUN_TEXT, slotsOf, TaskScheduler } from '../src/task-runs.ts'
import type { TurnEngine, TurnInput, TurnOutput } from '../src/turns.ts'

const ZONE = 'Indian/Reunion'
const owner = 'duke@datanalysis.re'
const operator = 'jdoe@datanalysis.re'
const PRICES: PriceGrid = { 'route-a/*': { input: 1, output: 2 } }
/** 08:00 at La Réunion on a day of November 2026: 04:00 UTC. */
const reunion = (day: number, hour: number, minute: number): Date => new Date(Date.UTC(2026, 10, day, hour - 4, minute))

/** A fake engine: records each run, answers its text or throws its error. */
class Engine implements TurnEngine {
  readonly runs: TurnInput[] = []
  answer: () => TurnOutput = () => ({ text: 'Trois factures impayées : A, B, C.', tokens: { input: 1000, output: 100 } })
  async run(input: TurnInput): Promise<TurnOutput> {
    this.runs.push(input)
    return this.answer()
  }
}

/** @returns a service, an agent, a channel, a clock, and a way to approve a task. */
async function bench(options: { eurPerMonth?: number } = {}) {
  let clock = reunion(25, 9, 0)
  const service = new WorkbenchService({ store: new MemoryStore(), now: () => clock })
  const agent = await service.createAgent({
    handle: 'compta', name: 'Compta', provider: 'route-a', model: 'm', connectors: ['office365', 'attio'], eurPerMonth: options.eurPerMonth ?? 5,
  }, owner)
  const channel = await service.createChannel({ title: 'Finances', members: [operator], agents: [agent.id], connectors: ['attio'] }, owner)
  const engine = new Engine()
  const lines: string[] = []
  const tasks = new TaskScheduler({ service, engine, prices: PRICES, dataDir: '/tmp/mndt-task-runs', timeZone: ZONE, warn: (line) => { lines.push(line) }, now: () => clock })
  const approve = async (overrides: Partial<ScheduleProposal> = {}): Promise<Schedule> => {
    const proposal: ScheduleProposal = {
      title: 'Relance des impayés', instructions: 'Fais le point des factures impayées.', cadence: { every: 'day', at: '08:00' },
      agentId: agent.id, destination: { kind: 'channel', channelId: channel.id }, eurPerRun: 0.4, ...overrides,
    }
    const card = await service.requestApproval({ kind: 'propose_schedule', title: `Tâche : ${proposal.title}`, requestedBy: operator, channelId: channel.id, requestedByAgent: { id: agent.id, handle: agent.handle }, scheduleProposal: proposal })
    return (await service.approveScheduleProposal(card.id, owner)).schedule
  }
  const set = (date: Date): void => { clock = date }
  const pass = async (): Promise<void> => { await tasks.tick(); await tasks.settled() }
  const schedule = async (id: string): Promise<Schedule | undefined> =>
    ((await service.snapshot()).schedules ?? []).find(item => item.id === id)
  const runsIn = async (channelId: string): Promise<Message[]> => (await service.messages(channelId)).filter(message => message.mission?.kind === 'scheduled')
  return { service, agent, channel, engine, lines, tasks, approve, set, pass, schedule, runsIn }
}

describe('the slots of a task', () => {
  const task = { cadence: { every: 'day', at: '08:00' }, approvedAt: reunion(25, 9, 0).toISOString() } as Schedule

  it('the latest slot runs if it is under 15 minutes old; the others are missed, never run', () => {
    expect(slotsOf(task, reunion(26, 8, 5), ZONE)).toEqual({ run: reunion(26, 8, 0), missed: 0, last: reunion(26, 8, 0) })
    expect(slotsOf(task, reunion(28, 8, 14), ZONE)).toEqual({ run: reunion(28, 8, 0), missed: 2, last: reunion(28, 8, 0) })
    expect(slotsOf(task, reunion(26, 8, 15), ZONE)).toEqual({ missed: 1, last: reunion(26, 8, 0) })
    expect(slotsOf(task, reunion(26, 7, 59), ZONE)).toEqual({ missed: 0 })
    // After the last slot handled, nothing until the next.
    expect(slotsOf({ ...task, lastSlotAt: reunion(26, 8, 0).toISOString() }, reunion(26, 8, 5), ZONE)).toEqual({ missed: 0 })
  })
})

describe('a run', () => {
  it('is a turn of its agent, as its requester, with what its channel allows, published there and recorded', async () => {
    const b = await bench()
    const task = await b.approve()
    b.set(reunion(26, 8, 2))
    await b.pass()
    expect(b.engine.runs).toHaveLength(1)
    const run = b.engine.runs[0] as TurnInput
    // As its requester: their connections, their computer; never the owner's.
    expect(run.actor).toBe(operator)
    expect(run.agent.id).toBe(b.agent.id)
    expect(run.servers).toEqual(['attio'])
    expect(run.budget?.eur).toBe(0.4)
    expect(run.prompt.startsWith('Nous sommes le jeudi 26 novembre 2026, 08:02')).toBe(true)
    expect(run.prompt).toContain('Fais le point des factures impayées.')
    const published = await b.runsIn(b.channel.id)
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ author: { kind: 'system' }, text: 'Trois factures impayées : A, B, C.' })
    expect(published[0]?.mission).toMatchObject({ kind: 'scheduled', title: 'Relance des impayés', status: 'done', scheduleId: task.id, agentId: b.agent.id })
    const eur = published[0]?.mission?.eur ?? 0
    expect(eur).toBeGreaterThan(0)
    expect(await b.schedule(task.id)).toMatchObject({ lastStatus: 'done', lastRunAt: reunion(26, 8, 2).toISOString(), lastEur: eur, failures: 0 })
    // Its cost counts on its agent's ceiling, and on the task's month.
    const state = await b.service.snapshot()
    expect(spentThisMonth(state.messages ?? [], b.agent.id, reunion(26, 9, 0).toISOString())).toBe(eur)
    expect(scheduleSpentThisMonth(state, task.id, reunion(26, 9, 0), ZONE)).toBe(eur)
    // The same slot never runs twice.
    b.set(reunion(26, 8, 5))
    await b.pass()
    expect(b.engine.runs).toHaveLength(1)
  })

  it('a slot missed by more than 15 minutes is counted, never run', async () => {
    const b = await bench()
    const task = await b.approve()
    b.set(reunion(27, 8, 30))
    await b.pass()
    expect(b.engine.runs).toHaveLength(0)
    expect(await b.schedule(task.id)).toMatchObject({ missed: 2, lastSlotAt: reunion(27, 8, 0).toISOString() })
    expect(b.lines.some(line => line.includes('2 slot(s) missed'))).toBe(true)
  })

  it('in its requester\'s lane: the agent\'s own connectors, the result in that lane', async () => {
    const b = await bench()
    const task = await b.approve({ destination: { kind: 'lane', member: operator } })
    b.set(reunion(26, 8, 1))
    await b.pass()
    expect(b.engine.runs[0]?.servers).toEqual(['attio', 'office365'])
    const lane = ((await b.service.snapshot()).channels ?? []).find(channel => isLaneOf(channel, operator))
    expect(lane).toBeDefined()
    expect((await b.runsIn(lane?.id ?? ''))[0]?.mission).toMatchObject({ scheduleId: task.id, status: 'done' })
  })

  it('a failure publishes the host\'s sentence, never the provider\'s words; three in a row pause it', async () => {
    const b = await bench()
    const task = await b.approve()
    b.engine.answer = () => { throw new Error('PROVIDER-RAW 500: upstream exploded at 10.1.2.3') }
    for (const day of [26, 27, 28]) {
      b.set(reunion(day, 8, 1))
      await b.pass()
    }
    const published = await b.runsIn(b.channel.id)
    expect(published).toHaveLength(3)
    expect(published.every(message => message.mission?.status === 'failed' && !message.text.includes('PROVIDER-RAW'))).toBe(true)
    expect(await b.schedule(task.id)).toMatchObject({ state: 'paused', pausedBecause: 'failures', failures: 3, lastStatus: 'failed' })
    // Paused: the next day's slot does not run.
    b.set(reunion(29, 8, 1))
    await b.pass()
    expect(b.engine.runs).toHaveLength(3)
  })

  it('an empty answer is a failure with the host\'s words', async () => {
    const b = await bench()
    const task = await b.approve()
    b.engine.answer = () => ({ text: '   ', tokens: { input: 10, output: 0 } })
    b.set(reunion(26, 8, 1))
    await b.pass()
    expect((await b.runsIn(b.channel.id))[0]).toMatchObject({ text: NO_RUN_TEXT, mission: { status: 'failed', reasonKind: 'no-answer' } })
    expect(await b.schedule(task.id)).toMatchObject({ lastStatus: 'failed', lastReasonKind: 'no-answer', failures: 1 })
  })

  it('its agent\'s ceiling reached: refused before any model call', async () => {
    const b = await bench({ eurPerMonth: 0.0001 })
    await b.approve()
    // A first run spends past the tiny ceiling.
    b.set(reunion(26, 8, 1))
    await b.pass()
    b.set(reunion(27, 8, 1))
    await b.pass()
    expect(b.engine.runs).toHaveLength(1)
    expect((await b.runsIn(b.channel.id))[1]).toMatchObject({ mission: { status: 'failed', reasonKind: 'refused' } })
    expect((await b.runsIn(b.channel.id))[1]?.text).toContain('Plafond mensuel atteint')
  })
})

describe('a run cut by a restart', () => {
  it('is said on the next pass, in its destination, not counted a failure; the next slot runs', async () => {
    const b = await bench()
    const task = await b.approve()
    b.set(reunion(26, 8, 1))
    // A run started, then the process died: its slot reserved, running, never published.
    await b.service.reserveScheduleSlot(task.id, undefined, reunion(26, 8, 0).toISOString(), 0, true)
    const fresh = new TaskScheduler({ service: b.service, engine: b.engine, prices: PRICES, dataDir: '/tmp/mndt-task-runs', timeZone: ZONE, warn: () => undefined, now: () => reunion(26, 8, 6) })
    await fresh.tick()
    await fresh.settled()
    expect((await b.runsIn(b.channel.id))[0]).toMatchObject({ text: CUT_BY_RESTART_TEXT, mission: { status: 'failed', reasonKind: 'restart' } })
    expect(await b.schedule(task.id)).toMatchObject({ lastStatus: 'failed', lastReasonKind: 'restart', failures: 0 })
    expect((await b.schedule(task.id))?.runningSince).toBeUndefined()
    expect(b.engine.runs).toHaveLength(0)
    b.set(reunion(27, 8, 1))
    await b.pass()
    expect(b.engine.runs).toHaveLength(1)
  })
})

describe('the pauses the host makes, and the deleted tasks', () => {
  it('its agent retired, or gone from its channel: paused with that reason, nothing run', async () => {
    const b = await bench()
    const retired = await b.approve()
    await b.service.retireAgent(b.agent.id, owner)
    b.set(reunion(26, 8, 1))
    await b.pass()
    expect(await b.schedule(retired.id)).toMatchObject({ state: 'paused', pausedBecause: 'agent-retired' })
    expect(b.engine.runs).toHaveLength(0)

    const c = await bench()
    const left = await c.approve()
    await c.service.updateChannel(c.channel.id, { removeAgents: [c.agent.id] }, owner)
    c.set(reunion(26, 8, 1))
    await c.pass()
    expect(await c.schedule(left.id)).toMatchObject({ state: 'paused', pausedBecause: 'agent-left' })
  })

  it('resumed: the slots that fell while it was paused are not missed', async () => {
    const b = await bench()
    const task = await b.approve()
    await b.service.changeSchedule(task.id, 'pause', operator)
    b.set(reunion(29, 9, 0))
    await b.service.changeSchedule(task.id, 'resume', owner)
    await b.pass()
    expect((await b.schedule(task.id))?.missed ?? 0).toBe(0)
    b.set(reunion(30, 8, 3))
    await b.pass()
    expect(b.engine.runs).toHaveLength(1)
  })

  it('a task deleted more than 90 days ago is forgotten; a recent one is kept, never run', async () => {
    const b = await bench()
    const old = await b.approve()
    const recent = await b.approve({ title: 'Autre' })
    await b.service.changeSchedule(old.id, 'delete', owner)
    b.set(new Date(reunion(25, 9, 0).getTime() + (91 * 86_400_000)))
    await b.service.changeSchedule(recent.id, 'delete', owner)
    await b.pass()
    const ids = ((await b.service.snapshot()).schedules ?? []).map(item => item.id)
    expect(ids).toEqual([recent.id])
    expect(b.engine.runs).toHaveLength(0)
  })
})

describe('what is served', () => {
  it('a task\'s last run (status, kind, time, cost) and its month, never its internal slot; a pending card\'s monthly bound', async () => {
    const b = await bench()
    const task = await b.approve()
    b.set(reunion(26, 8, 1))
    await b.pass()
    const api = createMndtApi({
      service: b.service,
      runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
      timeZone: ZONE,
      identity: { tokens: { owner: { user: owner } } },
      grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }, { subject: operator, role: 'operator' }] }) },
    })
    const listed = (await api({ method: 'GET', path: '/schedules', authorization: 'Bearer owner' })).body as { schedules: Record<string, unknown>[] }
    const served = listed.schedules.find(item => item.id === task.id) as Record<string, unknown>
    expect(served).toMatchObject({ lastStatus: 'done', lastRunAt: reunion(26, 8, 1).toISOString(), missed: 0 })
    expect(served.eurThisMonth).toBeGreaterThan(0)
    expect(served.lastSlotAt).toBeUndefined()
    // A pending card: what it may cost this month, bounded by its agent's ceiling.
    await b.service.requestApproval({
      kind: 'propose_schedule', title: 'Tâche : Veille', requestedBy: operator, channelId: b.channel.id, requestedByAgent: { id: b.agent.id, handle: b.agent.handle },
      scheduleProposal: { title: 'Veille', instructions: 'Lis la presse.', cadence: { every: 'day', at: '09:00' }, agentId: b.agent.id, destination: { kind: 'channel', channelId: b.channel.id }, eurPerRun: 5 },
    })
    const cards = (await api({ method: 'GET', path: '/approvals', authorization: 'Bearer owner' })).body as { approvals: Record<string, unknown>[] }
    const card = cards.approvals.find(item => item.kind === 'propose_schedule' && item.state === 'pending')
    expect(card?.eurPerMonthMax).toBe(5)
  })
})
