/**
 * Scheduled automations.
 *
 * An automation is a mission nobody starts by hand: a fixed prompt, a clock, and
 * a result dropped into the feed. The registry lives beside the product state so
 * a restart keeps it, and the same runner executes it, which means the model,
 * the connectors and the approval rules are exactly those of a normal mission.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { nextRuns, wallClock } from './core/index.ts'
import type { Mission, MissionKind, MissionResult, WorkbenchService } from './core/index.ts'

/**
 * How late a daily automation may still start: a pass that misses its minute
 * (a restart, a busy process) starts it within this window, never later. The
 * same rule as the scheduled tasks' `missed`.
 */
export const CATCH_UP_MINUTES = 15

/** One scheduled automation. */
export interface Automation {
  readonly id: string
  readonly name: string
  readonly kind: MissionKind
  readonly prompt: string
  /** Time in the instance's zone (DSH_MNDT_TIME_ZONE), HH:MM. Ignored when everyMinutes is set. */
  readonly at: string
  /** Week days it runs on, 0 is Sunday, in the instance's zone. Absent means every day. */
  readonly days?: readonly number[]
  /** Test clock: run every N minutes instead of at a fixed hour. */
  readonly everyMinutes?: number
  readonly enabled: boolean
  /**
   * Who last enabled it, written by the server (never read from a request). On
   * a team instance an automation runs only when the owner enabled it.
   */
  readonly enabledBy?: string
  readonly createdBy: string
  readonly mandateId?: string
  /** The day, in the instance's zone, the scheduler last started it. */
  readonly lastFiredDate?: string
  /** When the scheduler last started it. */
  readonly lastFiredAt?: string
  /** When it last started at all: by the scheduler or by a person (« Exécuter maintenant »). */
  readonly lastRunAt?: string
  readonly lastMissionId?: string
  readonly lastOutcome?: string
  readonly failures?: number
}

/** What the registry file contains. */
export interface AutomationRegistry {
  readonly items: readonly Automation[]
}

/** What a caller may propose. */
export type AutomationInput = Partial<Omit<Automation, 'id'>> & { readonly id?: string }

/** The briefing prompt, kept where the previous scheduler kept it. */
const BRIEFING_PROMPT = 'Briefing du matin : agenda, courriers sans réponse, comptes à risque, échéances, réunions du jour. '
  + 'Consulte les outils de lecture des connecteurs montés, par exemple Attio et Office365 en lecture, et cite ce que tu lis réellement. '
  + 'Si une rubrique n\'a aucune source accessible, dis-le au lieu de l\'inventer.'

/** What a fresh deployment starts with: the briefing, and three quiet candidates. */
export function defaultAutomations(): readonly Automation[] {
  return [
    {
      id: 'auto_briefing', name: 'Briefing du matin', kind: 'briefing', prompt: BRIEFING_PROMPT,
      at: '07:30', enabled: true, createdBy: 'scheduler',
    },
    {
      id: 'auto_approvals', name: 'Relance des approbations', kind: 'custom',
      prompt: 'Liste les approbations en attente et, pour chacune, depuis combien de temps elle attend et qui doit décider. '
        + 'Ne décide rien, ne demande rien, ne modifie rien.',
      at: '09:00', enabled: false, createdBy: 'scheduler',
    },
    {
      id: 'auto_mandates', name: 'Échéances de mandat', kind: 'custom',
      prompt: 'Regarde les mandats actifs. Signale ceux qui expirent dans moins de trente jours, avec leur échéance et le périmètre concerné. '
        + 'Ne modifie aucun mandat.',
      at: '08:30', enabled: false, createdBy: 'scheduler',
    },
  ]
}

