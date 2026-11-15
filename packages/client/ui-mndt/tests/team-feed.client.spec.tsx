// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebCard, WebMessage, placeOf, shownName } from '../src/client/TeamFeed.tsx'
import type { ThreadCard } from '../src/client/ChannelView.tsx'
import type { ChatAgent, ChatMessage } from '../src/client/chat.ts'
import { chatFrench } from '../src/client/chatLocales.ts'

afterEach(() => { cleanup() })

const you = 'stephane@datanalysis.re'
const assistant: ChatAgent = {
  id: 'agt_1', handle: 'assistant', name: 'Assistant', provider: 'scaleway-genapi', model: 'deepseek-v4.1-flash',
  connectors: [], eurPerMonth: 5, createdBy: you, createdAt: '2026-11-14T08:00:00.000Z',
}
const agents = new Map([[assistant.id, assistant]])

/** @param over - fields to change. @returns a human message. */
function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg_1', channelId: 'chn_1', author: { kind: 'human', email: you }, text: 'bonjour', mentions: [],
    createdAt: '2026-11-14T09:00:00.000Z', updatedAt: '2026-11-14T09:00:00.000Z', ...over,
  }
}

/** @param over - fields to change. @returns a pending card. */
function card(over: Partial<ThreadCard> = {}): ThreadCard {
  return { id: 'apr_1', kind: 'send-email', title: 'Envoyer la relance', requestedBy: 'assistant', requestedAt: '2026-11-14T09:01:00.000Z', state: 'pending', ...over }
}

describe('the feed, as mndt-web draws it', () => {
  it('names a person as /people serves them, else by the part before @', () => {
    expect(shownName('Stephane@datanalysis.re', { 'stephane@datanalysis.re': 'Stéphane Masson' })).toBe('Stéphane Masson')
    expect(shownName('lecteur@datanalysis.re', {})).toBe('lecteur')
  })

  it('joins the same author\'s messages within five minutes, and separates the days', () => {
    const first = message()
    expect(placeOf(undefined, first)).toEqual({ newDay: true, header: true })
    expect(placeOf(first, message({ id: 'm2', createdAt: '2026-11-14T09:04:00.000Z' }))).toEqual({ newDay: false, header: false })
    expect(placeOf(first, message({ id: 'm3', createdAt: '2026-11-14T09:06:00.000Z' }))).toEqual({ newDay: false, header: true })
    expect(placeOf(first, message({ id: 'm4', author: { kind: 'agent', agentId: 'agt_1' }, createdAt: '2026-11-14T09:01:00.000Z' })).header).toBe(true)
    expect(placeOf(first, message({ id: 'm5', createdAt: '2026-11-15T09:01:00.000Z' })).newDay).toBe(true)
  })

  it('heads an agent\'s message with its name and the « Agent » chip, and reads its Markdown', () => {
    render((
      <WebMessage
        message={message({ author: { kind: 'agent', agentId: 'agt_1' }, text: '**prêt**' })}
        header
        agents={agents}
        cards={[]}
        canDecide
        onDecide={vi.fn()}
        t={chatFrench}
      />
    ))
    const row = screen.getByTestId('chat-message')
    expect(row.querySelector('.mw-message-name')?.textContent).toBe('Assistant')
    expect(row.querySelector('.mw-chip')?.textContent).toBe('Agent')
    expect(screen.getByTestId('chat-markdown').querySelector('strong')?.textContent).toBe('prêt')
  })

  it('says a finished turn with its duration, tokens, cost and model', () => {
    const turned = message({ turns: [{ id: 't', agentId: 'agt_1', status: 'done', tokens: { input: 4421, output: 540 }, eur: 0.0041, startedAt: '2026-11-14T09:00:00.000Z', finishedAt: '2026-11-14T09:00:03.200Z' }] })
    render(<WebMessage message={turned} header agents={agents} cards={[]} canDecide onDecide={vi.fn()} t={chatFrench} />)
    expect(screen.getByTestId('chat-turn').textContent?.startsWith('Tour d\'agent')).toBe(true)
    expect(screen.getByTestId('chat-turn-cost').textContent).toMatch(/^@assistant · 3,2 s · 4\s961 jetons · 0,0041\s€ · deepseek-v4\.1-flash$/u)
  })

  it('says a turn under way, and one that did not complete with its cause', () => {
    const running = message({ turns: [{ id: 't', agentId: 'agt_1', status: 'running' }] })
    const { rerender } = render((
      <WebMessage
        message={running}
        header
        agents={agents}
        cards={[]}
        canDecide
        onDecide={vi.fn()}
        t={chatFrench}
      />
    ))
    expect(screen.getByRole('status').textContent).toBe('L\'agent répond…')
    rerender((
      <WebMessage
        message={message({ turns: [{ id: 't', agentId: 'agt_1', status: 'failed', reason: 'quota' }] })}
        header
        agents={agents}
        cards={[]}
        canDecide
        onDecide={vi.fn()}
        t={chatFrench}
      />
    ))
    expect(screen.getByTestId('chat-turn').textContent).toBe('Le tour de l\'agent n\'a pas abouti : quota')
  })

  it('leads from a waiting card to À traiter', () => {
    const onPending = vi.fn()
    render((
      <WebMessage
        message={message()}
        header
        agents={agents}
        cards={[card()]}
        canDecide
        onDecide={vi.fn()}
        onPending={onPending}
        t={chatFrench}
      />
    ))
    fireEvent.click(screen.getByRole('button', { name: '1 carte attend dans À traiter' }))
    expect(onPending).toHaveBeenCalledOnce()
  })

  it('a message removed says so, without its text', () => {
    render((
      <WebMessage
        message={message({ text: '', deletedAt: '2026-11-14T09:02:00.000Z' })}
        header
        agents={agents}
        cards={[]}
        canDecide
        onDecide={vi.fn()}
        t={chatFrench}
      />
    ))
    expect(screen.getByText('Ce message a été retiré.')).toBeTruthy()
  })
})

