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

  it('titles the channel with its kind below, and says an empty feed in the centre', async () => {
    await open()
    expect(screen.getByRole('heading', { level: 1, name: '# test' })).toBeTruthy()
    expect(document.querySelector('.mw-subtitle')?.textContent).toBe('Équipe')
    expect((await screen.findByTestId('chat-empty')).textContent).toBe('Aucun message dans ce canal pour l\'instant.')
  })

  it('shows the context card in the sections of mndt-web, « bientôt » where nothing is served', async () => {
    await open()
    const card = screen.getByTestId('context-panel')
    expect([...card.querySelectorAll('h3')].map(h => h.textContent)).toEqual(['Canal', 'Mandats', 'Agents', 'Mémoire', 'Documents', 'Membres'])
    expect(card.textContent).toContain('Bientôt : les mandats du canal arrivent avec leur écran.')
    expect(card.textContent).toContain('Bientôt : les documents du canal arrivent avec leur route.')
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
    expect(agent.textContent).toContain('LLM : scaleway-genapi · deepseek-v4.1-flash')
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
