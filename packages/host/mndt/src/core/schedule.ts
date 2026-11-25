/**
 * Scheduled tasks (design of 25/11, decided by Stéphane): an agent proposes a
 * recurring task as a card (propose_schedule), a decider approves it, and the
 * task runs as a mission of that agent, its result published in its
 * destination. This module holds the rules that need no host: what a proposal
 * is, when its next runs fall in the instance's time zone.
 */
import { Refusal } from './refusal.ts'

/** When a task runs: a day, days of the week, a day of the month, at a time; or a cron of five fields. */
export type ScheduleCadence =
  | { readonly every: 'day'; readonly at: string }
  | { readonly every: 'week'; readonly days: readonly number[]; readonly at: string }
  | { readonly every: 'month'; readonly monthDay: number; readonly at: string }
  | { readonly cron: string }

/** Where a task's result is published: the channel of the turn that proposed it, or the requester's lane. */
export type ScheduleDestination =
  | { readonly kind: 'channel'; readonly channelId: string }
  | { readonly kind: 'lane'; readonly member: string }

/** What a propose_schedule card carries: exactly what approval creates. */
export interface ScheduleProposal {
  readonly title: string
  readonly instructions: string
  readonly cadence: ScheduleCadence
  readonly agentId: string
  readonly destination: ScheduleDestination
  readonly eurPerRun: number
}

/** Why a task is paused when no person paused it. */
export type SchedulePauseReason = 'failures' | 'agent-retired' | 'agent-left' | 'owner'

/** A scheduled task, as the state keeps it. */
export interface Schedule extends ScheduleProposal {
  readonly id: string
  readonly state: 'active' | 'paused'
  readonly pausedBecause?: SchedulePauseReason
  readonly requestedBy: string
  readonly approvedBy: string
  readonly approvedAt: string
  /** The card it was approved from. */
  readonly approvalId: string
  readonly lastRunAt?: string
  readonly lastEur?: number
  readonly missed?: number
  readonly failures?: number
}

/** The codes of a refused proposal or gesture, the screen's to translate. */
export type ScheduleRefusalCode = 'schedule-invalid' | 'cadence-too-frequent' | 'destination-not-yours' | 'not-allowed'

/** A refusal of a proposal or a gesture on a task: the host's words, with a code. */
export class ScheduleRefusal extends Refusal {
  readonly code: ScheduleRefusalCode
  /** @param code - its code. @param message - the host's words. */
  constructor(code: ScheduleRefusalCode, message: string) {
    super(message)
    this.name = 'ScheduleRefusal'
    this.code = code
  }
}

export const MAX_SCHEDULE_TITLE = 80
export const MAX_SCHEDULE_INSTRUCTIONS = 4000
export const MIN_EUR_PER_RUN = 0.01
export const MAX_EUR_PER_RUN = 5
export const DEFAULT_EUR_PER_RUN = 0.5

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * @param value - a cadence as asked.
 * @returns it, checked, or why it is refused. A cron's minute is one value: a
 * task runs at most once an hour.
 */
