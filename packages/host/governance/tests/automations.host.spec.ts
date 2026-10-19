import { describe, expect, it } from 'vitest'
import {
  AutomationService,
  MemoryAutomationStorage,
} from '@deepseek-ai/dsh-host-governance/src/automations.ts'

/** Fixed clock, so ids and timestamps are deterministic. */
const now = (): Date => new Date('2026-10-19T12:00:00.000Z')

describe('ownership', () => {
  it('lists only the calling identity\'s automations', async () => {
    const service = new AutomationService(new MemoryAutomationStorage(), now)
    await service.create('stephane', 'summarise the inbox')
    await service.create('sara', 'draft the weekly report')

    await expect(service.list('stephane')).resolves.toMatchObject([{ prompt: 'summarise the inbox' }])
    await expect(service.list('sara')).resolves.toMatchObject([{ prompt: 'draft the weekly report' }])
    await expect(service.list('ghost')).resolves.toEqual([])
  })

  it('refuses to disable someone else\'s automation', async () => {
    const service = new AutomationService(new MemoryAutomationStorage(), now)
    const created = await service.create('sara', 'draft the weekly report')
    if ('allowed' in created) throw new Error('creation was refused')

    const outcome = await service.setEnabled('stephane', created.id, false)

    expect(outcome.allowed).toBe(false)
    expect(outcome.reason).toContain('someone else')
    await expect(service.list('sara')).resolves.toMatchObject([{ enabled: true }])
  })

  it('refuses to delete someone else\'s automation', async () => {
    const service = new AutomationService(new MemoryAutomationStorage(), now)
    const created = await service.create('sara', 'draft the weekly report')
    if ('allowed' in created) throw new Error('creation was refused')

    const outcome = await service.remove('stephane', created.id)

    expect(outcome.allowed).toBe(false)
    await expect(service.list('sara')).resolves.toHaveLength(1)
  })

  it('refuses an empty owner or an empty prompt', async () => {
    const service = new AutomationService(new MemoryAutomationStorage(), now)

    expect(await service.create('  ', 'do something')).toMatchObject({ allowed: false })
    expect(await service.create('stephane', '   ')).toMatchObject({ allowed: false })
  })
})

describe('lifecycle', () => {
  it('creates an enabled automation with a stable identity', async () => {
    const service = new AutomationService(new MemoryAutomationStorage(), now)

    const created = await service.create('stephane', 'summarise the inbox')

    expect(created).toMatchObject({
      owner: 'stephane',
      prompt: 'summarise the inbox',
      enabled: true,
      createdAt: '2026-10-19T12:00:00.000Z',
    })
  })

  it('disables, re-enables, then removes', async () => {
    const service = new AutomationService(new MemoryAutomationStorage(), now)
    const created = await service.create('stephane', 'summarise the inbox')
    if ('allowed' in created) throw new Error('creation was refused')

    expect(await service.setEnabled('stephane', created.id, false)).toMatchObject({ allowed: true })
    await expect(service.list('stephane')).resolves.toMatchObject([{ enabled: false }])
    expect(await service.setEnabled('stephane', created.id, true)).toMatchObject({ allowed: true })
    expect(await service.remove('stephane', created.id)).toMatchObject({ allowed: true })
    await expect(service.list('stephane')).resolves.toEqual([])
  })

  it('answers a clear refusal for an unknown id', async () => {
    const service = new AutomationService(new MemoryAutomationStorage(), now)

    expect(await service.setEnabled('stephane', 'nope', true)).toMatchObject({ allowed: false })
    expect(await service.remove('stephane', 'nope')).toMatchObject({ allowed: false })
  })
})
