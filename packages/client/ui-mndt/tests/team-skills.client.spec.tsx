// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CollabPage } from '../src/client/CollabPage.tsx'
import type { ChatAgent, ChatSkill } from '../src/client/chat.ts'
import { chatFrench } from '../src/client/chatLocales.ts'
import type { MndtFace, PageStateRow } from '../src/client/face.ts'
import { createMockChat } from '../src/client/mockChat.ts'
import { SkillPills } from '../src/client/skills.tsx'

afterEach(() => { cleanup() })

const you = 'stephane@datanalysis.re'
const at = '2026-11-24T08:00:00.000Z'
const agent: ChatAgent = { id: 'agt_1', handle: 'analyste', name: 'Analyste', provider: 'p', model: 'm', connectors: [], eurPerMonth: 5, createdBy: you, createdAt: at, skills: ['relances'] }
const skill = (slug: string, name: string, version = 1): ChatSkill => ({ slug, name, description: `Comment ${name}`, body: `## Étapes\n<b>${name}</b>`, version })
const SKILLS = [skill('relances', 'Relances', 3), skill('devis', 'Devis'), skill('rapports', 'Rapports'), skill('veille', 'Veille')]

/** @param role - the reader's role. @returns the Agents view over the double, and the double. */
async function open(role: string, skills: readonly ChatSkill[] = SKILLS) {
  const page: PageStateRow = { you, canWrite: true, canAdmin: role !== 'viewer', role, missions: [], briefs: [], approvals: [], memories: [] }
  const api = new Proxy({}, {
    get: (_t, key) => key === 'state' ? async () => page : key === 'members' || key === 'search' ? async () => [] : async () => { throw new Error('non utilise') },
  }) as MndtFace
  const chat = createMockChat({ you, agents: [agent], channels: [], skills }, () => Date.parse(at))
  render(<CollabPage api={api} chat={chat} tc={chatFrench} team={{}} />)
  const nav = await screen.findByTestId('side-nav')
  await waitFor(() => { expect(within(nav).getByRole('button', { name: 'Analyste' })).toBeTruthy() })
  fireEvent.click(within(nav).getByRole('button', { name: 'Agents' }))
  return { chat, section: await screen.findByTestId('skills', {}, { timeout: 5000 }) }
}

describe('the space\'s skills in the Agents view', { timeout: 20_000 }, () => {
  it('lists them readable; the body is folded and plain text', async () => {
    const { section } = await open('viewer')
    await waitFor(() => { expect(within(section).getAllByTestId('skill')).toHaveLength(4) })
    const first = within(section).getAllByTestId('skill')[0]
    expect(first?.textContent).toContain('Relances v3')
    expect(first?.querySelector('details')?.open).toBe(false)
    expect(first?.querySelector('b, h1, h2, h3, h4')).toBeNull()
    // A viewer only reads.
    expect(within(section).queryByRole('button', { name: 'Ajouter' })).toBeNull()
  })

  it('an admin pastes a SKILL.md; the fields without effect are said', async () => {
    const { section } = await open('admin')
    fireEvent.click(within(section).getByRole('button', { name: 'Ajouter' }))
    fireEvent.change(within(section).getByRole('textbox', { name: 'Le SKILL.md de la compétence' }), {
      target: { value: '---\nname: Litiges\ndescription: Traiter un litige client\nallowed-tools: Bash\nmodel: opus\n---\n\nÉcouter, puis proposer.' },
    })
    fireEvent.click(within(section).getByRole('button', { name: 'Enregistrer' }))
    expect((await within(section).findByTestId('skill-ignored')).textContent).toBe('Ces champs n\'ont aucun effet ici : allowed-tools, model.')
    await waitFor(() => { expect(within(section).getAllByTestId('skill')).toHaveLength(5) })
  })

  it('a change made meanwhile is said, nothing overwritten', async () => {
    const { chat, section } = await open('owner')
    await waitFor(() => { expect(within(section).getAllByTestId('skill')).toHaveLength(4) })
    await chat.updateSkill?.('devis', { markdown: '---\nname: Devis\ndescription: Ailleurs\n---\nautre', version: 1 })
    const devis = within(section).getAllByTestId('skill')[1]
    if (devis === undefined) throw new Error('no skill')
    fireEvent.click(within(devis).getByRole('button', { name: 'Modifier' }))
    fireEvent.click(within(section).getByRole('button', { name: 'Enregistrer' }))
    expect((await within(section).findByRole('alert')).textContent).toBe('Cette compétence a été modifiée entre-temps : relisez-la avant de la changer.')
  })

  it('removing is asked once, naming the skill', async () => {
    const { section } = await open('owner')
    await waitFor(() => { expect(within(section).getAllByTestId('skill')).toHaveLength(4) })
    const veille = within(section).getAllByTestId('skill')[3]
    if (veille === undefined) throw new Error('no skill')
    fireEvent.click(within(veille).getByRole('button', { name: 'Supprimer' }))
    expect(within(veille).getByTestId('skill-delete-confirm').textContent).toContain('Supprimer la compétence « Veille » ?')
    fireEvent.click(within(within(veille).getByTestId('skill-delete-confirm')).getByRole('button', { name: 'Supprimer' }))
    await waitFor(() => { expect(within(section).getAllByTestId('skill')).toHaveLength(3) })
  })
})

