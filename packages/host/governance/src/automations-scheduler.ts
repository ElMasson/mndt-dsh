/**
 * The scheduling core of user automations.
 *
 * It is deliberately ignorant of agents and workflows: it answers one question,
 * "what is due now", and hands each due item to a runner. That keeps the timing
 * logic testable without spawning an agent, and keeps the real execution path
 * (create an agent, start a workflow) in a thin adapter that cannot hide a
 * failure behind the clock.
 */

/** What the scheduler needs to know about one automation. */
export interface ScheduledAutomation {
  /** Stable identity. */
  readonly id: string
  /** How often it should run. */
  readonly everyMinutes: number
  /** Whether it is enabled. */
  readonly enabled: boolean
}

/** The scheduler's inputs. */
export interface SchedulerOptions<T extends ScheduledAutomation> {
  /** Reads the current automations. */
  readonly list: () => Promise<readonly T[]>
  /** Runs one automation. Its rejection is reported, never swallowed. */
  readonly run: (automation: T) => Promise<void>
  /** Clock seam. */
  readonly now?: () => Date
  /** Grace window, so a tick that lands a second early still counts. */
  readonly graceMs?: number
}

/** One tick's outcome. */
export interface TickOutcome {
  /** Identities that ran. */
  readonly ran: string[]
  /** Failures, with the automation identity and the reason. */
  readonly failed: { id: string; reason: string }[]
}

/** The scheduler. */
export class AutomationScheduler<T extends ScheduledAutomation> {
  readonly #options: SchedulerOptions<T>
  readonly #lastRun = new Map<string, number>()
  #timer: ReturnType<typeof setInterval> | undefined
  #running = false

  /** @param options - list, runner, clock, grace. */
  constructor(options: SchedulerOptions<T>) {
    this.#options = options
  }

  /** @returns the last recorded run instant per automation. */
  lastRuns(): ReadonlyMap<string, number> {
    return this.#lastRun
  }

  /**
   * Run one tick: every enabled automation whose interval has elapsed runs once.
   * @returns which items ran and which failed.
   */
  async tick(): Promise<TickOutcome> {
    if (this.#running) return { ran: [], failed: [] }
    this.#running = true
    const ran: string[] = []
    const failed: { id: string; reason: string }[] = []
    const now = (this.#options.now ?? (() => new Date()))()
    const grace = this.#options.graceMs ?? 1_000
    try {
      const items = await this.#options.list()
      for (const item of items) {
        if (!item.enabled) continue
        const last = this.#lastRun.get(item.id)
        const due = last === undefined || now.getTime() - last >= item.everyMinutes * 60_000 - grace
        if (!due) continue
        this.#lastRun.set(item.id, now.getTime())
        try {
          await this.#options.run(item)
          ran.push(item.id)
        } catch (error) {
          failed.push({ id: item.id, reason: error instanceof Error ? error.message : String(error) })
        }
      }
    } finally {
      this.#running = false
    }
    return { ran, failed }
  }

  /**
   * Start ticking.
   * @param intervalMs - tick period; defaults to one minute.
   */
  start(intervalMs = 60_000): void {
    if (this.#timer !== undefined) return
    this.#timer = setInterval(() => { void this.tick() }, intervalMs)
  }

  /** Stop ticking. */
  stop(): void {
    if (this.#timer === undefined) return
    clearInterval(this.#timer)
    this.#timer = undefined
  }
}
