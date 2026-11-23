// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatAgent, ChatChannel, ChatTurn } from '../src/client/chat.ts'
import { chatFrench } from '../src/client/chatLocales.ts'
import { CoordinationSection, coordinationOf } from '../src/client/coordination.tsx'
import { CouncilThread, councilOf } from '../src/client/council.tsx'
import type { TurnCouncil } from '../src/client/council.tsx'
import { createMockChat } from '../src/client/mockChat.ts'

afterEach(() => { cleanup() })

const you = 'stephane@datanalysis.re'
const at = '2026-11-24T08:00:00.000Z'
/** @returns an agent. */
function agent(id: string, handle: string, model: string): ChatAgent {
  return { id, handle, name: handle, provider: 'p', model, connectors: [], eurPerMonth: 5, createdBy: you, createdAt: at }
}
const AGENTS = [agent('agt_1', 'assistant', 'a'), agent('agt_2', 'analyste', 'b'), agent('agt_3', 'qwen', 'c'), agent('agt_4', 'synthese', 'd')]
const byId = new Map(AGENTS.map(a => [a.id, a]))
const CHANNEL: ChatChannel = {
  id: 'chn_1', name: 'conseil', title: 'conseil', kind: 'team', members: [you], agents: ['agt_1', 'agt_2', 'agt_3', 'agt_4'], connectors: [], createdBy: you, createdAt: at,
}

