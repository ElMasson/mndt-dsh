import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/core/store.ts'
import { WorkbenchService } from '../src/core/service.ts'
import {
  defaultAutomations, dueAutomations, firedFields, normalise, readAutomations, runAutomation, writeAutomations,
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
  it('fires at the exact minute, once, on the allowed days', () => {
    const sunday = new Date(2026, 10, 1, 9, 0)
    const everyDay = automation()
    const mondayOnly = automation({ id: 'auto_monday', days: [1] })
    const due = dueAutomations([everyDay, mondayOnly], sunday)
    expect(due.map(item => item.id)).toEqual(['auto_test'])
    expect(dueAutomations([{ ...everyDay, lastFiredDate: '2026-11-01' }], sunday)).toHaveLength(0)
    expect(dueAutomations([everyDay], new Date(2026, 10, 1, 9, 1))).toHaveLength(0)
  })

  it('ignores a suspended automation and honours an interval', () => {
    const now = new Date(2026, 10, 1, 9, 0)
    expect(dueAutomations([automation({ enabled: false })], now)).toHaveLength(0)
    const interval = automation({ everyMinutes: 5, lastFiredAt: new Date(2026, 10, 1, 8, 57).toISOString() })
    expect(dueAutomations([interval], now)).toHaveLength(0)
    expect(dueAutomations([interval], new Date(2026, 10, 1, 9, 2))).toHaveLength(1)
  })

  it('stamps the date and the moment of a run', () => {
    const now = new Date(2026, 10, 1, 9, 0)
    expect(firedFields(now)).toEqual({ lastFiredDate: '2026-11-01', lastFiredAt: now.toISOString() })
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
    expect(outcome.outcome).toBe('failed: modele injoignable')
    const mission = await service.getMission(outcome.missionId)
    expect(mission?.status).toBe('failed')
    expect(mission?.error).toContain('modele injoignable')
  })
})
