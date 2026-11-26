// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatAgent, ChatTurn } from '../src/client/chat.ts'
import { chatFrench } from '../src/client/chatLocales.ts'
import { HelpThread, helpOf } from '../src/client/help.tsx'
import type { TurnHelp } from '../src/client/help.tsx'
import { WebCard } from '../src/client/TeamFeed.tsx'

afterEach(() => { cleanup() })

const you = 'stephane@datanalysis.re'
const at = '2026-11-23T08:00:00.000Z'
/** @returns an agent. */
function agent(id: string, handle: string): ChatAgent {
  return { id, handle, name: handle, provider: 'p', model: 'm', connectors: [], eurPerMonth: 5, createdBy: you, createdAt: at }
}
const agents = new Map([['agt_2', agent('agt_2', 'analyste')], ['agt_3', agent('agt_3', 'qwen')]])
const request = { task: 'Relancer Sodiac', tried: 'Lu la facture FA2610-031', blocker: 'Le montant diffère du relevé', options: ['Garder 1 640 €', 'Prendre 1 460 €'], need: 'fact' }
/** @param help - the turn's help. @returns a finished turn carrying it. */
function turn(help: unknown): ChatTurn {
  return { id: 'trn_1', agentId: 'agt_1', status: 'done', help }
}
const advices = [
  { slot: 'A', round: 1, text: 'Le relevé est à jour : 1 640 €.', eur: 0.001, agentId: 'agt_2', model: 'glm-5.3' },
  { slot: 'B', round: 1, text: '<img src=x onerror=alert(1)> **1 640 €**', eur: 0.002, agentId: 'agt_3', model: 'qwen' },
]
/** @param help - a turn's help as served. @returns it read. */
const read = (help: unknown): TurnHelp => {
  const h = helpOf(turn(help))
  if (h === undefined) throw new Error('unreadable help')
  return h
}

describe('a turn\'s help, read (ask_peers)', () => {
  it('reads a well-formed help; anything else shows nothing', () => {
    expect(read({ state: 'advising', request, advices }).advices).toHaveLength(2)
    for (const odd of [undefined, null, 'x', {}, { state: 'nope', request }, { state: 'asked', request: { ...request, need: 'magic' } },
      { state: 'asked', request: { ...request, blocker: '' } }, { state: 'asked', request: { ...request, options: ['a', 3] } }]) {
      expect(helpOf(turn(odd))).toBeUndefined()
    }
  })

  it('no author is read before the asking agent has read the advices, even if served', () => {
    const before = read({ state: 'advising', request, advices })
    expect(before.advices.every(a => a.agentId === undefined && a.model === undefined)).toBe(true)
    const after = read({ state: 'done', request, advices, reading: { verdict: 'unblocked', retained: '1 640 €', why: 'deux avis concordent' } })
    expect(after.advices.map(a => a.agentId)).toEqual(['agt_2', 'agt_3'])
  })
})

