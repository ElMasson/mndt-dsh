// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CollabPage } from '../src/client/CollabPage.tsx'
import type { MndtFace, PageStateRow } from '../src/client/face.ts'

afterEach(() => { cleanup() })

/** @returns the channel rail, once the page has loaded. */
async function rail(): Promise<HTMLElement> {
  return waitFor(() => {
    const found = document.querySelector('.mndt-channels')
    expect(found).toBeTruthy()
    return found as HTMLElement
  })
}

/** @param overrides - fields to change. @returns a page state ready to render. */
function state(overrides: Partial<PageStateRow> = {}): PageStateRow {
  return {
    you: 'duke@datanalysis.re',
    canWrite: true,
    canAdmin: true,
    missions: [
      {
        id: 'mis_1', kind: 'briefing', prompt: 'briefing du matin', status: 'done', createdBy: 'scheduler',
        createdAt: '2026-11-01T07:30:00.000Z', visibility: 'team',
      },
      {
        id: 'mis_2', kind: 'custom', prompt: 'revue de compte', status: 'running', createdBy: 'smarion@datanalysis.re',
        createdAt: '2026-11-01T08:30:00.000Z', visibility: 'private',
      },
    ],
    briefs: [
      { id: 'brf_1', title: 'Briefing du matin', markdown: '# ok', status: 'draft', createdAt: '2026-11-01T07:31:00.000Z', createdBy: 'scheduler' },
    ],
    approvals: [
      {
        id: 'apr_1', kind: 'spend', title: 'Valider la campagne', requestedBy: 'gouvernance@datanalysis.re',
        requestedAt: '2026-11-01T09:00:00.000Z',
      },
    ],
    memories: [],
    mandates: [
      {
        id: 'mnd_1', delegant: 'gouvernance@datanalysis.re', delegataire: 'smarion@datanalysis.re', purpose: 'Reporting marketing',
        connectors: ['office365'], missionKinds: ['custom'], dailyCap: 3, expiresOn: '2026-11-30', state: 'active',
      },
    ],
    ...overrides,
  }
}

