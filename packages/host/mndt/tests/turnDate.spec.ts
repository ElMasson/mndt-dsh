/**
 * The host serves the date and time at the head of every prompt it sends the
 * model. Found live on 24/11: an agent said « nos échanges sont horodatés le
 * 16/11/2026 », having no clock (the engine's time-context does not reach a
 * workflow's agent: 63 of 63 calls of a rehearsal carried no date) and
 * guessing from what it read.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dateLine, instanceTimeZone, MemoryStore, WorkbenchService } from '../src/core/index.ts'
import type { PriceGrid } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import { TurnScheduler } from '../src/turns.ts'
import type { TurnEngine, TurnInput, TurnOutput } from '../src/turns.ts'

const owner = 'duke@datanalysis.re'
const PRICES: PriceGrid = { 'route-a/*': { input: 1, output: 2 }, 'route-b/*': { input: 3, output: 4 } }
const NOW = new Date('2026-11-24T08:18:36Z')
const LINE = 'Nous sommes le mardi 24 novembre 2026, 12:18 (heure de La Réunion).'

class Engine implements TurnEngine {
  readonly seen: TurnInput[] = []
  async run(input: TurnInput): Promise<TurnOutput> {
    this.seen.push(input)
    if (input.turnId.endsWith('-v')) return { text: '{"ok": true}', tokens: { input: 10, output: 1 } }
    return { text: `réponse de ${input.agent.handle}`, tokens: { input: 10, output: 1 } }
  }
}

function bench(timeZone = 'Indian/Reunion') {
  const service = new WorkbenchService({ store: new MemoryStore() })
  const engine = new Engine()
  const turns = new TurnScheduler({ service, engine, prices: PRICES, dataDir: '/data/mndt', timeZone, now: () => NOW })
  const api = createMndtApi({
    service, runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) }, turns,
    identity: { tokens: { owner: { user: owner } } },
    grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }] }) },
  })
  const call = async (method: string, path: string, body?: unknown) => {
    const answer = await api({ method, path, authorization: 'Bearer owner', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: answer.status, body: answer.body as Record<string, unknown> }
  }
  const agent = async (handle: string, provider = 'route-a') =>
    ((await call('POST', '/agents', { handle, name: handle, provider, model: 'm', eurPerMonth: 5 })).body.agent as { id: string }).id
  return { engine, turns, call, agent }
}

describe('the date line', () => {
  it('reads the date and time in the instance\'s zone, in French', () => {
    expect(dateLine(NOW, 'Indian/Reunion')).toBe(LINE)
    expect(dateLine(NOW, 'Indian/Mauritius')).toBe('Nous sommes le mardi 24 novembre 2026, 12:18 (heure normale de Maurice).')
    // Near midnight, the zone changes the day.
    expect(dateLine(new Date('2026-11-24T21:30:00Z'), 'Indian/Reunion')).toBe('Nous sommes le mercredi 25 novembre 2026, 01:30 (heure de La Réunion).')
    expect(dateLine(new Date('2026-11-24T21:30:00Z'), 'UTC')).toContain('mardi 24 novembre 2026, 21:30')
  })

  it('the instance\'s zone: the one configured, else the process\'s, a wrong one refused and said', () => {
    expect(instanceTimeZone('Indian/Reunion')).toEqual({ timeZone: 'Indian/Reunion' })
    const own = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(instanceTimeZone(undefined)).toEqual({ timeZone: own })
    expect(instanceTimeZone('  ')).toEqual({ timeZone: own })
    const wrong = instanceTimeZone('Mars/Olympus')
    expect(wrong.timeZone).toBe(own)
    expect(wrong.refused).toContain('« Mars/Olympus » is not an IANA time zone')
  })
})

describe('every prompt sent to the model opens with it', () => {
  it('a plain turn', async () => {
    const b = bench()
    const alpha = await b.agent('alpha')
    const channel = ((await b.call('POST', '/channels', { name: 'compta', agents: [alpha], members: [] })).body.channel as { id: string }).id
    await b.call('POST', `/channels/${channel}/messages`, { text: '@alpha bonjour' })
    await b.turns.settled()
    expect(b.engine.seen).toHaveLength(1)
    expect(b.engine.seen[0]!.prompt.startsWith(`${LINE}\n\n`)).toBe(true)
  })

  it('an author and its verifier, then workers and their synthesis', async () => {
    const b = bench()
    const alpha = await b.agent('alpha')
    const beta = await b.agent('beta', 'route-b')
    const gamma = await b.agent('gamma')
    const verified = ((await b.call('POST', '/channels', { name: 'verif', agents: [alpha, beta], members: [] })).body.channel as { id: string }).id
    await b.call('POST', `/channels/${verified}/coordination`, { mode: 'author-verifier', author: alpha, verifier: beta })
    await b.call('POST', `/channels/${verified}/messages`, { text: '@alpha la facture 42 ?' })
    const parallel = ((await b.call('POST', '/channels', { name: 'para', agents: [alpha, beta, gamma], members: [] })).body.channel as { id: string }).id
    await b.call('POST', `/channels/${parallel}/coordination`, { mode: 'parallel-synthesis', workers: [alpha, beta], synthesizer: gamma })
    await b.call('POST', `/channels/${parallel}/messages`, { text: '@gamma le point du mois ?' })
    await b.turns.settled()
    // Author, verifier, two workers and the synthesis: five calls, each one dated.
    expect(b.engine.seen.length).toBeGreaterThanOrEqual(5)
    expect(b.engine.seen.filter(input => !input.prompt.startsWith(`${LINE}\n\n`)).map(input => input.turnId)).toEqual([])
  })

  it('computed at each call, in the zone given', async () => {
    const b = bench('Indian/Mauritius')
    const alpha = await b.agent('alpha')
    const channel = ((await b.call('POST', '/channels', { name: 'compta', agents: [alpha], members: [] })).body.channel as { id: string }).id
    await b.call('POST', `/channels/${channel}/messages`, { text: '@alpha bonjour' })
    await b.turns.settled()
    expect(b.engine.seen[0]!.prompt.split('\n')[0]).toBe('Nous sommes le mardi 24 novembre 2026, 12:18 (heure normale de Maurice).')
  })

  it('the scheduler calls the engine in one place only, so no prompt goes out undated', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'turns.ts'), 'utf8')
    expect(source.match(/engine\.run\(/g)).toHaveLength(1)
  })
})
