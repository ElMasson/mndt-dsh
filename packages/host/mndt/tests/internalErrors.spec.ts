import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonFileStore, MemoryStore, WorkbenchService } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import type { MissionRunner } from '../src/api.ts'

const owner = 'duke@datanalysis.re'
const noMissions: MissionRunner = { run: async () => ({ title: 't', markdown: 'm', sources: [] }) }

/** @param fault - what createChannel throws. @returns the API and what reached the operator's log. */
function bench(fault: () => never) {
  const service = new WorkbenchService({ store: new MemoryStore() })
  Object.assign(service, { createChannel: async () => fault() })
  const logged: string[] = []
  const api = createMndtApi({
    service,
    runner: noMissions,
    identity: { tokens: { owner: { user: owner } } },
    grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }] }) },
    warn: (message) => { logged.push(message) },
  })
  const create = () => api({ method: 'POST', path: '/channels', authorization: 'Bearer owner', body: JSON.stringify({ name: 'compta', agents: [], members: [] }) })
  return { create, logged }
}

describe('a conversation route never serves an internal fault as a refusal', () => {
  it('a TypeError answers 500 « internal error », its detail in the operator log only', async () => {
    const { create, logged } = bench(() => { throw new TypeError("Cannot read properties of undefined (reading 'members')") })
    const answer = await create()
    expect(answer.status).toBe(500)
    expect(answer.body).toEqual({ error: 'internal error' })
    expect(logged).toEqual(["mndt: internal error on POST /channels: TypeError: Cannot read properties of undefined (reading 'members')"])
  })

  it('a system error, whose message carries a path, answers 500 without it', async () => {
    const { create, logged } = bench(() => { throw Object.assign(new Error("EACCES: permission denied, open '/state/state.json'"), { code: 'EACCES', errno: -13, syscall: 'open' }) })
    const answer = await create()
    expect(answer.status).toBe(500)
    expect(JSON.stringify(answer.body)).not.toContain('/state/state.json')
    expect(logged[0]).toContain('/state/state.json')
  })

  it('a refusal the product means keeps its status and its words', async () => {
    const plain = bench(() => { throw new Error('a channel keeps at least one person') })
    expect(await plain.create()).toMatchObject({ status: 400, body: { error: 'a channel keeps at least one person' } })
    expect(plain.logged).toEqual([])
    const missing = bench(() => { throw new Error('no channel ch_x') })
    expect((await missing.create()).status).toBe(404)
    class SampleRefusal extends Error {
      readonly code = 'same-agent'
      constructor() { super('the author and the verifier must be two agents'); this.name = 'SampleRefusal' }
    }
    const typed = bench(() => { throw new SampleRefusal() })
    expect(await typed.create()).toMatchObject({ status: 400, body: { error: 'the author and the verifier must be two agents', code: 'same-agent' } })
  })

  /** @param text - the state file's content. @returns a POST /channels on a service reading it, and the log. */
  function onStateFile(text: string) {
    const path = join(mkdtempSync(join(tmpdir(), 'state-')), 'state.json')
    writeFileSync(path, text)
    const logged: string[] = []
    const api = createMndtApi({
      service: new WorkbenchService({ store: new JsonFileStore(path) }),
      runner: noMissions,
      identity: { tokens: { owner: { user: owner } } },
      grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }] }) },
      warn: (message) => { logged.push(message) },
    })
    const create = () => api({ method: 'POST', path: '/channels', authorization: 'Bearer owner', body: JSON.stringify({ name: 'compta', agents: [], members: [] }) })
    return { path, create, logged }
  }

  it('a state file of another version answers 500: its path in the operator log, never served', async () => {
    const { path, create, logged } = onStateFile('{"version": 2}')
    const answer = await create()
    expect(answer.status).toBe(500)
    expect(JSON.stringify(answer.body)).not.toContain(path)
    expect(logged).toEqual([`mndt: internal error on POST /channels: StateFileError: the workbench state is not a version 1 state; refusing to overwrite it (${path})`])
  })

  it('a state file that is not JSON is said by its position, never by the text it holds', async () => {
    const { create, logged } = onStateFile('{"version": 1, "messages": [{"text": "Le salaire de Marion est confidentiel"')
    const answer = await create()
    expect(answer.status).toBe(500)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatch(/StateFileError: the workbench state is not JSON( \(at position \d+\))?; refusing to overwrite it/)
    expect(logged[0]).not.toContain('Marion')
    expect(JSON.stringify(answer.body)).not.toContain('Marion')
  })

  it('a SyntaxError from anywhere else is logged by its name and position only', async () => {
    let thrown: unknown
    try { JSON.parse('{"prompt": "Le brief confidentiel du client') } catch (error) { thrown = error }
    const { create, logged } = bench(() => { throw thrown as never })
    expect((await create()).status).toBe(500)
    expect(logged[0]).toMatch(/^mndt: internal error on POST \/channels: SyntaxError( at position \d+)?$/)
    expect(logged[0]).not.toContain('confidentiel')
  })
})
