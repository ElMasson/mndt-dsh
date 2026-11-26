// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamShell } from '../src/client/TeamShell.tsx'
import type { TeamShellProps } from '../src/client/TeamShell.tsx'
import { CollabPage } from '../src/client/CollabPage.tsx'
import type { MndtFace, PageStateRow } from '../src/client/face.ts'
import { translate } from '../src/client/locales.ts'
import { chatFrench } from '../src/client/chatLocales.ts'
import { createMockChat } from '../src/client/mockChat.ts'
import { ChatRefusal } from '../src/client/chat.ts'
import type { ChatFace } from '../src/client/chat.ts'
import { FaceRefusal } from '../src/client/httpFace.ts'
import { TEAM_CSS } from '../src/client/teamStyles.ts'
import { TeamApp, envLabel, frameOf, namesOf, orgOf, whoAmI } from '../src/client/TeamApp.tsx'

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
  it('lists the places of mndt-web in its order; no « Pilotage » while none of its places works', () => {
    render(<TeamShell {...props()} />)
    const nav = screen.getByTestId('side-nav')
    expect(nav.textContent).toBe('Ma laneÀ traiterMémoireCanaux# testAgentsAssistantRéglages')
    expect(within(nav).queryByText('Pilotage')).toBeNull()
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

  it('shows nothing without a function: no spaces selector, no chevron on the organisation', () => {
    render(<TeamShell {...props({ org: { name: 'DATANALYSIS', env: 'Préproduction' } })} />)
    const header = screen.getByTestId('app-header')
    expect(within(header).queryByRole('combobox')).toBeNull()
    expect(screen.getByTestId('org').querySelector('svg')).toBeNull()
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
    // The channel's context opens over the whole phone screen, as mndt-web's (fixed inset-0).
    expect(TEAM_CSS).toMatch(/\.mw-aside\[data-open\] \{[^}]*position: fixed; inset: 0;/u)
    // Stretched: a fixed box aligned flex-start would only be as tall as its content.
    expect(TEAM_CSS).toMatch(/\.mw-aside\[data-open\] \{[^}]*align-self: stretch;/u)
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

  it('refuses someone the API knows but who holds no role in the team', async () => {
    expect(await whoAmI(async () => answer(200, { you: 'x@datanalysis.re' }))).toEqual({ kind: 'refused' })
    expect(await whoAmI(async () => answer(200, { you: 'x@datanalysis.re', role: '' }))).toEqual({ kind: 'refused' })
  })

  it('reads the organisation, and shows none where it is not declared or not read', async () => {
    expect(await orgOf(async () => answer(200, { name: 'DATANALYSIS', slug: 'datanalysis', env: 'preprod' })))
      .toEqual({ name: 'DATANALYSIS', slug: 'datanalysis', env: 'preprod' })
    expect(await orgOf(async () => answer(200, { name: 'DATANALYSIS', slug: 'datanalysis' }))).toEqual({ name: 'DATANALYSIS', slug: 'datanalysis' })
    expect(await orgOf(async () => answer(200, { name: '', slug: '' }))).toBeUndefined()
    expect(await orgOf(async () => answer(502, {}))).toBeUndefined()
    expect(await orgOf(async () => { throw new Error('down') })).toBeUndefined()
  })

  it('labels pre-production only, as mndt-web does', () => {
    expect(envLabel('preprod')).toBe('Préproduction')
    expect(envLabel('prod')).toBeUndefined()
    expect(envLabel(undefined)).toBeUndefined()
  })

  it('reads the team\'s names by lower-case address, none where the team is not read', async () => {
    const people = { people: [{ email: 'Duke@datanalysis.re', role: 'owner', name: 'Stéphane Masson' }, { email: 'b@datanalysis.re', role: 'viewer' }] }
    expect(await namesOf(async () => answer(200, people))).toEqual({ 'duke@datanalysis.re': 'Stéphane Masson' })
    expect(await namesOf(async () => answer(403, {}))).toEqual({})
    expect(await namesOf(async () => { throw new Error('down') })).toEqual({})
  })

  it('gives « Mode avancé » to whom the gateway gives the shell, and to nobody else', () => {
    expect(frameOf({ kind: 'known', me: { you: 'a', role: 'owner', shell: true } }).advancedHref).toBe('/dsh/')
    // A second owner of the grants, without the gateway's shell, is not offered a link to a 404.
    expect(frameOf({ kind: 'known', me: { you: 'b', role: 'owner', shell: false } }).advancedHref).toBeUndefined()
    // An API without the field: no link.
    expect(frameOf({ kind: 'known', me: { you: 'a', role: 'owner' } }).advancedHref).toBeUndefined()
    expect(frameOf({ kind: 'known', me: { you: 'a', role: 'operator', shell: false } }).advancedHref).toBeUndefined()
    expect(frameOf({ kind: 'unread' }).advancedHref).toBeUndefined()
  })

  it('a refused person sees only that, and a way out', async () => {
    render(<TeamApp api={face(state())} chat={undefined as never} identity={Promise.resolve({ kind: 'refused' })} />)
    expect((await screen.findByTestId('team-denied')).textContent).toContain('Accès non autorisé')
    expect(screen.getByRole('link', { name: 'Se déconnecter' }).getAttribute('href')).toBe('/oauth2/sign_out')
    // Refused, the page read nothing else.
    expect(screen.queryByTestId('team-shell')).toBeNull()
  })

  it('a known person gets the frame, with their name', async () => {
    const identity = Promise.resolve({ kind: 'known', me: { you: 'stephane@datanalysis.re', name: 'Stéphane', role: 'owner', shell: true } } as const)
    const fetcher = vi.fn(async (input: string) => input === '/mndt-api/org'
      ? answer(200, { name: 'DATANALYSIS', slug: 'datanalysis', env: 'preprod' })
      : answer(200, { people: [] }))
    render(<TeamApp api={face(state())} chat={undefined as never} identity={identity} fetcher={fetcher} />)
    expect((await screen.findByTestId('account-name')).textContent).toContain('Stéphane')
    expect(screen.getByTestId('org').textContent).toBe('DATANALYSISPréproduction')
  })
})

describe('a channel in the team frame, as mndt-web draws it', () => {
  const at = '2026-11-14T09:00:00.000Z'
  const you = 'stephane@datanalysis.re'
  const assistant = { id: 'agt_1', handle: 'assistant', name: 'Assistant', provider: 'scaleway-genapi', model: 'deepseek-v4.1-flash', connectors: [], eurPerMonth: 5, eurThisMonth: 0.25, createdBy: you, createdAt: at }

  /** @param agents - the agents in « test ». @returns the page on a team channel, opened. */
  async function open(agents: readonly string[] = [], names: Readonly<Record<string, string>> = {}): Promise<void> {
    const chat = createMockChat({
      you,
      agents: [assistant],
      channels: [
        { id: 'chn_0', name: 'solo', title: 'Ma lane', kind: 'solo', members: [you], agents: [], connectors: [], createdBy: you, createdAt: at },
        { id: 'chn_1', name: 'test', title: 'test', kind: 'team', members: [you, 'lecteur@datanalysis.re'], agents: [...agents], connectors: [], createdBy: you, createdAt: at },
      ],
    }, () => Date.parse(at))
    render(<CollabPage api={face(state())} chat={chat} t={translate} tc={chatFrench} team={{ names }} />)
    fireEvent.click(within(await screen.findByTestId('side-nav')).getByRole('button', { name: '# test' }))
    await screen.findByTestId('context-panel')
  }

  it('titles the channel with its kind below, and says in the centre that no agent reads it yet', async () => {
    await open()
    expect(screen.getByRole('heading', { level: 1, name: '# test' })).toBeTruthy()
    expect(document.querySelector('.mw-subtitle')?.textContent).toBe('Équipe')
    // An empty channel with an agent says « Aucun message… » (see « a new team channel no agent reads »).
    expect((await screen.findByTestId('channel-welcome')).textContent).toContain('Aucun agent ne lit encore ce canal.')
  })

  it('shows the context card in the sections of mndt-web, « bientôt » where nothing is served', async () => {
    await open()
    const card = screen.getByTestId('context-panel')
    expect([...card.querySelectorAll('h3')].map(h => h.textContent)).toEqual(['Ce qu\'il faut savoir ici', 'Canal', 'Agents', 'Coordination', 'Connecteurs', 'Mémoire', 'Membres'])
    // No section without a function: « Mandats : bientôt » is gone from the panel.
    expect(card.textContent).not.toContain('les mandats du canal')
    // No section without a function: no documents route here, no « bientôt » documents section.
    expect(card.textContent).not.toContain('les documents du canal')
    // Members by the part before @, the address kept as title.
    expect([...card.querySelectorAll('.mw-ctx-member')].map(m => m.textContent)).toEqual(['stephane', 'lecteur'])
  })

  it('names the members as /people serves them', async () => {
    await open([], { 'stephane@datanalysis.re': 'Stéphane Masson' })
    expect([...document.querySelectorAll('.mw-ctx-member')].map(m => m.textContent)).toEqual(['Stéphane Masson', 'lecteur'])
  })

  it('« Toutes les mémoires » leads to Mémoire', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Toutes les mémoires' }))
    expect(screen.getByTestId('team-memory')).toBeTruthy()
  })

  it('says who reads a channel without an agent, and posts with « Publier »', async () => {
    await open()
    expect(screen.getByTestId('channel-mode').textContent).toBe('# test Visible par 2 personnes. Aucun agent ici : personne ne lit ce fil hors de ses membres.')
    const box = screen.getByPlaceholderText('Écrire une note')
    fireEvent.change(box, { target: { value: 'bonjour' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publier' }))
    await waitFor(() => { expect(screen.getAllByText('bonjour').length).toBeGreaterThan(0) })
  })

  it('with an agent, says it answers when mentioned and that a person decides its cards', async () => {
    await open(['agt_1'])
    expect(screen.getByTestId('channel-mode').textContent).toBe(
      '# test Visible par 2 personnes et 1 agent. L\'agent répond quand on le mentionne (@assistant). Ce qu\'il propose devient une carte, décidée par une personne.',
    )
    expect(screen.getByPlaceholderText('Une note, une question, ou @assistant pour lui parler…')).toBeTruthy()
    const agent = within(screen.getByTestId('context-panel')).getByTestId('chat-agent')
    expect(agent.textContent).toContain('Rapide')
  })

  it('the lane speaks of your agents, with no subtitle', async () => {
    await open()
    fireEvent.click(within(screen.getByTestId('side-nav')).getByRole('button', { name: 'Ma lane' }))
    await waitFor(() => { expect(screen.getByRole('heading', { level: 1, name: 'Ma lane' })).toBeTruthy() })
    const lane = screen.getAllByTestId('channel-mode').find(p => p.textContent?.startsWith('Conversation'))
    expect(lane?.textContent).toBe('Conversation avec vos agents Visible par vous seul. Aucun agent ne lit encore votre lane.')
  })

  it('on a narrow screen, « Contexte » opens the card over the page and closes it', async () => {
    await open()
    const aside = document.querySelector('.mw-aside[aria-label="Contexte du canal"]') as HTMLElement
    expect(aside.dataset.open).toBeUndefined()
    fireEvent.click(screen.getAllByRole('button', { name: 'Contexte' })[0] as HTMLElement)
    expect(aside.dataset.open).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Fermer le contexte du canal' }))
    expect(aside.dataset.open).toBeUndefined()
  })
})

describe('À traiter and Mémoire, as mndt-web draws them', () => {
  it('Mémoire sorts the notes by the scopes the core keeps, with their kind and keeper', async () => {
    const memories = [
      { id: 'm1', scope: 'user', kind: 'preference', text: 'Relances depuis contact@', createdBy: 'stephane@datanalysis.re' },
      { id: 'm2', scope: 'team', kind: 'fact', text: 'Sodiac paie à 60 jours', createdBy: 'smarion@datanalysis.re' },
    ]
    render(<CollabPage api={face(state({ memories }))} team={{ names: { 'smarion@datanalysis.re': 'Sophie Marion' } }} />)
    fireEvent.click(within(await screen.findByTestId('side-nav')).getByRole('button', { name: 'Mémoire' }))
    const columns = [...screen.getByTestId('team-memory').querySelectorAll('.mw-memory-column')]
    expect(columns.map(c => c.querySelector('h2')?.textContent)).toEqual(['Moi', 'Équipe', 'Missions'])
    expect(columns[0]?.textContent).toContain('Relances depuis contact@')
    expect(columns[1]?.textContent).toContain('FaitGardée par Sophie Marion')
    expect(columns[2]?.textContent).toContain('Rien n\'est encore mémorisé.')
  })

  it('À traiter counts the waiting cards and offers to decide them there', async () => {
    render(<CollabPage api={face(state())} tc={chatFrench} team={{}} />)
    fireEvent.click(within(await screen.findByTestId('side-nav')).getByRole('button', { name: /À traiter/u }))
    const queue = screen.getByTestId('team-pending')
    expect(queue.querySelector('.mw-counts')?.textContent).toBe('1 en attente')
    expect(within(queue).getByRole('button', { name: 'Valider' })).toBeTruthy()
    expect(within(queue).getByText('En attente de décision')).toBeTruthy()
  })

  it('says when nothing waits, in the empty box of mndt-web', async () => {
    render(<CollabPage api={face(state({ approvals: [] }))} team={{}} />)
    fireEvent.click(within(await screen.findByTestId('side-nav')).getByRole('button', { name: 'À traiter' }))
    expect(screen.getByTestId('team-pending').querySelector('.mw-empty-state')?.textContent).toBe('Rien ne requiert votre attention pour le moment.')
  })
})

describe('Agents and Réglages, as mndt-web draws them', () => {
  it('Agents shows a tile per agent: its name, handle and model, and what it spent', async () => {
    const at = '2026-11-14T09:00:00.000Z'
    const chat = createMockChat({
      you: 'stephane@datanalysis.re',
      agents: [{ id: 'agt_1', handle: 'assistant', name: 'Assistant', provider: 'scaleway-genapi', model: 'deepseek-v4.1-flash', connectors: [], eurPerMonth: 5, eurThisMonth: 0.25, createdBy: 'x', createdAt: at }],
      channels: [],
    }, () => Date.parse(at))
    render(<CollabPage api={face(state())} chat={chat} tc={chatFrench} team={{}} />)
    const nav = await screen.findByTestId('side-nav')
    await waitFor(() => { expect(within(nav).getByRole('button', { name: 'Assistant' })).toBeTruthy() })
    fireEvent.click(within(nav).getByRole('button', { name: 'Agents' }))
    const tile = screen.getByTestId('team-agent')
    expect(tile.textContent).toContain('Assistant')
    expect(tile.textContent).toContain('@assistant · deepseek-v4.1-flash')
    expect(tile.textContent).toMatch(/0,25\s€ ce mois-ci, sur 5,00\s€/u)
  })

  it('Réglages offers missions, automations and the advanced mode to the owner only', async () => {
    const { unmount } = render(<CollabPage api={face(state())} team={{}} />)
    fireEvent.click(within(await screen.findByTestId('side-nav')).getByRole('button', { name: 'Réglages' }))
    const member = screen.getByTestId('team-settings').textContent ?? ''
    expect(member).toContain('Activité')
    expect(member).not.toContain('Automatisations')
    expect(member).not.toContain('Fil de l\'équipe')
    expect(screen.queryByTestId('advanced-mode')).toBeNull()
    unmount()
    render(<CollabPage api={face(state())} team={{ owner: true, advancedHref: '/dsh/' }} />)
    fireEvent.click(within(await screen.findByTestId('side-nav')).getByRole('button', { name: 'Réglages' }))
    const owner = screen.getByTestId('team-settings').textContent ?? ''
    expect(owner).toContain('Automatisations')
    expect(owner).toContain('Fil de l\'équipe')
    expect(screen.getByTestId('advanced-mode').getAttribute('href')).toBe('/dsh/')
  })

  it('a 404 on the automations says they are the owner\'s, not a raw error', async () => {
    const page = state()
    const refusal = new Proxy({}, {
      get: (_t, key) => key === 'state' ? async () => page
        : key === 'members' || key === 'search' ? async () => []
          : key === 'automations' ? async () => { throw new FaceRefusal('not found', 404) }
            : async () => { throw new Error('non utilise') },
    }) as MndtFace
    render(<CollabPage api={refusal} team={{ owner: true }} />)
    fireEvent.click(within(await screen.findByTestId('side-nav')).getByRole('button', { name: 'Réglages' }))
    fireEvent.click(screen.getByRole('button', { name: /Automatisations/u }))
    expect(await screen.findByText('Réservé au propriétaire de l\'espace.')).toBeTruthy()
  })
})

describe('À traiter is what the person has to decide', () => {
  const at = '2026-11-14T09:00:00.000Z'
  const you = 'lecteur@datanalysis.re'

  it('counts only the pending cards the API marks theirs; readable ones stay in the feed', async () => {
    const chat = createMockChat({
      you,
      agents: [],
      channels: [{ id: 'chn_1', name: 'test', title: 'test', kind: 'team', members: [you], agents: [], connectors: [], createdBy: you, createdAt: at }],
      cards: [
        { id: 'apr_mine', kind: 'spend', title: 'À moi de décider', requestedBy: 'assistant', requestedAt: at, channelId: 'chn_1', messageId: 'm', state: 'pending', canDecide: true },
        { id: 'apr_read', kind: 'spend', title: 'Seulement lisible', requestedBy: 'assistant', requestedAt: at, channelId: 'chn_1', messageId: 'm', state: 'pending', canDecide: false },
      ],
    }, () => Date.parse(at))
    render(<CollabPage api={face(state({ canAdmin: false }))} chat={chat} tc={chatFrench} team={{}} />)
    const nav = await screen.findByTestId('side-nav')
    await waitFor(() => { expect(within(nav).getByLabelText('1 en attente')).toBeTruthy() })
    fireEvent.click(within(nav).getByRole('button', { name: /À traiter/u }))
    const queue = screen.getByTestId('team-pending')
    expect(queue.textContent).toContain('À moi de décider')
    expect(queue.textContent).not.toContain('Seulement lisible')
  })

  it('a mission\'s card in À traiter says « Mission » where a channel\'s card links its channel', async () => {
    const chat = createMockChat({
      you,
      agents: [],
      channels: [{ id: 'chn_1', name: 'test', title: 'test', kind: 'team', members: [you], agents: [], connectors: [], createdBy: you, createdAt: at }],
      cards: [
        { id: 'apr_m', kind: 'publish', title: 'De la mission', requestedBy: 'x', requestedAt: at, state: 'pending', canDecide: true, missionId: 'mis_1' },
        { id: 'apr_c', kind: 'publish', title: 'Du canal', requestedBy: 'x', requestedAt: at, channelId: 'chn_1', messageId: 'm', state: 'pending', canDecide: true },
      ],
    }, () => Date.parse(at))
    render(<CollabPage api={face(state())} chat={chat} tc={chatFrench} team={{}} />)
    fireEvent.click(within(await screen.findByTestId('side-nav')).getByRole('button', { name: /À traiter/u }))
    const queue = screen.getByTestId('team-pending')
    await waitFor(() => { expect(within(queue).getByTestId('queue-from-mission').textContent).toBe('Mission') })
    expect(within(queue).getByRole('button', { name: '# test' })).toBeTruthy()
  })

  it('a card of a channel the person cannot see shows no channel name in À traiter', async () => {
    const chat = createMockChat({
      you,
      agents: [],
      channels: [],
      cards: [{ id: 'apr_x', kind: 'publish', title: 'Ailleurs', requestedBy: 'x', requestedAt: at, channelId: 'chn_secret', messageId: 'm', state: 'pending', canDecide: true }],
    }, () => Date.parse(at))
    render(<CollabPage api={face(state())} chat={chat} tc={chatFrench} team={{}} />)
    fireEvent.click(within(await screen.findByTestId('side-nav')).getByRole('button', { name: /À traiter/u }))
    const queue = screen.getByTestId('team-pending')
    await waitFor(() => { expect(queue.textContent).toContain('Ailleurs') })
    expect(queue.textContent).not.toContain('chn_secret')
    expect(queue.querySelector('.mw-queue-where')).toBeNull()
    expect(within(queue).queryByTestId('queue-from-mission')).toBeNull()
  })

  it('a note of a kind the screen does not know is a « Note », never an object member', async () => {
    const memories = [{ id: 'm', scope: 'team', kind: 'constructor', text: 'x', createdBy: 'a@b.c' }]
    render(<CollabPage api={face(state({ memories }))} team={{}} />)
    fireEvent.click(within(await screen.findByTestId('side-nav')).getByRole('button', { name: 'Mémoire' }))
    expect(screen.getByTestId('team-memory-card').textContent).toContain('Note')
  })
})

describe('the channel panel, by pills', () => {
  const at = '2026-11-15T09:00:00.000Z'
  const you = 'stephane@datanalysis.re'
  const agent = (id: string, handle: string) => ({ id, handle, name: handle, provider: 'p', model: 'm', connectors: [], eurPerMonth: 5, createdBy: you, createdAt: at })
  const MOUNTED = [
    { module: 'm', server: 'office365', enabled: true },
    { module: 'm', server: 'qonto', enabled: true },
    { module: 'm', server: 'dolibarr', enabled: false },
  ]

  /** @returns a double with one channel holding @assistant and qonto. */
  function double(mounted = MOUNTED, connectors: readonly string[] = ['qonto']) {
    return createMockChat({
      you,
      agents: [agent('agt_1', 'assistant'), agent('agt_2', 'analyste')],
      channels: [{ id: 'chn_1', name: 'test', title: 'test', kind: 'team', members: [you], agents: ['agt_1'], connectors: [...connectors], createdBy: you, createdAt: at }],
      mounted,
    }, () => Date.parse(at))
  }

  /** @param chat - the face. @param canWrite - workflows.write. @returns the open channel's panel. */
  async function open(chat: ChatFace, canWrite = true, canAdmin = canWrite): Promise<HTMLElement> {
    render(<CollabPage api={face(state({ canWrite, canAdmin }))} chat={chat} tc={chatFrench} team={{}} />)
    fireEvent.click(within(await screen.findByTestId('side-nav')).getByRole('button', { name: '# test' }))
    return screen.findByTestId('context-panel')
  }

  /** @param panel - the card. @param name - the pill's accessible name. */
  const pill = (panel: HTMLElement, name: RegExp | string): HTMLElement => within(panel).getByRole('button', { name })

  it('one click puts an agent in the channel, another takes it out; each pill says what its click does', async () => {
    const panel = await open(double())
    fireEvent.click(pill(panel, 'Ajouter @analyste au canal'))
    await waitFor(() => { expect(pill(panel, 'Retirer @analyste du canal').getAttribute('aria-pressed')).toBe('true') })
    fireEvent.click(pill(panel, 'Retirer @assistant du canal'))
    await waitFor(() => { expect(pill(panel, 'Ajouter @assistant au canal').getAttribute('aria-pressed')).toBe('false') })
    expect(within(panel).queryByRole('combobox')).toBeNull()
  })

  it('adds a connector from the channel as it is now: one someone else took out is not given back', async () => {
    const chat = double()
    const panel = await open(chat)
    await within(panel).findByRole('button', { name: 'Retirer qonto du canal' })
    // Someone else takes qonto out; this page has not read it again yet.
    await chat.setConnectors?.('chn_1', [])
    fireEvent.click(pill(panel, 'Ajouter office365 au canal'))
    await waitFor(() => { expect(pill(panel, 'Retirer office365 du canal').getAttribute('aria-pressed')).toBe('true') })
    expect((await chat.channels()).find(c => c.id === 'chn_1')?.connectors).toEqual(['office365'])
  })

  it('a connector that is no longer mounted is greyed, can be taken out, and blocks an add with words', async () => {
    const panel = await open(double(MOUNTED, ['qonto', 'dolibarr']))
    const dolibarr = await within(panel).findByRole('button', { name: 'Retirer dolibarr du canal, non branché' })
    expect(dolibarr.getAttribute('aria-disabled')).toBe('false')
    fireEvent.click(pill(panel, 'Ajouter office365 au canal'))
    expect((await within(panel).findByRole('alert')).textContent).toBe('Retirez d\'abord dolibarr, qui n\'est plus branché.')
    fireEvent.click(dolibarr)
    // Out of the channel, it stays shown as mounted-but-off: greyed, and it cannot be added back.
    const back = await within(panel).findByRole('button', { name: 'Ajouter dolibarr au canal, non branché' })
    expect(back.getAttribute('aria-pressed')).toBe('false')
    expect(back.getAttribute('aria-disabled')).toBe('true')
  })

  it('a refusal is said in words and the pill stays as the channel is', async () => {
    const chat = double()
    const refusing: ChatFace = {
      ...chat,
      setConnectors: () => Promise.reject(new ChatRefusal('stephane@datanalysis.re is viewer and does not hold workflows.write', 403)),
      addAgents: () => Promise.reject(new ChatRefusal('connector not mounted: zzz', 400)),
    }
    const panel = await open(refusing)
    fireEvent.click(await within(panel).findByRole('button', { name: 'Ajouter office365 au canal' }))
    expect((await within(panel).findByRole('alert')).textContent).toBe('Votre rôle ne le permet pas : demandez à un owner ou un admin.')
    expect(pill(panel, 'Ajouter office365 au canal').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(pill(panel, 'Ajouter @analyste au canal'))
    await waitFor(() => { expect(within(panel).getAllByRole('alert').map(a => a.textContent)).toContain('Ce connecteur n\'est pas branché : zzz.') })
    expect(pill(panel, 'Ajouter @analyste au canal').getAttribute('aria-pressed')).toBe('false')
  })

  it('a 404 on the mounted connectors makes the section read-only, without marking anything « non branché »', async () => {
    const chat = double()
    const panel = await open({ ...chat, mounted: () => Promise.reject(new ChatRefusal('no route GET /connectors', 404)) })
    expect(await within(panel).findByTestId('connectors-not-served')).toBeTruthy()
    const qonto = pill(panel, 'Retirer qonto du canal')
    expect(qonto.getAttribute('aria-disabled')).toBe('true')
    expect(qonto.textContent).not.toContain('non branché')
  })

  it('a reader without the right sees every pill inert but reachable, and why', async () => {
    const panel = await open(double(), false)
    await within(panel).findByRole('button', { name: /qonto/u })
    // The agent and connector pills; asking an agent for the context stays open to everyone.
    const pills = [...within(panel).getByTestId('agent-pills').querySelectorAll('.mw-pill'), ...within(panel).getByTestId('connector-pills').querySelectorAll('.mw-pill')]
    for (const button of pills) {
      expect(button.getAttribute('aria-disabled')).toBe('true')
      expect((button as HTMLButtonElement).disabled).toBe(false)
    }
    expect(within(panel).getAllByText('Votre rôle ne permet pas de modifier ce canal.').length).toBe(2)
  })

  it('says when no connector is mounted at all', async () => {
    const panel = await open(double([], []))
    expect(await within(panel).findByText('Aucun connecteur n\'est branché sur cet espace.')).toBeTruthy()
  })
})

describe('Ma lane as a first screen, and a new member\'s arrival', { timeout: 20_000 }, () => {
  const you = 'stephane@datanalysis.re'
  const at = '2026-11-23T08:00:00.000Z'
  const agent = { id: 'agt_1', handle: 'assistant', name: 'Assistant', provider: 'p', model: 'm', connectors: [], eurPerMonth: 5, createdBy: you, createdAt: at }
  const lane = { id: 'chn_0', name: 'solo', title: 'Ma lane', kind: 'solo' as const, members: [you], agents: ['agt_1'], connectors: [], createdBy: you, createdAt: at }
  const team = { id: 'chn_1', name: 'compta', title: 'compta', kind: 'team' as const, members: [you], agents: ['agt_1'], connectors: [], createdBy: you, createdAt: at }

  it('an empty lane welcomes: one click on an agent starts a message to it; the team channels open in one click', async () => {
    const chat = createMockChat({ you, agents: [agent], channels: [lane, team] }, () => Date.parse(at))
    render(<CollabPage api={face(state())} chat={chat} tc={chatFrench} team={{}} />)
    const welcome = await screen.findByTestId('lane-welcome', {}, { timeout: 5000 })
    expect(within(welcome).getByText('Votre lane')).toBeTruthy()
    fireEvent.click(within(welcome).getByRole('button', { name: 'Écrire à @assistant' }))
    const box = screen.getByRole('textbox', { name: /Écrivez|agents/u })
    await waitFor(() => { expect(box instanceof HTMLTextAreaElement && box.value).toBe('@assistant ') })
    fireEvent.click(within(welcome).getByRole('button', { name: '# compta' }))
    expect(await screen.findByRole('heading', { name: '# compta' }, { timeout: 5000 })).toBeTruthy()
  })

  it('a draft already begun is kept: the mention goes in front, never twice', async () => {
    const chat = createMockChat({ you, agents: [agent], channels: [lane, team] }, () => Date.parse(at))
    render(<CollabPage api={face(state())} chat={chat} tc={chatFrench} team={{}} />)
    const welcome = await screen.findByTestId('lane-welcome', {}, { timeout: 5000 })
    const box = screen.getByRole('textbox', { name: /Écrivez|agents/u })
    fireEvent.change(box, { target: { value: 'résume les impayés' } })
    fireEvent.click(within(welcome).getByRole('button', { name: 'Écrire à @assistant' }))
    await waitFor(() => { expect(box instanceof HTMLTextAreaElement && box.value).toBe('@assistant résume les impayés') })
    fireEvent.click(within(welcome).getByRole('button', { name: 'Écrire à @assistant' }))
    await waitFor(() => { expect(box instanceof HTMLTextAreaElement && box.value).toBe('@assistant résume les impayés') })
  })

  it('after a pill, typing in the middle of the draft keeps the caret where it is', async () => {
    const chat = createMockChat({ you, agents: [agent], channels: [lane, team] }, () => Date.parse(at))
    render(<CollabPage api={face(state())} chat={chat} tc={chatFrench} team={{}} />)
    const welcome = await screen.findByTestId('lane-welcome', {}, { timeout: 5000 })
    const box = screen.getByRole('textbox', { name: /Écrivez|agents/u })
    if (!(box instanceof HTMLTextAreaElement)) throw new Error('no composer')
    fireEvent.change(box, { target: { value: 'résume les impayés' } })
    fireEvent.click(within(welcome).getByRole('button', { name: 'Écrire à @assistant' }))
    await waitFor(() => { expect(box.value).toBe('@assistant résume les impayés') })
    await new Promise(resolve => requestAnimationFrame(resolve))
    // A correction in the middle: the caret stays after the inserted letters.
    box.setSelectionRange(11, 11)
    fireEvent.change(box, { target: { value: '@assistant Xrésume les impayés', selectionStart: 12, selectionEnd: 12 } })
    box.setSelectionRange(12, 12)
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(box.value).toBe('@assistant Xrésume les impayés')
    expect(box.selectionStart).toBe(12)
  })

  it('a lane without team channel says who adds the person; with no agent, who adds one', async () => {
    const chat = createMockChat({ you, agents: [agent], channels: [{ ...lane, agents: [] }] }, () => Date.parse(at))
    render(<CollabPage api={face(state())} chat={chat} tc={chatFrench} team={{}} />)
    const welcome = await screen.findByTestId('lane-welcome', {}, { timeout: 5000 })
    expect(within(welcome).getByTestId('welcome-no-channel').textContent).toBe('Vous n\'êtes encore dans aucun canal d\'équipe : un owner ou un admin vous y ajoute.')
    // Someone who may add one gets the gesture, not a sentence sending them to themselves.
    expect(within(welcome).getByText('Aucun agent ne lit encore votre lane. Ajoutez-en un :')).toBeTruthy()
    fireEvent.click(within(within(welcome).getByTestId('lane-add-agents')).getByRole('button', { name: 'Ajouter @assistant au canal' }))
    await waitFor(async () => { expect((await chat.channels())[0]?.agents).toEqual(['agt_1']) })
  })

  it('a reader who may not add one is told who does', async () => {
    const chat = createMockChat({ you, agents: [agent], channels: [{ ...lane, agents: [] }] }, () => Date.parse(at))
    render(<CollabPage api={face(state({ canWrite: false }))} chat={chat} tc={chatFrench} team={{}} />)
    const welcome = await screen.findByTestId('lane-welcome', {}, { timeout: 5000 })
    expect(within(welcome).getByText('Aucun agent ne lit encore votre lane : un owner ou un admin en ajoute un.')).toBeTruthy()
    expect(within(welcome).queryByTestId('lane-add-agents')).toBeNull()
  })

  it('a private lane\'s panel shows no coordination nor documents', async () => {
    const chat = createMockChat({ you, agents: [agent], channels: [lane] }, () => Date.parse(at))
    render(<CollabPage api={face(state())} chat={chat} tc={chatFrench} team={{}} />)
    await screen.findByTestId('lane-welcome', {}, { timeout: 5000 })
    const card = screen.getByTestId('context-panel')
    const titles = [...card.querySelectorAll('h3')].map(h => h.textContent)
    expect(titles).not.toContain('Coordination')
    expect(titles).not.toContain('Documents')
  })

  it('no lane but a team channel: the person lands in it', async () => {
    const chat = createMockChat({ you, agents: [agent], channels: [team] }, () => Date.parse(at))
    render(<CollabPage api={face(state())} chat={chat} tc={chatFrench} team={{}} />)
    expect(await screen.findByRole('heading', { name: '# compta' }, { timeout: 5000 })).toBeTruthy()
  })

  it('no channel at all: an arrival screen says what comes next, and the cards waiting', async () => {
    const chat = createMockChat({ you, agents: [], channels: [] }, () => Date.parse(at))
    render(<CollabPage api={face(state())} chat={chat} tc={chatFrench} team={{ name: 'Sophie Marion' }} />)
    const arrival = await screen.findByTestId('team-arrival', {}, { timeout: 5000 })
    expect(within(arrival).getByRole('heading').textContent).toBe('Bienvenue, Sophie Marion')
    expect(arrival.textContent).toContain('un owner ou un admin ouvre votre accès')
  })
})

describe('À traiter lists the agents\' open questions (GET /escalations)', { timeout: 20_000 }, () => {
  const you = 'stephane@datanalysis.re'
  const at = '2026-11-23T08:00:00.000Z'
  const team = { id: 'chn_1', name: 'compta', title: 'compta', kind: 'team' as const, members: [you], agents: [], connectors: [], createdBy: you, createdAt: at }
  it('each question with its summary and a link to its channel; counted in the badge', async () => {
    const chat = createMockChat({
      you, agents: [], channels: [team],
      escalations: [{ channelId: 'chn_1', turnId: 'trn_1', messageId: 'msg_1', questionMessageId: 'msg_2', question: 'Quel montant retenir ?', summary: 'A dit 1 640 €, B dit 1 460 €.', at }],
    }, () => Date.parse(at))
    render(<CollabPage api={face(state({ approvals: [] }))} chat={chat} tc={chatFrench} team={{}} />)
    const nav = await screen.findByTestId('side-nav')
    await waitFor(() => { expect(within(nav).getByLabelText('1 en attente')).toBeTruthy() })
    fireEvent.click(within(nav).getByRole('button', { name: /À traiter/u }))
    const question = await screen.findByTestId('pending-question')
    expect(question.textContent).toContain('Question pour vous : Quel montant retenir ?')
    fireEvent.click(within(question).getByRole('button', { name: 'Répondre dans # compta' }))
    expect(await screen.findByRole('heading', { name: '# compta' })).toBeTruthy()
  })
})

describe('an open question answered where it is read (À traiter)', { timeout: 20_000 }, () => {
  const you = 'stephane@datanalysis.re'
  const at = '2026-11-24T08:00:00.000Z'
  const team = { id: 'chn_1', name: 'compta', title: 'compta', kind: 'team' as const, members: [you], agents: [], connectors: [], createdBy: you, createdAt: at }
  const escalations = [{ channelId: 'chn_1', turnId: 'trn_1', messageId: 'msg_1', questionMessageId: 'msg_2', question: 'HT ou TTC ?', at, kind: 'council' as const }]

  it('its channel and hour first; one field; the answer replies to the published question', async () => {
    const chat = createMockChat({ you, agents: [], channels: [team], escalations }, () => Date.parse(at))
    const post = vi.spyOn(chat, 'post')
    render(<CollabPage api={face(state({ approvals: [] }))} chat={chat} tc={chatFrench} team={{}} />)
    fireEvent.click(within(await screen.findByTestId('side-nav')).getByRole('button', { name: /À traiter/u }))
    const item = await screen.findByTestId('pending-question')
    expect(within(item).getByTestId('pending-question-where').textContent).toMatch(/^# compta · /u)
    // The button stays active: an empty answer is said.
    fireEvent.click(within(item).getByRole('button', { name: 'Répondre et clore ce fil' }))
    expect(within(item).getByRole('alert').textContent).toBe('Écrivez votre réponse avant de l\'envoyer.')
    expect(post).not.toHaveBeenCalled()
    fireEvent.change(within(item).getByRole('textbox', { name: 'Votre réponse' }), { target: { value: 'HT.' } })
    fireEvent.click(within(item).getByRole('button', { name: 'Répondre et clore ce fil' }))
    await waitFor(() => { expect(post).toHaveBeenCalledWith('chn_1', 'HT.', 'msg_2') })
  })

  it('a reader whose answer would not count gets the channel only', async () => {
    const chat = createMockChat({ you, agents: [], channels: [team], escalations }, () => Date.parse(at))
    render(<CollabPage api={face(state({ approvals: [], canWrite: false }))} chat={chat} tc={chatFrench} team={{}} />)
    fireEvent.click(within(await screen.findByTestId('side-nav')).getByRole('button', { name: /À traiter/u }))
    const item = await screen.findByTestId('pending-question')
    expect(within(item).queryByRole('textbox')).toBeNull()
    expect(within(item).getByRole('button', { name: 'Répondre dans # compta' })).toBeTruthy()
  })
})

describe('review of #141 and #142', { timeout: 20_000 }, () => {
  const you = 'stephane@datanalysis.re'
  const at = '2026-11-25T08:00:00.000Z'
  const assistant = { id: 'agt_1', handle: 'assistant', name: 'Assistant', provider: 'p', model: 'm', connectors: [], eurPerMonth: 5, createdBy: you, createdAt: at }
  const lane = { id: 'chn_0', name: 'solo', title: 'Ma lane', kind: 'solo' as const, members: [you], agents: [], connectors: [], createdBy: you, createdAt: at }

  it('adding an agent to the lane that is refused is said', async () => {
    const chat = createMockChat({ you, agents: [assistant], channels: [lane] }, () => Date.parse(at))
    const refusing = { ...chat, addAgents: () => Promise.reject(new ChatRefusal('stephane is viewer and does not hold workflows.write', 403)) }
    render(<CollabPage api={face(state())} chat={refusing} tc={chatFrench} team={{}} />)
    const welcome = await screen.findByTestId('lane-welcome', {}, { timeout: 5000 })
    fireEvent.click(within(within(welcome).getByTestId('lane-add-agents')).getByRole('button', { name: 'Ajouter @assistant au canal' }))
    expect((await within(welcome).findByRole('alert')).textContent).not.toBe('')
  })

  it('a question without its published message (an older help) offers the channel only, no field', async () => {
    const team = { id: 'chn_1', name: 'compta', title: 'compta', kind: 'team' as const, members: [you], agents: [], connectors: [], createdBy: you, createdAt: at }
    const chat = createMockChat({
      you, agents: [], channels: [team],
      escalations: [{ channelId: 'chn_1', turnId: 'trn_1', messageId: 'msg_1', questionMessageId: '', question: 'HT ?', at }],
    }, () => Date.parse(at))
    render(<CollabPage api={face(state({ approvals: [] }))} chat={chat} tc={chatFrench} team={{}} />)
    fireEvent.click(within(await screen.findByTestId('side-nav')).getByRole('button', { name: /À traiter/u }))
    const item = await screen.findByTestId('pending-question')
    expect(within(item).queryByRole('textbox')).toBeNull()
    expect(within(item).getByRole('button', { name: 'Répondre dans # compta' })).toBeTruthy()
  })
})

describe('a new team channel no agent reads', { timeout: 20_000 }, () => {
  const you = 'stephane@datanalysis.re'
  const at = '2026-11-25T08:00:00.000Z'
  const assistant = { id: 'agt_1', handle: 'assistant', name: 'Assistant', provider: 'p', model: 'm', connectors: [], eurPerMonth: 5, createdBy: you, createdAt: at }
  const fresh = { id: 'chn_1', name: 'rapprochement', title: 'Rapprochement', kind: 'team' as const, members: [you], agents: [], connectors: [], createdBy: you, createdAt: at }

  it('says so, and one click adds an agent', async () => {
    const chat = createMockChat({ you, agents: [assistant], channels: [fresh] }, () => Date.parse(at))
    render(<CollabPage api={face(state())} chat={chat} tc={chatFrench} team={{}} />)
    const welcome = await screen.findByTestId('channel-welcome', {}, { timeout: 5000 })
    expect(within(welcome).getByText('Aucun agent ne lit encore ce canal. Ajoutez-en un :')).toBeTruthy()
    fireEvent.click(within(within(welcome).getByTestId('channel-add-agents')).getByRole('button', { name: 'Ajouter @assistant au canal' }))
    await waitFor(async () => { expect((await chat.channels()).find(c => c.id === 'chn_1')?.agents).toEqual(['agt_1']) })
    await waitFor(() => { expect(screen.queryByTestId('channel-welcome')).toBeNull() })
    expect(screen.getByTestId('chat-empty').textContent).toBe('Aucun message dans ce canal pour l\'instant.')
  })

  it('a reader who may not add one is told who does, without pills', async () => {
    const chat = createMockChat({ you, agents: [assistant], channels: [fresh] }, () => Date.parse(at))
    render(<CollabPage api={face(state({ canWrite: false }))} chat={chat} tc={chatFrench} team={{}} />)
    const welcome = await screen.findByTestId('channel-welcome', {}, { timeout: 5000 })
    expect(welcome.textContent).toBe('Aucun agent ne lit encore ce canal : quelqu\'un qui peut écrire dans l\'espace en ajoute un.')
    expect(within(welcome).queryByTestId('channel-add-agents')).toBeNull()
  })

  it('a refusal is cleared when the person tries again', async () => {
    const chat = createMockChat({ you, agents: [assistant], channels: [fresh] }, () => Date.parse(at))
    let first = true
    const once = {
      ...chat,
      addAgents: (id: string, agents: readonly string[]) => {
        if (first) { first = false; return Promise.reject(new ChatRefusal('try later', 503)) }
        return chat.addAgents(id, agents)
      },
    }
    render(<CollabPage api={face(state())} chat={once} tc={chatFrench} team={{}} />)
    const welcome = await screen.findByTestId('channel-welcome', {}, { timeout: 5000 })
    const pill = within(within(welcome).getByTestId('channel-add-agents')).getByRole('button', { name: 'Ajouter @assistant au canal' })
    fireEvent.click(pill)
    expect(await within(welcome).findByRole('alert')).toBeTruthy()
    fireEvent.click(pill)
    await waitFor(() => { expect(screen.queryByTestId('channel-welcome')).toBeNull() })
  })

  it('an agent added that refuses is said', async () => {
    const chat = createMockChat({ you, agents: [assistant], channels: [fresh] }, () => Date.parse(at))
    const refusing = { ...chat, addAgents: () => Promise.reject(new ChatRefusal('no agent agt_1', 404)) }
    render(<CollabPage api={face(state())} chat={refusing} tc={chatFrench} team={{}} />)
    const welcome = await screen.findByTestId('channel-welcome', {}, { timeout: 5000 })
    fireEvent.click(within(within(welcome).getByTestId('channel-add-agents')).getByRole('button', { name: 'Ajouter @assistant au canal' }))
    expect((await within(welcome).findByRole('alert')).textContent).not.toBe('')
  })
})

describe('cards raised to the deciders (À traiter)', { timeout: 20_000 }, () => {
  const you = 'stephane@datanalysis.re'
  const at = '2026-11-25T08:00:00.000Z'
  const raised = (over: Record<string, unknown>) => ({
    id: 'apr_9', kind: 'send-email', title: 'Relancer Orange', requestedBy: 'smarion@datanalysis.re', requestedAt: at,
    state: 'pending', canDecide: true, channelId: 'chn_lane_smarion', ...over,
  })
  const openPending = async (cards: readonly unknown[]) => {
    const chat = createMockChat({ you, agents: [], channels: [], cards: cards as never }, () => Date.parse(at))
    render(<CollabPage api={face(state())} chat={chat} tc={chatFrench} team={{ names: { 'smarion@datanalysis.re': 'Sophie Marion' } }} />)
    fireEvent.click(within(await screen.findByTestId('side-nav')).getByRole('button', { name: /À traiter/u }))
    return screen.findByTestId('team-pending', {}, { timeout: 5000 })
  }

  it('from a lane: whose, and no link to it', async () => {
    const pending = await openPending([raised({ origin: { kind: 'lane' } })])
    expect((await within(pending).findByTestId('queue-from-lane')).textContent).toBe('depuis la lane de Sophie Marion')
    expect(within(pending).queryByRole('button', { name: /lane/u })).toBeNull()
  })

  it('from a channel with no decider: said, no title, no link', async () => {
    const pending = await openPending([raised({ origin: { kind: 'channel' }, channelId: 'chn_x' })])
    expect((await within(pending).findByTestId('queue-from-channel')).textContent).toBe('depuis un canal sans décideur')
  })
})

describe('a card of a channel absent from the list, without origin', { timeout: 20_000 }, () => {
  it('says nothing about where it comes from (no « canal sans décideur » it cannot prove)', async () => {
    const you = 'stephane@datanalysis.re'
    const at = '2026-11-25T08:00:00.000Z'
    const card = { id: 'apr_8', kind: 'send-email', title: 'x', requestedBy: you, requestedAt: at, state: 'pending', canDecide: true, channelId: 'chn_gone' }
    const chat = createMockChat({ you, agents: [], channels: [], cards: [card] as never }, () => Date.parse(at))
    render(<CollabPage api={face(state())} chat={chat} tc={chatFrench} team={{}} />)
    fireEvent.click(within(await screen.findByTestId('side-nav')).getByRole('button', { name: /À traiter/u }))
    const pending = await screen.findByTestId('team-pending', {}, { timeout: 5000 })
    await waitFor(() => { expect(within(pending).getAllByRole('article').length).toBeGreaterThan(0) })
    expect(within(pending).queryByTestId('queue-from-channel')).toBeNull()
    expect(within(pending).queryByTestId('queue-from-lane')).toBeNull()
  })
})

describe('« Tâches planifiées » in the navigation (owner)', { timeout: 20_000 }, () => {
  const you = 'stephane@datanalysis.re'
  const at = '2026-11-26T08:00:00.000Z'
  const lane = { id: 'chn_0', name: 'solo', title: 'Ma lane', kind: 'solo' as const, members: [you], agents: [], connectors: [], createdBy: you, createdAt: at }
  const briefing = { id: 'auto_briefing', name: 'Briefing du matin', kind: 'briefing', prompt: 'briefing', at: '07:30', days: [1, 2, 3, 4, 5],
    enabled: true, createdBy: 'scheduler', lastFiredDate: '2026-11-26', lastOutcome: 'ok: mission mis_1' }
  const relance = { id: 'auto_x', name: 'Relance', kind: 'custom', prompt: 'x', at: '09:00', enabled: false, createdBy: you }
  const saved: { id: string; at: string }[] = []
  const automationsFace = (over: Record<string, unknown> = {}): MndtFace => {
    let items = [briefing, relance]
    const base = face(state())
    return new Proxy(base, {
      get: (target, key) => {
        if (key === 'automations') return over.automations ?? (async () => ({ items, canAdmin: true, ...(over.timeZone === undefined ? {} : { timeZone: over.timeZone }) }))
        if (key === 'saveAutomation' && over.saveAutomation !== undefined) return over.saveAutomation
        if (key === 'saveAutomation') return async (input: { id: string; at: string }) => {
          saved.push(input)
          items = items.map(a => (a.id === input.id ? { ...a, at: input.at } : a))
          return { ok: true }
        }
        if (key === 'runAutomationNow') return over.runAutomationNow ?? (async () => ({ ok: true, value: { outcome: 'ok' } }))
        if (key === 'toggleAutomation' && over.toggleAutomation !== undefined) return over.toggleAutomation
        if (key === 'toggleAutomation') return async (id: string, enabled: boolean) => {
          items = items.map(a => (a.id === id ? { ...a, enabled } : a))
          return { ok: true }
        }
        return (target as unknown as Record<string | symbol, unknown>)[key]
      },
    })
  }
  const open = async (owner: boolean, api: MndtFace = automationsFace()) => {
    const chat = createMockChat({ you, agents: [], channels: [lane] }, () => Date.parse(at))
    render(<CollabPage api={api} chat={chat} tc={chatFrench} team={{ owner }} />)
    return screen.findByTestId('side-nav')
  }

  it('the owner has the entry; another member has none', async () => {
    expect(within(await open(true)).getByRole('button', { name: 'Tâches planifiées' })).toBeTruthy()
    cleanup()
    expect(within(await open(false)).queryByRole('button', { name: 'Tâches planifiées' })).toBeNull()
  })

  it('lists each one with its hour in words, its last run and its state', async () => {
    fireEvent.click(within(await open(true)).getByRole('button', { name: 'Tâches planifiées' }))
    const rows = await screen.findAllByTestId('scheduled-row')
    expect(rows[0]?.textContent).toContain('Briefing du matin · du lundi au vendredi à 07:30')
    expect(within(rows[0] as HTMLElement).getByTestId('scheduled-last').textContent).toBe('dernier passage : 2026-11-26 · abouti')
    expect(within(rows[1] as HTMLElement).getByTestId('scheduled-state').textContent).toBe('suspendue')
  })

  it('run now in one click; a briefing links to the lane, which one click opens', async () => {
    fireEvent.click(within(await open(true)).getByRole('button', { name: 'Tâches planifiées' }))
    const [first] = await screen.findAllByTestId('scheduled-row')
    fireEvent.click(within(first as HTMLElement).getByRole('button', { name: 'Lancer maintenant' }))
    const ran = await screen.findByTestId('scheduled-ran')
    fireEvent.click(within(ran).getByRole('button', { name: 'Voir dans ma lane' }))
    expect(await screen.findByTestId('lane-welcome')).toBeTruthy()
  })

  it('any kind is linked to the lane (#166 publishes them all there)', async () => {
    fireEvent.click(within(await open(true)).getByRole('button', { name: 'Tâches planifiées' }))
    const rows = await screen.findAllByTestId('scheduled-row')
    fireEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: 'Lancer maintenant' }))
    const ran = await screen.findByTestId('scheduled-ran')
    expect(within(ran).getByRole('button', { name: 'Voir dans ma lane' })).toBeTruthy()
  })

  it('suspend and activate in one click', async () => {
    fireEvent.click(within(await open(true)).getByRole('button', { name: 'Tâches planifiées' }))
    const rows = await screen.findAllByTestId('scheduled-row')
    fireEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: 'Activer' }))
    await waitFor(() => { expect(screen.getAllByTestId('scheduled-state')[1]?.textContent).toBe('active') })
  })

  it('a refused run is said in a fixed sentence, never the served text', async () => {
    const api = automationsFace({ runAutomationNow: async () => ({ ok: false, error: 'upstream sk-live-1', status: 500 }) })
    fireEvent.click(within(await open(true, api)).getByRole('button', { name: 'Tâches planifiées' }))
    const [first] = await screen.findAllByTestId('scheduled-row')
    fireEvent.click(within(first as HTMLElement).getByRole('button', { name: 'Lancer maintenant' }))
    const alert = await within(first as HTMLElement).findByRole('alert')
    expect(alert.textContent).toBe('Elle n\'a pas pu être lancée : réessayez dans un moment.')
  })

  it('a 200 that says it failed reads a fixed sentence, never the rest of the text', async () => {
    const api = automationsFace({ runAutomationNow: async () => ({ ok: true, value: { outcome: 'failed: upstream sk-live-1 at 10.0.0.4' } }) })
    fireEvent.click(within(await open(true, api)).getByRole('button', { name: 'Tâches planifiées' }))
    const [first] = await screen.findAllByTestId('scheduled-row')
    fireEvent.click(within(first as HTMLElement).getByRole('button', { name: 'Lancer maintenant' }))
    const alert = await within(first as HTMLElement).findByRole('alert')
    expect(alert.textContent).toBe('Le lancement a échoué.')
    expect(screen.queryByTestId('scheduled-ran')).toBeNull()
  })

  it('a member who is not the owner has neither the entry nor the screen', async () => {
    const side = await open(false)
    expect(within(side).queryByRole('button', { name: 'Tâches planifiées' })).toBeNull()
    expect(screen.queryByTestId('team-scheduled')).toBeNull()
  })

  it('two clicks make one call; a rejected call frees the line', async () => {
    let calls = 0
    let release: () => void = () => undefined
    const api = automationsFace({
      runAutomationNow: () => { calls += 1; return new Promise((_r, reject) => { release = () => { reject(new Error('down')) } }) },
    })
    fireEvent.click(within(await open(true, api)).getByRole('button', { name: 'Tâches planifiées' }))
    const [first] = await screen.findAllByTestId('scheduled-row')
    const button = within(first as HTMLElement).getByRole('button', { name: 'Lancer maintenant' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(calls).toBe(1)
    release()
    expect((await within(first as HTMLElement).findByRole('alert')).textContent).toBe('Elle n\'a pas pu être lancée : réessayez dans un moment.')
    await waitFor(() => { expect(within(first as HTMLElement).getByRole('button', { name: 'Lancer maintenant' }).hasAttribute('disabled')).toBe(false) })
  })

  it('a refused toggle reads a fixed sentence', async () => {
    const api = automationsFace({ toggleAutomation: async () => ({ ok: false, error: 'internal sk-live-2', status: 500 }) })
    fireEvent.click(within(await open(true, api)).getByRole('button', { name: 'Tâches planifiées' }))
    const rows = await screen.findAllByTestId('scheduled-row')
    fireEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: 'Activer' }))
    expect((await within(rows[1] as HTMLElement).findByRole('alert')).textContent).toBe('Elle n\'a pas pu être modifiée : réessayez dans un moment.')
  })

  it('the last run reads lastRunAt first, else lastFiredDate, else nothing', async () => {
    const items = [
      { ...briefing, lastRunAt: '2026-11-26T05:12:00.000Z', lastFiredDate: '2026-11-20' },
      { ...relance, id: 'auto_y', lastFiredDate: '2026-11-25' },
      { ...relance, id: 'auto_z' },
    ]
    const api = automationsFace({ automations: async () => ({ items, canAdmin: true }) })
    fireEvent.click(within(await open(true, api)).getByRole('button', { name: 'Tâches planifiées' }))
    const rows = await screen.findAllByTestId('scheduled-row')
    expect(within(rows[0] as HTMLElement).getByTestId('scheduled-last').textContent).not.toContain('2026-11-20')
    expect(within(rows[1] as HTMLElement).getByTestId('scheduled-last').textContent).toContain('2026-11-25')
    expect(within(rows[2] as HTMLElement).queryByTestId('scheduled-last')).toBeNull()
  })

  it('the hour changes in place: a click, the field, Enter; sent as { id, at } for any automation', async () => {
    saved.length = 0
    fireEvent.click(within(await open(true, automationsFace({ timeZone: 'Indian/Reunion' }))).getByRole('button', { name: 'Tâches planifiées' }))
    const rows = await screen.findAllByTestId('scheduled-row')
    expect(within(rows[1] as HTMLElement).getByTestId('scheduled-zone').textContent).toBe(' (heure de La Réunion)')
    fireEvent.click(within(rows[1] as HTMLElement).getByTestId('scheduled-hour'))
    const field = within(rows[1] as HTMLElement).getByLabelText('Nouvelle heure pour Relance')
    fireEvent.change(field, { target: { value: '08:15' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => { expect(saved).toEqual([{ id: 'auto_x', at: '08:15' }]) })
    await waitFor(() => { expect(within(screen.getAllByTestId('scheduled-row')[1] as HTMLElement).getByTestId('scheduled-hour').textContent).toBe('à 08:15') })
  })

  it('Escape leaves the hour as it was, nothing sent', async () => {
    saved.length = 0
    fireEvent.click(within(await open(true)).getByRole('button', { name: 'Tâches planifiées' }))
    const [first] = await screen.findAllByTestId('scheduled-row')
    fireEvent.click(within(first as HTMLElement).getByTestId('scheduled-hour'))
    const field = within(first as HTMLElement).getByLabelText('Nouvelle heure pour Briefing du matin')
    fireEvent.change(field, { target: { value: '09:00' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(within(first as HTMLElement).getByTestId('scheduled-hour').textContent).toBe('à 07:30')
    expect(saved).toEqual([])
  })

  it('without a served zone, the line says « heure de l\'instance », never a guessed place', async () => {
    fireEvent.click(within(await open(true)).getByRole('button', { name: 'Tâches planifiées' }))
    const [first] = await screen.findAllByTestId('scheduled-row')
    expect(within(first as HTMLElement).getByTestId('scheduled-zone').textContent).toBe(' (heure de l\'instance)')
  })

  it('a refused hour, or one that cannot be read, is said in a fixed sentence; nothing malformed is sent', async () => {
    saved.length = 0
    const api = automationsFace({ saveAutomation: async () => ({ ok: false, error: 'a name, a prompt… sk-live', status: 400 }) })
    fireEvent.click(within(await open(true, api)).getByRole('button', { name: 'Tâches planifiées' }))
    const [first] = await screen.findAllByTestId('scheduled-row')
    fireEvent.click(within(first as HTMLElement).getByTestId('scheduled-hour'))
    const field = within(first as HTMLElement).getByLabelText('Nouvelle heure pour Briefing du matin')
    fireEvent.change(field, { target: { value: '06:45' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect((await within(first as HTMLElement).findByRole('alert')).textContent).toBe('L\'heure n\'a pas pu être changée : réessayez dans un moment.')
    // An hour the field cannot hold (emptied) is said, and never sent: the core would make it 07:30.
    fireEvent.click(within(first as HTMLElement).getByTestId('scheduled-hour'))
    const again = within(first as HTMLElement).getByLabelText('Nouvelle heure pour Briefing du matin')
    fireEvent.change(again, { target: { value: '' } })
    fireEvent.keyDown(again, { key: 'Enter' })
    expect((await within(first as HTMLElement).findByRole('alert')).textContent).toBe('Cette heure est illisible : écrivez-la comme 07:30.')
    expect(saved).toEqual([])
  })

  it('a double Enter saves once', async () => {
    let calls = 0
    let release: () => void = () => undefined
    const api = automationsFace({
      saveAutomation: () => { calls += 1; return new Promise((resolve) => { release = () => { resolve({ ok: true }) } }) },
    })
    fireEvent.click(within(await open(true, api)).getByRole('button', { name: 'Tâches planifiées' }))
    const [first] = await screen.findAllByTestId('scheduled-row')
    fireEvent.click(within(first as HTMLElement).getByTestId('scheduled-hour'))
    const field = within(first as HTMLElement).getByLabelText('Nouvelle heure pour Briefing du matin')
    fireEvent.change(field, { target: { value: '06:45' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(calls).toBe(1)
    release()
    await waitFor(() => { expect(within(first as HTMLElement).getByTestId('scheduled-hour').hasAttribute('disabled')).toBe(false) })
    expect(calls).toBe(1)
  })

  it('the next run, in the served zone; none on a suspended one', async () => {
    const items = [{ ...briefing, nextRunAt: '2026-11-27T03:30:00.000Z' }, { ...relance, nextRunAt: '2026-11-27T05:00:00.000Z' }]
    const api = automationsFace({ automations: async () => ({ items, canAdmin: true, timeZone: 'Indian/Reunion' }) })
    fireEvent.click(within(await open(true, api)).getByRole('button', { name: 'Tâches planifiées' }))
    const rows = await screen.findAllByTestId('scheduled-row')
    expect(within(rows[0] as HTMLElement).getByTestId('scheduled-next').textContent).toContain('07:30')
    expect(within(rows[1] as HTMLElement).queryByTestId('scheduled-next')).toBeNull()
    expect(within(rows[0] as HTMLElement).getByTestId('scheduled-zone').textContent).toBe(' (heure de La Réunion)')
  })

  it('a scheduler silent for over 2 minutes, on the server\'s clock, is said; a recent one, none, or no server clock says nothing', async () => {
    const said = async (schedulerAt: string | undefined, serverAt: string | undefined): Promise<HTMLElement | null> => {
      cleanup()
      const answer = { items: [briefing], canAdmin: true, timeZone: 'Indian/Reunion',
        ...(schedulerAt === undefined ? {} : { schedulerAt }), ...(serverAt === undefined ? {} : { serverAt }) }
      fireEvent.click(within(await open(true, automationsFace({ automations: async () => answer }))).getByRole('button', { name: 'Tâches planifiées' }))
      await screen.findAllByTestId('scheduled-row')
      return screen.queryByTestId('scheduler-stopped')
    }
    const server = 'Thu, 26 Nov 2026 08:00:00 GMT'
    expect((await said('2026-11-26T07:50:00.000Z', server))?.textContent).toContain('Le planificateur ne tourne plus depuis')
    expect(await said('2026-11-26T07:59:30.000Z', server)).toBeNull()
    expect(await said(undefined, server)).toBeNull()
    // Without the server's clock (the Date header did not come through), the age is unknown: nothing.
    expect(await said('2026-11-26T07:00:00.000Z', undefined)).toBeNull()
    expect(await said('2026-11-26T07:00:00.000Z', 'not a date')).toBeNull()
  })

  it('a browser clock off by 10 minutes, either way, changes nothing', async () => {
    const realNow = Date.now
    try {
      for (const offset of [10 * 60_000, -10 * 60_000]) {
        cleanup()
        Date.now = () => Date.parse('2026-11-26T08:00:00.000Z') + offset
        // A recent pass on the server's clock: never « arrêté », whatever the browser thinks.
        const recent = { items: [briefing], canAdmin: true, schedulerAt: '2026-11-26T07:59:30.000Z', serverAt: 'Thu, 26 Nov 2026 08:00:00 GMT' }
        fireEvent.click(within(await open(true, automationsFace({ automations: async () => recent }))).getByRole('button', { name: 'Tâches planifiées' }))
        await screen.findAllByTestId('scheduled-row')
        expect(screen.queryByTestId('scheduler-stopped')).toBeNull()
        cleanup()
        // A silent one on the server's clock: always said.
        const silent = { ...recent, schedulerAt: '2026-11-26T07:50:00.000Z' }
        fireEvent.click(within(await open(true, automationsFace({ automations: async () => silent }))).getByRole('button', { name: 'Tâches planifiées' }))
        await screen.findAllByTestId('scheduled-row')
        expect(screen.getByTestId('scheduler-stopped')).toBeTruthy()
      }
    } finally {
      Date.now = realNow
    }
  })

  it('a bad-time refusal reads its fixed sentence', async () => {
    const api = automationsFace({ saveAutomation: async () => ({ ok: false, error: 'the time must read HH:MM', status: 400, code: 'bad-time' }) })
    fireEvent.click(within(await open(true, api)).getByRole('button', { name: 'Tâches planifiées' }))
    const [first] = await screen.findAllByTestId('scheduled-row')
    fireEvent.click(within(first as HTMLElement).getByTestId('scheduled-hour'))
    const field = within(first as HTMLElement).getByLabelText('Nouvelle heure pour Briefing du matin')
    fireEvent.change(field, { target: { value: '06:45' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect((await within(first as HTMLElement).findByRole('alert')).textContent).toBe('Cette heure est illisible : écrivez-la comme 07:30.')
  })
})
