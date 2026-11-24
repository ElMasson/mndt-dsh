// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatAgent, ChatChannel, ChatTurn, CoordinationChange } from '../src/client/chat.ts'
import { chatFrench } from '../src/client/chatLocales.ts'
import { CoordinationSection, coordinatedTurn, coordinationOf, stepsOf, turnSteps } from '../src/client/coordination.tsx'
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
    fireEvent.click(screen.getByRole('button', { name: 'Modifier' }))
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
    // Saved: folded again to its one line.
    await waitFor(() => { expect(screen.getByTestId('coordination-read').textContent).toBe('Rédigé par @redacteur, vérifié par @relecteur.') })
    fireEvent.click(screen.getByRole('button', { name: 'Modifier' }))
    expect(within(screen.getByTestId('coord-verifier')).getByRole('button', { name: '@relecteur' }).getAttribute('aria-pressed')).toBe('true')
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
    fireEvent.click(screen.getByRole('button', { name: 'Modifier' }))
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
      { role: 'revision', agentId: 'agt_1', eur: 0.006, replaced: true },
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

describe('the core\'s refusals of a coordination, in words (#84)', () => {
  it('says each sentence A1 serves in French', async () => {
    const { coordinationRefusal } = await import('../src/client/CollabPage.tsx')
    const { ChatRefusal } = await import('../src/client/chat.ts')
    const say = (m: string): string => coordinationRefusal(new ChatRefusal(m, 400), chatFrench)
    expect(say('the verifier must run another model than the author (both are scaleway-genapi/qwen-3.5)')).toBe('Le vérificateur doit tourner sur un autre modèle que l\'auteur.')
    expect(say('the author and the verifier must both be active agents of this channel')).toBe('L\'auteur et le vérificateur doivent être deux agents actifs de ce canal.')
    expect(say('the author and the verifier must be two agents')).toBe('L\'auteur et le vérificateur doivent être deux agents différents.')
    expect(say('mode is solo, author-verifier (author, verifier) or parallel-synthesis (workers, synthesizer)')).toBe('Cet espace ne connaît pas ce mode de réponse.')
  })
})

