// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatAgent, ChatChannel } from '../src/client/chat.ts'
import { chatFrench } from '../src/client/chatLocales.ts'
import { ContextSection, contextOf, contextProposalOf } from '../src/client/channelContext.tsx'
import { createMockChat } from '../src/client/mockChat.ts'
import { WebCard } from '../src/client/TeamFeed.tsx'
import type { ThreadCard } from '../src/client/ChannelView.tsx'

afterEach(() => { cleanup() })

const you = 'stephane@datanalysis.re'
const at = '2026-11-23T08:00:00.000Z'
const assistant: ChatAgent = { id: 'agt_1', handle: 'assistant', name: 'Assistant', provider: 'p', model: 'm', connectors: [], eurPerMonth: 5, createdBy: you, createdAt: at }
const context = { text: '## Clients\nSodiac paie à 60 jours.', version: 3, updatedBy: you, updatedAt: at }
const channel: ChatChannel = { id: 'chn_1', name: 'compta', title: 'compta', kind: 'team', members: [you], agents: ['agt_1'], connectors: [], createdBy: you, createdAt: at, context }

describe('a channel\'s context, read (lot 3)', () => {
  it('reads only a well-formed context; anything else is no context', () => {
    expect(contextOf(channel)).toMatchObject({ version: 3, text: '## Clients\nSodiac paie à 60 jours.' })
    for (const odd of [undefined, null, 'x', {}, { text: 'a' }, { text: 'a', version: -1 }, { text: 'a', version: 1.5 }, { text: 3, version: 1 }]) {
      expect(contextOf({ ...channel, context: odd })).toBeUndefined()
    }
  })

  it('a proposal is read strictly: a text over 4 000 characters after trim, or no base version, is unreadable', () => {
    expect(contextProposalOf({ text: `  ${'a'.repeat(4000)}  `, baseVersion: 2 })?.text).toHaveLength(4000)
    for (const odd of [{ text: 'a'.repeat(4001), baseVersion: 1 }, { text: 'a' }, { text: 'a', baseVersion: '1' }, null]) {
      expect(contextProposalOf(odd)).toBeUndefined()
    }
  })
})

