// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebCard } from '../src/client/TeamFeed.tsx'
import type { ThreadCard } from '../src/client/ChannelView.tsx'
import type { ChatAgent, ChatChannel } from '../src/client/chat.ts'
import { chatFrench } from '../src/client/chatLocales.ts'
import { ScheduleList, cadenceOf, cadenceWords, runTime, scheduleProposalOf, scheduleRowOf } from '../src/client/schedule.tsx'
import { createMockChat } from '../src/client/mockChat.ts'
import { ChatRefusal } from '../src/client/chat.ts'

afterEach(cleanup)

const you = 'stephane@datanalysis.re'
const at = '2026-11-25T08:00:00.000Z'
const assistant: ChatAgent = {
  id: 'agt_1', handle: 'assistant', name: 'Assistant', provider: 'p', model: 'm', connectors: [], eurPerMonth: 5, createdBy: you, createdAt: at,
}
const compta: ChatChannel = {
  id: 'chn_1', name: 'compta', title: 'Compta', kind: 'team', members: [you], agents: ['agt_1'], connectors: [], createdBy: you, createdAt: at,
}
const schedule = {
  title: 'Relance des impayés', instructions: '## Étapes\n- Lister les **impayés**',
  cadence: { every: 'week', days: [1], at: '08:00' }, agentId: 'agt_1',
  destination: { kind: 'channel', channelId: 'chn_1' }, eurPerRun: 0.5,
}
const card = (over: Record<string, unknown> = {}): ThreadCard => ({
  id: 'apr_s', kind: 'propose_schedule', title: 'Relance des impayés', requestedBy: you, requestedAt: at, state: 'pending',
  channelId: 'chn_1', scheduleProposal: schedule, timeZone: 'Indian/Reunion',
  nextRuns: ['2026-11-30T04:00:00.000Z', '2026-12-07T04:00:00.000Z', '2026-12-14T04:00:00.000Z'], ...over,
}) as unknown as ThreadCard

describe('a cadence in words', () => {
  const say = (raw: unknown): string => { const c = cadenceOf(raw); return c === undefined ? 'illisible' : cadenceWords(c, chatFrench) }
  it('the four forms', () => {
    expect(say({ every: 'day', at: '07:30' })).toBe('chaque jour à 07:30')
    expect(say({ every: 'week', days: [1], at: '08:00' })).toBe('chaque lundi à 08:00')
    expect(say({ every: 'week', days: [4, 1], at: '08:00' })).toBe('chaque lundi et jeudi à 08:00')
    expect(say({ every: 'week', days: [1, 2, 3, 4, 5], at: '07:30' })).toBe('du lundi au vendredi à 07:30')
    expect(say({ every: 'month', monthDay: 1, at: '09:00' })).toBe('le 1er de chaque mois à 09:00')
    expect(say({ every: 'month', monthDay: 15, at: '09:00' })).toBe('le 15 de chaque mois à 09:00')
    expect(say({ cron: '0 8 * * 1' })).toBe('planification personnalisée')
  })
  it('an odd cadence is unreadable, never guessed', () => {
    for (const raw of [{ every: 'day', at: '8h' }, { every: 'week', days: [0], at: '08:00' }, { every: 'week', days: [], at: '08:00' },
      { every: 'month', monthDay: 31, at: '09:00' }, { every: 'hour', at: '08:00' }, 'weekly', null]) expect(say(raw)).toBe('illisible')
  })
})

describe('next runs are shown in the instance\'s time zone', () => {
  it('04:00 UTC reads 08:00 in Réunion, whatever the reader\'s zone', () => {
    expect(runTime('2026-11-30T04:00:00.000Z', 'Indian/Reunion')).toContain('08:00')
  })
})

describe('the proposal a card carries', () => {
  it('is read whole, or not at all', () => {
    expect(scheduleProposalOf(card())?.title).toBe('Relance des impayés')
    for (const broken of [{ ...schedule, eurPerRun: -1 }, { ...schedule, cadence: { every: 'hour' } }, { ...schedule, agentId: '' },
      { ...schedule, destination: { kind: 'elsewhere' } }, { ...schedule, title: ' ' }]) {
      expect(scheduleProposalOf(card({ scheduleProposal: broken }))).toBeUndefined()
    }
    expect(scheduleProposalOf(card({ scheduleProposal: 'x' }))).toBeUndefined()
  })
  it('an unknown time zone is dropped, the runs still shown', () => {
    expect(scheduleProposalOf(card({ timeZone: 'Mars/Olympus' }))?.timeZone).toBeUndefined()
  })
})