/** @param value - a clock. @returns whether it is HH:MM. */
export function isClock(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

/** @param value - a proposed automation. @returns its id. */
function newId(): string {
  return `auto_${randomBytes(6).toString('hex')}`
}

/**
 * Read the registry, seeding it on first use.
 *
 * A deployment that predates the registry has only the briefing hour file, so
 * that hour is carried over instead of silently reset.
 * @param path - the registry file.
 * @param legacyAt - the briefing hour from the older file, when present.
 * @returns the items, and whether the file had to be written.
 */
export async function readAutomations(path: string, legacyAt?: string): Promise<readonly Automation[]> {
  const raw = await readFile(path, 'utf8').catch(() => '')
  if (raw.trim() !== '') {
    const parsed = JSON.parse(raw) as { items?: unknown }
    const items = Array.isArray(parsed.items) ? parsed.items : []
    const kept: Automation[] = []
    for (const candidate of items) {
      const normalised = normalise(candidate)
      if (normalised !== undefined) kept.push(normalised)
    }
    return kept
  }
  const seeded = defaultAutomations().map(item => (item.id === 'auto_briefing' && legacyAt !== undefined && isClock(legacyAt) ? { ...item, at: legacyAt } : item))
  await writeAutomations(path, seeded)
  return seeded
}

/** @param path - the registry file. @param items - what to store. */
export async function writeAutomations(path: string, items: readonly Automation[]): Promise<void> {
  await writeFile(path, JSON.stringify({ items }, null, 2), 'utf8')
}

/**
 * @param candidate - something read or posted.
 * @returns a complete automation, or undefined when it cannot be used.
 */
export function normalise(candidate: unknown): Automation | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const input = candidate as Record<string, unknown>
  const kind = input.kind
  if (kind !== 'briefing' && kind !== 'weekly-synthesis' && kind !== 'account-review' && kind !== 'custom') return undefined
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (prompt === '') return undefined
  const everyMinutes = typeof input.everyMinutes === 'number' && Number.isFinite(input.everyMinutes) && input.everyMinutes > 0
    ? Math.floor(input.everyMinutes)
    : undefined
  const at = isClock(input.at) ? input.at : '07:30'
  if (everyMinutes === undefined && !isClock(at)) return undefined
  const days = Array.isArray(input.days)
    ? [...new Set(input.days.filter((day): day is number => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6))].sort((left, right) => left - right)
    : undefined
  const name = typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : 'Automatisation'
  const enabled = input.enabled !== false
  return {
    id: typeof input.id === 'string' && input.id.trim() !== '' ? input.id.trim() : newId(),
    name,
    kind,
    prompt,
    at,
    ...(days === undefined || days.length === 0 ? {} : { days }),
    ...(everyMinutes === undefined ? {} : { everyMinutes }),
    enabled,
    createdBy: typeof input.createdBy === 'string' && input.createdBy.trim() !== '' ? input.createdBy.trim() : 'scheduler',
    ...(typeof input.enabledBy === 'string' && input.enabledBy.trim() !== '' ? { enabledBy: input.enabledBy.trim() } : {}),
    ...(typeof input.mandateId === 'string' && input.mandateId.trim() !== '' ? { mandateId: input.mandateId.trim() } : {}),
    ...(typeof input.lastFiredDate === 'string' ? { lastFiredDate: input.lastFiredDate } : {}),
    ...(typeof input.lastFiredAt === 'string' ? { lastFiredAt: input.lastFiredAt } : {}),
    ...(typeof input.lastRunAt === 'string' ? { lastRunAt: input.lastRunAt } : {}),
    ...(typeof input.lastMissionId === 'string' ? { lastMissionId: input.lastMissionId } : {}),
    ...(typeof input.lastOutcome === 'string' ? { lastOutcome: input.lastOutcome } : {}),
    ...(typeof input.failures === 'number' && Number.isFinite(input.failures) ? { failures: Math.max(0, Math.floor(input.failures)) } : {}),
  }
}

/**
 * @param now - the moment to test.
 * @param timeZone - the instance's IANA zone.
 * @returns the day (YYYY-MM-DD), the minute of the day and the week day (0 is Sunday) there.
 */
function clockOf(now: Date, timeZone: string): { readonly date: string; readonly minute: number; readonly weekday: number } {
  const wall = wallClock(now, timeZone)
  const date = `${wall.year}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}`
  return { date, minute: (wall.hour * 60) + wall.minute, weekday: wall.weekday % 7 }
}

/** @param at - HH:MM. @returns its minute of the day. */
function minuteOf(at: string): number {
  const [hours, minutes] = at.split(':').map(Number)
  return ((hours ?? 0) * 60) + (minutes ?? 0)
}

/**
 * A daily automation is due from its minute, in the instance's zone, until
 * CATCH_UP_MINUTES later, once a day: a pass that misses the minute itself (a
 * restart, a busy process) still starts it, and a later one never does. The
 * window stays within the day: an automation at 23:55 missed past midnight is
 * not started the next day.
 * @param items - the registry.
 * @param now - the moment to test.
 * @param timeZone - the instance's IANA zone.
 * @returns the automations that must run now, in registry order.
 */