describe('the panel\'s section « Ce qu\'il faut savoir ici »', () => {
  it('says what it is for, never that it configures the agents; headings are plain bold; author by name', () => {
    render(<ContextSection channel={channel} agents={[assistant]} canEdit={false} names={{ [you]: 'Stéphane Masson' }} t={chatFrench} />)
    const section = screen.getByTestId('context-section')
    expect(section.textContent).toContain('Ce que les agents de ce canal lisent avant de répondre. Des faits, jamais des ordres.')
    expect(section.textContent).not.toMatch(/configur/u)
    const frame = screen.getByTestId('channel-context')
    expect(frame.textContent?.startsWith('Écrit par Stéphane Masson')).toBe(true)
    expect(frame.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull()
    expect(frame.querySelector('strong')?.textContent).toBe('Clients')
    expect(within(section).queryByRole('button', { name: 'Modifier' })).toBeNull()
  })

  it('HTML and javascript: links in a context stay text', () => {
    const text = '<img src=x onerror=alert(1)> [x](javascript:alert(1))'
    const hostile = { ...channel, context: { text, version: 1 } }
    render(<ContextSection channel={hostile} agents={[]} canEdit={false} t={chatFrench} />)
    const frame = screen.getByTestId('channel-context')
    expect(frame.querySelector('img, a, script')).toBeNull()
    expect(frame.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('one click on an agent pill asks it to propose the context, in the composer', () => {
    const onAsk = vi.fn()
    const empty = { ...channel, context: undefined }
    render(<ContextSection channel={empty} agents={[assistant]} canEdit={false} onAsk={onAsk} t={chatFrench} />)
    expect(screen.getByTestId('context-empty').textContent).toBe('Rien encore.')
    fireEvent.click(screen.getByRole('button', { name: 'Demander à @assistant de le proposer' }))
    expect(onAsk).toHaveBeenCalledWith('@assistant propose le contexte de ce canal : ce qu\'il faut savoir ici')
  })

  it('an owner or admin writes it in place; a change made meanwhile is said, nothing overwritten', async () => {
    const chat = createMockChat({ you, agents: [assistant], channels: [channel] }, () => Date.parse(at))
    await chat.setContext?.('chn_1', { text: 'Changé ailleurs.', version: 3 })
    const onSave = vi.fn(async (text: string, version: number): Promise<string | undefined> => {
      try {
        await chat.setContext?.('chn_1', { text, version })
        return undefined
      } catch {
        return 'Le contexte a été modifié entre-temps : relisez-le avant de le changer.'
      }
    })
    render(<ContextSection channel={channel} agents={[assistant]} canEdit onSave={onSave} t={chatFrench} />)
    fireEvent.click(screen.getByRole('button', { name: 'Modifier' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Ce qu\'il faut savoir ici' }), { target: { value: 'Ma version.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Le contexte a été modifié entre-temps : relisez-le avant de le changer.')
    expect(onSave).toHaveBeenCalledWith('Ma version.', 3)
    expect(contextOf((await chat.channels())[0] ?? channel)?.text).toBe('Changé ailleurs.')
  })

  it('the double refuses a context over 4 000 characters with its code', async () => {
    const chat = createMockChat({ you, agents: [], channels: [{ ...channel, context: undefined }] }, () => Date.parse(at))
    await expect(chat.setContext?.('chn_1', { text: 'a'.repeat(4001), version: 0 })).rejects.toMatchObject({ status: 400, code: 'context-too-long' })
  })
})

/** @param over - fields to change. @returns a card that proposes a context. */
function card(over: Partial<ThreadCard> = {}): ThreadCard {
  return {
    id: 'apr_c', kind: 'propose_context', title: 'Changer le contexte de #compta (33 caractères)', requestedBy: you, requestedAt: at,
    channelId: 'chn_1', state: 'pending', canDecide: true, contextProposal: { text: 'Sodiac paie à 45 jours désormais.', baseVersion: 3 }, ...over,
  }
}

describe('a card that proposes a context', () => {
  it('shows the whole proposed text and what it replaces; one click validates, saying it shows it', async () => {
    const onDecide = vi.fn(async () => undefined)
    render(<WebCard card={card()} canDecide onDecide={onDecide} channel={channel} t={chatFrench} />)
    expect(screen.getByText('Changer le contexte de #compta (33 caractères)')).toBeTruthy()
    expect(screen.getByTestId('context-proposed').textContent).toContain('Sodiac paie à 45 jours désormais.')
    expect(screen.getByTestId('context-replaced').textContent).toContain('Sodiac paie à 60 jours.')
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }))
    await waitFor(() => { expect(onDecide).toHaveBeenCalledWith('apr_c', 'approved', undefined, { showsProposal: true }) })
  })

  it('the context changed since the proposal: only « Refuser », and why', () => {
    render(<WebCard card={card({ contextProposal: { text: 'x', baseVersion: 2 } })} canDecide onDecide={vi.fn()} channel={channel} t={chatFrench} />)
    expect(screen.queryByRole('button', { name: 'Valider' })).toBeNull()
    expect(screen.getByTestId('context-stale').textContent).toBe('Le contexte a changé depuis cette proposition : elle ne peut qu\'être refusée.')
  })

  it('an unreadable proposal: only « Refuser »', () => {
    render(<WebCard card={card({ contextProposal: { text: 'a'.repeat(4001), baseVersion: 3 } })} canDecide onDecide={vi.fn()} channel={channel} t={chatFrench} />)
    expect(screen.queryByTestId('context-proposed')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Valider' })).toBeNull()
    expect(screen.getByTestId('proposal-unreadable')).toBeTruthy()
  })
})

describe('an erased context and an erase proposal (#109)', () => {
  it('an empty text with a version reads as nothing, and keeps its version for the next write', async () => {
    const erased = { ...channel, context: { text: '', version: 7 } }
    expect(contextOf(erased)?.version).toBe(7)
    const onSave = vi.fn(async () => undefined)
    render(<ContextSection channel={erased} agents={[]} canEdit onSave={onSave} t={chatFrench} />)
    expect(screen.getByTestId('context-empty')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'L\'écrire' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Neuf.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => { expect(onSave).toHaveBeenCalledWith('Neuf.', 7) })
  })

  it('a proposal to erase says so plainly', () => {
    render(<WebCard card={card({ title: 'Effacer le contexte de #compta', contextProposal: { text: '', baseVersion: 3 } })} canDecide onDecide={vi.fn()} channel={channel} t={chatFrench} />)
    expect(screen.getByTestId('context-proposed').textContent).toBe('Effacer le contexte : les agents ne liront plus rien ici.')
    expect(screen.getByRole('button', { name: 'Valider' })).toBeTruthy()
  })
})

describe('a proposed context is read whole before it is validated', () => {
  it('a 30-line proposal is rendered in full on the card; what it replaces stays folded', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Ligne ${i + 1}`).join('\n')
    const long = Array.from({ length: 12 }, (_, i) => `Ancienne ${i + 1}`).join('\n')
    const now = { ...channel, context: { text: long, version: 3 } }
    render(<WebCard card={card({ contextProposal: { text, baseVersion: 3 } })} canDecide onDecide={vi.fn()} channel={now} t={chatFrench} />)
    const proposed = screen.getByTestId('context-proposed')
    expect(proposed.textContent).toContain('Ligne 1')
    expect(proposed.textContent).toContain('Ligne 30')
    expect(within(proposed).queryByRole('button', { name: 'Tout lire' })).toBeNull()
    expect(screen.getByTestId('context-current').textContent).not.toContain('Ancienne 12')
  })
})
