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
import type { Mission, MissionKind, MissionResult, WorkbenchService } from './core/index.ts'

/** One scheduled automation. */
export interface Automation {
  readonly id: string
  readonly name: string
  readonly kind: MissionKind
  readonly prompt: string
  /** Local time, HH:MM. Ignored when everyMinutes is set. */
  readonly at: string
  /** Week days it runs on, 0 is Sunday. Absent means every day. */
  readonly days?: readonly number[]
  /** Test clock: run every N minutes instead of at a fixed hour. */
  readonly everyMinutes?: number
  readonly enabled: boolean
  readonly createdBy: string
  readonly mandateId?: string
  readonly lastFiredDate?: string
  readonly lastFiredAt?: string
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
    ...(typeof input.mandateId === 'string' && input.mandateId.trim() !== '' ? { mandateId: input.mandateId.trim() } : {}),
    ...(typeof input.lastFiredDate === 'string' ? { lastFiredDate: input.lastFiredDate } : {}),
    ...(typeof input.lastFiredAt === 'string' ? { lastFiredAt: input.lastFiredAt } : {}),
    ...(typeof input.lastMissionId === 'string' ? { lastMissionId: input.lastMissionId } : {}),
    ...(typeof input.lastOutcome === 'string' ? { lastOutcome: input.lastOutcome } : {}),
    ...(typeof input.failures === 'number' && Number.isFinite(input.failures) ? { failures: Math.max(0, Math.floor(input.failures)) } : {}),
  }
}

/** @param now - the moment to test. @returns the run date and the run clock. */
function clockOf(now: Date): { readonly date: string; readonly clock: string } {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return { date, clock }
}

/**
 * @param items - the registry.
 * @param now - the moment to test.
 * @returns the automations that must run now, in registry order.
 */
export function dueAutomations(items: readonly Automation[], now: Date): readonly Automation[] {
  const { date, clock } = clockOf(now)
  const due: Automation[] = []
  for (const item of items) {
    if (!item.enabled) continue
    if (item.everyMinutes !== undefined) {
      const previous = item.lastFiredAt === undefined ? 0 : Date.parse(item.lastFiredAt)
      if (!Number.isFinite(previous) || now.getTime() - previous < item.everyMinutes * 60_000) continue
      due.push(item)
      continue
    }
    if (item.at !== clock) continue
    if (item.days !== undefined && !item.days.includes(now.getDay())) continue
    if (item.lastFiredDate === date) continue
    due.push(item)
  }
  return due
}

/** @param now - the moment the run starts. @returns the fields to store. */
export function firedFields(now: Date): Partial<Automation> {
  const { date } = clockOf(now)
  return { lastFiredDate: date, lastFiredAt: now.toISOString() }
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
): Promise<{ readonly missionId: string; readonly outcome: string }> {
  const mission = await service.createMission({
    kind: item.kind,
    prompt: item.prompt,
    createdBy: item.createdBy,
    visibility: 'team',
    ...(item.mandateId === undefined ? {} : { mandateId: item.mandateId }),
  })
  const started = await service.startMission(mission.id, 'scheduled')
  try {
    const result = await runner.run(started)
    await service.completeMission(started.id, result)
    return { missionId: started.id, outcome: 'done' }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await service.failMission(started.id, reason).catch(() => undefined)
    return { missionId: started.id, outcome: `failed: ${reason}` }
  }
}
