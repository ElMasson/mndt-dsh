// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CollabPage } from '../src/client/CollabPage.tsx'
import { handleOf, modelLabel, modelsOf } from '../src/client/TeamAgentForm.tsx'
import { createMockChat } from '../src/client/mockChat.ts'
import { chatFrench } from '../src/client/chatLocales.ts'
import type { ChatAgent } from '../src/client/chat.ts'
import type { MndtFace, PageStateRow } from '../src/client/face.ts'

afterEach(() => { cleanup() })

const at = '2026-11-15T09:00:00.000Z'
const you = 'stephane@datanalysis.re'
const agent = (id: string, handle: string, provider: string, model: string, eurPerMonth = 5): ChatAgent => ({
  id, handle, name: `${handle[0]?.toUpperCase() ?? ''}${handle.slice(1)}`, provider, model,
  connectors: [], eurPerMonth, eurThisMonth: 0, createdBy: you, createdAt: at,
})
const AGENTS = [
  agent('agt_1', 'assistant', 'scaleway-genapi', 'deepseek-v4.1-flash'),
  agent('agt_2', 'analyste', 'scaleway-genapi', 'glm-5.3'),
  agent('agt_3', 'qwen', 'vllm-qwen', 'qwen-local'),
]

/** @param role - the reader's role. @returns the page on Agents, over a double. */
async function open(role: string, agents: readonly ChatAgent[] = AGENTS) {
  const page: PageStateRow = { you, canWrite: true, canAdmin: role !== 'operator', role, missions: [], briefs: [], approvals: [], memories: [] }
  const api = new Proxy({}, {
    get: (_t, key) => key === 'state' ? async () => page : key === 'members' || key === 'search' ? async () => [] : async () => { throw new Error('non utilise') },
  }) as MndtFace
  const chat = createMockChat({
    you, agents, channels: [],
    mounted: [{ module: 'm', server: 'qonto', enabled: true }, { module: 'm', server: 'dolibarr', enabled: false }],
  }, () => Date.parse(at))
  render(<CollabPage api={api} chat={chat} tc={chatFrench} team={{}} />)
  const nav = await screen.findByTestId('side-nav')
  await waitFor(() => { expect(within(nav).getByRole('button', { name: 'Assistant' })).toBeTruthy() })
  fireEvent.click(within(nav).getByRole('button', { name: 'Agents' }))
  return { chat, view: screen.getByTestId('team-agents') }
}

describe('the agent sheet, its parts', () => {
  it('deduces a handle the core accepts from the name', () => {
    expect(handleOf('Recouvrement')).toBe('recouvrement')
    expect(handleOf('Suivi des impayés 2026')).toBe('suivi-des-impayes-2026')
    expect(handleOf('  Éléonore  ')).toBe('eleonore')
    expect(handleOf('x')).toBe('')
    expect(handleOf('a'.repeat(40))).toHaveLength(32)
    for (const name of ['Recouvrement', 'Suivi des impayés 2026', 'Ça va !']) expect(handleOf(name)).toMatch(/^[a-z0-9][a-z0-9-]{1,31}$/u)
  })

  it('offers the models already in use, the most used first, in words', () => {
    const models = modelsOf([...AGENTS, agent('agt_4', 'autre', 'vllm-qwen', 'qwen-local')])
    expect(models[0]).toEqual({ provider: 'vllm-qwen', model: 'qwen-local' })
    expect(models.map(m => modelLabel(m, chatFrench))).toEqual(['Qwen local', 'Rapide', 'Analyse'])
  })
})