describe('the propose_schedule card', () => {
  const draw = (c: ThreadCard, onDecide = vi.fn(async () => undefined), channel: ChatChannel | undefined = compta): void => {
    render(<WebCard card={c} canDecide onDecide={onDecide} channel={channel} agents={new Map([[assistant.id, assistant]])} names={{ [you]: 'Stéphane' }} t={chatFrench} />)
  }

  it('shows the whole proposal under a fixed heading; validating says it showed it', async () => {
    const onDecide = vi.fn(async () => undefined)
    draw(card(), onDecide)
    expect(document.querySelector('.mw-card-title')?.textContent).toBe('Une tâche planifiée est proposée')
    expect(screen.getByTestId('schedule-title').textContent).toBe('Relance des impayés')
    expect(screen.getByTestId('schedule-cadence').textContent).toBe('chaque lundi à 08:00')
    expect(screen.getByTestId('schedule-runs').textContent?.split(' · ')).toHaveLength(3)
    expect(screen.getByTestId('schedule-runs').textContent).toContain('08:00')
    expect(screen.getByTestId('schedule-agent').textContent).toBe('@assistant')
    expect(screen.getByTestId('schedule-where').textContent).toBe('# Compta')
    expect(screen.getByTestId('schedule-cost').textContent).toContain('au plus par passage')
    // The instructions are a model's text: Markdown read, headings kept plain.
    expect(screen.getByTestId('schedule-instructions').querySelector('h1, h2, h3')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }))
    await vi.waitFor(() => { expect(onDecide).toHaveBeenCalledWith('apr_s', 'approved', undefined, { showsProposal: true }) })
  })

  it('a lane destination names whose; a channel the reader does not read is said, no title', () => {
    draw(card({ scheduleProposal: { ...schedule, destination: { kind: 'lane', member: you } } }))
    expect(screen.getByTestId('schedule-where').textContent).toBe('la lane de Stéphane')
    cleanup()
    draw(card({ scheduleProposal: { ...schedule, destination: { kind: 'channel', channelId: 'chn_other' } } }))
    expect(screen.getByTestId('schedule-where').textContent).toBe('un canal que vous ne lisez pas')
  })

  it('an unreadable proposal can only be refused, and says why', () => {
    draw(card({ scheduleProposal: { ...schedule, cadence: { every: 'hour' } } }))
    expect(screen.getByTestId('schedule-unreadable')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Valider' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Refuser' })).toBeTruthy()
  })
})

const task = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'sch_1', title: 'Relance des impayés', instructions: '…', cadence: { every: 'week', days: [1], at: '08:00' }, agentId: 'agt_1',
  destination: { kind: 'channel', channelId: 'chn_1' }, eurPerRun: 0.5, state: 'active', requestedBy: you, approvedBy: you, approvedAt: at,
  nextRuns: ['2026-11-30T04:00:00.000Z'], timeZone: 'Indian/Reunion', eurThisMonth: 0, eurPerMonthMax: 2, missed: 0,
  can: { pause: true, resume: true, delete: true }, ...over,
})