export function checkedCadence(value: unknown): ScheduleCadence {
  if (typeof value !== 'object' || value === null) throw new ScheduleRefusal('schedule-invalid', 'a cadence is an object')
  const cadence = value as Record<string, unknown>
  if (typeof cadence.cron === 'string') {
    const fields = cadence.cron.trim().split(/\s+/)
    if (fields.length !== 5) throw new ScheduleRefusal('schedule-invalid', 'a cron has five fields: minute, hour, day of the month, month, day of the week')
    if (!/^\d{1,2}$/.test(fields[0] ?? '') || Number(fields[0]) > 59) {
      throw new ScheduleRefusal('cadence-too-frequent', 'a task runs at most once an hour: its cron names one minute (0-59)')
    }
    for (const [index, field] of fields.slice(1).entries()) parseField(field, CRON_RANGES[index + 1] ?? [0, 0])
    return { cron: fields.join(' ') }
  }
  const at = typeof cadence.at === 'string' ? cadence.at.trim() : ''
  if (!TIME.test(at)) throw new ScheduleRefusal('schedule-invalid', 'a cadence names its time as HH:MM')
  if (cadence.every === 'day') return { every: 'day', at }
  if (cadence.every === 'week') {
    const days = Array.isArray(cadence.days) ? [...new Set(cadence.days)] : []
    if (days.length === 0 || !days.every(day => Number.isInteger(day) && (day as number) >= 1 && (day as number) <= 7)) {
      throw new ScheduleRefusal('schedule-invalid', 'a weekly cadence names its days, 1 (Monday) to 7 (Sunday)')
    }
    return { every: 'week', days: (days as number[]).sort((a, b) => a - b), at }
  }
  if (cadence.every === 'month') {
    const day = cadence.monthDay
    if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 28) {
      throw new ScheduleRefusal('schedule-invalid', 'a monthly cadence names its day, 1 to 28 (every month has it)')
    }
    return { every: 'month', monthDay: day, at }
  }
  throw new ScheduleRefusal('schedule-invalid', 'a cadence is every day, week or month, or a cron')
}

/**
 * @param value - a proposal as an agent asked it (the agent and the destination
 * are the host's, never what the request says).
 * @param agentId - the agent of the turn.
 * @param destination - the channel of the turn, or the requester's lane.
 * @returns the proposal, checked.
 */
export function checkedScheduleProposal(value: unknown, agentId: string, destination: ScheduleDestination): ScheduleProposal {
  if (typeof value !== 'object' || value === null) throw new ScheduleRefusal('schedule-invalid', 'a propose_schedule card needs a schedule')
  const asked = value as Record<string, unknown>
  const title = typeof asked.title === 'string' ? asked.title.replace(/\s+/g, ' ').trim() : ''
  if (title === '' || Array.from(title).length > MAX_SCHEDULE_TITLE) {
    throw new ScheduleRefusal('schedule-invalid', `a task's title is one line, ${MAX_SCHEDULE_TITLE} characters at most`)
  }
  const instructions = typeof asked.instructions === 'string' ? asked.instructions.trim() : ''
  if (instructions === '' || instructions.length > MAX_SCHEDULE_INSTRUCTIONS) {
    throw new ScheduleRefusal('schedule-invalid', `a task's instructions are ${MAX_SCHEDULE_INSTRUCTIONS} characters at most, and not empty`)
  }
  const eur = asked.eurPerRun === undefined ? DEFAULT_EUR_PER_RUN : asked.eurPerRun
  if (typeof eur !== 'number' || !Number.isFinite(eur) || eur < MIN_EUR_PER_RUN || eur > MAX_EUR_PER_RUN) {
    throw new ScheduleRefusal('schedule-invalid', `a task costs ${MIN_EUR_PER_RUN} € to ${MAX_EUR_PER_RUN} € at most per run`)
  }
  return { title, instructions, cadence: checkedCadence(asked.cadence), agentId, destination, eurPerRun: Math.round(eur * 100) / 100 }
}

/** The ranges of a cron's fields: minute, hour, day of the month, month, day of the week (0 and 7: Sunday). */
const CRON_RANGES: readonly (readonly [number, number])[] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]

/**
 * @param field - one cron field: `*`, a number, a range `a-b`, a step `*\/n` or `a-b/n`, a list of those.
 * @param range - its bounds.
 * @returns the values it names.
 */
function parseField(field: string, range: readonly [number, number]): ReadonlySet<number> {
  const [low, high] = range
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (match === null) throw new ScheduleRefusal('schedule-invalid', `a cron field « ${field} » is not understood`)
    const from = match[1] === '*' ? low : Number(match[2])
    const to = match[1] === '*' ? high : match[3] === undefined ? (match[4] === undefined ? from : high) : Number(match[3])
    const step = match[4] === undefined ? 1 : Number(match[4])
    if (from < low || to > high || from > to || step < 1) throw new ScheduleRefusal('schedule-invalid', `a cron field « ${field} » is out of ${low}-${high}`)
    for (let value = from; value <= to; value += step) values.add(value)
  }
  return values
}