describe('the help under a turn', () => {
  it('while it runs: unfolded, « en attente d\'avis », advices A and B without author', () => {
    render(<HelpThread help={read({ state: 'advising', request, advices, eur: 0.003, capEur: 0.05 })} agents={agents} t={chatFrench} />)
    expect(screen.getByTestId('help-state').textContent).toBe('en attente d\'avis')
    expect(screen.getByTestId('turn-help').textContent).toContain('A demandé l\'aide de 2 pairs')
    const steps = screen.getByTestId('help-steps')
    expect(steps instanceof HTMLDetailsElement && steps.open).toBe(true)
    expect(screen.getByTestId('help-request').textContent).toContain('Le montant diffère du relevé')
    expect(screen.getByTestId('help-request').textContent).toContain('un fait')
    const shown = screen.getAllByTestId('help-advice').map(a => a.textContent ?? '')
    expect(shown[0]?.startsWith('Avis A')).toBe(true)
    expect(shown.join(' ')).not.toMatch(/@analyste|@qwen|glm/u)
  })

  it('once read: folded, the outcome always visible, authors and models revealed, what was kept and why', () => {
    render(<HelpThread help={read({ state: 'done', request, advices, reading: { verdict: 'unblocked', retained: '1 640 €', why: 'deux avis concordent' } })} agents={agents} t={chatFrench} />)
    expect(screen.getByTestId('help-state').textContent).toBe('débloqué')
    const steps = screen.getByTestId('help-steps')
    expect(steps instanceof HTMLDetailsElement && steps.open).toBe(false)
    expect(screen.getAllByTestId('help-advice')[0]?.textContent).toContain('@analyste (glm-5.3)')
    expect(screen.getByTestId('help-reading').textContent).toContain('deux avis concordent')
  })

  it('an advice is text: no element from it', () => {
    render(<HelpThread help={read({ state: 'advising', request, advices })} agents={agents} t={chatFrench} />)
    const b = screen.getAllByTestId('help-advice')[1]
    expect(b?.querySelector('img')).toBeNull()
    expect(b?.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('a question for you: one field, « Répondre et clore ce fil » replies to the published question', async () => {
    const onAnswer = vi.fn(async () => undefined)
    const help = read({ state: 'done', request, advices, reading: { verdict: 'escalate', retained: '', why: 'avis divergents' },
      escalation: { question: 'Quel montant retenir ?', summary: 'A dit 1 640 €, B dit 1 460 €.', messageId: 'msg_9' } })
    render(<HelpThread help={help} agents={agents} onAnswer={onAnswer} canAnswer t={chatFrench} />)
    expect(screen.getByTestId('help-state').textContent).toBe('une question pour vous')
    const question = screen.getByTestId('help-question')
    expect(question.textContent).toContain('Question pour vous : Quel montant retenir ?')
    fireEvent.change(within(question).getByRole('textbox', { name: 'Votre réponse' }), { target: { value: '1 640 €' } })
    fireEvent.click(within(question).getByRole('button', { name: 'Répondre et clore ce fil' }))
    await waitFor(() => { expect(onAnswer).toHaveBeenCalledWith('1 640 €', 'msg_9') })
  })

  it('answered, or closed by a person: said; no field any more', () => {
    const answered = read({ state: 'done', request, advices, reading: { verdict: 'escalate' }, escalation: { question: 'Q ?', answeredAt: at, messageId: 'msg_9' } })
    const { unmount } = render(<HelpThread help={answered} agents={agents} onAnswer={vi.fn()} canAnswer t={chatFrench} />)
    expect(screen.getByTestId('help-state').textContent).toBe('répondu par une personne')
    expect(screen.queryByTestId('help-question')).toBeNull()
    unmount()
    render(<HelpThread help={read({ state: 'done', request, advices: [], closedBy: { by: you, at } })} agents={agents} names={{ [you]: 'Stéphane Masson' }} t={chatFrench} />)
    expect(screen.getByTestId('help-state').textContent).toBe('close par Stéphane Masson')
    expect(screen.getByTestId('help-closed')).toBeTruthy()
  })

  it('a peer that did not answer is said, with its reason, its author hidden before reading', () => {
    render(<HelpThread help={read({ state: 'advising', request, advices: [advices[0]], skipped: [{ slot: 'B', agentId: 'agt_3', reason: 'plafond mensuel atteint' }] })} agents={agents} t={chatFrench} />)
    const missing = screen.getByTestId('help-skipped')
    expect(missing.textContent).toContain('Avis B manquant')
    expect(missing.textContent).toContain('plafond mensuel atteint')
    expect(missing.textContent).not.toContain('@qwen')
  })
})

describe('a card born of a mutual help', () => {
  it('says « d\'une entraide »', () => {
    const card = { id: 'apr_h', kind: 'send-email', title: 'Relancer Sodiac', requestedBy: you, requestedAt: at, state: 'pending' as const, canDecide: true }
    render(<WebCard card={card} canDecide onDecide={vi.fn()} fromHelp t={chatFrench} />)
    expect(screen.getByTestId('card-from-help').textContent).toBe('d\'une entraide')
  })
})

describe('who answers, and when (#113)', () => {
  it('a viewer, whose answer would not count, is offered no field', () => {
    const help = read({ state: 'done', request, advices, reading: { verdict: 'escalate' }, escalation: { question: 'Q ?', messageId: 'msg_9' } })
    render(<HelpThread help={help} agents={agents} onAnswer={vi.fn()} canAnswer={false} t={chatFrench} />)
    expect(screen.getByTestId('help-question').textContent).toContain('Q ?')
    expect(screen.queryByRole('button', { name: 'Répondre et clore ce fil' })).toBeNull()
  })

  it('while the help runs, a member closes it by answering the turn\'s own message', async () => {
    const onAnswer = vi.fn(async () => undefined)
    render(<HelpThread help={read({ state: 'advising', request, advices })} agents={agents} onAnswer={onAnswer} originMessageId="msg_1" canAnswer t={chatFrench} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Votre réponse' }), { target: { value: 'Prenez 1 640 €.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Répondre et clore ce fil' }))
    await waitFor(() => { expect(onAnswer).toHaveBeenCalledWith('Prenez 1 640 €.', 'msg_1') })
  })

  it('before reading, no cost per advice is read, even if served; the total is', () => {
    const h = read({ state: 'advising', request, advices, eur: 0.003 })
    expect(h.advices.every(a => a.eur === undefined && a.tokens === undefined)).toBe(true)
    expect(h.eur).toBe(0.003)
  })
})

describe('closed by a person during the reading (#113, dd6922e2c9)', () => {
  it('a reading may be there, nothing is published: the screen says who closed it, no field', () => {
    const help = read({ state: 'done', request, advices, reading: { verdict: 'unblocked', retained: 'x', why: 'y' }, closedBy: { by: you, at } })
    render(<HelpThread help={help} agents={agents} onAnswer={vi.fn()} originMessageId="msg_1" canAnswer names={{}} t={chatFrench} />)
    expect(screen.getByTestId('help-state').textContent).toBe('close par stephane')
    expect(screen.queryByRole('button', { name: 'Répondre et clore ce fil' })).toBeNull()
  })

  it('a category reason before reading is shown as served', () => {
    render(<HelpThread help={read({ state: 'advising', request, advices: [advices[0]], skipped: [{ slot: 'B', reason: 'avis non obtenu : plafond' }] })} agents={agents} t={chatFrench} />)
    expect(screen.getByTestId('help-skipped').textContent).toContain('avis non obtenu : plafond')
  })
})

describe('a help ended without a reading (#116)', () => {
  it('says « close sans lecture » with the core\'s reason, and offers no field', () => {
    const help = read({ state: 'done', request, advices: [], skipped: [{ reason: 'redémarrage' }] })
    render(<HelpThread help={help} agents={agents} onAnswer={vi.fn()} originMessageId="msg_1" canAnswer t={chatFrench} />)
    expect(screen.getByTestId('help-state').textContent).toBe('close sans lecture : redémarrage')
    expect(screen.queryByRole('button', { name: 'Répondre et clore ce fil' })).toBeNull()
    const steps = screen.getByTestId('help-steps')
    expect(steps instanceof HTMLDetailsElement && steps.open).toBe(false)
  })

  it('without a reason: « close sans lecture »', () => {
    render(<HelpThread help={read({ state: 'done', request, advices })} agents={agents} t={chatFrench} />)
    expect(screen.getByTestId('help-state').textContent).toBe('close sans lecture')
  })
})

describe('a question waiting is never hidden by « close sans lecture »', () => {
  it('done without a reading but with an unanswered escalation: « une question pour vous » and its field', () => {
    const help = read({ state: 'done', request, advices: [], skipped: [{ reason: 'redémarrage' }], escalation: { question: 'Que faire ?', messageId: 'msg_9' } })
    render(<HelpThread help={help} agents={agents} onAnswer={vi.fn()} originMessageId="msg_1" canAnswer t={chatFrench} />)
    expect(screen.getByTestId('help-state').textContent).toBe('une question pour vous')
    expect(screen.getByRole('button', { name: 'Répondre et clore ce fil' })).toBeTruthy()
  })
})

describe('a help\'s authors only once read and no question waits (#119)', () => {
  it('read but asking a person: the advices stay unnamed; answered, named', () => {
    const waiting = read({ state: 'done', request, advices, reading: { verdict: 'escalate' }, escalation: { question: 'Q ?', messageId: 'msg_9' } })
    expect(waiting.advices.every(a => a.agentId === undefined && a.eur === undefined)).toBe(true)
    const answered = read({ state: 'done', request, advices, reading: { verdict: 'escalate' }, escalation: { question: 'Q ?', messageId: 'msg_9', answeredAt: at } })
    expect(answered.advices[0]?.agentId).toBe('agt_2')
  })
})

describe('a question shown once, under the message that publishes it', () => {
  it('the turn says « une question pour vous » without its box when the question is shown below', () => {
    const help = read({ state: 'done', request, advices, reading: { verdict: 'escalate' }, escalation: { question: 'HT ?', messageId: 'msg_9' } })
    render(<HelpThread help={help} agents={agents} onAnswer={vi.fn()} canAnswer questionBelow t={chatFrench} />)
    expect(screen.getByTestId('help-state').textContent).toBe('une question pour vous')
    expect(screen.queryByTestId('help-question')).toBeNull()
  })

  it('the publishing message carries the box; its answer replies to that message', async () => {
    const { WebMessage } = await import('../src/client/TeamFeed.tsx')
    const onAnswer = vi.fn(async () => undefined)
    const published = { id: 'msg_9', channelId: 'chn_1', author: { kind: 'agent' as const, agentId: 'agt_2' }, text: 'Je retiens A. Question à l\'équipe : HT ?', mentions: [], createdAt: at, updatedAt: at }
    const asks = { channelId: 'chn_1', turnId: 'trn_1', messageId: 'msg_1', questionMessageId: 'msg_9', question: 'HT ?', kind: 'help' as const }
    render(
      <WebMessage
        message={published}
        header
        agents={agents}
        cards={[]}
        canDecide
        onDecide={vi.fn()}
        onAnswer={onAnswer}
        canAnswer
        asks={asks}
        t={chatFrench}
      />,
    )
    const box = screen.getByTestId('pending-question')
    expect(box.textContent).toContain('Question pour vous : HT ?')
    expect(screen.queryByTestId('pending-question-where')).toBeNull()
    fireEvent.change(within(box).getByRole('textbox', { name: 'Votre réponse' }), { target: { value: 'Oui.' } })
    fireEvent.click(within(box).getByRole('button', { name: 'Répondre et clore ce fil' }))
    await waitFor(() => { expect(onAnswer).toHaveBeenCalledWith('Oui.', 'msg_9') })
  })
})

describe('a question never becomes invisible', { timeout: 20_000 }, () => {
  it('when its published message is not in the thread, it stays under its turn', async () => {
    const { ChannelThread } = await import('../src/client/ChannelView.tsx')
    const { createMockChat } = await import('../src/client/mockChat.ts')
    const help = { state: 'done', request, advices, reading: { verdict: 'escalate' }, escalation: { question: 'HT ?', messageId: 'msg_absent' } }
    const asking = { id: 'msg_1', channelId: 'chn_1', author: { kind: 'human' as const, email: 'stephane@datanalysis.re' }, text: '@qwen ?', mentions: ['agt_2'], createdAt: at, updatedAt: at,
      turns: [{ id: 'trn_1', agentId: 'agt_2', status: 'done' as const, help }] }
    const channel = { id: 'chn_1', name: 'x', title: 'x', kind: 'team' as const, members: ['stephane@datanalysis.re'], agents: ['agt_2'], connectors: [], createdBy: 'stephane@datanalysis.re', createdAt: at }
    const chat = createMockChat({ you: 'stephane@datanalysis.re', agents: [...agents.values()], channels: [channel], messages: [asking] }, () => Date.parse(at))
    render(<ChannelThread chat={chat} channel={channel} agents={[...agents.values()]} cards={[]} canDecide onDecide={vi.fn()} t={chatFrench} look="mndt-web" canAnswer />)
    expect((await screen.findByTestId('help-question')).textContent).toContain('HT ?')
  })
})

describe('a help with no advice that asks the team (Stéphane\'s try, seventh jump)', () => {
  const failedHelp = (skipped: unknown[], summary = 'Blocage : Le montant diffère du relevé. Avis reçus : 0. Sans avis : avis non obtenu : erreur.') => read({
    state: 'done', request, advices: [], skipped,
    escalation: { question: 'Le montant diffère du relevé', summary, at, messageId: 'msg_q' },
  })
  it('one line for the question, no summary restating it; who could not answer, named', () => {
    render(<HelpThread help={failedHelp([{ slot: 'A', agentId: 'agt_3', reason: 'Erreur pendant l’exécution.', reasonKind: 'failed' }])} agents={agents} t={chatFrench} />)
    const box = screen.getByTestId('help-question')
    expect(box.textContent?.match(/Le montant diffère du relevé/gu)).toHaveLength(1)
    expect(box.textContent).not.toContain('Avis reçus')
    expect(box.textContent).not.toContain('avis non obtenu')
    expect(within(box).getByTestId('help-could-not-answer').textContent).toBe('@qwen n\'a pas pu répondre (le modèle a renvoyé une erreur).')
  })
  it('without a served category, the plain sentence; the raw reason never shows', () => {
    render(<HelpThread help={failedHelp([{ slot: 'A', agentId: 'agt_3', reason: 'upstream sk-live-1' }])} agents={agents} t={chatFrench} />)
    expect(screen.getByTestId('help-could-not-answer').textContent).toBe('@qwen n\'a pas pu répondre.')
    expect(screen.getByTestId('help-question').textContent).not.toContain('sk-live')
  })
  it('with advices, the summary shows as before and the peers stay anonymous', () => {
    const h = read({ state: 'done', request, advices, skipped: [], escalation: { question: 'Quel montant ?', summary: 'Désaccord restant : le relevé.', at, messageId: 'msg_q' } })
    render(<HelpThread help={h} agents={agents} t={chatFrench} />)
    expect(screen.getByTestId('help-question').textContent).toContain('Désaccord restant')
    expect(screen.queryByTestId('help-could-not-answer')).toBeNull()
    expect(h.advices.every(a => a.agentId === undefined)).toBe(true)
  })
})

describe('an agent\'s answer whose turn then failed', () => {
  it('is greyed, and what it announces is said void', async () => {
    const { WebMessage } = await import('../src/client/TeamFeed.tsx')
    const answer = { id: 'msg_a', channelId: 'chn_1', author: { kind: 'agent' as const, agentId: 'agt_2' }, text: 'Ma demande d\'avis est envoyée à Qwen… je serai relancé avec sa réponse.', mentions: [], replyTo: 'msg_h', createdAt: at, updatedAt: at }
    render(<WebMessage message={answer} staleAfterFailure header agents={agents} cards={[]} canDecide onDecide={vi.fn()} t={chatFrench} />)
    expect(screen.getByTestId('chat-markdown').getAttribute('data-stale')).toBe('true')
    expect(screen.getByTestId('stale-after-failure').textContent).toBe('Le tour a échoué après ce message : ce qu\'il annonce n\'aura pas lieu.')
  })
  it('the thread marks it from the failed turn of the message it answers, and only then', async () => {
    const { ChannelThread } = await import('../src/client/ChannelView.tsx')
    const { createMockChat } = await import('../src/client/mockChat.ts')
    const channel = { id: 'chn_1', name: 'x', title: 'x', kind: 'team' as const, members: [you], agents: ['agt_2'], connectors: [], createdBy: you, createdAt: at }
    const asking = { id: 'msg_h', channelId: 'chn_1', author: { kind: 'human' as const, email: you }, text: '@analyste ?', mentions: ['agt_2'], createdAt: at, updatedAt: at,
      turns: [{ id: 'trn_1', agentId: 'agt_2', status: 'failed' as const, reasonKind: 'failed', reason: 'Erreur pendant l’exécution.' }] }
    const answer = { id: 'msg_a', channelId: 'chn_1', author: { kind: 'agent' as const, agentId: 'agt_2' }, text: 'je serai relancé', mentions: [], replyTo: 'msg_h', createdAt: at, updatedAt: at }
    const other = { ...answer, id: 'msg_b', author: { kind: 'agent' as const, agentId: 'agt_3' }, text: 'autre agent' }
    const seed = { you, agents: [...agents.values()], channels: [channel], messages: [asking, answer, other] }
    const chat = createMockChat(seed, () => Date.parse(at))
    render(<ChannelThread chat={chat} channel={channel} agents={[...agents.values()]} cards={[]} canDecide onDecide={vi.fn()} t={chatFrench} look="mndt-web" />)
    await waitFor(() => { expect(screen.getAllByTestId('chat-markdown')).toHaveLength(2) })
    const [mine, theirs] = screen.getAllByTestId('chat-markdown')
    expect(mine?.getAttribute('data-stale')).toBe('true')
    expect(theirs?.getAttribute('data-stale')).toBeNull()
  })
})

describe('the question moved under its message, after a help with no advice', () => {
  it('shows the question once and who could not answer, never the summary restating it', async () => {
    const { ChannelThread } = await import('../src/client/ChannelView.tsx')
    const { createMockChat } = await import('../src/client/mockChat.ts')
    const channel = { id: 'chn_1', name: 'x', title: 'x', kind: 'team' as const, members: [you], agents: ['agt_2', 'agt_3'], connectors: [], createdBy: you, createdAt: at }
    const help = { state: 'done', request, advices: [], skipped: [{ slot: 'A', agentId: 'agt_3', reason: 'Erreur pendant l’exécution.', reasonKind: 'failed' }],
      escalation: { question: 'Le montant diffère du relevé', summary: 'Blocage : Le montant diffère du relevé. Avis reçus : 0. Sans avis : avis non obtenu : erreur.', at, messageId: 'msg_q' } }
    const asking = { id: 'msg_h', channelId: 'chn_1', author: { kind: 'human' as const, email: you }, text: '@analyste ?', mentions: ['agt_2'], createdAt: at, updatedAt: at,
      turns: [{ id: 'trn_1', agentId: 'agt_2', status: 'done' as const, help }] }
    const question = { id: 'msg_q', channelId: 'chn_1', author: { kind: 'agent' as const, agentId: 'agt_2' }, text: 'Aucun avis n’a abouti.', mentions: [], replyTo: 'msg_h', createdAt: at, updatedAt: at }
    const seed = { you, agents: [...agents.values()], channels: [channel], messages: [asking, question] }
    const chat = createMockChat(seed, () => Date.parse(at))
    render(<ChannelThread chat={chat} channel={channel} agents={[...agents.values()]} cards={[]} canDecide onDecide={vi.fn()} t={chatFrench} look="mndt-web" canAnswer />)
    const pending = await screen.findByTestId('pending-question')
    expect(pending.textContent?.match(/Le montant diffère du relevé/gu)).toHaveLength(1)
    expect(pending.textContent).not.toContain('avis non obtenu')
    expect(within(pending).getByTestId('pending-unanswered').textContent).toBe('@qwen n\'a pas pu répondre (le modèle a renvoyé une erreur).')
  })
})

describe('review of #170', () => {
  it('only the last answer of the agent to the failed turn is greyed', async () => {
    const { ChannelThread } = await import('../src/client/ChannelView.tsx')
    const { createMockChat } = await import('../src/client/mockChat.ts')
    const channel = { id: 'chn_1', name: 'x', title: 'x', kind: 'team' as const, members: [you], agents: ['agt_2'], connectors: [], createdBy: you, createdAt: at }
    const asking = { id: 'msg_h', channelId: 'chn_1', author: { kind: 'human' as const, email: you }, text: '@analyste ?', mentions: ['agt_2'], createdAt: at, updatedAt: at,
      turns: [{ id: 'trn_1', agentId: 'agt_2', status: 'failed' as const, reasonKind: 'failed', reason: 'Erreur pendant l’exécution.' }] }
    const earlier = { id: 'msg_a1', channelId: 'chn_1', author: { kind: 'agent' as const, agentId: 'agt_2' }, text: 'premier', mentions: [], replyTo: 'msg_h', createdAt: at, updatedAt: at }
    const later = { ...earlier, id: 'msg_a2', text: 'je serai relancé', createdAt: '2026-11-23T08:01:00.000Z', updatedAt: '2026-11-23T08:01:00.000Z' }
    const seed = { you, agents: [...agents.values()], channels: [channel], messages: [asking, earlier, later] }
    render(<ChannelThread chat={createMockChat(seed, () => Date.parse(at))} channel={channel} agents={[...agents.values()]} cards={[]} canDecide onDecide={vi.fn()} t={chatFrench} look="mndt-web" />)
    await waitFor(() => { expect(screen.getAllByTestId('chat-markdown')).toHaveLength(2) })
    const [first, second] = screen.getAllByTestId('chat-markdown')
    expect(first?.getAttribute('data-stale')).toBeNull()
    expect(second?.getAttribute('data-stale')).toBe('true')
  })

  it('a peer the page does not know: no line, no error', () => {
    const h = read({ state: 'done', request, advices: [], skipped: [{ slot: 'A', agentId: 'agt_unknown', reason: 'x', reasonKind: 'failed' }],
      escalation: { question: 'Le montant diffère du relevé', at, messageId: 'msg_q' } })
    render(<HelpThread help={h} agents={agents} t={chatFrench} />)
    expect(screen.getByTestId('help-question')).toBeTruthy()
    expect(screen.queryByTestId('help-could-not-answer')).toBeNull()
  })
})
