/**
 * Scheduled tasks, run (tasks PR 2).
 *
 * A pass every 30 s, in the workbench: for each active task, the slots its
 * cadence placed since the last slot it handled, in the instance's zone. The
 * latest one is run if it is less than TASK_CATCH_UP_MINUTES old; every other
 * is counted missed, never run (no catch-up after a cut). A task never runs
 * twice at once; one agent's runs go one after the other; MAX_PARALLEL_RUNS at
 * most at once.
 *
 * A run is a turn of the task's agent, outside any conversation: the agent's
 * model, prompt and skills; its connectors as the destination allows them
 * (until the personal connections); the date, then the task's instructions;
 * acting as its requester (their mailbox, their computer: never the owner's);
 * bounded by the task's euros per run and the agent's monthly ceiling. What
 * came of it is published in the destination as a system message carrying the
 * run (Message.mission, kind `scheduled`), and recorded on the task.
 *
 * A task whose agent is retired or gone from its destination, or whose
 * requester left (the role table, a viewer's role, its channel), is paused with
 * that reason, checked at each pass and just before its run. Deleted tasks are forgotten after TOMBSTONE_DAYS.
 */
import { randomUUID } from 'node:crypto'
import { ceilingRefusal, dateLine, eurOf, isLaneOf, nextRuns, priceOf, skillsOf, spentThisMonth, turnPrompt, turnServers } from './core/index.ts'
import type { Agent, Channel, Message, PriceGrid, Schedule, WorkbenchService, WorkbenchState } from './core/index.ts'
import type { GrantSource, GrantTable } from './policy.ts'
import { turnFailure } from './public-failure.ts'
import { reservedFor, reserveSpend } from './spend-reservations.ts'
import { channelFolder } from './turns.ts'
import type { TurnEngine } from './turns.ts'

/** How late a slot may still run; an older one is missed. */
export const TASK_CATCH_UP_MINUTES = 15
/** The most slots read in one pass for one task (a month of hourly slots). */
export const MAX_SLOTS_PER_PASS = 1000
/** How long a deleted task is kept for its journal's readers. */
export const TOMBSTONE_DAYS = 90
/** What a run that produced no text says, as the host. */
export const NO_RUN_TEXT = 'La tâche n’a produit aucun texte.'
/** What a run cut by a restart says, as the host. */
export const CUT_BY_RESTART_TEXT = 'Interrompue par un redémarrage.'

/** The slots of a pass, for one task. */
export interface TaskSlots {
  readonly run?: Date
  readonly missed: number
  readonly last?: Date
}

/**
 * @param schedule - a task.
 * @param now - the moment of the pass.
 * @param timeZone - the instance's IANA zone.
 * @returns the slot to run now (if any), how many are missed, and the last slot reached.
 */
export function slotsOf(schedule: Schedule, now: Date, timeZone: string): TaskSlots {
  const from = new Date(schedule.lastSlotAt ?? schedule.approvedAt)
  const slots = nextRuns(schedule.cadence, from, timeZone, MAX_SLOTS_PER_PASS).filter(slot => slot.getTime() <= now.getTime())
  const last = slots.at(-1)
  if (last === undefined) return { missed: 0 }
  const runnable = now.getTime() - last.getTime() < TASK_CATCH_UP_MINUTES * 60_000
  return { ...(runnable ? { run: last } : {}), missed: runnable ? slots.length - 1 : slots.length, last }
}

/** At most this many runs at once, whatever the agents: the model server is shared. */
export const MAX_PARALLEL_RUNS = 2
/** The roles that may start a turn: a viewer only reads. */
const WRITING_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'operator'])

/** What the tasks' scheduler needs. */
export interface TaskSchedulerOptions {
  readonly service: WorkbenchService
  readonly engine: TurnEngine
  readonly prices: PriceGrid
  /** The role table: a requester gone from it, or now a viewer, no longer acts. */
  readonly grants: GrantSource
  /** Where each channel's folder lives (the run's working directory). */
  readonly dataDir: string
  readonly timeZone: string
  /** The operator's line. */
  readonly warn: (line: string) => void
  /** The clock (tests). */
  readonly now?: () => Date
}

