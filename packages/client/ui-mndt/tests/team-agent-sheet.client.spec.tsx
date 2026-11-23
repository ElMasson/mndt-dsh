// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatAgent, ChatChannel } from '../src/client/chat.ts'
import { chatFrench } from '../src/client/chatLocales.ts'
import { TeamAgentSheet } from '../src/client/TeamAgentSheet.tsx'

afterEach(() => { cleanup() })

const you = 'stephane@datanalysis.re'
const at = '2026-11-23T08:00:00.000Z'
/** @param over - fields to change. @returns an agent. */
function agent(over: Partial<ChatAgent> = {}): ChatAgent {
  return {
    id: 'agt_1', handle: 'recouvrement', name: 'Recouvrement', provider: 'scaleway-genapi', model: 'deepseek-v4.1-flash',
    connectors: ['qonto', 'dolibarr'], eurPerMonth: 5, eurThisMonth: 0.42, createdBy: you, createdAt: at,
    instructions: '## Rôle\nSuit les impayés.\n\n## Ne décide pas\n- les relances partent après validation', ...over,
  }
}
const channels: ChatChannel[] = [
  { id: 'chn_0', name: 'solo', title: 'Ma lane', kind: 'solo', members: [you], agents: ['agt_1'], connectors: [], createdBy: you, createdAt: at },
  { id: 'chn_1', name: 'compta', title: 'compta', kind: 'team', members: [you], agents: ['agt_1'], connectors: [], createdBy: you, createdAt: at },
]
const mounted = [{ module: 'm', server: 'qonto', enabled: true }, { module: 'm', server: 'dolibarr', enabled: false }]

describe('an agent\'s readable sheet (lot 3)', () => {
  it('says what is served, the rule written once, and the instructions with their sections as written', () => {
    const onEdit = vi.fn()
    render(<TeamAgentSheet agent={agent()} channels={channels} mounted={mounted} names={{ [you]: 'Stéphane Masson' }} onEdit={onEdit} onClose={vi.fn()} t={chatFrench} />)
    const sheet = screen.getByTestId('agent-sheet')
    expect(sheet.textContent).toContain('@recouvrement')
    expect(sheet.textContent).toContain('Rapide')
    expect(sheet.textContent).toContain('dolibarrnon branché')
    expect(sheet.textContent).toMatch(/0,42\s€ ce mois-ci, sur 5,00\s€/u)
    // Only team channels; the lane is the person's own.
    expect(screen.getByTestId('agent-channels').textContent).toBe('# compta')
    expect(sheet.textContent).toContain('par Stéphane Masson')
    expect(sheet.textContent).toContain('Rien seul : ce qu\'il propose devient une carte, décidée par une personne.')
    const text = screen.getByTestId('agent-instructions')
    // Inside the frame, a « ## Rôle » is bold text, never a heading that could pass for the sheet's.
    expect(text.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull()
    expect(text.querySelector('strong')?.textContent).toBe('Rôle')
    expect(screen.getByTestId('agent-instructions-frame').textContent?.startsWith('Consigne écrite par une personne')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Modifier' }))
    expect(onEdit).toHaveBeenCalled()
  })

  it('HTML and a javascript: link in the instructions stay text: no element, no link', () => {
    render(<TeamAgentSheet agent={agent({ instructions: '<img src=x onerror=alert(1)> [clic](javascript:alert(1)) <script>alert(2)</script>' })} channels={channels} onClose={vi.fn()} t={chatFrench} />)
    const text = screen.getByTestId('agent-instructions')
    expect(text.querySelector('img, script, a, iframe')).toBeNull()
    expect(text.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(text.textContent).toContain('<script>alert(2)</script>')
  })

  it('no instructions: said, nothing made up', () => {
    render(<TeamAgentSheet agent={agent({ instructions: '   ' })} channels={[]} onClose={vi.fn()} t={chatFrench} />)
    expect(screen.getByTestId('agent-no-instructions').textContent).toBe('Pas de consigne écrite pour cet agent.')
    expect(screen.getByTestId('agent-channels').textContent).toBe('Dans aucun canal d\'équipe')
  })

  it('a retired agent says so and offers no change', () => {
    render(<TeamAgentSheet agent={agent({ retiredAt: '2026-11-20T10:00:00.000Z' })} channels={channels} onEdit={vi.fn()} onClose={vi.fn()} t={chatFrench} />)
    expect(screen.getByTestId('agent-retired').textContent).toMatch(/^Retiré le /u)
    expect(screen.queryByRole('button', { name: 'Modifier' })).toBeNull()
  })

  it('long instructions are folded beyond ten lines, and unfold in one click', () => {
    const long = Array.from({ length: 14 }, (_, i) => `Ligne ${i + 1}`).join('\n')
    render(<TeamAgentSheet agent={agent({ instructions: long })} channels={channels} onClose={vi.fn()} t={chatFrench} />)
    expect(screen.getByTestId('agent-instructions').textContent).not.toContain('Ligne 11')
    fireEvent.click(screen.getByRole('button', { name: 'Lire toute la consigne (14 lignes)' }))
    expect(screen.getByTestId('agent-instructions').textContent).toContain('Ligne 14')
    fireEvent.click(screen.getByRole('button', { name: 'Replier' }))
    expect(screen.getByTestId('agent-instructions').textContent).not.toContain('Ligne 11')
  })
})

describe('who wrote the instructions, and the author\'s name (#67)', () => {
  it('an agent that proposed it is named by its handle', () => {
    const proposer = agent({ id: 'agt_9', handle: 'assistant', name: 'Assistant' })
    render(<TeamAgentSheet agent={agent({ createdBy: 'agt_9' })} agents={[proposer]} channels={channels} onClose={vi.fn()} t={chatFrench} />)
    expect(screen.getByTestId('agent-instructions-frame').textContent?.startsWith('Consigne écrite par @assistant')).toBe(true)
  })

  it('the author\'s name is read from the team\'s own entries only', () => {
    render(<TeamAgentSheet agent={agent({ createdBy: 'constructor@datanalysis.re' })} channels={channels} names={{}} onClose={vi.fn()} t={chatFrench} />)
    expect(screen.getByTestId('agent-sheet').textContent).toContain('par constructor,')
  })
})
