/**
 * Scheduled tasks, run (tasks PR 2): the slots of a task in the instance's
 * zone, the latest run within 15 minutes and the older ones missed; a run as a
 * turn of its agent, acting as its requester, its connectors as its
 * destination allows, bounded by its euros per run and its agent's ceiling;
 * the result published in its destination and recorded on the task; the
 * pauses the host makes (its agent, its requester); a refusal that is not a
 * failure; one agent's runs one after the other; the deleted tasks forgotten
 * after 90 days; what each reader reads of it.
 */
import { describe, expect, it } from 'vitest'
import { MemoryStore, SPACE_PREAMBLE, spentThisMonth, WorkbenchService } from '../src/core/index.ts'
import type { Message, PriceGrid, Schedule, ScheduleProposal } from '../src/core/index.ts'
import { createMndtApi, scheduleSpentThisMonth } from '../src/api.ts'
import type { GrantSource } from '../src/policy.ts'
import { CUT_BY_RESTART_TEXT, MAX_PARALLEL_RUNS, NO_RUN_TEXT, slotsOf, TaskScheduler } from '../src/task-runs.ts'
import { TurnScheduler } from '../src/turns.ts'
import type { TurnEngine, TurnInput, TurnOutput } from '../src/turns.ts'
import { reservedFor } from '../src/spend-reservations.ts'
import { parseModelRoles } from '../src/model-roles.ts'
import type { ModelRolesRead } from '../src/model-roles.ts'

const ZONE = 'Indian/Reunion'
const owner = 'duke@datanalysis.re'
const operator = 'jdoe@datanalysis.re'
const viewer = 'smarion@datanalysis.re'
const other = 'aautre@datanalysis.re'
// route-a is priced; vllm-qwen is declared free (our H100: a 0 price, never an unknown one).
const PRICES: PriceGrid = { 'route-a/*': { input: 1, output: 2 }, 'vllm-qwen/*': { input: 0, output: 0 } }
/** A time at La Réunion on a day of November 2026 (UTC+4). */
const reunion = (day: number, hour: number, minute: number): Date => new Date(Date.UTC(2026, 10, day, hour - 4, minute))

/** A fake engine: records each run, answers its text or throws its error; `hold` keeps runs going until released. */
class Engine implements TurnEngine {
  readonly runs: TurnInput[] = []
  answer: () => TurnOutput = () => ({ text: 'Trois factures impayées : A, B, C.', tokens: { input: 1000, output: 100 } })
  hold: Promise<void> | undefined
  async run(input: TurnInput): Promise<TurnOutput> {
    this.runs.push(input)
    if (this.hold !== undefined) await this.hold
    return this.answer()
  }
}