describe('an agent\'s skills, as pills', () => {
  it('three at most: the others are greyed with the reason; each with its version', () => {
    const onChange = vi.fn()
    render(<SkillPills skills={SKILLS} chosen={['relances', 'devis', 'rapports']} onChange={onChange} t={chatFrench} />)
    const veille = screen.getByRole('button', { name: 'Veille, trois compétences au plus' })
    expect(veille.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(veille)
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Relances' }).textContent).toContain('v3')
  })

  it('on a sheet: the agent\'s skills by name and version, nothing to tick', async () => {
    await open('viewer')
    fireEvent.click(await screen.findByRole('button', { name: 'Voir Analyste' }))
    const sheet = await screen.findByTestId('agent-sheet')
    await waitFor(() => { expect(within(sheet).getByTestId('agent-skills').textContent).toBe('Relancesv3') })
  })
})

describe('ticking an agent\'s skills in its form', { timeout: 20_000 }, () => {
  it('saves the skills ticked', async () => {
    const { chat } = await open('owner')
    fireEvent.click(await screen.findByRole('button', { name: 'Voir Analyste' }))
    fireEvent.click(within(await screen.findByTestId('agent-sheet')).getByRole('button', { name: 'Modifier' }))
    const form = await screen.findByTestId('agent-form')
    fireEvent.click(within(within(form).getByTestId('skill-pills')).getByRole('button', { name: 'Devis' }))
    fireEvent.click(within(form).getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => { expect(screen.queryByTestId('agent-form')).toBeNull() })
    expect((await chat.agents())[0]?.skills).toEqual(['relances', 'devis'])
  })
})

describe('the core\'s refusals of a skill, in words', { timeout: 20_000 }, () => {
  it('a name already taken (skill-exists) is said', async () => {
    const { section } = await open('owner')
    fireEvent.click(within(section).getByRole('button', { name: 'Ajouter' }))
    fireEvent.change(within(section).getByRole('textbox', { name: 'Le SKILL.md de la compétence' }), {
      target: { value: '---\nname: Devis\ndescription: encore\n---\nx' },
    })
    fireEvent.click(within(section).getByRole('button', { name: 'Enregistrer' }))
    expect((await within(section).findByRole('alert')).textContent).toBe('Une compétence porte déjà ce nom.')
  })

  it('a SKILL.md without front matter (missing-fields) is said', async () => {
    const { section } = await open('owner')
    fireEvent.click(within(section).getByRole('button', { name: 'Ajouter' }))
    fireEvent.change(within(section).getByRole('textbox', { name: 'Le SKILL.md de la compétence' }), { target: { value: 'juste du texte' } })
    fireEvent.click(within(section).getByRole('button', { name: 'Enregistrer' }))
    expect((await within(section).findByRole('alert')).textContent).toBe('Un SKILL.md demande un en-tête avec un nom, et un texte.')
  })
})