describe('a card in the feed', () => {
  it('waits for a decision: « Valider » approves it', async () => {
    const onDecide = vi.fn(async () => undefined)
    render(<WebCard card={card()} canDecide onDecide={onDecide} t={chatFrench} />)
    expect(screen.getByText('En attente de décision')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }))
    await waitFor(() => { expect(onDecide).toHaveBeenCalledWith('apr_1', 'approved', undefined) })
  })

  it('a refusal needs its reason, as the core does: asked first, then sent with it', async () => {
    const onDecide = vi.fn(async () => undefined)
    render(<WebCard card={card()} canDecide onDecide={onDecide} t={chatFrench} />)
    fireEvent.click(screen.getByRole('button', { name: 'Refuser' }))
    expect(screen.getByRole('alert').textContent).toBe('Indiquez un motif de refus.')
    expect(onDecide).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Commentaire (obligatoire pour refuser)'), { target: { value: ' pas avant la revue ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Refuser' }))
    await waitFor(() => { expect(onDecide).toHaveBeenCalledWith('apr_1', 'rejected', 'pas avant la revue') })
  })

  it('shows the core\'s refusal when the decision is refused', async () => {
    render(<WebCard card={card()} canDecide onDecide={async () => 'déjà décidée'} t={chatFrench} />)
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }))
    expect((await screen.findByRole('alert')).textContent).toBe('déjà décidée')
  })

  it('decided, says who and when, and the reason of a refusal; no button any more', () => {
    const names = { [you]: 'Stéphane Masson' }
    const { rerender } = render((
      <WebCard
        card={card({ state: 'approved', decidedBy: you, decidedAt: '2026-11-14T09:05:00.000Z' })}
        canDecide
        onDecide={vi.fn()}
        names={names}
        t={chatFrench}
      />
    ))
    expect(screen.getByTestId('chat-card-decision').textContent).toMatch(/^Validée par Stéphane Masson · /u)
    expect(screen.queryByRole('button')).toBeNull()
    rerender((
      <WebCard
        card={card({ state: 'rejected', decidedBy: you, decidedAt: '2026-11-14T09:05:00.000Z', reason: 'pas avant la revue' })}
        canDecide
        onDecide={vi.fn()}
        names={names}
        t={chatFrench}
      />
    ))
    expect(screen.getByTestId('chat-card-decision').textContent).toContain('Rejetée par Stéphane Masson')
    expect(screen.getByTestId('chat-card-decision').textContent).toContain('pas avant la revue')
  })

  it('a card a turn asked for says the agent, for the person accountable', () => {
    const asked = card({ requestedBy: 'duke@datanalysis.re', requestedByAgent: { id: 'agt_3', handle: 'qwen' } })
    render(<WebCard card={asked} canDecide={false} onDecide={vi.fn()} names={{ 'duke@datanalysis.re': 'Duke' }} t={chatFrench} />)
    expect(screen.getByText(/^Demandée par @qwen, pour Duke · /u)).toBeTruthy()
  })

  it('someone who may not decide is told so', () => {
    render(<WebCard card={card()} canDecide={false} onDecide={vi.fn()} t={chatFrench} />)
    expect(screen.getByText('Vous ne pouvez pas décider de cette approbation.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('the feed, after review', () => {
  it('a joined row, without its header, can still be deleted by its author', () => {
    const onRemove = vi.fn(async () => undefined)
    render(
      <WebMessage
        message={message()}
        header={false}
        agents={agents}
        cards={[]}
        canDecide
        onDecide={vi.fn()}
        onRemove={onRemove}
        t={chatFrench}
      />,
    )
    expect(screen.getByTestId('chat-message').querySelector('.mw-message-head')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la suppression' }))
    expect(onRemove).toHaveBeenCalledOnce()
  })

  it('names who asked a card as it names who decided it', () => {
    render(<WebCard card={card({ requestedBy: 'smarion@datanalysis.re' })} canDecide={false} onDecide={vi.fn()} names={{ 'smarion@datanalysis.re': 'Sophie Marion' }} t={chatFrench} />)
    expect(screen.getByText(/^Demandée par Sophie Marion · /u)).toBeTruthy()
  })

  it('never reads a name from the prototype of the names', () => {
    expect(shownName('constructor@datanalysis.re', {})).toBe('constructor')
    // A plain object holds « constructor » on its prototype: it must not come out as a name.
    expect(shownName('constructor', {})).toBe('constructor')
  })
})