describe('the council in the panel', () => {
  it('members by pills (the first chairs), « Vote » by default, then « Enregistrer »', async () => {
    const sent = vi.fn()
    const chat = createMockChat({ you, agents: AGENTS, channels: [CHANNEL] }, () => Date.parse(at))
    /** The section over the double. */
    function Panel(): ReactNode {
      const [channel, setChannel] = useState(CHANNEL)
      return (
        <CoordinationSection
          channel={channel}
          agents={AGENTS}
          canManage
          onChange={async (change) => {
            sent(change)
            setChannel(await (chat.setCoordination?.(channel.id, change) ?? Promise.resolve(channel)))
            return undefined
          }}
          t={chatFrench}
        />
      )
    }
    render(<Panel />)
    fireEvent.click(screen.getByRole('button', { name: 'Conseil' }))
    const members = screen.getByTestId('council-members')
    fireEvent.click(within(members).getByRole('button', { name: '@assistant' }))
    fireEvent.click(within(members).getByRole('button', { name: '@analyste' }))
    fireEvent.click(within(members).getByRole('button', { name: '@qwen' }))
    expect(within(members).getByRole('button', { name: '@assistant, préside' })).toBeTruthy()
    expect(within(screen.getByTestId('council-decision')).getByRole('button', { name: 'Vote' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByTestId('council-synthesizer')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => { expect(sent).toHaveBeenCalledWith({ mode: 'council', members: ['agt_1', 'agt_2', 'agt_3'], decision: 'vote', maxEurPerTurn: 1 }) })
  })

  it('« Synthèse » asks for a synthesiser outside the members', () => {
    render(<CoordinationSection channel={CHANNEL} agents={AGENTS} canManage onChange={vi.fn()} t={chatFrench} />)
    fireEvent.click(screen.getByRole('button', { name: 'Conseil' }))
    const members = screen.getByTestId('council-members')
    fireEvent.click(within(members).getByRole('button', { name: '@assistant' }))
    fireEvent.click(within(members).getByRole('button', { name: '@analyste' }))
    fireEvent.click(within(screen.getByTestId('council-decision')).getByRole('button', { name: 'Synthèse' }))
    const synth = screen.getByTestId('council-synthesizer')
    expect(within(synth).getByRole('button', { name: /@assistant/u }).getAttribute('aria-disabled')).toBe('true')
    const save = screen.getByRole('button', { name: 'Enregistrer' })
    expect(save instanceof HTMLButtonElement && save.disabled).toBe(true)
  })

  it('a council of another shape reads as alone; a reader reads it in one sentence', () => {
    for (const coordination of [{ mode: 'council', memberIds: ['agt_1'], decision: 'vote', maxEurPerTurn: 1 },
      { mode: 'council', memberIds: ['agt_1', 'agt_2'], decision: 'synthesis', synthesizerId: 'agt_1', maxEurPerTurn: 1 },
      { mode: 'council', memberIds: ['agt_1', 'agt_2'], decision: 'dice', maxEurPerTurn: 1 }]) {
      expect(coordinationOf({ ...CHANNEL, coordination })).toBeUndefined()
    }
    const council = { ...CHANNEL, coordination: { mode: 'council', memberIds: ['agt_1', 'agt_2', 'agt_3'], decision: 'vote', maxEurPerTurn: 1 } }
    render(<CoordinationSection channel={council} agents={AGENTS} canManage={false} t={chatFrench} />)
    expect(screen.getByTestId('coordination-read').textContent).toMatch(/^Conseil : @assistant, @analyste, @qwen, présidé par @assistant, décision par vote/u)
  })
})

const options = ['Relancer Sodiac maintenant', 'Attendre la fin du mois', 'aucune de ces options']
const positions = [
  { slot: 'A', choice: 0, text: 'La facture a 45 jours de retard.', agentId: 'agt_1', model: 'p/a' },
  { slot: 'B', choice: 1, text: 'Sodiac paie toujours en fin de mois.', agentId: 'agt_2', model: 'p/b' },
  { slot: 'C', choice: 0, text: '<b>Relancer</b> poliment.', agentId: 'agt_3', model: 'p/c' },
]
const critiques = [
  { slot: 'A', about: 'B', text: 'La fin du mois est passée.', choice: 0 },
  { slot: 'B', about: 'C', text: 'Je me range à A.', choice: 0 },
]
/** @param council - the turn's council. @returns a turn of the chair. */
function turn(council: unknown): ChatTurn {
  return { id: 'trn_1', agentId: 'agt_1', status: 'done', council }
}
/** @param council - as served. @returns it read. */
const read = (council: unknown): TurnCouncil => {
  const c = councilOf(turn(council))
  if (c === undefined) throw new Error('unreadable council')
  return c
}

describe('a council in the feed', () => {
  it('reads only a well-formed council; a choice out of the options makes it unreadable', () => {
    expect(read({ state: 'done', options, positions, critiques }).positions).toHaveLength(3)
    // Only an unknown shape closes the display: no state, or no options.
    expect(councilOf(turn({ options, positions }))).toBeUndefined()
    expect(councilOf(turn({ state: 'done', positions }))).toBeUndefined()
    expect(councilOf(turn({ state: 'done', options: ['seule'] }))).toBeUndefined()
  })

  it('while deliberating: unfolded, no author; the chair frames it, by name', () => {
    render(<CouncilThread turn={turn({})} council={read({ state: 'deliberating', options, positions, critiques, framing: { text: 'Faut-il relancer Sodiac ?' } })} agents={byId} t={chatFrench} />)
    expect(screen.getByTestId('council-outcome').textContent).toBe('délibération en cours')
    expect(screen.getByTestId('council-framing').textContent).toContain('Cadrage par le président, @assistant')
    const all = screen.getAllByTestId('council-position').map(p => p.textContent ?? '').join(' ')
    expect(all).not.toMatch(/@analyste|@qwen|p\/b/u)
    expect(screen.getAllByTestId('council-position')[2]?.querySelector('b')).toBeNull()
  })

  it('decided by vote: the option and its count, the critique\'s choice said, authors revealed, disagreement always visible', () => {
    const council = read({ state: 'done', options, positions, critiques, decision: { kind: 'vote', tally: { 0: 3, 1: 0 }, chosen: 0 }, dissent: [{ slot: 'B', why: 'préférait attendre' }] })
    render(<CouncilThread turn={turn({})} council={council} agents={byId} t={chatFrench} />)
    expect(screen.getByTestId('council-outcome').textContent).toBe('Relancer Sodiac maintenant (3 sur 3)')
    expect(screen.getByTestId('council-dissent').textContent).toBe('Désaccord, position B : préférait attendre')
    const steps = screen.getByTestId('council-steps')
    expect(steps instanceof HTMLDetailsElement && steps.open).toBe(false)
    const [a, b] = screen.getAllByTestId('council-position')
    expect(a?.textContent).toContain('@assistant (p/a)')
    expect(a?.textContent).toContain('confirme')
    expect(b?.textContent).toContain('change pour l\'option 1 : Relancer Sodiac maintenant')
    expect(screen.getByTestId('council-tally').textContent).toContain('Relancer Sodiac maintenant : 3')
  })

  it('a tie asks a person: one field, where the answer counts', async () => {
    const onAnswer = vi.fn(async () => undefined)
    const council = read({ state: 'done', options, positions, critiques, decision: { kind: 'vote', tally: { 0: 1, 1: 1 } },
      escalation: { question: 'Relancer ou attendre ?', messageId: 'msg_9' } })
    render(<CouncilThread turn={turn({})} council={council} agents={byId} onAnswer={onAnswer} canAnswer t={chatFrench} />)
    expect(screen.getByTestId('council-outcome').textContent).toBe('une question pour vous')
    fireEvent.change(screen.getByRole('textbox', { name: 'Votre réponse' }), { target: { value: 'Relancez.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Répondre et clore ce fil' }))
    await waitFor(() => { expect(onAnswer).toHaveBeenCalledWith('Relancez.', 'msg_9') })
  })

  it('a synthesis is shown, by its synthesiser', () => {
    render(<CouncilThread turn={turn({})} council={read({ state: 'done', options, positions, critiques, decision: { kind: 'synthesis', text: 'Relancer avec délai de 8 jours.', agentId: 'agt_4' } })} agents={byId} t={chatFrench} />)
    expect(screen.getByTestId('council-outcome').textContent).toBe('synthèse par @synthese')
    expect(screen.getByTestId('council-synthesis').textContent).toContain('Relancer avec délai de 8 jours.')
  })
})

describe('an unreadable choice keeps the council', () => {
  it('the position stays, said « choix illisible »; the rest is shown', () => {
    const council = read({ state: 'done', options, positions: [...positions.slice(0, 2), { slot: 'C', choice: 7, text: 'Hors des options.' }], critiques,
      decision: { kind: 'vote', tally: { 0: 1, 1: 1 } }, skipped: [{ slot: 'C', reason: 'choix illisible' }] })
    render(<CouncilThread turn={turn({})} council={council} agents={byId} t={chatFrench} />)
    const all = screen.getAllByTestId('council-position')
    expect(all).toHaveLength(3)
    expect(all[2]?.textContent).toContain('Position C · choix illisible')
    expect(all[0]?.textContent).toContain('Position A · option 1 : Relancer Sodiac maintenant')
    expect(screen.getByTestId('council-skipped').textContent).toContain('Position C non comptée : choix illisible')
  })

  it('a critique may name several positions; a council closed by a restart is not shown as running', () => {
    const council = read({ state: 'closed', options, positions, critiques: [{ slot: 'A', about: ['B', 'C'], text: 'Les deux oublient le retard.', choice: 0 }],
      skipped: [{ reason: 'redémarrage' }] })
    render(<CouncilThread turn={turn({})} council={council} agents={byId} t={chatFrench} />)
    expect(screen.getByTestId('council-outcome').textContent).toBe('clos sans décision : redémarrage')
    expect(screen.getByTestId('council-critique').textContent).toContain('Critique de la position B, C')
    expect(screen.getByTestId('council-skipped').textContent).toContain('redémarrage')
  })
})
