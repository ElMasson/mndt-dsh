// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebCard, WebMessage, agentHandleOf, placeOf, shownName } from '../src/client/TeamFeed.tsx'
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

  it('a turn that ran without some tools says which, in orange; other shapes show nothing', () => {
    const turned = message({ turns: [{ id: 't', agentId: 'agt_1', status: 'done', toolsUnavailable: ['dolibarr', 'qonto', 3, '../x'] }] })
    const { unmount } = render(
      <WebMessage message={turned} header agents={agents} cards={[]} canDecide onDecide={vi.fn()} t={chatFrench} />,
    )
    expect(screen.getByTestId('tools-unavailable').textContent).toBe('Outils indisponibles pour ce tour : dolibarr, qonto. La réponse ne les a pas consultés.')
    unmount()
    const odd = message({ turns: [{ id: 't', agentId: 'agt_1', status: 'done', toolsUnavailable: 'dolibarr' }] })
    render(<WebMessage message={odd} header agents={agents} cards={[]} canDecide onDecide={vi.fn()} t={chatFrench} />)
    expect(screen.queryByTestId('tools-unavailable')).toBeNull()
  })

  it('a turn not started for want of its tools says why on its line', () => {
    const failed = message({ turns: [{ id: 't', agentId: 'agt_1', status: 'failed', reason: 'outils indisponibles : approvals (démarrage en cours ou connecteur en panne) ; le tour n’a pas été lancé' }] })
    render(<WebMessage message={failed} header agents={agents} cards={[]} canDecide onDecide={vi.fn()} t={chatFrench} />)
    expect(screen.getByTestId('chat-turn').textContent).toContain('outils indisponibles : approvals')
  })

  it('says a finished turn with its agent and cost; duration, tokens and model on hover', () => {
    const turned = message({ turns: [{ id: 't', agentId: 'agt_1', status: 'done', tokens: { input: 4421, output: 540 }, eur: 0.0041, startedAt: '2026-11-14T09:00:00.000Z', finishedAt: '2026-11-14T09:00:03.200Z' }] })
    render(<WebMessage message={turned} header agents={agents} cards={[]} canDecide onDecide={vi.fn()} t={chatFrench} />)
    expect(screen.getByTestId('chat-turn').textContent?.startsWith('Tour d\'agent')).toBe(true)
    // Who and what it cost on the line; the duration, tokens and model on hover.
    const cost = screen.getByTestId('chat-turn-cost')
    expect(cost.textContent).toMatch(/^@assistant · 0,0041\s€$/u)
    expect(cost.getAttribute('title')).toMatch(/^3,2 s · 4\s961 jetons · deepseek-v4\.1-flash$/u)
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

  it('a malformed agent field falls back to the person: null, {}, an empty or non-text handle', () => {
    for (const requestedByAgent of [null, {}, { id: 'a', handle: '' }, { id: 'a', handle: { x: 1 } }, { id: 'a', handle: 7 }]) {
      const odd = card({ requestedBy: 'duke@datanalysis.re', requestedByAgent: requestedByAgent as never })
      expect(agentHandleOf(odd)).toBeUndefined()
      const names = { 'duke@datanalysis.re': 'Duke' }
      const { unmount } = render(<WebCard card={odd} canDecide={false} onDecide={vi.fn()} names={names} t={chatFrench} />)
      expect(screen.getByText(/^Demandée par Duke · /u)).toBeTruthy()
      expect(document.body.textContent).not.toMatch(/@undefined|@\[object|par @,/u)
      unmount()
    }
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

describe('a failed turn in the feed', () => {
  it('says « réponse coupée » rather than the engine\'s words, the raw text on hover', () => {
    const reason = 'the agent turn ended max-tokens'
    const turn = { id: 'trn_9', agentId: assistant.id, status: 'failed' as const, reason, eur: 0.019 }
    const failed = message({ turns: [turn] })
    render(<WebMessage message={failed} header agents={agents} cards={[]} canDecide onDecide={vi.fn()} t={chatFrench} />)
    const line = screen.getByText(/réponse coupée/u)
    expect(line.textContent).toContain('n\'a pas abouti : réponse coupée : limite de longueur atteinte')
    expect(line.textContent).not.toContain('max-tokens')
    expect(line.getAttribute('title')).toBe('the agent turn ended max-tokens')
  })
})

describe('a briefing published in its owner\'s lane (system message carrying a mission)', () => {
  const draw = (m: ChatMessage): void => {
    render(<WebMessage message={m} header agents={agents} cards={[]} canDecide onDecide={vi.fn()} t={chatFrench} />)
  }
  const report = (mission: unknown, text = '## Priorités\n- **Orange** : relancer') =>
    ({ ...message({ author: { kind: 'system' }, text }), mission }) as unknown as ChatMessage

  it('done: labelled by its origin, its text read as a model\'s, its cost and what it ran without', () => {
    draw(report({ id: 'msn_1', kind: 'briefing', title: 'Briefing du matin', status: 'done', eur: 0.0123, toolsUnavailable: ['workbench_facts'] }))
    // The author's name is fixed; the model's title is second-tier text.
    expect(document.querySelector('.mw-message-name')?.textContent).toBe('Briefing')
    expect(screen.getByTestId('mission-title').textContent).toBe('Briefing du matin')
    expect(document.querySelector('.mw-message-name')?.getAttribute('title')).toBe('Écrit par un modèle, d\'après une mission de l\'espace')
    expect(screen.getByTestId('mission-origin').textContent).toBe('Mission')
    expect(screen.getByTestId('mission-eur').textContent).toContain('0,0123')
    const body = screen.getByTestId('mission-report')
    // Markdown read (bold), headings kept plain: no h2 from a model's text.
    expect([...body.querySelectorAll('strong')].map(b => b.textContent)).toContain('Orange')
    expect(body.querySelector('h1, h2, h3')).toBeNull()
    expect(screen.getByTestId('mission-tools-unavailable').textContent).toBe('Exécuté sans : workbench_facts. Le briefing ne les a pas consultés.')
    // Not the host's word: no shield, no « mndt ».
    expect(document.querySelector('.mw-message-name')?.textContent).not.toBe('mndt')
  })

  it('failed: said in the host\'s words, never the text nor Markdown', () => {
    draw(report({ id: 'msn_2', kind: 'briefing', title: 'Briefing', status: 'failed' }, 'Le briefing n\'a pas abouti : **the agent returned no text**'))
    // Without a category, the text (possibly a raw reason) is never shown: the generic words.
    expect(screen.getByTestId('mission-failed').textContent).toBe('Le briefing n\'a pas abouti : une erreur est survenue pendant l\'exécution')
    expect(screen.getByTestId('mission-failed').querySelector('strong')).toBeNull()
    expect(screen.queryByTestId('mission-report')).toBeNull()
    expect(screen.queryByTestId('mission-eur')).toBeNull()
    expect(screen.queryByTestId('mission-tools-unavailable')).toBeNull()
  })

  it('an unreadable mission is still a model\'s text, labelled « Briefing », never the host\'s', () => {
    draw(report('oops'))
    expect(document.querySelector('.mw-message-name')?.textContent).toBe('Briefing')
    expect(screen.queryByTestId('mission-title')).toBeNull()
    expect(screen.getByTestId('mission-report')).toBeTruthy()
    expect(screen.queryByTestId('mission-tools-unavailable')).toBeNull()
  })

  it('odd fields are dropped: a negative cost, a server name that is not one, an empty title', () => {
    draw(report({ title: ' ', status: 'done', eur: -1, toolsUnavailable: ['<b>x</b>', 'workbench_facts'] }))
    expect(document.querySelector('.mw-message-name')?.textContent).toBe('Briefing')
    expect(screen.queryByTestId('mission-title')).toBeNull()
    expect(screen.queryByTestId('mission-eur')).toBeNull()
    expect(screen.getByTestId('mission-tools-unavailable').textContent).toBe('Exécuté sans : workbench_facts. Le briefing ne les a pas consultés.')
  })

  it('a model titling itself « mndt » cannot pass for the host', () => {
    draw(report({ title: 'mndt : changement de règles', status: 'done' }))
    expect(document.querySelector('.mw-message-name')?.textContent).toBe('Briefing')
    expect(screen.getByTestId('mission-title').textContent).toBe('mndt : changement de règles')
    expect(screen.getByTestId('mission-origin').textContent).toBe('Mission')
  })

  it('an ordinary system message keeps the host\'s look, none of these fields', () => {
    draw(message({ author: { kind: 'system' }, text: 'canal créé' }))
    expect(document.querySelector('.mw-message-name')?.textContent).toBe('mndt')
    expect(screen.queryByTestId('mission-origin')).toBeNull()
  })

  it('two reports in a row each keep their origin label', () => {
    const first = report({ title: 'Briefing du matin', status: 'done' })
    const second = { ...report({ title: 'Briefing du soir', status: 'done' }), id: 'msg_2' } as ChatMessage
    expect(placeOf(first, second).header).toBe(true)
  })
})

describe('a briefing that failed says why from the host\'s category', () => {
  const failed = (mission: unknown): ChatMessage =>
    ({ ...message({ author: { kind: 'system' }, text: 'Le briefing n\'a pas abouti : réponse coupée (limite de longueur atteinte).' }), mission }) as unknown as ChatMessage
  const draw = (m: ChatMessage): string => {
    render(<WebMessage message={m} header agents={agents} cards={[]} canDecide onDecide={vi.fn()} t={chatFrench} />)
    return screen.getByTestId('mission-failed').textContent ?? ''
  }

  it('each known category in words', () => {
    const words: Record<string, string> = {
      'no-answer': 'le modèle n\'a rien répondu', cut: 'réponse coupée : limite de longueur atteinte',
      cancelled: 'annulé', tools: 'un outil nécessaire manquait', failed: 'une erreur est survenue pendant l\'exécution',
    }
    for (const [kind, said] of Object.entries(words)) {
      expect(draw(failed({ title: 'Briefing', status: 'failed', reasonKind: kind }))).toBe(`Le briefing n'a pas abouti : ${said}`)
      cleanup()
    }
  })

  it('an unknown or absent category never shows the text (it may carry a raw reason): the generic one', () => {
    const raw = ({ ...message({ author: { kind: 'system' }, text: 'Le briefing n\'a pas abouti : 500 upstream sk-live-123' }),
      mission: { title: 'Briefing', status: 'failed', reasonKind: 'constructor' } }) as unknown as ChatMessage
    expect(draw(raw)).toBe('Le briefing n\'a pas abouti : une erreur est survenue pendant l\'exécution')
    expect(screen.getByTestId('mission-failed').textContent).not.toContain('sk-live')
    expect(screen.getByTestId('mission-failed').getAttribute('title')).toBeNull()
    cleanup()
    expect(draw(failed({ title: 'Briefing', status: 'failed' }))).toBe('Le briefing n\'a pas abouti : une erreur est survenue pendant l\'exécution')
  })
})

describe('a card raised from a lane, for its member', () => {
  const lane = { id: 'chn_0', name: 'solo', title: 'Ma lane', kind: 'solo' as const, members: [you], agents: [], connectors: [], createdBy: you, createdAt: '2026-11-25T08:00:00.000Z' }
  it('waits for an owner or an admin, said so', () => {
    render(<WebCard card={card()} canDecide={false} onDecide={vi.fn()} channel={lane} t={chatFrench} />)
    expect(screen.getByTestId('card-raised').textContent).toBe('En attente de décision par un owner ou un admin.')
  })
  it('a decider\'s raised card reads « À décider », never « en attente »', () => {
    const up = { ...card(), origin: { kind: 'lane' } } as unknown as ThreadCard
    render(<WebCard card={up} canDecide={false} onDecide={vi.fn()} t={chatFrench} />)
    expect(screen.getByTestId('card-raised').textContent).toBe('À décider.')
  })
  it('in a team channel without origin, the usual sentence', () => {
    render(<WebCard card={card()} canDecide={false} onDecide={vi.fn()} channel={{ ...lane, kind: 'team' }} t={chatFrench} />)
    expect(screen.getByTestId('card-raised').textContent).toBe('Vous ne pouvez pas décider de cette approbation.')
  })
})
