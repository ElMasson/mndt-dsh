import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/core/store.ts'
import { WorkbenchService } from '../src/core/service.ts'
import {
  defaultAutomations, dueAutomations, firedFields, nextRunAt, normalise, readAutomations, runAutomation, writeAutomations,
} from '../src/automations.ts'
import type { Automation } from '../src/automations.ts'
import type { Mission, MissionResult } from '../src/core/index.ts'

const created: string[] = []
afterEach(async () => {
  while (created.length > 0) {
    const path = created.pop()
    if (path !== undefined) await rm(path, { recursive: true, force: true })
  }
})

/** @returns a temporary directory that the teardown removes. */
async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'mndt-automations-'))
  created.push(path)
  return path
}

/** @param overrides - fields to change. @returns a usable automation. */
function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto_test', name: 'Test', kind: 'custom', prompt: 'regarde', at: '09:00', enabled: true, createdBy: 'scheduler',
    ...overrides,
  }
}

/** A service with a predictable clock. */
function bench(): WorkbenchService {
  let counter = 0
  return new WorkbenchService({
    store: new MemoryStore(),
    now: () => new Date('2026-11-01T08:00:00.000Z'),
    nextId: prefix => `${prefix}_${(counter += 1)}`,
  })
}

describe('automation registry', () => {
  it('keeps a usable automation and rejects an incomplete one', () => {
    const kept = normalise({ name: 'Briefing', kind: 'briefing', prompt: 'salut', at: '07:30', days: [5, 1, 1] })
    expect(kept?.kind).toBe('briefing')
    expect(kept?.at).toBe('07:30')
    expect(kept?.days).toEqual([1, 5])
    expect(kept?.enabled).toBe(true)
    expect(kept?.id.startsWith('auto_')).toBe(true)
    expect(normalise({ name: 'x', kind: 'briefing', prompt: '', at: '07:30' })).toBeUndefined()
    expect(normalise({ name: 'x', kind: 'unknown', prompt: 'y', at: '07:30' })).toBeUndefined()
    expect(normalise({ name: 'x', kind: 'briefing', prompt: 'y', at: '7:30' })?.at).toBe('07:30')
  })

  it('narrows a test clock and keeps an explicit disable', () => {
    const interval = normalise({ kind: 'custom', prompt: 'p', everyMinutes: 2.4 })
    expect(interval?.everyMinutes).toBe(2)
    expect(normalise({ kind: 'custom', prompt: 'p', at: '07:30', enabled: false })?.enabled).toBe(false)
  })

  it('seeds a fresh registry from the default list and the legacy hour', async () => {
    const dir = await scratch()
    const path = join(dir, 'automations.json')
    const items = await readAutomations(path, '06:15')
    const briefing = items.find(item => item.id === 'auto_briefing')
    expect(briefing?.at).toBe('06:15')
    expect(briefing?.enabled).toBe(true)
    expect(items).toHaveLength(defaultAutomations().length)
    const stored = JSON.parse(await readFile(path, 'utf8')) as { items?: unknown[] }
    expect(stored.items).toHaveLength(items.length)
  })

  it('drops unusable entries already on disk', async () => {
    const dir = await scratch()
    const path = join(dir, 'automations.json')
    await writeAutomations(path, [automation(), { id: 'broken' } as Automation])
    const items = await readAutomations(path)
    expect(items.map(item => item.id)).toEqual(['auto_test'])
  })
})