/** A Host face that answers from a fixed state and records the calls. */
function fakeFace(overrides: Partial<MndtFace> = {}): MndtFace & { toggleAutomation: ReturnType<typeof vi.fn> } {
  const refusal = (): Promise<never> => Promise.reject(new Error('non utilise'))
  return {
    state: async () => ({
      ...state(),
      events: [
        { at: '2026-11-01T07:31:00.000Z', actor: 'scheduler', action: 'mission.done', subject: 'mis_1' },
        { at: '2026-11-01T09:00:00.000Z', actor: 'gouvernance@datanalysis.re', action: 'approval.requested', subject: 'apr_1' },
        { at: '2026-11-01T08:31:00.000Z', actor: 'duke@datanalysis.re', action: 'mission.created', subject: 'mis_2' },
      ],
    }) as never,
    runMission: refusal, cancelMission: refusal, retryMission: refusal, decide: refusal, approveBrief: refusal, remember: refusal,
    shareMission: refusal, shareMemory: refusal, members: async () => [{ subject: 'duke@datanalysis.re', role: 'owner' }],
    grantMember: refusal, revokeMember: refusal,
    usage: async () => ({ mine: { user: 'duke@datanalysis.re', missions: 2, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, team: [], canAdmin: true }),
    schedule: async () => ({ at: '07:30' }), setSchedule: async () => ({ at: '07:30' }),
    machineCapture: refusal, browserAct: refusal, desktopAct: refusal, desktopStop: refusal, browserStop: refusal,
    createMandate: refusal, signMandate: refusal, retireMandate: refusal,
    journal: async () => ({ format: 'json', entries: [] }),
    connectors: async () => [],
    automations: async () => ({
      canAdmin: true,
      items: [
        {
          id: 'auto_briefing', name: 'Briefing du matin', kind: 'briefing', prompt: 'briefing du matin',
          at: '06:30', enabled: true, createdBy: 'scheduler',
        },
        {
          id: 'auto_approvals', name: 'Relance des approbations', kind: 'custom', prompt: 'liste les approbations',
          at: '09:00', enabled: false, createdBy: 'scheduler',
        },
      ],
    }),
    saveAutomation: refusal,
    toggleAutomation: vi.fn(async () => ({ ok: true })),
    runAutomationNow: refusal,
    ...overrides,
  } as never
}

describe('collaboration page', () => {
  it('renders the channels, the team feed and the reader presence', async () => {
    render(<CollabPage api={fakeFace()} />)
    expect(await screen.findByText('# equipe')).toBeTruthy()
    const rail = document.querySelector('.mndt-channels')
    expect(rail).toBeTruthy()
    expect(within(rail as HTMLElement).getByText('Reporting marketing - smarion')).toBeTruthy()
    expect(within(rail as HTMLElement).getByText('duke@datanalysis.re')).toBeTruthy()
    expect(document.querySelectorAll('.mndt-post-card').length).toBeGreaterThan(0)
  })

  it('disables the decision on a request the reader made and says who decides', async () => {
    render(<CollabPage api={fakeFace({
      state: async () => state({
        approvals: [{ id: 'apr_2', kind: 'publish', title: 'Publier la synthese', requestedBy: 'duke@datanalysis.re', requestedAt: '2026-11-01T09:10:00.000Z' }],
      }) as never,
    })} />)
    const approve = await screen.findByRole('button', { name: 'Approuver' })
    expect((approve as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/un autre humain/i)).toBeTruthy()
  })

  it('retries a failed mission and cancels a waiting one', async () => {
    const retryMission = vi.fn(async () => ({
      ok: true,
      value: {
        id: 'mis_9', kind: 'custom', prompt: 'panne', status: 'done', createdBy: 'duke@datanalysis.re',
        createdAt: '2026-11-01T10:20:00.000Z', visibility: 'team',
      },
    }))
    const cancelMission = vi.fn(async () => ({
      ok: true,
      value: {
        id: 'mis_4', kind: 'custom', prompt: 'attente', status: 'failed', createdBy: 'duke@datanalysis.re',
        createdAt: '2026-11-01T10:10:00.000Z', visibility: 'private',
      },
    }))
    const failed = {
      id: 'mis_3', kind: 'custom', prompt: 'panne', status: 'failed', createdBy: 'scheduler',
      createdAt: '2026-11-01T10:00:00.000Z', visibility: 'team',
    }
    const waiting = {
      id: 'mis_4', kind: 'custom', prompt: 'attente', status: 'queued', createdBy: 'duke@datanalysis.re',
      createdAt: '2026-11-01T10:10:00.000Z', visibility: 'private',
    }
    const api = fakeFace({
      state: async () => ({
        ...state({ missions: [...state().missions, failed, waiting] }),
        events: [],
      }) as never,
      retryMission,
      cancelMission,
    })
    render(<CollabPage api={api} />)
    const failedCard = await waitFor(() => {
      const found = document.querySelector('[data-mission="mission:mis_3"]')
      expect(found).toBeTruthy()
      return found as HTMLElement
    })
    fireEvent.click(within(failedCard).getByRole('button', { name: 'Relancer' }))
    await waitFor(() => { expect(retryMission).toHaveBeenCalledWith('mis_3') })
    const waitingCard = document.querySelector('[data-mission="mission:mis_4"]')
    if (waitingCard === null) throw new Error('carte de la mission en attente absente')
    fireEvent.click(within(waitingCard as HTMLElement).getByRole('button', { name: 'Annuler' }))
    await waitFor(() => { expect(cancelMission).toHaveBeenCalledWith('mis_4') })
  })

  it('opens the activity view, lists the journal and filters it by channel', async () => {
    render(<CollabPage api={fakeFace()} />)
    fireEvent.click(within(await rail()).getByRole('button', { name: /Activite/ }))
    const rows = await waitFor(() => {
      const found = document.querySelectorAll('.mndt-activity .mndt-event-post')
      expect(found.length).toBeGreaterThan(0)
      return found
    })
    const before = rows.length
    const filter = screen.getByLabelText(/Filtrer par canal/) as HTMLSelectElement
    fireEvent.change(filter, { target: { value: 'mandate:mnd_1' } })
    await waitFor(() => {
      expect(document.querySelectorAll('.mndt-activity .mndt-event-post').length).toBeLessThan(before + 1)
    })
  })

  it('opens the global search with Ctrl K and answers a query', async () => {
    render(<CollabPage api={fakeFace()} />)
    await screen.findByText('# equipe')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const input = await screen.findByPlaceholderText(/Chercher une mission/)
    fireEvent.change(input, { target: { value: 'Reporting' } })
    await waitFor(() => {
      expect(document.querySelectorAll('.mndt-search-results .mndt-search-row').length).toBeGreaterThan(0)
    })
  })

  it('opens the administration view, grants a role and proposes a mandate', async () => {
    const grantMember = vi.fn(async (subject: string, role: string) => ({ ok: true, value: { subject, role } }))
    const createMandate = vi.fn(async (input: Record<string, unknown>) => ({
      ok: true,
      value: {
        id: 'mnd_9', delegant: 'duke@datanalysis.re', delegataire: 'smarion@datanalysis.re',
        purpose: typeof input.purpose === 'string' ? input.purpose : 'Reporting',
        connectors: ['office365'], missionKinds: ['custom'],
        dailyCap: 3, expiresOn: '2026-12-31', state: 'proposed',
      },
    }))
    const api = fakeFace({
      members: async () => [
        { subject: 'duke@datanalysis.re', role: 'owner' },
        { subject: 'smarion@datanalysis.re', role: 'operator' },
      ],
      grantMember,
      createMandate,
    })
    render(<CollabPage api={api} />)
    fireEvent.click(within(await rail()).getByRole('button', { name: /Administration/ }))
    expect(await screen.findByText('Personnes et droits')).toBeTruthy()
    const email = screen.getByLabelText('adresse de la personne a accorder')
    fireEvent.change(email, { target: { value: 'contact@datanalysis.re' } })
    fireEvent.click(screen.getByRole('button', { name: 'Accorder' }))
    await waitFor(() => {
      expect(grantMember).toHaveBeenCalledWith('contact@datanalysis.re', 'viewer')
    })
    fireEvent.change(screen.getByLabelText('objet du mandat'), { target: { value: 'Reporting' } })
    fireEvent.change(screen.getByLabelText('delegataire du mandat'), { target: { value: 'smarion@datanalysis.re' } })
    fireEvent.click(screen.getByRole('button', { name: 'Proposer' }))
    await waitFor(() => {
      expect(createMandate).toHaveBeenCalled()
    })
  })

  it('opens the automations view from the rail and toggles one', async () => {
    const api = fakeFace()
    render(<CollabPage api={api} />)
    fireEvent.click(within(await rail()).getByRole('button', { name: /Automatisations/ }))
    await waitFor(() => {
      expect(document.querySelectorAll('.mndt-post-card[data-kind="automation"]').length).toBe(2)
    })
    const cards = [...document.querySelectorAll('.mndt-post-card[data-kind="automation"]')] as HTMLElement[]
    const relance = cards.find(card => card.textContent?.includes('Relance des approbations'))
    expect(relance).toBeTruthy()
    fireEvent.click(within(relance as HTMLElement).getByRole('button', { name: 'Activer' }))
    await waitFor(() => {
      expect(api.toggleAutomation).toHaveBeenCalledWith('auto_approvals', true)
    })
  })
})