describe('« en parallèle puis synthèse » (#85)', () => {
  const FOUR = [...AGENTS, agent('agt_4', 'synthese', 'glm-5.2')]
  const WIDE: ChatChannel = { ...CHANNEL, agents: ['agt_1', 'agt_2', 'agt_3', 'agt_4'] }

  it('two workers, a synthesiser that is not one of them, a budget, then « Enregistrer »', async () => {
    const sent = vi.fn()
    const chat = createMockChat({ you, agents: FOUR, channels: [WIDE] }, () => Date.parse(at))
    /** The section over the double, re-drawn on what it returns. */
    function Wide(): ReactNode {
      const [channel, setChannel] = useState(WIDE)
      return (
        <CoordinationSection
          channel={channel}
          agents={FOUR}
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
    render(<Wide />)
    fireEvent.click(screen.getByRole('button', { name: 'Modifier' }))
    fireEvent.click(screen.getByRole('button', { name: 'En parallèle puis synthèse' }))
    const save = (): HTMLElement => screen.getByRole('button', { name: 'Enregistrer' })
    const saveOff = (): boolean => {
      const button = save()
      return button instanceof HTMLButtonElement && button.disabled
    }
    expect(saveOff()).toBe(true)
    const workers = screen.getByTestId('coord-workers')
    fireEvent.click(within(workers).getByRole('button', { name: '@redacteur' }))
    fireEvent.click(within(workers).getByRole('button', { name: '@relecteur' }))
    // A worker cannot synthesise.
    expect(within(screen.getByTestId('coord-synthesizer')).getByRole('button', { name: /@redacteur/u }).getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(within(screen.getByTestId('coord-synthesizer')).getByRole('button', { name: '@synthese' }))
    fireEvent.click(within(screen.getByTestId('coord-budget')).getByRole('button', { name: /^2/u }))
    fireEvent.click(save())
    await waitFor(() => { expect(sent).toHaveBeenCalledWith({ mode: 'parallel-synthesis', workers: ['agt_1', 'agt_2'], synthesizer: 'agt_4', maxEurPerTurn: 2 }) })
    // Saved: folded again to its one line, which says it.
    await waitFor(() => { expect(screen.getByTestId('coordination-read').textContent).toMatch(/^En parallèle : @redacteur, @relecteur, puis synthèse par @synthese/u) })
  })

  it('a reader reads it; fewer than three agents greys the mode; a malformed one reads as alone', () => {
    const parallel = { ...CHANNEL, coordination: { mode: 'parallel-synthesis', workerIds: ['agt_1', 'agt_2'], synthesizerId: 'agt_3', maxEurPerTurn: 1 } }
    render(<Panel canManage={false} channel={parallel} />)
    expect(screen.getByTestId('coordination-read').textContent).toMatch(/^En parallèle : @redacteur, @relecteur, puis synthèse par @jumeau \(1/u)
    cleanup()
    render(<Panel channel={{ ...CHANNEL, agents: ['agt_1', 'agt_2'] }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Modifier' }))
    expect(screen.getByRole('button', { name: 'En parallèle puis synthèse' }).getAttribute('aria-disabled')).toBe('true')
    for (const coordination of [
      { mode: 'parallel-synthesis', workerIds: ['agt_1'], synthesizerId: 'agt_3', maxEurPerTurn: 1 },
      { mode: 'parallel-synthesis', workerIds: ['agt_1', 'agt_3'], synthesizerId: 'agt_3', maxEurPerTurn: 1 },
      { mode: 'parallel-synthesis', workerIds: ['agt_1', 'agt_2'], synthesizerId: 'agt_3', maxEurPerTurn: 9 },
    ]) {
      expect(coordinationOf({ ...CHANNEL, coordination })).toBeUndefined()
    }
  })
})

describe('a parallel turn in the feed (#85)', () => {
  it('synthesised: who answered, who synthesised, the cost; the parts folded under their agents', () => {
    render(<>{coordinatedTurn(turn([
      { role: 'worker', agentId: 'agt_1', text: 'Part A : <b>chiffres</b>', eur: 0.01 },
      { role: 'worker', agentId: 'agt_2', text: 'Part B', eur: 0.01 },
      { role: 'synthesis', agentId: 'agt_3', eur: 0.02 },
    ], 0.04), byId, chatFrench)}</>)
    expect(screen.getByTestId('chat-turn-cost').textContent).toMatch(/^En parallèle : @redacteur, @relecteur · synthèse par @jumeau · /u)
    const steps = screen.getByTestId('turn-steps')
    expect(steps instanceof HTMLDetailsElement && steps.open).toBe(false)
    expect(screen.getAllByTestId('turn-part').map(p => p.textContent)).toEqual(['Part A : <b>chiffres</b>', 'Part B'])
    expect(steps.querySelector('b')).toBeNull()
  })

  it('a missing part is counted and its reason said; not synthesised shows the parts unfolded', () => {
    render(<>{coordinatedTurn(turn([
      { role: 'worker', agentId: 'agt_1', text: 'Part A' },
      { role: 'worker', agentId: 'agt_2', verdict: 'skipped', notes: ['plafond mensuel'] },
      { role: 'synthesis', agentId: 'agt_3', verdict: 'skipped', notes: ['le coût du tour atteindrait sa borne (1 €)'] },
    ]), byId, chatFrench)}</>)
    expect(screen.getByTestId('chat-turn-cost').textContent).toContain('1 part sur 2')
    expect(screen.getByTestId('chat-turn-cost').textContent).not.toContain('synthèse par')
    expect(screen.getByTestId('turn-not-synthesised').textContent).toBe('Non synthétisé : le coût du tour atteindrait sa borne (1 €). Les parts sont dans le détail ci-dessous.')
    const steps = screen.getByTestId('turn-steps')
    expect(steps instanceof HTMLDetailsElement && steps.open).toBe(true)
    expect(steps.textContent).toContain('Part manquante @relecteur')
    expect(steps.textContent).toContain('plafond mensuel')
  })

  it('no part at all: said, with the reasons', () => {
    render(<>{coordinatedTurn(turn([
      { role: 'worker', agentId: 'agt_1', verdict: 'skipped', notes: ['aucun texte'] },
      { role: 'worker', agentId: 'agt_2', verdict: 'skipped', notes: ['tour arrêté'] },
    ]), byId, chatFrench)}</>)
    expect(screen.getByTestId('turn-no-part').textContent).toBe('Aucune part n\'a abouti : les raisons sont dans le détail ci-dessous.')
    expect(screen.getByTestId('turn-steps').textContent).toContain('aucun texte')
  })

  it('the core\'s refusals of a parallel turn, in words', async () => {
    const { coordinationRefusal } = await import('../src/client/CollabPage.tsx')
    const { ChatRefusal } = await import('../src/client/chat.ts')
    const say = (m: string): string => coordinationRefusal(new ChatRefusal(m, 400), chatFrench)
    expect(say('a parallel turn has 2 to 4 distinct workers')).toBe('Un tour parallèle compte 2 à 4 travailleurs différents.')
    expect(say('the workers and the synthesizer must all be active agents of this channel')).toBe('Les travailleurs et le synthétiseur doivent tous être des agents actifs de ce canal.')
    expect(say('the synthesizer is not one of the workers')).toBe('Le synthétiseur ne peut pas être un des travailleurs.')
    expect(say('a parallel turn costs 5 € at most (maxEurPerTurn)')).toBe('Un tour parallèle coûte 5 € au plus.')
  })
})

describe('a stopped turn keeps its steps (#85)', () => {
  it('its parts and costs stay readable, folded', () => {
    const stopped = { ...turn([{ role: 'worker', agentId: 'agt_1', text: 'Part A', eur: 0.01 }, { role: 'worker', agentId: 'agt_2', verdict: 'skipped', notes: ['tour arrêté'] }]), status: 'cancelled' as const }
    render(<>{turnSteps(stopped, byId, chatFrench)}</>)
    expect(screen.getByTestId('turn-part').textContent).toBe('Part A')
    expect(screen.getByTestId('turn-steps').textContent).toContain('tour arrêté')
  })
})

describe('a step\'s tokens as the core serves them (#84)', () => {
  it('{ input, output } is summed; anything else is left out', () => {
    expect(stepsOf(turn([{ role: 'author', agentId: 'agt_1', tokens: { input: 900, output: 120, cacheRead: 400 } }]))[0]?.tokens).toBe(1020)
    expect(stepsOf(turn([{ role: 'author', agentId: 'agt_1', tokens: { input: 'x' } }]))[0]?.tokens).toBeUndefined()
    render(<>{coordinatedTurn(turn([
      { role: 'author', agentId: 'agt_1', tokens: { input: 1000, output: 234 } },
      { role: 'verifier', agentId: 'agt_2', verdict: 'ok' },
    ]), byId, chatFrench)}</>)
    expect(screen.getByTestId('turn-steps').textContent).toContain('1\u202f234 jetons')
  })
})

describe('« corrigé » only when the draft was replaced (#99)', () => {
  const issues = { role: 'verifier', agentId: 'agt_2', verdict: 'issues', notes: ['Montant faux.'] }
  it('replaced: false is an empty correction, the draft published as is, never « corrigé »', () => {
    render(<>{coordinatedTurn(turn([{ role: 'author', agentId: 'agt_1' }, issues, { role: 'revision', agentId: 'agt_1', replaced: false }]), byId, chatFrench)}</>)
    expect(screen.getByTestId('turn-empty-revision').textContent).toBe('Pas de correction (@redacteur) : brouillon publié tel quel')
    expect(screen.getByTestId('chat-turn-cost').textContent).not.toContain('corrigé')
  })

  it('replaced absent (an older core): said as not checked, never « corrigé »', () => {
    render(<>{coordinatedTurn(turn([{ role: 'author', agentId: 'agt_1' }, issues, { role: 'revision', agentId: 'agt_1' }]), byId, chatFrench)}</>)
    expect(screen.getByTestId('turn-unchecked').textContent).toBe('Correction non confirmée : lisez cette réponse comme non vérifiée.')
    const line = screen.getByTestId('chat-turn-cost').textContent
    expect(line).not.toContain('corrigé')
    expect(line).not.toContain('vérifié par')
  })

  it('replaced: true is « corrigé »', () => {
    render(<>{coordinatedTurn(turn([{ role: 'author', agentId: 'agt_1' }, issues, { role: 'revision', agentId: 'agt_1', replaced: true }]), byId, chatFrench)}</>)
    expect(screen.getByTestId('chat-turn-cost').textContent).toContain('corrigé')
    expect(screen.queryByTestId('turn-unchecked')).toBeNull()
  })
})

describe('the core\'s codes for a coordination refused (#100)', () => {
  it('reads the code first, and the sentence for a code it does not know', async () => {
    const { coordinationRefusal } = await import('../src/client/CollabPage.tsx')
    const { ChatRefusal } = await import('../src/client/chat.ts')
    const say = (code: string, m = 'whatever'): string => coordinationRefusal(new ChatRefusal(m, 400, code), chatFrench)
    expect(say('same-model')).toBe('Le vérificateur doit tourner sur un autre modèle que l\'auteur.')
    expect(say('not-member')).toBe('Les agents choisis doivent tous être des agents actifs de ce canal.')
    expect(say('same-agent')).toBe('L\'auteur et le vérificateur doivent être deux agents différents.')
    expect(say('too-few-workers')).toBe('Un tour parallèle compte 2 à 4 travailleurs différents.')
    expect(say('too-many-workers')).toBe('Un tour parallèle compte 2 à 4 travailleurs différents.')
    expect(say('synthesizer-is-worker')).toBe('Le synthétiseur ne peut pas être un des travailleurs.')
    expect(say('budget-out-of-range')).toBe('Un tour parallèle coûte 5 € au plus.')
    expect(say('unknown-mode')).toBe('Cet espace ne connaît pas ce mode de réponse.')
    expect(say('missing-fields')).toBe('Choisissez d\'abord les agents de ce mode.')
    expect(say('brand-new', 'the synthesizer is not one of the workers')).toBe('Le synthétiseur ne peut pas être un des travailleurs.')
  })

  it('a correction identical to the draft says the core\'s note, as text and bounded', () => {
    render(<>{coordinatedTurn(turn([
      { role: 'author', agentId: 'agt_1' },
      { role: 'verifier', agentId: 'agt_2', verdict: 'issues' },
      { role: 'revision', agentId: 'agt_1', replaced: false, notes: [`<b>identique</b> ${'x'.repeat(300)}`] },
    ]), byId, chatFrench)}</>)
    const band = screen.getByTestId('turn-empty-revision')
    expect(band.textContent?.startsWith('Pas de correction (@redacteur) : brouillon publié tel quel — <b>identique</b>')).toBe(true)
    expect(band.querySelector('b')).toBeNull()
    expect(band.textContent?.endsWith('…')).toBe(true)
  })

  it('an empty correction carries the core\'s note in the folded steps', () => {
    render(<>{coordinatedTurn(turn([
      { role: 'author', agentId: 'agt_1' },
      { role: 'verifier', agentId: 'agt_2', verdict: 'issues', notes: ['Montant faux.'] },
      { role: 'revision', agentId: 'agt_1', replaced: false, notes: ['correction vide, brouillon publié'] },
    ]), byId, chatFrench)}</>)
    expect(screen.getByTestId('turn-empty-revision').textContent).toBe('Pas de correction (@redacteur) : brouillon publié tel quel — correction vide, brouillon publié')
    expect(screen.getByTestId('turn-steps').textContent).toContain('correction vide, brouillon publié')
  })
})

describe('the parts counted, agreed with the first number', () => {
  it('« 1 part sur 3 », « 2 parts sur 3 »', () => {
    const parts = (got: number): ChatTurn => turn([
      ...Array.from({ length: 3 }, (_, i) => (i < got
        ? { role: 'worker', agentId: i === 0 ? 'agt_1' : i === 1 ? 'agt_2' : 'agt_3', text: `Part ${i}` }
        : { role: 'worker', agentId: i === 0 ? 'agt_1' : i === 1 ? 'agt_2' : 'agt_3', verdict: 'skipped', notes: ['aucun texte'] })),
      { role: 'synthesis', agentId: 'agt_4' },
    ])
    const { unmount } = render(<>{coordinatedTurn(parts(1), byId, chatFrench)}</>)
    expect(screen.getByTestId('chat-turn-cost').textContent).toContain('1 part sur 3')
    unmount()
    render(<>{coordinatedTurn(parts(2), byId, chatFrench)}</>)
    expect(screen.getByTestId('chat-turn-cost').textContent).toContain('2 parts sur 3')
  })
})

describe('the coordination folded to one line by default', () => {
  it('a manager reads it in one line with « Modifier »; the choice opens on it and folds back with « Fermer »', () => {
    const coordinated = { ...CHANNEL, coordination: { mode: 'author-verifier', authorId: 'agt_1', verifierId: 'agt_2' } }
    render(<CoordinationSection channel={coordinated} agents={AGENTS} canManage onChange={vi.fn()} t={chatFrench} />)
    expect(screen.getByTestId('coordination-read').textContent).toBe('Rédigé par @redacteur, vérifié par @relecteur.')
    expect(screen.queryByRole('group', { name: 'Comment les agents répondent ici' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Modifier' }))
    expect(screen.getByRole('group', { name: 'Comment les agents répondent ici' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }))
    expect(screen.getByTestId('coordination-read')).toBeTruthy()
  })
})