describe('the list of a channel\'s tasks', { timeout: 20_000 }, () => {
  const open = (rows: readonly Record<string, unknown>[]) => {
    const chat = createMockChat({ you, agents: [assistant], channels: [compta], schedules: rows }, () => Date.parse(at))
    render(<ScheduleList face={chat} query={{ channelId: 'chn_1' }} agents={[assistant]} t={chatFrench} />)
    return chat
  }

  it('says nothing, not even a title, when there is no task', async () => {
    open([])
    await new Promise(r => setTimeout(r, 50))
    expect(screen.queryByTestId('schedule-list')).toBeNull()
  })

  it('one line: title, cadence, agent, state, next run in the instance\'s zone, the month\'s cost', async () => {
    open([task()])
    const row = await screen.findByTestId('schedule-row')
    expect(row.textContent).toContain('Relance des impayés · chaque lundi à 08:00 · @assistant')
    expect(within(row).getByTestId('schedule-state').textContent).toBe('active')
    expect(row.textContent).toContain('prochain :')
    expect(row.textContent).toContain('08:00')
    expect(row.textContent).toContain('ce mois :')
  })

  it('pause, then resume, in one click each; delete in two', async () => {
    const chat = open([task()])
    fireEvent.click(await screen.findByRole('button', { name: 'Mettre en pause' }))
    await waitFor(() => { expect(screen.getByTestId('schedule-state').textContent).toBe('en pause') })
    fireEvent.click(screen.getByRole('button', { name: 'Reprendre' }))
    await waitFor(() => { expect(screen.getByTestId('schedule-state').textContent).toBe('active') })
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la suppression' }))
    await waitFor(() => { expect(screen.queryByTestId('schedule-list')).toBeNull() })
    expect(await chat.schedules?.({ channelId: 'chn_1' })).toEqual([])
  })

  it('a gesture the host does not allow is not offered; resume is a decider\'s', async () => {
    open([task({ state: 'paused', pausedBecause: 'failures', can: { pause: true, resume: false, delete: true } })])
    await screen.findByTestId('schedule-row')
    expect(screen.queryByRole('button', { name: 'Reprendre' })).toBeNull()
    expect(screen.getByTestId('schedule-paused-because').textContent).toBe('En pause après 3 échecs de suite.')
  })

  it('a can of another shape offers nothing', async () => {
    open([task({ can: { pause: 'yes', resume: 1, delete: null } })])
    await screen.findByTestId('schedule-row')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('missed runs are said; a refused gesture is said by its code', async () => {
    const chat = open([task({ missed: 2 })])
    expect((await screen.findByTestId('schedule-missed')).textContent).toBe('2 passages manqués')
    vi.spyOn(chat, 'pauseSchedule').mockRejectedValue(new ChatRefusal('x is viewer', 403, 'not-allowed'))
    fireEvent.click(screen.getByRole('button', { name: 'Mettre en pause' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Vous ne pouvez pas faire cela sur cette tâche.')
  })

  it('rows the page cannot read are dropped', () => {
    expect(scheduleRowOf({ id: '', title: 'x', state: 'active' })).toBeUndefined()
    expect(scheduleRowOf({ id: 'a', title: 'x', state: 'running' })).toBeUndefined()
    expect(scheduleRowOf({ id: 'a', title: 'x', state: 'active', lastEur: -1 })?.lastEur).toBeUndefined()
  })
})

describe('a core that serves no tasks route', () => {
  it('shows no section and no error; another failure is said', async () => {
    const chat = createMockChat({ you, agents: [assistant], channels: [compta] }, () => Date.parse(at))
    vi.spyOn(chat, 'schedules').mockRejectedValue(new ChatRefusal('no route GET /schedules', 404))
    render(<ScheduleList face={chat} query={{ channelId: 'chn_1' }} agents={[assistant]} t={chatFrench} />)
    await new Promise(r => setTimeout(r, 50))
    expect(screen.queryByTestId('schedule-list')).toBeNull()
    cleanup()
    vi.spyOn(chat, 'schedules').mockRejectedValue(new ChatRefusal('ECONNRESET 10.0.0.4:8443 internal', 500))
    render(<ScheduleList face={chat} query={{ channelId: 'chn_1' }} agents={[assistant]} t={chatFrench} />)
    expect((await screen.findByRole('alert')).textContent).toBe('Les tâches ne répondent pas pour l\'instant : réessayez dans un moment.')
  })
})

describe('a scheduled run in its destination (PR 2)', () => {
  const run = (mission: unknown, text = '## Impayés\n- Orange') => ({
    id: 'msg_r', channelId: 'chn_1', author: { kind: 'system' }, text, mentions: [], createdAt: at, updatedAt: at, mission,
  }) as never
  it('its author is fixed « Tâche planifiée », its title the model\'s, second-tier', async () => {
    const { WebMessage } = await import('../src/client/TeamFeed.tsx')
    const done = run({ kind: 'scheduled', title: 'mndt : relance', status: 'done', scheduleId: 'sch_1' })
    render(<WebMessage message={done} header agents={new Map()} cards={[]} canDecide onDecide={vi.fn()} t={chatFrench} />)
    expect(document.querySelector('.mw-message-name')?.textContent).toBe('Tâche planifiée')
    expect(screen.getByTestId('mission-title').textContent).toBe('mndt : relance')
  })
  it('a failed run says why from a turn\'s category; an unknown one, the generic words; never the text', async () => {
    const { WebMessage } = await import('../src/client/TeamFeed.tsx')
    const draw = (reasonKind: unknown): string => {
      cleanup()
      const failed = run({ kind: 'scheduled', title: 'x', status: 'failed', reasonKind }, 'raw sk-live-1')
      render(<WebMessage message={failed} header agents={new Map()} cards={[]} canDecide onDecide={vi.fn()} t={chatFrench} />)
      return screen.getByTestId('mission-failed').textContent ?? ''
    }
    expect(draw('budget')).toBe('La tâche n\'a pas abouti : le coût du tour a atteint sa borne')
    expect(draw('cut')).toBe('La tâche n\'a pas abouti : réponse coupée : limite de longueur atteinte')
    expect(draw('constructor')).toBe('La tâche n\'a pas abouti : une erreur est survenue pendant l\'exécution')
    expect(draw(undefined)).not.toContain('sk-live')
  })
})

describe('a task\'s last run (PR 2)', () => {
  it('a failed last run is said with its category', async () => {
    const chat = createMockChat({ you, agents: [assistant], channels: [compta],
      schedules: [task({ lastRunAt: '2026-11-24T04:00:00.000Z', lastStatus: 'failed', lastReasonKind: 'cut', lastEur: 0.12 })] }, () => Date.parse(at))
    render(<ScheduleList face={chat} query={{ channelId: 'chn_1' }} agents={[assistant]} t={chatFrench} />)
    const row = await screen.findByTestId('schedule-row')
    expect(row.textContent).toContain('échec (réponse coupée : limite de longueur atteinte)')
    expect(row.textContent).toContain('0,12')
  })
  it('the card shows the month\'s bound when the host serves it', () => {
    const agents = new Map([[assistant.id, assistant]])
    render(<WebCard card={card({ eurPerMonthMax: 2 })} canDecide onDecide={vi.fn()} channel={compta} agents={agents} t={chatFrench} />)
    expect(screen.getByTestId('schedule-cost').textContent).toContain('au plus par mois')
  })
})

describe('a refusal never shows the served or thrown message', { timeout: 20_000 }, () => {
  it('another refusal or a network error reads the generic sentence', async () => {
    const failures = [
      new ChatRefusal('upstream sk-live-9 refused', 400, 'something-else'),
      new TypeError('Failed to fetch https://10.0.0.4/x'),
    ]
    for (const failure of failures) {
      cleanup()
      const chat = createMockChat({ you, agents: [assistant], channels: [compta], schedules: [task()] }, () => Date.parse(at))
      render(<ScheduleList face={chat} query={{ channelId: 'chn_1' }} agents={[assistant]} t={chatFrench} />)
      vi.spyOn(chat, 'pauseSchedule').mockRejectedValue(failure)
      fireEvent.click(await screen.findByRole('button', { name: 'Mettre en pause' }))
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toBe('Les tâches ne répondent pas pour l\'instant : réessayez dans un moment.')
      expect(alert.textContent).not.toMatch(/sk-live|10\.0\.0\.4/u)
    }
  })
})

describe('the month\'s bound on the card', () => {
  it('absent when the host does not serve it: only the cost per run', () => {
    const agents = new Map([[assistant.id, assistant]])
    render(<WebCard card={card()} canDecide onDecide={vi.fn()} channel={compta} agents={agents} t={chatFrench} />)
    expect(screen.getByTestId('schedule-cost').textContent).toContain('au plus par passage')
    expect(screen.getByTestId('schedule-cost').textContent).not.toContain('par mois')
  })
})

describe('a run under way (#169)', () => {
  it('« en cours » while running; nothing otherwise, nor for a field of another shape', async () => {
    const draw = async (running: unknown): Promise<HTMLElement | null> => {
      cleanup()
      const chat = createMockChat({ you, agents: [assistant], channels: [compta], schedules: [task({ running })] }, () => Date.parse(at))
      render(<ScheduleList face={chat} query={{ channelId: 'chn_1' }} agents={[assistant]} t={chatFrench} />)
      await screen.findByTestId('schedule-row')
      return screen.queryByTestId('schedule-running')
    }
    expect((await draw(true))?.textContent).toBe('en cours')
    expect(await draw(false)).toBeNull()
    expect(await draw('yes')).toBeNull()
  })
})

describe('the last run\'s outcome in words (#169)', () => {
  const line = async (over: Record<string, unknown>): Promise<string> => {
    cleanup()
    const chat = createMockChat({ you, agents: [assistant], channels: [compta], schedules: [task({ lastRunAt: '2026-11-26T04:00:00.000Z', ...over })] }, () => Date.parse(at))
    render(<ScheduleList face={chat} query={{ channelId: 'chn_1' }} agents={[assistant]} t={chatFrench} />)
    return (await screen.findByTestId('schedule-row')).textContent ?? ''
  }
  it('done, failed with its category, and a restart said as one, with the month\'s real cost', async () => {
    expect(await line({ lastStatus: 'done', lastEur: 0.08, eurThisMonth: 0.32 })).toMatch(/dernier :.*0,08.*· abouti.*ce mois : 0,32/u)
    expect(await line({ lastStatus: 'failed', lastReasonKind: 'refused' })).toContain('échec (refusé par l\'espace)')
    const restarted = await line({ lastStatus: 'failed', lastReasonKind: 'restart' })
    expect(restarted).toContain('· interrompu par un redémarrage')
    expect(restarted).not.toContain('échec')
  })
})
