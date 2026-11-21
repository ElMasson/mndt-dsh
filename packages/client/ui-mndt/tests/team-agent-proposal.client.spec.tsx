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
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }))
    await waitFor(() => { expect(onDecide).toHaveBeenCalledWith('apr_p', 'approved', undefined) })
  })

  it('above 5 EUR, an admin is told only the owner validates, and may only refuse; the owner validates', async () => {
    const rich = card({ proposal: { ...proposal, eurPerMonth: 20 } })
    const { unmount } = render(<WebCard card={rich} canDecide onDecide={vi.fn()} mounted={mounted} t={chatFrench} />)
    expect(screen.getByTestId('proposal-owner-only').textContent).toBe('Au-dessus de 5 € par mois, seul l\'owner peut valider cet agent.')
    const validate = screen.getByRole('button', { name: 'Valider' })
    expect(validate instanceof HTMLButtonElement && validate.disabled).toBe(true)
    const refuse = screen.getByRole('button', { name: 'Refuser' })
    expect(refuse instanceof HTMLButtonElement && refuse.disabled).toBe(false)
    unmount()
    const onDecide = vi.fn(async () => undefined)
    render(<WebCard card={rich} canDecide isOwner onDecide={onDecide} mounted={mounted} t={chatFrench} />)
    expect(screen.queryByTestId('proposal-owner-only')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }))
    await waitFor(() => { expect(onDecide).toHaveBeenCalledWith('apr_p', 'approved', undefined) })
  })

  it('a malformed proposal falls back to the card as served, never a half sheet', () => {
    render(<WebCard card={card({ proposal: { name: 'X' }, title: 'Proposition illisible' })} canDecide onDecide={vi.fn()} t={chatFrench} />)
    expect(screen.queryByTestId('agent-sheet-view')).toBeNull()
    expect(screen.getByText('Proposition illisible')).toBeTruthy()
  })

  it('a card of another kind never reads a proposal field', () => {
    render(<WebCard card={card({ kind: 'send-email', title: 'Envoyer' })} canDecide onDecide={vi.fn()} t={chatFrench} />)
    expect(screen.queryByTestId('agent-sheet-view')).toBeNull()
  })
})
