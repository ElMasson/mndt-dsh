// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebCard } from '../src/client/TeamFeed.tsx'
import { proposalOf } from '../src/client/TeamAgentForm.tsx'
import type { ThreadCard } from '../src/client/ChannelView.tsx'
import { chatFrench } from '../src/client/chatLocales.ts'

afterEach(() => { cleanup() })

const proposal = {
  name: 'Recouvrement', handle: 'recouvrement', provider: 'scaleway-genapi', model: 'deepseek-v4.1-flash',
  instructions: 'Suit les factures impayées et prépare les relances.', connectors: ['qonto', 'dolibarr'], eurPerMonth: 3,
}
const mounted = [{ module: 'm', server: 'qonto', enabled: true }, { module: 'm', server: 'dolibarr', enabled: false }]

/** @param over - fields to change. @returns a pending card an agent asked to declare an agent. */
function card(over: Partial<ThreadCard> = {}): ThreadCard {
  return {
    id: 'apr_p', kind: 'propose_agent', title: 'propose_agent', requestedBy: 'stephane@datanalysis.re', requestedAt: '2026-11-21T09:00:00.000Z',
    state: 'pending', canDecide: true, proposal, ...over,
  }
}

describe('a card that proposes an agent', () => {
  it('reads only a well-formed proposal', () => {
    expect(proposalOf(proposal)).toMatchObject({ name: 'Recouvrement', handle: 'recouvrement', eurPerMonth: 3 })
    for (const odd of [null, {}, 'x', { ...proposal, handle: 'Pas Un Slug' }, { ...proposal, name: '' }, { ...proposal, model: 7 }]) {
      expect(proposalOf(odd)).toBeUndefined()
    }
    expect(proposalOf({ ...proposal, connectors: ['qonto', 3, '../x'] })?.connectors).toEqual(['qonto'])
    expect(proposalOf({ ...proposal, eurPerMonth: -1 })?.eurPerMonth).toBeUndefined()
  })

  it('shows the whole sheet read-only, and validates in one click', async () => {
    const onDecide = vi.fn(async () => undefined)
    render(<WebCard card={card()} canDecide onDecide={onDecide} mounted={mounted} t={chatFrench} />)
    expect(screen.getByText('Créer l\'agent Recouvrement')).toBeTruthy()
    const sheet = screen.getByTestId('agent-sheet-view')
    expect(sheet.textContent).toContain('@recouvrement')
    expect(sheet.textContent).toContain('Suit les factures impayées et prépare les relances.')
    expect(sheet.textContent).toContain('Rapide')
    expect(sheet.textContent).toContain('scaleway-genapi · deepseek-v4.1-flash')
    // A connector the agent would carry but that is not mounted is said on the card.
    expect(sheet.textContent).toContain('dolibarrnon branché')
    // Read-only: no field to type in the sheet.
    expect(within(sheet).queryByRole('textbox')).toBeNull()
    cleanup()
    // Every connector mounted: one click validates.
    render(<WebCard card={card()} canDecide onDecide={onDecide} mounted={mounted.map(m => ({ ...m, enabled: true }))} t={chatFrench} />)
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }))
    await waitFor(() => { expect(onDecide).toHaveBeenCalledWith('apr_p', 'approved', undefined, { showsProposal: true }) })
  })

  it('above 5 EUR, an admin is told only the owner validates, and may only refuse; the owner validates', async () => {
    const rich = card({ proposal: { ...proposal, eurPerMonth: 20 } })
    const { unmount } = render(<WebCard card={rich} canDecide onDecide={vi.fn()} t={chatFrench} />)
    expect(screen.getByTestId('proposal-owner-only').textContent).toBe('Au-dessus de 5 € par mois, seul l\'owner peut valider cet agent.')
    const validate = screen.getByRole('button', { name: 'Valider' })
    expect(validate instanceof HTMLButtonElement && validate.disabled).toBe(true)
    const refuse = screen.getByRole('button', { name: 'Refuser' })
    expect(refuse instanceof HTMLButtonElement && refuse.disabled).toBe(false)
    unmount()
    const onDecide = vi.fn(async () => undefined)
    render(<WebCard card={rich} canDecide isOwner onDecide={onDecide} t={chatFrench} />)
    expect(screen.queryByTestId('proposal-owner-only')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }))
    await waitFor(() => { expect(onDecide).toHaveBeenCalledWith('apr_p', 'approved', undefined, { showsProposal: true }) })
  })

  it('an absent or malformed proposal is never validated blind: only « Refuser », and why', () => {
    for (const odd of [undefined, { name: 'X' }, null]) {
      const { unmount } = render(<WebCard card={card({ proposal: odd, title: 'Créer un agent' })} canDecide isOwner onDecide={vi.fn()} t={chatFrench} />)
      expect(screen.queryByTestId('agent-sheet-view')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Valider' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Refuser' })).toBeTruthy()
      expect(screen.getByTestId('proposal-unreadable').textContent).toBe('Cette proposition ne peut pas être lue en entier : elle ne peut qu\'être refusée.')
      unmount()
    }
  })

  it('the instructions come from an agent: shown whole, as text', () => {
    const long = `${'Relancer. '.repeat(150)}<script>alert(1)</script>`
    render(<WebCard card={card({ proposal: { ...proposal, instructions: long } })} canDecide isOwner onDecide={vi.fn()} t={chatFrench} />)
    const sheet = screen.getByTestId('agent-sheet-view')
    expect(sheet.textContent).toContain('<script>alert(1)</script>')
    expect(sheet.querySelector('script')).toBeNull()
  })

  it('a card of another kind never reads a proposal field', () => {
    render(<WebCard card={card({ kind: 'send-email', title: 'Envoyer' })} canDecide onDecide={vi.fn()} t={chatFrench} />)
    expect(screen.queryByTestId('agent-sheet-view')).toBeNull()
  })
})