export function dueAutomations(items: readonly Automation[], now: Date, timeZone: string): readonly Automation[] {
  const { date, minute, weekday } = clockOf(now, timeZone)
  const due: Automation[] = []
  for (const item of items) {
    if (!item.enabled) continue
    if (item.everyMinutes !== undefined) {
      const previous = item.lastFiredAt === undefined ? 0 : Date.parse(item.lastFiredAt)
      if (!Number.isFinite(previous) || now.getTime() - previous < item.everyMinutes * 60_000) continue
      due.push(item)
      continue
    }
    const late = minute - minuteOf(item.at)
    if (late < 0 || late >= CATCH_UP_MINUTES) continue
    if (item.days !== undefined && !item.days.includes(weekday)) continue
    if (item.lastFiredDate === date) continue
    due.push(item)
  }
  return due
}

/**
 * @param now - the moment the run starts.
 * @param timeZone - the instance's IANA zone.
 * @returns the fields to store.
 */
export function firedFields(now: Date, timeZone: string): Partial<Automation> {
  const { date } = clockOf(now, timeZone)
  return { lastFiredDate: date, lastFiredAt: now.toISOString(), lastRunAt: now.toISOString() }
}

/**
 * @param item - an automation.
 * @param now - from when.
 * @param timeZone - the instance's IANA zone.
 * @returns when the scheduler will next start it (ISO), or undefined when it is suspended.
 */
export function nextRunAt(item: Automation, now: Date, timeZone: string): string | undefined {
  if (!item.enabled) return undefined
  if (item.everyMinutes !== undefined) {
    const previous = item.lastFiredAt === undefined ? Number.NaN : Date.parse(item.lastFiredAt)
    const next = Number.isFinite(previous) ? Math.max(now.getTime(), previous + (item.everyMinutes * 60_000)) : now.getTime()
    return new Date(next).toISOString()
  }
  // Already due today (within its window, not yet started): now.
  if (dueAutomations([item], now, timeZone).length > 0) return now.toISOString()
  const cadence = item.days === undefined
    ? { every: 'day' as const, at: item.at }
    // The tasks' cadence counts the days 1 (Monday) to 7 (Sunday); an automation, 0 (Sunday) to 6.
    : { every: 'week' as const, days: item.days.map(day => (day === 0 ? 7 : day)), at: item.at }
  const today = clockOf(now, timeZone).date
  // nextRuns counts from `now` included: a slot today already started (or past) is skipped.
  const runs = nextRuns(cadence, now, timeZone, 3)
  const next = runs.find(run => !(clockOf(run, timeZone).date === today && item.lastFiredDate === today) && run.getTime() >= now.getTime())
  return next?.toISOString()
}

/**
 * Run one automation now.
 *
 * The mission is created and started before the model runs, so a crash leaves a
 * visible mission instead of silence. The caller stores the returned outcome.
 * @param service - the product service.
 * @param runner - the mission runner.
 * @param item - the automation to run.
 * @returns the mission id and the outcome sentence.
 */
export async function runAutomation(
  service: WorkbenchService,
  runner: { run(mission: Mission): Promise<MissionResult> },
  item: Automation,
  owner?: string,
): Promise<{ readonly missionId: string; readonly outcome: string }> {
  // On a team instance (`owner` given) the run is the owner's and stays private:
  // it reads every mounted connector, so its text is never served to the team.
  const mission = await service.createMission({
    kind: item.kind,
    prompt: item.prompt,
    createdBy: owner ?? item.createdBy,
    visibility: owner === undefined ? 'team' : 'private',
    ...(item.mandateId === undefined ? {} : { mandateId: item.mandateId }),
    // The name the owner reads above the report published in their lane.
    title: item.name,
    automationId: item.id,
  })
  const started = await service.startMission(mission.id, 'scheduled')
  try {
    const result = await runner.run(started)
    await service.completeMission(started.id, result)
    return { missionId: started.id, outcome: 'done' }
  } catch (error) {
    // The runtime's words, for failMission: it serves the host's sentence and logs these.
    const raw = error instanceof Error ? error.message : String(error)
    await service.failMission(started.id, raw).catch(() => undefined)
    // Served on the automation (lastOutcome): the host's sentence, never the runtime's words.
    const failed = await service.getMission(started.id)
    return { missionId: started.id, outcome: `failed: ${failed?.error ?? 'Erreur pendant l’exécution.'}` }
  }
}
