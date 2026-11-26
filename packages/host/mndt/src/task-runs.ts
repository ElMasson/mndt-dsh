/**
 * Scheduled tasks, run (tasks PR 2).
 *
 * A pass every 30 s, in the workbench: for each active task, the slots its
 * cadence placed since the last slot it handled, in the instance's zone. The
 * latest one is run if it is less than TASK_CATCH_UP_MINUTES old; every other
 * is counted missed, never run (no catch-up after a cut). A task never runs
 * twice at once.
 *
 * A run is a turn of the task's agent, outside any conversation: the agent's
 * model, prompt and skills; its connectors as the destination allows them (all
 * of them in its requester's lane); the date, then the task's instructions;
 * acting as its requester (their mailbox, their computer: never the owner's);
 * bounded by the task's euros per run and the agent's monthly ceiling. What
 * came of it is published in the destination as a system message carrying the
 * run (Message.mission, kind `scheduled`), and recorded on the task.
 *
 * A task whose agent is retired, or gone from its destination channel, is
 * paused with that reason. Deleted tasks are forgotten after TOMBSTONE_DAYS.
 */
import { randomUUID } from 'node:crypto'
import { ceilingRefusal, dateLine, eurOf, nextRuns, priceOf, skillsOf, spentThisMonth, turnPrompt, turnServers } from './core/index.ts'
import type { Agent, Channel, Message, PriceGrid, Schedule, WorkbenchService } from './core/index.ts'
import { turnFailure } from './public-failure.ts'
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

/** What the tasks' scheduler needs. */
export interface TaskSchedulerOptions {
  readonly service: WorkbenchService
  readonly engine: TurnEngine
  readonly prices: PriceGrid
  /** Where each channel's folder lives (the run's working directory). */
  readonly dataDir: string
  readonly timeZone: string
  /** The operator's line. */
  readonly warn: (line: string) => void
  /** The clock (tests). */
  readonly now?: () => Date
}

/** The tasks' scheduler: call `tick()` every 30 s. */
export class TaskScheduler {
  readonly #options: TaskSchedulerOptions
  readonly #running = new Map<string, Promise<void>>()
  #ticking = false
  #purgedOn: string | undefined

  /** @param options - what it needs. */
  constructor(options: TaskSchedulerOptions) {
    this.#options = options
  }

  /** One pass: one at a time; a task already running is left alone. */
  async tick(): Promise<void> {
    if (this.#ticking) return
    this.#ticking = true
    try {
      const { service, timeZone, warn } = this.#options
      const now = this.#now()
      await this.#purge(now)
      const state = await service.snapshot()
      for (const schedule of state.schedules ?? []) {
        if (schedule.deletedAt !== undefined || this.#running.has(schedule.id)) continue
        // Started and never published, and not running here: a restart cut it. Said, not counted a failure.
        if (schedule.runningSince !== undefined) {
          await service.publishScheduleRun(schedule.id, {
            runId: `run_${randomUUID().replaceAll('-', '').slice(0, 20)}`, text: CUT_BY_RESTART_TEXT, status: 'failed',
            startedAt: schedule.runningSince, reasonKind: 'restart', counts: false,
          })
          warn(`mndt: task ${schedule.id}: its run started at ${schedule.runningSince} was cut by a restart`)
          continue
        }
        if (schedule.state !== 'active') continue
        const agent = (state.agents ?? []).find(candidate => candidate.id === schedule.agentId)
        if (agent === undefined || agent.retiredAt !== undefined) {
          await service.pauseScheduleBecause(schedule.id, 'agent-retired')
          warn(`mndt: task ${schedule.id} paused: its agent is retired`)
          continue
        }
        if (schedule.destination.kind === 'channel') {
          const destination = schedule.destination.channelId
          const channel = (state.channels ?? []).find(candidate => candidate.id === destination)
          if (channel === undefined || !channel.agents.includes(agent.id)) {
            await service.pauseScheduleBecause(schedule.id, 'agent-left')
            warn(`mndt: task ${schedule.id} paused: its agent is no longer in its channel`)
            continue
          }
        }
        const { run, missed, last } = slotsOf(schedule, now, timeZone)
        if (last === undefined) continue
        // The slot is reserved in one write: another pass that moved it wins, never two runs.
        const reserved = await service.reserveScheduleSlot(schedule.id, schedule.lastSlotAt, last.toISOString(), missed, run !== undefined)
        if (reserved === undefined) continue
        if (missed > 0) warn(`mndt: task ${schedule.id}: ${missed} slot(s) missed, never run`)
        if (run === undefined) continue
        const work = this.#run(reserved, agent)
          .catch((error: unknown) => { warn(`mndt: task ${schedule.id} could not be recorded: ${error instanceof Error ? error.name : 'error'}`) })
          .finally(() => { this.#running.delete(schedule.id) })
        this.#running.set(schedule.id, work)
      }
    } finally {
      this.#ticking = false
    }
  }

  /** @returns once every run started has settled (tests, shutdown). */
  async settled(): Promise<void> {
    await Promise.all([...this.#running.values()])
  }

  /** @returns now, by the clock given. */
  #now(): Date {
    return (this.#options.now ?? (() => new Date()))()
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
   * One run of a task, as its requester, published in its destination.
   * @param schedule - the task, its slot reserved.
   * @param agent - its agent.
   */
  async #run(schedule: Schedule, agent: Agent): Promise<void> {
    const { service, engine, prices, dataDir, timeZone, warn } = this.#options
    const runId = `run_${randomUUID().replaceAll('-', '').slice(0, 20)}`
    const started = this.#now()
    const startedAt = started.toISOString()
    const state = await service.snapshot()
    const channel: Channel = schedule.destination.kind === 'channel'
      ? (state.channels ?? []).find(candidate => candidate.id === (schedule.destination as { channelId: string }).channelId) as Channel
      : await service.laneOf(schedule.destination.member)
    // The agent's monthly ceiling, its runs included; and a model without a price never runs.
    const refused = ceilingRefusal(agent, prices, spentThisMonth(state.messages ?? [], agent.id, startedAt))
    const price = priceOf(prices, agent)
    if (refused !== undefined || price === undefined) {
      await service.publishScheduleRun(schedule.id, { runId, text: refused ?? 'Prix du modèle non configuré.', status: 'failed', startedAt, reasonKind: 'refused' })
      return
    }
    try {
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
      // In the requester's lane, the agent's own connectors; in a channel, those the channel allows.
      const servers = schedule.destination.kind === 'lane' ? [...agent.connectors].sort() : turnServers(agent, channel)
      const output = await engine.run({
        turnId: runId,
        runId,
        agent,
        channel,
        // As its requester: their connections, their computer; never the owner's.
        actor: schedule.requestedBy,
        prompt,
        cwd: channelFolder(dataDir, channel.id),
        servers,
        budget: { eur: schedule.eurPerRun, price },
        signal: new AbortController().signal,
      })
      const eur = output.tokens === undefined ? undefined : eurOf(output.tokens, price)
      const text = output.text.trim()
      await service.publishScheduleRun(schedule.id, {
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
      const failed = turnFailure(error, warn, `task ${schedule.id} (run ${runId})`)
      await service.publishScheduleRun(schedule.id, { runId, text: failed.reason, status: 'failed', startedAt, reasonKind: failed.kind })
    }
  }
}