/** @param check - a condition. @returns once it holds, or after a second. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise(resolve => setTimeout(resolve, 10))
}

/** @returns a service, agents, a channel, a clock, a role table to change, and a way to approve a task. */
async function bench(options: { eurPerMonth?: number } = {}) {
  let clock = reunion(25, 9, 0)
  const service = new WorkbenchService({ store: new MemoryStore(), now: () => clock })
  const agent = await service.createAgent({
    handle: 'compta', name: 'Compta', provider: 'route-a', model: 'm', connectors: ['office365', 'attio'], eurPerMonth: options.eurPerMonth ?? 5,
  }, owner)
  const channel = await service.createChannel({ title: 'Finances', members: [operator, viewer], agents: [agent.id], connectors: ['attio'] }, owner)
  const engine = new Engine()
  const lines: string[] = []
  let table: { subject: string; role: 'owner' | 'admin' | 'operator' | 'viewer' }[] = [
    { subject: owner, role: 'owner' }, { subject: operator, role: 'operator' }, { subject: viewer, role: 'viewer' }, { subject: other, role: 'operator' },
  ]
  const grants: GrantSource = { grants: async () => ({ ok: true, grants: table }) }
  const scheduler = (
    source: GrantSource = grants, now: () => Date = () => clock, modelRoles?: () => Promise<ModelRolesRead>,
  ) => new TaskScheduler({
    service, engine, prices: PRICES, grants: source, dataDir: '/tmp/mndt-task-runs', timeZone: ZONE, warn: (line) => { lines.push(line) }, now,
    ...(modelRoles === undefined ? {} : { modelRoles }),
  })
  const tasks = scheduler()
  const approve = async (overrides: Partial<ScheduleProposal> = {}, by = agent): Promise<Schedule> => {
    const proposal: ScheduleProposal = {
      title: 'Relance des impayés', instructions: 'Fais le point des factures impayées.', cadence: { every: 'day', at: '08:00' },
      agentId: by.id, destination: { kind: 'channel', channelId: channel.id }, eurPerRun: 0.4, ...overrides,
    }
    const card = await service.requestApproval({
      kind: 'propose_schedule', title: `Tâche : ${proposal.title}`, requestedBy: operator, channelId: channel.id,
      requestedByAgent: { id: by.id, handle: by.handle }, scheduleProposal: proposal,
    })
    return (await service.approveScheduleProposal(card.id, owner)).schedule
  }
  const set = (date: Date): void => { clock = date }
  const setGrants = (next: typeof table): void => { table = next }
  const pass = async (): Promise<void> => { await tasks.tick(); await tasks.settled() }
  const schedule = async (id: string): Promise<Schedule | undefined> =>
    ((await service.snapshot()).schedules ?? []).find(item => item.id === id)
  const runsIn = async (channelId: string): Promise<Message[]> => (await service.messages(channelId)).filter(message => message.mission?.kind === 'scheduled')
  return { service, agent, channel, engine, lines, tasks, scheduler, grants, approve, set, setGrants, pass, schedule, runsIn }
}