describe('approving a proposal over HTTP (#82)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('says the page shows the whole proposal on approval only', async () => {
    const { createHttpFace } = await import('../src/client/httpFace.ts')
    const sent: Headers[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(new Headers(init.headers))
      return new Response(JSON.stringify({ approval: { id: 'apr_p' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const face = createHttpFace()
    await face.decide('apr_p', 'approved', undefined, { showsProposal: true })
    await face.decide('apr_p', 'rejected', 'non', { showsProposal: true })
    await face.decide('apr_q', 'approved')
    expect(sent.map(h => h.get('x-mndt-shows-proposal'))).toEqual(['1', null, null])
  })

  it('the core\'s refusals are said in the page\'s words', async () => {
    const { decisionRefusal } = await import('../src/client/CollabPage.tsx')
    const say = (m: string): string => decisionRefusal(m, chatFrench)
    expect(say('only the owner gives an agent a ceiling above 5 € a month')).toBe('Au-dessus de 5 € par mois, seul l\'owner peut valider cet agent.')
    expect(say('the handle @resume is taken')).toBe('L\'identifiant @resume est déjà pris.')
    expect(say('connector not mounted: qonto')).toBe('Ce connecteur n\'est pas branché : qonto.')
    expect(say('model not offered: x/y')).toBe('Ce modèle n\'est plus proposé (x/y) : cette carte ne peut qu\'être refusée.')
    expect(say('this card proposes an agent: approve it from a screen that shows the whole proposal')).toBe('Cette proposition ne peut pas être lue en entier : elle ne peut qu\'être refusée.')
    expect(say('something else')).toBe('something else')
  })

  it('a name on two lines or over 60 characters is no proposal', () => {
    expect(proposalOf({ ...proposal, name: 'Ligne\nDeux' })).toBeUndefined()
    expect(proposalOf({ ...proposal, name: 'x'.repeat(61) })).toBeUndefined()
    expect(proposalOf({ ...proposal, name: 'x'.repeat(60) })?.name).toHaveLength(60)
  })
})

describe('a proposal the workbench can no longer serve (#82)', () => {
  const offered = [{ provider: 'scaleway-genapi', model: 'deepseek-v4.1-flash' }]
  const allOn = [{ module: 'm', server: 'qonto', enabled: true }, { module: 'm', server: 'dolibarr', enabled: true }]

  it('a model gone from GET /models: said, and only « Refuser »', () => {
    render(<WebCard card={card()} canDecide isOwner onDecide={vi.fn()} mounted={allOn} offered={[{ provider: 'x', model: 'y' }]} t={chatFrench} />)
    expect(screen.getByTestId('proposal-model-gone').textContent).toBe('Ce modèle n\'est plus proposé (scaleway-genapi/deepseek-v4.1-flash) : cette carte ne peut qu\'être refusée.')
    expect(screen.queryByRole('button', { name: 'Valider' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Refuser' })).toBeTruthy()
  })

  it('a connector no longer mounted: said, and only « Refuser »', () => {
    render(<WebCard card={card()} canDecide isOwner onDecide={vi.fn()} mounted={mounted} offered={offered} t={chatFrench} />)
    expect(screen.getByTestId('proposal-unmounted').textContent).toBe('Plus branché : dolibarr. Cette carte ne peut qu\'être refusée.')
    expect(screen.queryByRole('button', { name: 'Valider' })).toBeNull()
  })

  it('all there: « Valider » is offered; lists not known yet block nothing', () => {
    const { unmount } = render(
      <WebCard card={card()} canDecide isOwner onDecide={vi.fn()} mounted={allOn} offered={offered} t={chatFrench} />,
    )
    expect(screen.getByRole('button', { name: 'Valider' })).toBeTruthy()
    unmount()
    render(<WebCard card={card()} canDecide isOwner onDecide={vi.fn()} t={chatFrench} />)
    expect(screen.getByRole('button', { name: 'Valider' })).toBeTruthy()
  })
})