// Each case mounts the whole page and runs a declare-or-change round trip on the double.
describe('declaring and changing an agent', { timeout: 20_000 }, () => {
  it('an owner declares one in a few gestures: name, purpose, defaults for the rest', async () => {
    const { chat, view } = await open('owner')
    fireEvent.click(within(view).getByRole('button', { name: 'Nouvel agent' }))
    const form = screen.getByTestId('agent-form')
    // No drop-down: the model is a button, the first one chosen already.
    expect(within(form).queryByRole('combobox')).toBeNull()
    expect(within(form).getAllByRole('button', { pressed: true })[0]?.textContent).toContain('Rapide')
    fireEvent.change(within(form).getByLabelText('Nom'), { target: { value: 'Recouvrement' } })
    fireEvent.change(within(form).getByLabelText('À quoi il sert'), { target: { value: 'Suit les impayés.' } })
    const handle = within(form).getByLabelText('Identifiant (@…)')
    expect(handle instanceof HTMLInputElement && handle.value).toBe('recouvrement')
    fireEvent.click(within(form).getByRole('button', { name: 'Ajouter qonto au canal' }))
    fireEvent.click(within(form).getByRole('button', { name: 'Créer l\'agent' }))
    await waitFor(() => { expect(screen.queryByTestId('agent-form')).toBeNull() })
    const made = (await chat.agents()).find(a => a.handle === 'recouvrement')
    expect(made).toMatchObject({ name: 'Recouvrement', instructions: 'Suit les impayés.', provider: 'scaleway-genapi', model: 'deepseek-v4.1-flash', connectors: ['qonto'], eurPerMonth: 5 })
  })

  it('a handle already taken is said in words', async () => {
    const { view } = await open('owner')
    fireEvent.click(within(view).getByRole('button', { name: 'Nouvel agent' }))
    const form = screen.getByTestId('agent-form')
    fireEvent.change(within(form).getByLabelText('Nom'), { target: { value: 'Qwen' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Créer l\'agent' }))
    expect((await within(form).findByRole('alert')).textContent).toBe('L\'identifiant @qwen est déjà pris.')
  })

  it('a click on a tile opens its sheet; the handle stays as it is, and an admin cannot raise the ceiling', async () => {
    const { chat, view } = await open('admin')
    fireEvent.click(within(view).getByRole('button', { name: 'Voir Analyste' }))
    fireEvent.click(within(await screen.findByTestId('agent-sheet')).getByRole('button', { name: 'Modifier' }))
    const form = await screen.findByTestId('agent-form')
    const fixed = within(form).getByLabelText('Identifiant (@…)')
    expect(fixed instanceof HTMLInputElement && fixed.readOnly).toBe(true)
    expect(within(form).getByText('L\'identifiant ne change pas.')).toBeTruthy()
    fireEvent.change(within(form).getByLabelText('Plafond (€ / mois)'), { target: { value: '8' } })
    expect(within(form).getByRole('alert').textContent).toBe('Seul l\'owner peut relever un plafond.')
    const save = within(form).getByRole('button', { name: 'Enregistrer' })
    expect(save instanceof HTMLButtonElement && save.disabled).toBe(true)
    fireEvent.change(within(form).getByLabelText('Plafond (€ / mois)'), { target: { value: '3' } })
    fireEvent.change(within(form).getByLabelText('À quoi il sert'), { target: { value: 'Analyse les comptes.' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => { expect(screen.queryByTestId('agent-form')).toBeNull() })
    expect((await chat.agents()).find(a => a.id === 'agt_2')).toMatchObject({ handle: 'analyste', eurPerMonth: 3, instructions: 'Analyse les comptes.' })
  })

  it('an operator reads an agent\'s sheet but is offered neither its change nor a new agent', async () => {
    const { view } = await open('operator')
    expect(within(view).queryByRole('button', { name: 'Nouvel agent' })).toBeNull()
    fireEvent.click(within(view).getByRole('button', { name: 'Voir Analyste' }))
    expect(within(await screen.findByTestId('agent-sheet')).queryByRole('button', { name: 'Modifier' })).toBeNull()
    expect(within(view).getAllByTestId('team-agent')).toHaveLength(3)
  })
})

describe('the agent sheet, after review of #81', { timeout: 20_000 }, () => {
  /** @param form - the sheet. @param name - the label. @param value - what to type. */
  const type = (form: HTMLElement, name: string, value: string): void => {
    fireEvent.change(within(form).getByLabelText(name), { target: { value } })
  }
  /** @param form - the sheet. @param name - the button. @returns whether it is disabled. */
  const off = (form: HTMLElement, name: string): boolean => {
    const button = within(form).getByRole('button', { name })
    return button instanceof HTMLButtonElement && button.disabled
  }

  it('an admin creates at 5 EUR at most, and is told why; the owner up to 50', async () => {
    const { view } = await open('admin')
    fireEvent.click(within(view).getByRole('button', { name: 'Nouvel agent' }))
    const form = screen.getByTestId('agent-form')
    type(form, 'Nom', 'Recouvrement')
    expect(within(form).getByText('Jusqu\'à 5 € par mois : seul l\'owner fixe un plafond plus haut.')).toBeTruthy()
    type(form, 'Plafond (€ / mois)', '6')
    expect(within(form).getByRole('alert').textContent).toBe('Seul l\'owner peut relever un plafond.')
    expect(off(form, 'Créer l\'agent')).toBe(true)
    cleanup()
    const owner = await open('owner')
    fireEvent.click(within(owner.view).getByRole('button', { name: 'Nouvel agent' }))
    const sheet = screen.getByTestId('agent-form')
    type(sheet, 'Nom', 'Recouvrement')
    type(sheet, 'Plafond (€ / mois)', '60')
    expect(within(sheet).getByRole('alert').textContent).toBe('Un plafond est de 50 € par mois au plus.')
    type(sheet, 'Plafond (€ / mois)', '30')
    expect(within(sheet).queryByRole('alert')).toBeNull()
    expect(off(sheet, 'Créer l\'agent')).toBe(false)
  })

  it('an agent changed by someone else meanwhile is said, not overwritten', async () => {
    const { chat, view } = await open('owner')
    fireEvent.click(within(view).getByRole('button', { name: 'Voir Analyste' }))
    fireEvent.click(within(await screen.findByTestId('agent-sheet')).getByRole('button', { name: 'Modifier' }))
    const form = await screen.findByTestId('agent-form')
    await chat.updateAgent?.('agt_2', { instructions: 'Changé ailleurs.' })
    type(form, 'À quoi il sert', 'Ma version.')
    fireEvent.click(within(form).getByRole('button', { name: 'Enregistrer' }))
    expect((await within(form).findByRole('alert')).textContent).toBe('Cet agent a été modifié entre-temps : rouvrez sa fiche pour le voir tel qu\'il est.')
    expect((await chat.agents()).find(a => a.id === 'agt_2')?.instructions).toBe('Changé ailleurs.')
  })

  it('a connector the agent carries but that is no longer mounted is named before anything is sent', async () => {
    const carrying = [...AGENTS.slice(0, 2), { ...agent('agt_3', 'qwen', 'vllm-qwen', 'qwen-local'), connectors: ['dolibarr'] }]
    const { view } = await open('owner', carrying)
    fireEvent.click(within(view).getByRole('button', { name: 'Voir Qwen' }))
    fireEvent.click(within(await screen.findByTestId('agent-sheet')).getByRole('button', { name: 'Modifier' }))
    const form = await screen.findByTestId('agent-form')
    expect(within(form).getByRole('alert').textContent).toBe('Retirez d\'abord dolibarr, qui n\'est plus branché.')
    expect(off(form, 'Enregistrer')).toBe(true)
    fireEvent.click(within(form).getByRole('button', { name: /Retirer dolibarr/u }))
    expect(within(form).queryByRole('alert')).toBeNull()
  })

  it('the purpose is bounded at 2 000 characters and counted', async () => {
    const { view } = await open('owner')
    fireEvent.click(within(view).getByRole('button', { name: 'Nouvel agent' }))
    const form = screen.getByTestId('agent-form')
    const purpose = within(form).getByLabelText('À quoi il sert')
    expect(purpose instanceof HTMLTextAreaElement && purpose.maxLength).toBe(2000)
    type(form, 'À quoi il sert', 'abc')
    expect(within(form).getByText('3 / 2000')).toBeTruthy()
  })
})