describe('the slots of a task', () => {
  const task = { cadence: { every: 'day', at: '08:00' }, approvedAt: reunion(25, 9, 0).toISOString() } as Schedule

  it('the latest slot runs if it is under 15 minutes old; the others are missed, never run', () => {
    expect(slotsOf(task, reunion(26, 8, 5), ZONE)).toEqual({ run: reunion(26, 8, 0), missed: 0, last: reunion(26, 8, 0) })
    expect(slotsOf(task, reunion(28, 8, 14), ZONE)).toEqual({ run: reunion(28, 8, 0), missed: 2, last: reunion(28, 8, 0) })
    expect(slotsOf(task, reunion(26, 8, 15), ZONE)).toEqual({ missed: 1, last: reunion(26, 8, 0) })
    expect(slotsOf(task, reunion(26, 7, 59), ZONE)).toEqual({ missed: 0 })
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
    // The date at the end (the prefix cache); the space's preamble at the head.
    expect(run.prompt.split('\n').at(-1)?.startsWith('Nous sommes le jeudi 26 novembre 2026, 08:02')).toBe(true)
    expect(run.prompt.startsWith(SPACE_PREAMBLE)).toBe(true)
    expect(run.prompt).toContain('Fais le point des factures impayées.')
    const published = await b.runsIn(b.channel.id)
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ author: { kind: 'system' }, text: 'Trois factures impayées : A, B, C.' })
    expect(published[0]?.mission).toMatchObject({ kind: 'scheduled', title: 'Relance des impayés', status: 'done', scheduleId: task.id, agentId: b.agent.id })
    const eur = published[0]?.mission?.eur ?? 0
    expect(eur).toBeGreaterThan(0)
    expect(await b.schedule(task.id)).toMatchObject({ lastStatus: 'done', lastRunAt: reunion(26, 8, 2).toISOString(), lastEur: eur, failures: 0 })
    expect((await b.schedule(task.id))?.runningSince).toBeUndefined()
    const state = await b.service.snapshot()
    expect(spentThisMonth(state.messages ?? [], b.agent.id, reunion(26, 9, 0).toISOString())).toBe(eur)
    expect(scheduleSpentThisMonth(state, task.id, reunion(26, 9, 0), ZONE)).toBe(eur)
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

  it('in its requester\'s lane, from a lane never set up: approval puts its agent there, a run uses the agent\'s connectors, the result lands there', async () => {
    const b = await bench()
    const task = await b.approve({ destination: { kind: 'lane', member: operator } })
    const lane = ((await b.service.snapshot()).channels ?? []).find(channel => channel.kind === 'solo' && channel.members[0] === operator)
    expect(lane?.agents).toEqual([b.agent.id])
    b.set(reunion(26, 8, 1))
    await b.pass()
    expect(b.engine.runs[0]?.servers).toEqual(['attio', 'office365'])
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

  it('a step that fails before the model is called is a counted failure, published, and its mark of a run cleared (no loop)', async () => {
    const b = await bench()
    const task = await b.approve()
    let reads = 0
    // The role table reads at the pass, then fails just before the run.
    const flaky: GrantSource = { grants: async () => { reads += 1; if (reads > 1) throw new Error('EIO: grants.json'); return b.grants.grants() } }
    const tasks = b.scheduler(flaky)
    b.set(reunion(26, 8, 1))
    await tasks.tick()
    await tasks.settled()
    expect(b.engine.runs).toHaveLength(0)
    expect((await b.runsIn(b.channel.id))[0]?.mission).toMatchObject({ status: 'failed' })
    expect(await b.schedule(task.id)).toMatchObject({ lastStatus: 'failed', failures: 1 })
    expect((await b.schedule(task.id))?.runningSince).toBeUndefined()
    // The next pass does not take it for a restart.
    await b.pass()
    expect(await b.runsIn(b.channel.id)).toHaveLength(1)
  })
})

describe('the ceiling', () => {
  it('reached with this run\'s bound: refused before any model call, recorded as refused, not a failure, never published, said once a day', async () => {
    // A ceiling of 0.39 €, a run bound at 0.40 €: this run alone would pass it.
    const b = await bench({ eurPerMonth: 0.39 })
    const task = await b.approve()
    for (const [day, minute] of [[26, 1], [26, 2], [27, 1]] as const) {
      b.set(reunion(day, 8, minute))
      await b.pass()
    }
    expect(b.engine.runs).toHaveLength(0)
    expect(await b.runsIn(b.channel.id)).toHaveLength(0)
    expect(await b.schedule(task.id)).toMatchObject({ state: 'active', lastStatus: 'refused', lastReasonKind: 'refused' })
    expect((await b.schedule(task.id))?.failures ?? 0).toBe(0)
    // Once a day: the 26th, then the 27th.
    expect(b.lines.filter(line => line.includes('not run: its agent\'s ceiling'))).toHaveLength(2)
  })
})

describe('a route declared free', () => {
  it('a task of an agent on a route priced 0 (declared, not unknown) runs, and costs 0 €', async () => {
    const b = await bench()
    const qwen = await b.service.createAgent({ handle: 'qwen', name: 'Qwen', provider: 'vllm-qwen', model: 'qwen3.5', connectors: [], eurPerMonth: 5 }, owner)
    await b.service.updateChannel(b.channel.id, { addAgents: [qwen.id] }, owner)
    const task = await b.approve({ title: 'Veille' }, qwen)
    b.set(reunion(26, 8, 1))
    await b.pass()
    expect(b.engine.runs.map(run => run.agent.id)).toEqual([qwen.id])
    expect((await b.runsIn(b.channel.id))[0]?.mission).toMatchObject({ status: 'done', eur: 0, scheduleId: task.id })
    expect(await b.schedule(task.id)).toMatchObject({ lastStatus: 'done', lastEur: 0 })
  })
})

describe('the space\'s models by role (roles.json)', () => {
  it('a run plays on the « scheduled » role\'s route, as its agent, priced for that route', async () => {
    const b = await bench()
    const policy = '{"routes": {"volume": "vllm-qwen/qwen3.5"}, "roles": {"scheduled": "volume"}}'
    const tasks = b.scheduler(b.grants, undefined, async () => parseModelRoles(policy, {}, PRICES))
    const task = await b.approve()
    b.set(reunion(26, 8, 2))
    await tasks.tick()
    await tasks.settled()
    expect(b.engine.runs.map(run => [run.agent.id, `${run.agent.provider}/${run.agent.model}`])).toEqual([[b.agent.id, 'vllm-qwen/qwen3.5']])
    // Priced 0 on Qwen: its agent's own route-a would have cost 0.0012 €.
    expect((await b.runsIn(b.channel.id))[0]?.mission).toMatchObject({ status: 'done', eur: 0, scheduleId: task.id })
  })

  it('a policy that cannot be read: no model is called, and the run says why', async () => {
    const b = await bench()
    const tasks = b.scheduler(b.grants, undefined, async () => ({ ok: false, reason: 'roles.json n’est pas un JSON valide' }))
    const task = await b.approve()
    b.set(reunion(26, 8, 2))
    await tasks.tick()
    await tasks.settled()
    expect(b.engine.runs).toHaveLength(0)
    expect(JSON.stringify(await b.schedule(task.id))).not.toContain('"lastStatus":"done"')
  })
})

describe('the ceiling, with what is in flight', () => {
  it('a conversation\'s turn in flight and a run of the same agent never go over its ceiling together', async () => {
    const b = await bench({ eurPerMonth: 0.6 })
    await b.approve()
    // A conversation's turn of the same agent, held running: it reserves its estimate.
    let release!: () => void
    const held: TurnEngine = { run: async () => { await new Promise<void>((resolve) => { release = resolve }); return { text: 'ok', tokens: { input: 1, output: 1 } } } }
    const turns = new TurnScheduler({ service: b.service, engine: held, prices: PRICES, dataDir: '/tmp/mndt-task-runs' })
    const posted = await b.service.postMessage(b.channel.id, operator, '@compta bonjour')
    turns.launch(posted)
    await until(() => reservedFor(b.agent.id) > 0)
    // The run's bound (0.4 €) plus the turn's reservation (0.5 €) would pass 0.6 €: refused, no model call.
    b.set(reunion(26, 8, 1))
    await b.pass()
    expect(b.engine.runs).toHaveLength(0)
    expect((await b.schedule((await b.service.snapshot()).schedules?.[0]?.id ?? ''))?.lastStatus).toBe('refused')
    release()
    await turns.settled()
    expect(reservedFor(b.agent.id)).toBe(0)
  })
})

describe('one agent\'s runs, one after the other', () => {
  it('two tasks of the same agent in the same pass: the second waits for the first, then runs', async () => {
    const b = await bench()
    await b.approve()
    await b.approve({ title: 'Autre' })
    let release!: () => void
    b.engine.hold = new Promise((resolve) => { release = resolve })
    b.set(reunion(26, 8, 1))
    await b.tasks.tick()
    await until(() => b.engine.runs.length >= 1)
    // A moment more: the second never starts while the first runs.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(b.engine.runs).toHaveLength(1)
    release()
    await b.tasks.settled()
    b.engine.hold = undefined
    b.set(reunion(26, 8, 2))
    await b.pass()
    expect(b.engine.runs).toHaveLength(2)
  })

  it(`different agents side by side, ${MAX_PARALLEL_RUNS} at most`, async () => {
    const b = await bench()
    const agents = [b.agent]
    for (const handle of ['veille', 'ventes']) {
      const agent = await b.service.createAgent({ handle, name: handle, provider: 'route-a', model: 'm', connectors: [], eurPerMonth: 5 }, owner)
      await b.service.updateChannel(b.channel.id, { addAgents: [agent.id] }, owner)
      agents.push(agent)
    }
    for (const agent of agents) await b.approve({ title: agent.handle }, agent)
    let release!: () => void
    b.engine.hold = new Promise((resolve) => { release = resolve })
    b.set(reunion(26, 8, 1))
    await b.tasks.tick()
    await until(() => b.engine.runs.length >= MAX_PARALLEL_RUNS)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(b.engine.runs).toHaveLength(MAX_PARALLEL_RUNS)
    release()
    await b.tasks.settled()
  })
})

describe('the pauses the host makes', () => {
  it('its agent retired, or gone from its channel', async () => {
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

  it('its requester gone from the role table, now a viewer, or gone from its channel: requester-left, nothing run as them', async () => {
    for (const change of ['removed', 'viewer', 'left-channel'] as const) {
      const b = await bench()
      const task = await b.approve()
      if (change === 'removed') b.setGrants([{ subject: owner, role: 'owner' }])
      if (change === 'viewer') b.setGrants([{ subject: owner, role: 'owner' }, { subject: operator, role: 'viewer' }])
      if (change === 'left-channel') await b.service.updateChannel(b.channel.id, { removeMembers: [operator] }, owner)
      b.set(reunion(26, 8, 1))
      await b.pass()
      expect(await b.schedule(task.id), change).toMatchObject({ state: 'paused', pausedBecause: 'requester-left' })
      expect(b.engine.runs, change).toHaveLength(0)
    }
  })

  it('checked again just before the run: a requester removed between the pass and the run never acts', async () => {
    const b = await bench()
    const task = await b.approve()
    let reads = 0
    const removedAfterPass: GrantSource = {
      grants: async () => {
        reads += 1
        return { ok: true, grants: reads === 1 ? [{ subject: owner, role: 'owner' }, { subject: operator, role: 'operator' }] : [{ subject: owner, role: 'owner' }] }
      },
    }
    const tasks = b.scheduler(removedAfterPass)
    b.set(reunion(26, 8, 1))
    await tasks.tick()
    await tasks.settled()
    expect(b.engine.runs).toHaveLength(0)
    expect(await b.schedule(task.id)).toMatchObject({ state: 'paused', pausedBecause: 'requester-left' })
    expect((await b.schedule(task.id))?.runningSince).toBeUndefined()
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
})

describe('a task that changes during its run', () => {
  it('deleted during its run: not published, said in the journal; paused during its run: published, it took place', async () => {
    const b = await bench()
    const deleted = await b.approve()
    let release!: () => void
    b.engine.hold = new Promise((resolve) => { release = resolve })
    b.set(reunion(26, 8, 1))
    await b.tasks.tick()
    await b.service.changeSchedule(deleted.id, 'delete', owner)
    release()
    await b.tasks.settled()
    expect(await b.runsIn(b.channel.id)).toHaveLength(0)
    expect((await b.service.snapshot()).events.some(event => event.action === 'schedule.run.dropped' && event.subject === deleted.id)).toBe(true)

    const c = await bench()
    const paused = await c.approve()
    let go!: () => void
    c.engine.hold = new Promise((resolve) => { go = resolve })
    c.set(reunion(26, 8, 1))
    await c.tasks.tick()
    await c.service.changeSchedule(paused.id, 'pause', operator)
    go()
    await c.tasks.settled()
    expect(await c.runsIn(c.channel.id)).toHaveLength(1)
  })

  it('deleted between its reservation and its start: it never starts, its mark of a run cleared', async () => {
    const b = await bench()
    const task = await b.approve()
    b.set(reunion(26, 8, 1))
    await b.service.reserveScheduleSlot(task.id, undefined, reunion(26, 8, 0).toISOString(), 0, true)
    await b.service.changeSchedule(task.id, 'delete', owner)
    expect(await b.service.confirmScheduleRun(task.id)).toBeUndefined()
    const after = ((await b.service.snapshot()).schedules ?? []).find(item => item.id === task.id)
    expect(after?.runningSince).toBeUndefined()
    expect((await b.service.snapshot()).events.some(event => event.action === 'schedule.run.skipped' && event.subject === task.id)).toBe(true)
  })
})

describe('a run cut by a restart', () => {
  it('is said on the next pass, in its destination, not counted a failure; the next slot runs', async () => {
    const b = await bench()
    const task = await b.approve()
    b.set(reunion(26, 8, 1))
    await b.service.reserveScheduleSlot(task.id, undefined, reunion(26, 8, 0).toISOString(), 0, true)
    const fresh = b.scheduler(b.grants, () => reunion(26, 8, 6))
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

describe('the deleted tasks', () => {
  it('deleted more than 90 days ago: forgotten; a recent one kept, never run', async () => {
    const b = await bench()
    const old = await b.approve()
    const recent = await b.approve({ title: 'Autre' })
    await b.service.changeSchedule(old.id, 'delete', owner)
    b.set(new Date(reunion(25, 9, 0).getTime() + (91 * 86_400_000)))
    await b.service.changeSchedule(recent.id, 'delete', owner)
    await b.pass()
    expect(((await b.service.snapshot()).schedules ?? []).map(item => item.id)).toEqual([recent.id])
    expect(b.engine.runs).toHaveLength(0)
  })
})

describe('what is served, and to whom', () => {
  /** @param b - a bench. @returns the API over its service, each person by a bearer token. */
  const apiOf = (b: Awaited<ReturnType<typeof bench>>) => {
    const api = createMndtApi({
      service: b.service,
      runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
      timeZone: ZONE,
      identity: { tokens: { owner: { user: owner }, operator: { user: operator }, viewer: { user: viewer }, other: { user: other } } },
      grants: b.grants,
    })
    return async (who: string, path: string) => (await api({ method: 'GET', path, authorization: `Bearer ${who}` }))
  }

  it('a task\'s last run and its month, never its internal slot; a pending card\'s monthly bound', async () => {
    const b = await bench()
    const task = await b.approve()
    b.set(reunion(26, 8, 1))
    await b.pass()
    const get = apiOf(b)
    const listed = (await get('owner', '/schedules')).body as { schedules: Record<string, unknown>[] }
    const served = listed.schedules.find(item => item.id === task.id) as Record<string, unknown>
    expect(served).toMatchObject({ lastStatus: 'done', lastRunAt: reunion(26, 8, 1).toISOString(), missed: 0, running: false })
    expect(served.eurThisMonth).toBeGreaterThan(0)
    expect(served.lastSlotAt).toBeUndefined()
    expect(served.runningSince).toBeUndefined()
    await b.service.requestApproval({
      kind: 'propose_schedule', title: 'Tâche : Veille', requestedBy: operator, channelId: b.channel.id, requestedByAgent: { id: b.agent.id, handle: b.agent.handle },
      scheduleProposal: { title: 'Veille', instructions: 'Lis la presse.', cadence: { every: 'day', at: '09:00' }, agentId: b.agent.id, destination: { kind: 'channel', channelId: b.channel.id }, eurPerRun: 5 },
    })
    const cards = (await get('owner', '/approvals')).body as { approvals: Record<string, unknown>[] }
    expect(cards.approvals.find(item => item.kind === 'propose_schedule' && item.state === 'pending')?.eurPerMonthMax).toBe(5)
  })

  it('a run in an operator\'s lane: its message, its task and its journal lines read by nobody else but the deciders', async () => {
    const b = await bench()
    const task = await b.approve({ destination: { kind: 'lane', member: operator } })
    const lane = await b.service.laneOf(operator)
    b.set(reunion(26, 8, 1))
    await b.pass()
    expect(await b.runsIn(lane.id)).toHaveLength(1)
    const get = apiOf(b)
    expect((await get('operator', `/channels/${lane.id}/messages`)).status).toBe(200)
    for (const reader of ['viewer', 'other']) {
      expect((await get(reader, `/channels/${lane.id}/messages`)).status, reader).toBe(404)
      const schedules = ((await get(reader, '/schedules')).body as { schedules: { id: string }[] }).schedules
      expect(schedules.map(item => item.id), reader).not.toContain(task.id)
      const events = ((await get(reader, '/events')).body as { events?: { subject: string; detail?: string }[] }).events ?? []
      expect(events.some(event => event.subject === task.id || event.detail === lane.id), reader).toBe(false)
    }
  })
})
