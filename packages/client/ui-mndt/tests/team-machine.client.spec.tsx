// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatRefusal } from '../src/client/chat.ts'
import type { ChatFace } from '../src/client/chat.ts'
import { chatFrench } from '../src/client/chatLocales.ts'
import { MachineScreen, machineOf, machinesServed } from '../src/client/machine.tsx'

afterEach(cleanup)

type Face = Pick<ChatFace, 'machine' | 'startMachine' | 'stopMachine' | 'machineMembers'>

/** @returns a face over one computer, in the state given. */
function face(state: string, over: Partial<Face> = {}): Face & { calls: string[] } {
  let now: Record<string, unknown> = { state, capacity: { used: state === 'running' ? 1 : 0, max: 4 } }
  if (state === 'running') now = { ...now, startedAt: '2026-11-27T05:00:00.000Z', stopsAt: '2026-11-27T05:15:00.000Z' }
  const calls: string[] = []
  return {
    calls,
    machine: async () => now,
    startMachine: async () => { calls.push('start'); now = { ...now, state: 'running', startedAt: '2026-11-27T05:00:00.000Z' }; return now },
    stopMachine: async () => { calls.push('stop'); now = { state: 'stopped', capacity: { used: 0, max: 4 } }; return now },
    machineMembers: async () => ({ machines: [{ member: 'smarion@datanalysis.re', state: 'running', startedAt: '2026-11-27T04:50:00.000Z' }, { member: 'x@y', state: 'stopped' }], capacity: { used: 1, max: 4 } }),
    ...over,
  }
}

const draw = (f: Face, canSeeMembers = false): void => {
  render(<MachineScreen face={f} canSeeMembers={canSeeMembers} names={{ 'smarion@datanalysis.re': 'Sophie Marion' }} title="Mon ordinateur" t={chatFrench} />)
}

describe('« Mon ordinateur »', () => {
  it('stopped: says so, and Démarrer starts it in one click', async () => {
    const f = face('stopped')
    draw(f)
    expect((await screen.findByTestId('machine-state')).textContent).toBe('Arrêté')
    fireEvent.click(screen.getByRole('button', { name: 'Démarrer' }))
    await waitFor(() => { expect(screen.getByTestId('machine-state').textContent).toBe('Allumé') })
    expect(f.calls).toEqual(['start'])
  })

  it('on: since when, when it stops by itself, the capacity; Arrêter in one click', async () => {
    const f = face('running')
    draw(f)
    await screen.findByTestId('machine-stops')
    expect(screen.getByTestId('machine-capacity').textContent).toBe('Ordinateurs : 1 / 4 en marche')
    fireEvent.click(screen.getByRole('button', { name: 'Arrêter' }))
    await waitFor(() => { expect(screen.getByTestId('machine-state').textContent).toBe('Arrêté') })
    expect(f.calls).toEqual(['stop'])
  })

  it('every computer taken: one fixed sentence, never the served text', async () => {
    draw(face('stopped', { startMachine: async () => { throw new ChatRefusal('les 4 ordinateurs sont occupés sk-live', 409, 'machines-busy') } }))
    fireEvent.click(await screen.findByRole('button', { name: 'Démarrer' }))
    expect((await screen.findByTestId('machine-error')).textContent).toBe('Les 4 ordinateurs de l\'espace sont occupés : réessayez dans un moment.')
  })

  it('another failure reads the generic sentence', async () => {
    draw(face('stopped', { startMachine: async () => { throw new TypeError('Failed to fetch https://10.0.0.4') } }))
    fireEvent.click(await screen.findByRole('button', { name: 'Démarrer' }))
    const said = await screen.findByTestId('machine-error')
    expect(said.textContent).toBe('Votre ordinateur ne répond pas pour l\'instant : réessayez dans un moment.')
  })

  it('two clicks make one call', async () => {
    let release: () => void = () => undefined
    const calls: string[] = []
    draw(face('stopped', { startMachine: () => { calls.push('start'); return new Promise((resolve) => { release = () => { resolve({ state: 'running' }) } }) } }))
    const button = await screen.findByRole('button', { name: 'Démarrer' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(calls).toEqual(['start'])
    release()
  })

  it('the owner sees who has one on, by name, never what it shows; a member does not', async () => {
    draw(face('stopped'), true)
    const list = await screen.findByTestId('machine-members')
    expect(within(list).getAllByTestId('machine-member')).toHaveLength(1)
    expect(within(list).getByTestId('machine-member').textContent).toContain('Sophie Marion · Allumé')
    cleanup()
    draw(face('stopped'), false)
    await screen.findByTestId('machine-state')
    expect(screen.queryByTestId('machine-members')).toBeNull()
  })

  it('a state the page does not know reads as stopped; odd fields are dropped', () => {
    expect(machineOf({ state: 'flying', stopsAt: 'nope', capacity: { used: 'x', max: 4 } })).toEqual({ state: 'stopped' })
  })

  it('an instance without computers (503 no-machines, or no route) is not offered the place', async () => {
    expect(await machinesServed({ machine: async () => { throw new ChatRefusal('no machine service', 503, 'no-machines') } })).toBe(false)
    expect(await machinesServed({ machine: async () => { throw new ChatRefusal('no route', 404) } })).toBe(false)
    expect(await machinesServed({ machine: async () => ({ state: 'stopped' }) })).toBe(true)
    expect(await machinesServed({})).toBe(false)
  })

  it('a member without a served name reads as a name, never the raw address', async () => {
    const f = face('stopped', { machineMembers: async () => ({ machines: [{ member: 'paul.grondin@datanalysis.re', state: 'running' }], capacity: { used: 1, max: 4 } }) })
    render(<MachineScreen face={f} canSeeMembers names={{}} title="Mon ordinateur" t={chatFrench} />)
    const row = await screen.findByTestId('machine-member')
    expect(row.textContent).not.toContain('@datanalysis.re')
    expect(row.textContent).toContain('paul.grondin')
  })

  it('two clicks on Arrêter make one call', async () => {
    let release: () => void = () => undefined
    const calls: string[] = []
    draw(face('running', { stopMachine: () => { calls.push('stop'); return new Promise((resolve) => { release = () => { resolve({ state: 'stopped' }) } }) } }))
    const button = await screen.findByRole('button', { name: 'Arrêter' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(calls).toEqual(['stop'])
    release()
  })
})