/** @param date - an instant. @param timeZone - an IANA zone. @returns its wall clock there. */
/** A wall-clock reading in a zone. */
interface WallClock { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

function wallClock(date: Date, timeZone: string): WallClock {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date).map(part => [part.type, part.value]))
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), weekday: weekdays.indexOf(String(parts.weekday)) + 1,
  }
}

/**
 * @param year - a year. @param month - 1-12. @param day - 1-31. @param hour - 0-23. @param minute - 0-59.
 * @param timeZone - an IANA zone.
 * @returns the instant at which that wall-clock time falls in the zone.
 */
function instantAt(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute)
  // Two passes reach the zone's offset at that time, a change of offset included.
  let guess = asUtc
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = wallClock(new Date(guess), timeZone)
    guess += asUtc - Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute)
  }
  return new Date(guess)
}

/**
 * The next runs of a cadence, strictly after `from`, in the instance's zone.
 * @param cadence - a checked cadence.
 * @param from - the instant after which to look.
 * @param timeZone - the instance's IANA zone.
 * @param count - how many.
 * @returns the runs, as instants; fewer when none falls in the next 400 days.
 */
export function nextRuns(cadence: ScheduleCadence, from: Date, timeZone: string, count = 3): Date[] {
  const runs: Date[] = []
  const start = wallClock(from, timeZone)
  const cron = 'cron' in cadence
    ? cadence.cron.split(' ').map((field, index) => parseField(field, CRON_RANGES[index] ?? [0, 0]))
    : undefined
  for (let offset = 0; offset <= 400 && runs.length < count; offset += 1) {
    // The calendar day `offset` days after `from`'s, in the zone (noon: clear of a change of offset).
    const noon = instantAt(start.year, start.month, start.day, 12, 0, timeZone)
    const day = wallClock(new Date(noon.getTime() + offset * 86_400_000), timeZone)
    const times: [number, number][] = []
    if (cron !== undefined) {
      type Field = ReadonlySet<number>
      const [minutes, hours, monthDays, months, weekdays] = cron as [Field, Field, Field, Field, Field]
      const weekday = day.weekday % 7
      const dayMatches = (monthDays.size === 31 || weekdays.size === 8)
        ? monthDays.has(day.day) && (weekdays.has(weekday) || (weekday === 0 && weekdays.has(7)))
        : monthDays.has(day.day) || weekdays.has(weekday) || (weekday === 0 && weekdays.has(7))
      if (!months.has(day.month) || !dayMatches) continue
      for (const hour of [...hours].sort((a, b) => a - b)) {
        for (const minute of [...minutes].sort((a, b) => a - b)) times.push([hour, minute])
      }
    } else {
      const timed = cadence as Exclude<ScheduleCadence, { readonly cron: string }>
      const [hour, minute] = timed.at.split(':').map(Number) as [number, number]
      const matches = timed.every === 'day'
        || (timed.every === 'week' && timed.days.includes(day.weekday))
        || (timed.every === 'month' && timed.monthDay === day.day)
      if (matches) times.push([hour, minute])
    }
    for (const [hour, minute] of times) {
      const at = instantAt(day.year, day.month, day.day, hour, minute, timeZone)
      if (at.getTime() > from.getTime() && runs.length < count) runs.push(at)
    }
  }
  return runs
}

/**
 * @param cadence - a checked cadence.
 * @param now - the instant.
 * @param timeZone - the instance's zone.
 * @returns how many runs fall in the month of `now`, in the zone (all of them, past ones included).
 */
export function runsThisMonth(cadence: ScheduleCadence, now: Date, timeZone: string): number {
  const today = wallClock(now, timeZone)
  const first = instantAt(today.year, today.month, 1, 0, 0, timeZone)
  const next = today.month === 12
    ? instantAt(today.year + 1, 1, 1, 0, 0, timeZone)
    : instantAt(today.year, today.month + 1, 1, 0, 0, timeZone)
  return nextRuns(cadence, new Date(first.getTime() - 1), timeZone, 31 * 24).filter(run => run.getTime() < next.getTime()).length
}
