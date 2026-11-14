// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamShell } from '../src/client/TeamShell.tsx'
import type { TeamShellProps } from '../src/client/TeamShell.tsx'
import { CollabPage } from '../src/client/CollabPage.tsx'
import type { MndtFace, PageStateRow } from '../src/client/face.ts'
import { translate } from '../src/client/locales.ts'
import { TEAM_CSS } from '../src/client/teamStyles.ts'
import { TeamApp, frameOf, whoAmI } from '../src/client/TeamApp.tsx'

afterEach(() => { cleanup() })

/** @param over - props to change. @returns the frame's props, with recording callbacks. */
function props(over: Partial<TeamShellProps> = {}): TeamShellProps {
  return {
    t: translate,
    place: 'lane',
    onPlace: vi.fn(),
    pending: 0,
    channels: [{ id: 'chn_1', label: 'test', active: false }],
    onChannel: vi.fn(),
    agents: [{ id: 'agt_1', label: 'Assistant', active: false }],
    onAgent: vi.fn(),
    you: 'stephane@datanalysis.re',
    live: true,
    children: <p>page</p>,
    ...over,
  }
}

describe('the team frame, as mndt-web draws it', () => {
  it('lists the places of mndt-web in its order, the steering ones greyed « bientôt »', () => {
    render(<TeamShell {...props()} />)
    const nav = screen.getByTestId('side-nav')
    expect(nav.textContent).toBe('Ma laneÀ traiterMémoireCanaux# testAgentsAssistantPilotageMissionsbientôtMandatsbientôtPreuvesbientôtRéglages')
    for (const label of ['Missions', 'Mandats', 'Preuves']) {
      const entry = within(nav).getByText(label).parentElement as HTMLElement
      expect(entry.getAttribute('aria-disabled')).toBe('true')
      // Greyed entries are not buttons: nothing to follow until their screen exists.
      expect(entry.tagName).toBe('SPAN')
    }
    expect(within(nav).getByRole('button', { name: 'Ma lane' }).getAttribute('aria-current')).toBe('page')
  })

  it('says how many cards wait, and nothing when none does', () => {
    const { rerender } = render(<TeamShell {...props({ pending: 3 })} />)
    expect(within(screen.getByTestId('side-nav')).getByLabelText('3 en attente').textContent).toBe('3')
    rerender(<TeamShell {...props({ pending: 0 })} />)
    expect(document.querySelector('.mw-badge')).toBeNull()
  })

  it('leads each entry to its place, a channel to its thread', () => {
    const p = props()
    render(<TeamShell {...p} />)
    const nav = screen.getByTestId('side-nav')
    fireEvent.click(within(nav).getByRole('button', { name: 'Mémoire' }))
    expect(p.onPlace).toHaveBeenLastCalledWith('memory')
    fireEvent.click(within(nav).getByRole('button', { name: '# test' }))
    expect(p.onChannel).toHaveBeenLastCalledWith('chn_1')
    fireEvent.click(within(nav).getByRole('button', { name: 'Assistant' }))
    expect(p.onAgent).toHaveBeenLastCalledWith('agt_1')
  })

  it('shows the organisation only where its name is served, with its environment', () => {
    const { rerender } = render(<TeamShell {...props()} />)
    expect(screen.queryByTestId('org')).toBeNull()
    rerender(<TeamShell {...props({ org: { name: 'DATANALYSIS', env: 'Préproduction' } })} />)
    expect(screen.getByTestId('org').textContent).toBe('DATANALYSISPréproduction')
  })

  it('names the person by the part before @ until the name is served, and says when updates pause', () => {
    const { rerender } = render(<TeamShell {...props({ live: false })} />)
    expect(screen.getByTestId('account-name').textContent).toBe('stephanestephane@datanalysis.re')
    expect(screen.getByTitle('Mises à jour en pause')).toBeTruthy()
    rerender(<TeamShell {...props({ name: 'Stéphane Masson' })} />)
    expect(screen.getByTestId('account-name').textContent).toBe('Stéphane Massonstephane@datanalysis.re')
    expect(screen.getByTitle('Mises à jour en direct')).toBeTruthy()
  })

  it('keeps the spaces selector inert: all spaces, until they are served', () => {
    render(<TeamShell {...props()} />)
    for (const select of screen.getAllByRole('combobox')) {
      expect((select as HTMLSelectElement).disabled).toBe(true)
      expect((select as HTMLSelectElement).value).toBe('all')
    }
  })

  it('on a phone, Menu opens the whole navigation, and following a link closes it', () => {
    const p = props()
    render(<TeamShell {...p} />)
    fireEvent.click(within(screen.getByTestId('bottom-nav')).getByRole('button', { name: 'Menu' }))
    const sheet = screen.getByRole('dialog')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Agents' }))
    expect(p.onPlace).toHaveBeenLastCalledWith('agents')
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(within(screen.getByTestId('bottom-nav')).getByRole('button', { name: 'Menu' }))
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('carries the sizes of mndt-web: a 56 px bar, a 224 px column, its breakpoints', () => {
    expect(TEAM_CSS).toContain('height: 56px')
    expect(TEAM_CSS).toContain('width: 224px')
    expect(TEAM_CSS).toContain('@media (min-width: 768px)')
  })
})

/** @param over - fields to change. @returns a page state with one waiting card and one memory. */
function state(over: Partial<PageStateRow> = {}): PageStateRow {
  return {
    you: 'stephane@datanalysis.re',
    canWrite: true,
    canAdmin: true,
    missions: [],
    briefs: [],
    approvals: [{ id: 'apr_1', kind: 'spend', title: 'Valider la campagne', requestedBy: 'assistant', requestedAt: '2026-11-14T09:00:00.000Z' }],
    memories: [{ id: 'mem_1', scope: 'team', kind: 'fact', text: 'Clôture le 30', createdBy: 'stephane@datanalysis.re' }],
    ...over,
  }
}

/** @param page - the state to answer. @returns a face that reads it, and refuses the rest. */
function face(page: PageStateRow): MndtFace {
  const refusal = (): Promise<never> => Promise.reject(new Error('non utilise'))
  return new Proxy({}, {
    get: (_target, key) => {
      if (key === 'state') return async () => page
      if (key === 'members') return async () => []
      if (key === 'search') return async () => []
      return refusal
    },
  }) as MndtFace
}

describe('the page in the team frame', () => {
  it('draws the frame instead of its own rail', async () => {
    render(<CollabPage api={face(state())} team={{}} />)
    expect(await screen.findByTestId('team-shell')).toBeTruthy()
    expect(document.querySelector('.mndt-channels')).toBeNull()
  })

  it('À traiter lists the waiting cards, and the badge counts them', async () => {
    render(<CollabPage api={face(state())} team={{}} />)
    const nav = await screen.findByTestId('side-nav')
    await waitFor(() => { expect(within(nav).getByLabelText('1 en attente')).toBeTruthy() })
    fireEvent.click(within(nav).getByRole('button', { name: /À traiter/u }))
    expect(within(screen.getByTestId('team-pending')).getByText('Valider la campagne')).toBeTruthy()
  })

  it('says when nothing waits, and when nothing is remembered', async () => {
    render(<CollabPage api={face(state({ approvals: [], memories: [] }))} team={{}} />)
    const nav = await screen.findByTestId('side-nav')
    fireEvent.click(within(nav).getByRole('button', { name: 'À traiter' }))
    expect(screen.getByTestId('team-pending').textContent).toContain('Rien ne requiert votre attention pour le moment.')
    fireEvent.click(within(nav).getByRole('button', { name: 'Mémoire' }))
    expect(screen.getByTestId('team-memory').textContent).toContain('Rien n\'est encore mémorisé.')
  })

  it('Mémoire shows what the team remembers', async () => {
    render(<CollabPage api={face(state())} team={{}} />)
    fireEvent.click(within(await screen.findByTestId('side-nav')).getByRole('button', { name: 'Mémoire' }))
    expect(screen.getByTestId('team-memory').textContent).toContain('Clôture le 30')
  })

  it('offers « Mode avancé » only where the full interface is given (the owner)', async () => {
    const { unmount } = render(<CollabPage api={face(state())} team={{}} />)
    fireEvent.click(within(await screen.findByTestId('side-nav')).getByRole('button', { name: 'Réglages' }))
    expect(screen.queryByTestId('advanced-mode')).toBeNull()
    unmount()
    render(<CollabPage api={face(state())} team={{ advancedHref: '/dsh/' }} />)
    fireEvent.click(within(await screen.findByTestId('side-nav')).getByRole('button', { name: 'Réglages' }))
    expect(screen.getByTestId('advanced-mode').getAttribute('href')).toBe('/dsh/')
  })

  it('without channels served, Ma lane says so instead of an empty thread', async () => {
    render(<CollabPage api={face(state())} team={{}} />)
    fireEvent.click(within(await screen.findByTestId('side-nav')).getByRole('button', { name: 'Ma lane' }))
    expect(screen.getByTestId('team-lane-missing')).toBeTruthy()
  })
})

describe('the standalone page, before the frame', () => {
  const answer = (status: number, body: unknown): Response =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response

  it('reads the person from /me, through the product API only', async () => {
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => answer(200, { you: 'a@datanalysis.re', name: 'A', role: 'owner' }))
    expect(await whoAmI(fetcher)).toEqual({ kind: 'known', me: { you: 'a@datanalysis.re', name: 'A', role: 'owner' } })
    expect(fetcher.mock.calls[0]?.[0]).toBe('/mndt-api/me')
  })

  it('tells a refusal apart from a workspace that does not answer', async () => {
    expect(await whoAmI(async () => answer(403, {}))).toEqual({ kind: 'refused' })
    expect(await whoAmI(async () => answer(401, {}))).toEqual({ kind: 'refused' })
    expect(await whoAmI(async () => answer(502, {}))).toEqual({ kind: 'unread' })
    expect(await whoAmI(async () => answer(200, { nobody: true }))).toEqual({ kind: 'unread' })
    expect(await whoAmI(async () => { throw new Error('down') })).toEqual({ kind: 'unread' })
  })

  it('gives « Mode avancé » to the owner only', () => {
    expect(frameOf({ kind: 'known', me: { you: 'a', role: 'owner' } }).advancedHref).toBe('/dsh/')
    expect(frameOf({ kind: 'known', me: { you: 'a', role: 'operator' } }).advancedHref).toBeUndefined()
    expect(frameOf({ kind: 'unread' }).advancedHref).toBeUndefined()
  })

  it('a refused person sees only that, and a way out', async () => {
    render(<TeamApp api={face(state())} chat={undefined as never} identity={Promise.resolve({ kind: 'refused' })} />)
    expect((await screen.findByTestId('team-denied')).textContent).toContain('Accès non autorisé')
    expect(screen.getByRole('link', { name: 'Se déconnecter' }).getAttribute('href')).toBe('/oauth2/sign_out')
    expect(screen.queryByTestId('team-shell')).toBeNull()
  })

  it('a known person gets the frame, with their name', async () => {
    const identity = Promise.resolve({ kind: 'known', me: { you: 'stephane@datanalysis.re', name: 'Stéphane' } } as const)
    render(<TeamApp api={face(state())} chat={undefined as never} identity={identity} />)
    expect((await screen.findByTestId('account-name')).textContent).toContain('Stéphane')
  })
})