/**
 * @param schedule - a task.
 * @param state - the state.
 * @param table - the role table.
 * @returns why its requester may no longer act through it, or undefined when they may:
 * gone from the role table, now a viewer, or no longer a member of its channel.
 */
export function requesterGone(schedule: Schedule, state: WorkbenchState, table: GrantTable): string | undefined {
  if (!table.ok) return undefined
  const who = schedule.requestedBy.toLowerCase()
  const grant = table.grants.find(candidate => candidate.subject.toLowerCase() === who)
  if (grant === undefined) return 'no longer in the role table'
  if (!WRITING_ROLES.has(grant.role)) return `now ${grant.role}`
  if (schedule.destination.kind === 'channel') {
    const channelId = schedule.destination.channelId
    const channel = (state.channels ?? []).find(candidate => candidate.id === channelId)
    if (channel === undefined || !channel.members.some(member => member.toLowerCase() === who)) return 'no longer a member of its channel'
  }
  return undefined
}

/**
 * @param schedule - a task.
 * @param state - the state.
 * @returns why its agent may no longer run it, or undefined: retired, or gone from its destination (its channel, or its requester's lane).
 */
export function agentGone(schedule: Schedule, state: WorkbenchState): { readonly reason: 'agent-retired' | 'agent-left'; readonly agent?: Agent } | { readonly agent: Agent } {
  const agent = (state.agents ?? []).find(candidate => candidate.id === schedule.agentId)
  if (agent === undefined || agent.retiredAt !== undefined) return { reason: 'agent-retired' }
  const destination = destinationOf(schedule, state)
  if (destination === undefined || !destination.agents.includes(agent.id)) return { reason: 'agent-left', agent }
  return { agent }
}

/** @param schedule - a task. @param state - the state. @returns its destination channel (a lane found without case), if it exists. */
function destinationOf(schedule: Schedule, state: WorkbenchState): Channel | undefined {
  const destination = schedule.destination
  return destination.kind === 'channel'
    ? (state.channels ?? []).find(candidate => candidate.id === destination.channelId)
    : (state.channels ?? []).find(candidate => isLaneOf(candidate, destination.member))
}

/**
 * The tasks' scheduler: call `tick()` every 30 s. One pass at a time; the
 * runs of one agent one after the other (its ceiling is read before each),
 * different agents' side by side, MAX_PARALLEL_RUNS at most.
 */
export class TaskScheduler {
  readonly #options: TaskSchedulerOptions
  /** Running, by task. */
  readonly #running = new Map<string, Promise<void>>()
  /** The agents with a run going on. */
  readonly #busyAgents = new Set<string>()
  #ticking = false
  #purgedOn: string | undefined
  /** The reasons said today: once a day each. */
  readonly #said = new Set<string>()

  /** @param options - what it needs. */
  constructor(options: TaskSchedulerOptions) {
    this.#options = options
  }

