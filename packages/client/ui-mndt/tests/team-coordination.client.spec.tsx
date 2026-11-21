// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatAgent, ChatChannel, ChatTurn, CoordinationChange } from '../src/client/chat.ts'
import { chatFrench } from '../src/client/chatLocales.ts'
import { CoordinationSection, coordinatedTurn, coordinationOf, stepsOf } from '../src/client/coordination.tsx'
import { createMockChat } from '../src/client/mockChat.ts'

afterEach(() => { cleanup() })

const you = 'stephane@datanalysis.re'
const at = '2026-11-21T09:00:00.000Z'
/** @returns an agent of the double. */
function agent(id: string, handle: string, model: string): ChatAgent {
  return { id, handle, name: handle, provider: 'scaleway-genapi', model, connectors: [], eurPerMonth: 5, createdBy: you, createdAt: at }
}
const AGENTS = [agent('agt_1', 'redacteur', 'qwen-3.5'), agent('agt_2', 'relecteur', 'deepseek-v4.1-flash'), agent('agt_3', 'jumeau', 'qwen-3.5')]
const CHANNEL: ChatChannel = {
  id: 'chn_1', name: 'test', title: 'test', kind: 'team', members: [you], agents: ['agt_1', 'agt_2', 'agt_3'], connectors: [], createdBy: you, createdAt: at,
}

/** The section over the double, re-drawn on the channel the double returns. */
function Panel(props: {
  readonly canManage?: boolean
  readonly channel?: ChatChannel
  readonly onChange?: (c: CoordinationChange) => void
}): ReactNode {
  const [chat] = useState(() => createMockChat({ you, agents: AGENTS, channels: [props.channel ?? CHANNEL] }, () => Date.parse(at)))
  const [channel, setChannel] = useState(props.channel ?? CHANNEL)
  return (
    <CoordinationSection
      channel={channel}
      agents={AGENTS}
      canManage={props.canManage ?? true}
      onChange={async (change) => {
        props.onChange?.(change)
        try {
          setChannel(await (chat.setCoordination?.(channel.id, change) ?? Promise.resolve(channel)))
          return undefined
        } catch (failure) {
          return failure instanceof Error ? failure.message : 'refused'
        }
      }}
      t={chatFrench}
    />
  )
}