describe('automation clock', () => {
  // La Réunion is UTC+4 all year: 09:00 there is 05:00 UTC.
  const ZONE = 'Indian/Reunion'
  const reunion = (day: number, hour: number, minute: number): Date => new Date(Date.UTC(2026, 10, day, hour - 4, minute))

  it('reads its time in the instance\'s zone, not the process\'s', () => {
    const everyDay = automation()
    expect(dueAutomations([everyDay], reunion(1, 9, 0), ZONE)).toHaveLength(1)
    // 09:00 UTC is 13:00 at La Réunion: not its time.
    expect(dueAutomations([everyDay], new Date(Date.UTC(2026, 10, 1, 9, 0)), ZONE)).toHaveLength(0)
    expect(dueAutomations([everyDay], new Date(Date.UTC(2026, 10, 1, 9, 0)), 'UTC')).toHaveLength(1)
  })

  it('is due from its minute until 15 minutes later, once a day, on the allowed days of the zone', () => {
    const everyDay = automation()
    expect(dueAutomations([everyDay], reunion(1, 8, 59), ZONE)).toHaveLength(0)
    // A pass that missed the minute itself (a restart, a busy process) still starts it.
    expect(dueAutomations([everyDay], reunion(1, 9, 14), ZONE)).toHaveLength(1)
    expect(dueAutomations([everyDay], reunion(1, 9, 15), ZONE)).toHaveLength(0)
    expect(dueAutomations([{ ...everyDay, lastFiredDate: '2026-11-01' }], reunion(1, 9, 5), ZONE)).toHaveLength(0)
    // 1 November 2026 is a Sunday at La Réunion: a Monday-only automation waits.
    const mondayOnly = automation({ id: 'auto_monday', days: [1] })
    expect(dueAutomations([everyDay, mondayOnly], reunion(1, 9, 0), ZONE).map(item => item.id)).toEqual(['auto_test'])
    expect(dueAutomations([mondayOnly], reunion(2, 9, 0), ZONE)).toHaveLength(1)
    // Sunday by the zone even when it is still Saturday in UTC: 01:00 at La Réunion.
    const early = automation({ id: 'auto_early', at: '01:00', days: [0] })
    expect(dueAutomations([early], reunion(1, 1, 0), ZONE)).toHaveLength(1)
  })

  it('ignores a suspended automation and honours an interval', () => {
    const now = reunion(1, 9, 0)
    expect(dueAutomations([automation({ enabled: false })], now, ZONE)).toHaveLength(0)
    const interval = automation({ everyMinutes: 5, lastFiredAt: new Date(now.getTime() - (3 * 60_000)).toISOString() })
    expect(dueAutomations([interval], now, ZONE)).toHaveLength(0)
    expect(dueAutomations([interval], new Date(now.getTime() + (2 * 60_000)), ZONE)).toHaveLength(1)
  })

  it('stamps the day of the zone, the moment of the run and the last run', () => {
    // 23:30 UTC on 31 October is 03:30 on 1 November at La Réunion.
    const now = new Date(Date.UTC(2026, 9, 31, 23, 30))
    expect(firedFields(now, ZONE)).toEqual({ lastFiredDate: '2026-11-01', lastFiredAt: now.toISOString(), lastRunAt: now.toISOString() })
  })

  it('says when it starts next, in the zone; nothing while suspended', () => {
    const everyDay = automation()
    expect(nextRunAt(everyDay, reunion(1, 8, 0), ZONE)).toBe(reunion(1, 9, 0).toISOString())
    // Within its window and not started yet: now.
    expect(nextRunAt(everyDay, reunion(1, 9, 3), ZONE)).toBe(reunion(1, 9, 3).toISOString())
    // Started today: tomorrow.
    expect(nextRunAt({ ...everyDay, lastFiredDate: '2026-11-01' }, reunion(1, 9, 3), ZONE)).toBe(reunion(2, 9, 0).toISOString())
    // Past its window today: tomorrow.
    expect(nextRunAt(everyDay, reunion(1, 10, 0), ZONE)).toBe(reunion(2, 9, 0).toISOString())
    // On Sundays only (0): from Monday 2 November, the next Sunday is the 8th.
    expect(nextRunAt(automation({ days: [0] }), reunion(2, 8, 0), ZONE)).toBe(reunion(8, 9, 0).toISOString())
    expect(nextRunAt(automation({ enabled: false }), reunion(1, 8, 0), ZONE)).toBeUndefined()
  })
})

describe('automation run', () => {
  it('creates a team mission credited to the automation author and stores the result', async () => {
    const service = bench()
    const seen: Mission[] = []
    const outcome = await runAutomation(service, {
      run: async (mission: Mission): Promise<MissionResult> => {
        seen.push(mission)
        return { title: 'Brief', markdown: '# ok', sources: [] }
      },
    }, automation())
    expect(outcome.outcome).toBe('done')
    const mission = await service.getMission(outcome.missionId)
    expect(mission?.visibility).toBe('team')
    expect(mission?.createdBy).toBe('scheduler')
    expect(mission?.status).toBe('done')
    expect(seen).toHaveLength(1)
  })

  it('fails the mission with the runner reason instead of leaving it running', async () => {
    const service = bench()
    const outcome = await runAutomation(service, {
      run: async (): Promise<MissionResult> => {
        throw new Error('modele injoignable')
      },
    }, automation({ id: 'auto_break', createdBy: 'automation:test' }))
    // Served on the automation and the mission: the host's sentence, not the runtime's words.
    expect(outcome.outcome).toBe('failed: Erreur pendant l’exécution.')
    const mission = await service.getMission(outcome.missionId)
    expect(mission?.status).toBe('failed')
    expect(mission?.error).toBe('Erreur pendant l’exécution.')
  })
})