  /** One pass. */
  async tick(): Promise<void> {
    if (this.#ticking) return
    this.#ticking = true
    try {
      const { service, timeZone, warn } = this.#options
      const now = this.#now()
      await this.#purge(now)
      const table = await this.#options.grants.grants()
      if (!table.ok) {
        this.#sayDaily(now, 'grants', 'mndt: scheduled tasks skipped: the role table cannot be read')
        return
      }
      const state = await service.snapshot()
      for (const schedule of state.schedules ?? []) {
        if (schedule.deletedAt !== undefined || this.#running.has(schedule.id)) continue
        // Started and never published, and not running here: a restart cut it. Said, not counted a failure.
        if (schedule.runningSince !== undefined) {
          await service.publishScheduleRun(schedule.id, {
            runId: newRunId(), text: CUT_BY_RESTART_TEXT, status: 'failed',
            startedAt: schedule.runningSince, reasonKind: 'restart', counts: false,
          })
          warn(`mndt: task ${schedule.id}: its run started at ${schedule.runningSince} was cut by a restart`)
          continue
        }
        if (schedule.state !== 'active') continue
        const gone = agentGone(schedule, state)
        if ('reason' in gone) {
          await service.pauseScheduleBecause(schedule.id, gone.reason)
          warn(`mndt: task ${schedule.id} paused: ${gone.reason}`)
          continue
        }
        const left = requesterGone(schedule, state, table)
        if (left !== undefined) {
          await service.pauseScheduleBecause(schedule.id, 'requester-left')
          warn(`mndt: task ${schedule.id} paused: its requester is ${left}`)
          continue
        }
        const { run, missed, last } = slotsOf(schedule, now, timeZone)
        if (last === undefined) continue
        // Its agent already running, or every place taken: the slot waits for a
        // later pass (it stays due within its window), never reserved for nothing.
        if (run !== undefined && (this.#busyAgents.has(gone.agent.id) || this.#running.size >= MAX_PARALLEL_RUNS)) continue
        // The slot is reserved in one write: another pass that moved it wins, never two runs.
        const reserved = await service.reserveScheduleSlot(schedule.id, schedule.lastSlotAt, last.toISOString(), missed, run !== undefined)
        if (reserved === undefined) continue
        if (missed > 0) warn(`mndt: task ${schedule.id}: ${missed} slot(s) missed, never run`)
        if (run === undefined) continue
        const agentId = gone.agent.id
        this.#busyAgents.add(agentId)
        const work = this.#run(reserved.id)
          .catch((error: unknown) => { warn(`mndt: task ${schedule.id} could not be recorded: ${error instanceof Error ? error.name : 'error'}`) })
          .finally(() => {
            this.#running.delete(schedule.id)
            this.#busyAgents.delete(agentId)
          })
        this.#running.set(schedule.id, work)
      }
    } finally {
      this.#ticking = false
    }
  }

  /** @returns once every run started has settled (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.#running.size > 0) await Promise.all([...this.#running.values()])
  }

  /** @returns now, by the clock given. */
  #now(): Date {
    return (this.#options.now ?? (() => new Date()))()
  }

  /** @param now - when. @param key - the reason. @param line - what to say, once a day. */
  #sayDaily(now: Date, key: string, line: string): void {
    const day = now.toISOString().slice(0, 10)
    const said = `${day}|${key}|${line}`
    if (this.#said.has(said)) return
    for (const entry of this.#said) if (!entry.startsWith(`${day}|`)) this.#said.delete(entry)
    this.#said.add(said)
    this.#options.warn(line)
  }

  /** Once a day: the tasks deleted more than TOMBSTONE_DAYS ago are forgotten (their journal lines stay). */
  async #purge(now: Date): Promise<void> {
    const day = now.toISOString().slice(0, 10)
    if (this.#purgedOn === day) return
    this.#purgedOn = day
    const gone = await this.#options.service.purgeDeletedSchedules(new Date(now.getTime() - (TOMBSTONE_DAYS * 86_400_000)).toISOString())
    if (gone > 0) this.#options.warn(`mndt: ${gone} deleted task(s) older than ${TOMBSTONE_DAYS} days forgotten`)
  }

  /**
   * One run of a task, as its requester, published in its destination. Every
   * step is under one try: whatever fails, the run is published as a failure
   * (counted), and its mark of a run never outlives it.
   * @param id - the task, its slot reserved.
   */
  async #run(id: string): Promise<void> {
    const { service, engine, prices, dataDir, timeZone, warn } = this.#options
    const runId = newRunId()
    const started = this.#now()
    const startedAt = started.toISOString()
    let release = (): void => undefined
    try {
      // Read again under a write: still active, not deleted. Otherwise nothing runs.
      const schedule = await service.confirmScheduleRun(id)
      if (schedule === undefined) return
      // Checked again just before it starts: its agent and its requester, now.
      const state = await service.snapshot()
      const table = await this.#options.grants.grants()
      const gone = agentGone(schedule, state)
      const left = requesterGone(schedule, state, table)
      if ('reason' in gone || left !== undefined) {
        await service.pauseScheduleBecause(id, 'reason' in gone ? gone.reason : 'requester-left')
        warn(`mndt: task ${id} paused just before its run: ${'reason' in gone ? gone.reason : `its requester is ${left ?? ''}`}`)
        return
      }
      const agent = gone.agent
      const channel = destinationOf(schedule, state)
      if (channel === undefined) throw new Error('its destination is gone')
      // Its agent's monthly ceiling: what was spent, plus what its turns and runs
      // in flight reserved, plus this run's bound. A model without a price never
      // runs. A refusal is not a failure: the task runs again by itself next month.
      const spent = spentThisMonth(state.messages ?? [], agent.id, startedAt) + reservedFor(agent.id)
      const refused = ceilingRefusal(agent, prices, spent) ?? (spent + schedule.eurPerRun > agent.eurPerMonth ? 'over the ceiling with this run' : undefined)
      const price = priceOf(prices, agent)
      if (refused !== undefined || price === undefined) {
        await service.recordScheduleRefusal(id, startedAt)
        this.#sayDaily(started, `refused-${id}`, `mndt: task ${id} not run: its agent's ceiling is reached, or its model has no price`)
        return
      }
      // The task's instructions, as its requester's message to the agent, with no conversation around it.
      const asked: Message = {
        id: runId,
        channelId: channel.id,
        author: { kind: 'human', email: schedule.requestedBy },
        text: schedule.instructions,
        mentions: [agent.id],
        createdAt: startedAt,
      }
      const skills = skillsOf(agent, state.skills ?? []).kept
      const prompt = `${dateLine(started, timeZone)}\n\n${turnPrompt(agent, channel, [], asked, state.agents ?? [], undefined, skills)}`
      // Its bound is reserved for as long as it runs: a conversation's turn of the same agent sees it.
      release = reserveSpend(agent.id, schedule.eurPerRun)
      const output = await engine.run({
        turnId: runId,
        runId,
        agent,
        channel,
        // As its requester: their connections, their computer; never the owner's.
        actor: schedule.requestedBy,
        prompt,
        cwd: channelFolder(dataDir, channel.id),
        // In a channel, the agent's that the channel allows; in its requester's
        // lane (private to them), the agent's own. The requester's personal
        // connections narrow this with connectors, phase 1.
        servers: schedule.destination.kind === 'lane' ? [...agent.connectors].sort() : turnServers(agent, channel),
        budget: { eur: schedule.eurPerRun, price },
        signal: new AbortController().signal,
      })
      const eur = output.tokens === undefined ? undefined : eurOf(output.tokens, price)
      const text = output.text.trim()
      await service.publishScheduleRun(id, {
        runId,
        text: text === '' ? NO_RUN_TEXT : text,
        status: text === '' ? 'failed' : 'done',
        startedAt,
        ...(eur === undefined ? {} : { eur }),
        ...(text === '' ? { reasonKind: 'no-answer' as const } : {}),
        ...(output.toolsUnavailable === undefined ? {} : { toolsUnavailable: output.toolsUnavailable }),
      })
    } catch (error) {
      // The engine's or a provider's words go to the operator's log; the destination reads the host's sentence.
      const failed = turnFailure(error, warn, `task ${id} (run ${runId})`)
      await service.publishScheduleRun(id, { runId, text: failed.reason, status: 'failed', startedAt, reasonKind: failed.kind })
    } finally {
      release()
    }
  }
}

/** @returns a new run's id. */
function newRunId(): string {
  return `run_${randomUUID().replaceAll('-', '').slice(0, 20)}`
}