describe('the coordination of a channel, in its panel (#84)', () => {
  it('« Auteur puis vérificateur » in three clicks: the mode, the author, the verifier', async () => {
    const sent = vi.fn()
    render(<Panel onChange={sent} />)
    expect(screen.getByRole('button', { name: 'Seul' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Auteur puis vérificateur' }))
    fireEvent.click(within(screen.getByTestId('coord-author')).getByRole('button', { name: '@redacteur' }))
    const verifiers = screen.getByTestId('coord-verifier')
    // The author's model twin is greyed, with the reason; the author itself too.
    expect(within(verifiers).getByRole('button', { name: /@jumeau/u }).getAttribute('aria-disabled')).toBe('true')
    expect(within(verifiers).getByRole('button', { name: /@jumeau/u }).getAttribute('aria-label')).toBe('@jumeau, Le vérificateur doit tourner sur un autre modèle que l\'auteur.')
    expect(within(verifiers).getByRole('button', { name: /@redacteur/u }).getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(within(verifiers).getByRole('button', { name: '@relecteur' }))
    await waitFor(() => { expect(sent).toHaveBeenCalledWith({ mode: 'author-verifier', author: 'agt_1', verifier: 'agt_2' }) })
    await waitFor(() => { expect(within(screen.getByTestId('coord-verifier')).getByRole('button', { name: '@relecteur' }).getAttribute('aria-pressed')).toBe('true') })
    fireEvent.click(screen.getByRole('button', { name: 'Seul' }))
    await waitFor(() => { expect(sent).toHaveBeenLastCalledWith({ mode: 'solo' }) })
    await waitFor(() => { expect(screen.queryByTestId('coord-author')).toBeNull() })
  })

  it('a reader without the right reads it, without a button', () => {
    const coordinated = { ...CHANNEL, coordination: { mode: 'author-verifier', authorId: 'agt_1', verifierId: 'agt_2' } }
    render(<Panel canManage={false} channel={coordinated} />)
    expect(screen.getByTestId('coordination-read').textContent).toBe('Rédigé par @redacteur, vérifié par @relecteur.')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('fewer than two agents: the mode is greyed, and why', () => {
    render(<Panel channel={{ ...CHANNEL, agents: ['agt_1'] }} />)
    expect(screen.getByRole('button', { name: 'Auteur puis vérificateur' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByText('Il faut deux agents dans le canal.')).toBeTruthy()
  })

  it('a coordination of another shape reads as alone', () => {
    for (const coordination of [null, 'x', {}, { mode: 'other', authorId: 'a', verifierId: 'b' }, { mode: 'author-verifier', authorId: 'a', verifierId: 'a' }, { mode: 'author-verifier', authorId: 3, verifierId: 'b' }]) {
      expect(coordinationOf({ ...CHANNEL, coordination })).toBeUndefined()
    }
  })
})

const byId = new Map(AGENTS.map(a => [a.id, a]))
/** @param steps - the turn's steps. @returns a finished turn. */
function turn(steps: unknown, eur = 0.0123): ChatTurn {
  return { id: 'trn_1', agentId: 'agt_1', status: 'done', eur, steps }
}

describe('a coordinated turn in the feed (#84)', () => {
  it('says who wrote, who checked, that it was corrected, the total cost; steps folded', () => {
    render(<>{coordinatedTurn(turn([
      { role: 'author', agentId: 'agt_1', tokens: 900, eur: 0.004 },
      { role: 'verifier', agentId: 'agt_2', eur: 0.002, verdict: 'issues', notes: ['Le montant de mars est faux.'] },
      { role: 'revision', agentId: 'agt_1', eur: 0.006 },
    ]), byId, chatFrench)}</>)
    expect(screen.getByTestId('chat-turn-cost').textContent).toMatch(/^Rédigé par @redacteur · vérifié par @relecteur · corrigé · /u)
    const steps = screen.getByTestId('turn-steps')
    expect(steps instanceof HTMLDetailsElement && steps.open).toBe(false)
    expect(steps.textContent).toContain('Vérification @relecteur · réserves')
    expect(steps.textContent).toContain('Le montant de mars est faux.')
    expect(screen.queryByTestId('turn-unchecked')).toBeNull()
  })

  it('an impossible check is said plainly, never shown as checked', () => {
    render(<>{coordinatedTurn(turn([
      { role: 'author', agentId: 'agt_1' },
      { role: 'verifier', agentId: 'agt_2', verdict: 'unreadable' },
    ]), byId, chatFrench)}</>)
    expect(screen.getByTestId('turn-unchecked').textContent).toBe('Vérification impossible (@relecteur) : brouillon publié tel quel, non vérifié.')
    expect(screen.getByTestId('chat-turn-cost').textContent).not.toContain('vérifié par')
  })

  it('reservations not corrected: a third state, an orange band, never « corrigé »', () => {
    render(<>{coordinatedTurn(turn([
      { role: 'author', agentId: 'agt_1' },
      { role: 'verifier', agentId: 'agt_2', verdict: 'issues', notes: ['Chiffre faux.'] },
    ]), byId, chatFrench)}</>)
    expect(screen.getByTestId('turn-uncorrected').textContent).toBe('Réserves non corrigées (@redacteur) : publié avec les remarques du vérificateur en suspens.')
    const line = screen.getByTestId('chat-turn-cost').textContent
    expect(line).toContain('vérifié par @relecteur')
    expect(line).not.toContain('corrigé')
    expect(line).not.toContain('conforme')
  })

  it('a correction skipped at the author\'s ceiling: « plafond de @a atteint », never « corrigé »', () => {
    render(<>{coordinatedTurn(turn([
      { role: 'author', agentId: 'agt_1' },
      { role: 'verifier', agentId: 'agt_2', verdict: 'issues', notes: ['Chiffre faux.'] },
      { role: 'revision', agentId: 'agt_1', verdict: 'skipped', notes: ['ceiling reached'] },
    ]), byId, chatFrench)}</>)
    expect(screen.getByTestId('turn-uncorrected').textContent).toBe('Réserves non corrigées : plafond de @redacteur atteint.')
    expect(screen.getByTestId('chat-turn-cost').textContent).not.toContain('corrigé')
    expect(screen.getByTestId('turn-steps').textContent).toContain('Correction @redacteur · non faite')
  })

  it('a verifier skipped is not checked, its reason in the steps', () => {
    render(<>{coordinatedTurn(turn([
      { role: 'author', agentId: 'agt_1' },
      { role: 'verifier', agentId: 'agt_2', verdict: 'skipped', notes: ['ceiling of the verifier reached'] },
    ]), byId, chatFrench)}</>)
    expect(screen.getByTestId('turn-unchecked')).toBeTruthy()
    expect(screen.getByTestId('turn-steps').textContent).toContain('ceiling of the verifier reached')
  })

  it('notes come from an agent: text, never markup', () => {
    render(<>{coordinatedTurn(turn([
      { role: 'author', agentId: 'agt_1' },
      { role: 'verifier', agentId: 'agt_2', verdict: 'ok', notes: ['<img src=x onerror=alert(1)>'] },
    ]), byId, chatFrench)}</>)
    const steps = screen.getByTestId('turn-steps')
    expect(steps.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(steps.querySelector('img')).toBeNull()
    expect(screen.getByTestId('chat-turn-cost').textContent).toContain('conforme')
  })

  it('steps of another shape show nothing coordinated, rather than breaking', () => {
    for (const steps of [undefined, null, 'x', [], [{ role: 'verifier', agentId: 'agt_2' }], [{ role: 'author', agentId: 'agt_1' }, { role: 'judge', agentId: 'x' }], [{ role: 'author', agentId: 'agt_1', verdict: 'great' }], [null]]) {
      expect(stepsOf(turn(steps))).toEqual([])
      expect(coordinatedTurn(turn(steps), byId, chatFrench)).toBeUndefined()
    }
    // An author alone: not a coordinated line.
    expect(coordinatedTurn(turn([{ role: 'author', agentId: 'agt_1' }]), byId, chatFrench)).toBeUndefined()
  })
})
