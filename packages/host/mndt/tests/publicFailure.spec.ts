/**
 * A served failure says the host's words, never words it did not write
 * (coordination, 25/11, on #157). One rule, publicFailure: a Refusal is served
 * as such, anything else as the caller's fixed sentence, and the error itself
 * goes to the operator's log. The guard below refuses an error's own text in an
 * answer anywhere else.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryStore, Refusal, SkillRefusal, WorkbenchService } from '../src/core/index.ts'
import type { WorkbenchState } from '../src/core/index.ts'
import { createMndtApi } from '../src/api.ts'
import { publicFailure } from '../src/public-failure.ts'

/** A line that serves something: an HTTP answer, a machine tool's answer, a role table's reason. */
const SERVES = /respond\(|JSON\.stringify\(\{ ok: false|ok: false, reason:/
/** An error's own text: its message, or the error made a string. */
const RAW = /messageOf\(|\b(error|err|e|cause)\.message\b|String\((error|err|e)\)|rawDetail\(/

/** @param text - a source file. @returns the lines that serve an error's own text. */
function rawServed(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(line => SERVES.test(line) && RAW.test(line))
}

describe('a served failure', () => {
  it('no file of src/ serves an error\'s own text but through publicFailure', () => {
    const src = join(import.meta.dirname, '..', 'src')
    const found = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter(file => file.endsWith('.ts') && file.split('\\').join('/') !== 'public-failure.ts')
      .flatMap(file => rawServed(readFileSync(join(src, file), 'utf8')).map(line => `${file}: ${line}`))
    expect(found).toEqual([])
  })

  it('the guard bites, through its own predicate', () => {
    expect(rawServed('      return respond(502, { error: `unreachable: ${messageOf(error)}` })')).toHaveLength(1)
    expect(rawServed('      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })')).toHaveLength(1)
    expect(rawServed('        return { ok: false, reason: error instanceof Error ? error.message : String(error) }')).toHaveLength(1)
    expect(rawServed("      return respond(502, { error: failure(error, 'the desktop agent is unreachable', 'the desktop agent') })")).toEqual([])
    expect(rawServed('      await service.failMission(started.id, messageOf(error))')).toEqual([])
  })

  it('a refusal of the host is served as such; anything else as the fixed sentence, its text in the operator\'s log only', () => {
    const log: string[] = []
    expect(publicFailure(new Refusal('a rejection needs a reason'), 'refused', line => log.push(line))).toBe('a rejection needs a reason')
    expect(publicFailure(new SkillRefusal('unknown-skill', 'no skill relance'), 'refused', line => log.push(line))).toBe('no skill relance')
    expect(log).toEqual([])
    const foreign = Object.assign(new Error('connect ECONNREFUSED 10.0.3.7:8443'), { errno: -111, syscall: 'connect' })
    expect(publicFailure(foreign, 'the desktop agent is unreachable', line => log.push(line), 'the desktop agent')).toBe('the desktop agent is unreachable')
    expect(publicFailure(new TypeError('fetch failed'), 'unreachable', line => log.push(line))).toBe('unreachable')
    // A plain Error from a library is not the host's word either.
    expect(publicFailure(new Error('provider req_77 shard eu-3'), 'failed', line => log.push(line))).toBe('failed')
    expect(log).toEqual([
      'mndt: the desktop agent: Error: connect ECONNREFUSED 10.0.3.7:8443',
      'mndt: internal error: TypeError: fetch failed',
      'mndt: internal error: Error: provider req_77 shard eu-3',
    ])
  })

  it('through the API: a fault of the store is « internal error », its path in the operator\'s log only', async () => {
    class BrokenStore extends MemoryStore {
      override save(_state: WorkbenchState): Promise<void> {
        return Promise.reject(Object.assign(new Error("EACCES: permission denied, open '/secret/state.json'"), { errno: -13, syscall: 'open' }))
      }
    }
    const warned: string[] = []
    const owner = 'duke@datanalysis.re'
    const api = createMndtApi({
      service: new WorkbenchService({ store: new BrokenStore() }),
      runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
      identity: { tokens: { owner: { user: owner } } },
      grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }] }) },
      warn: (line) => { warned.push(line) },
    })
    const answer = await api({ method: 'POST', path: '/channels', authorization: 'Bearer owner', body: JSON.stringify({ name: 'compta' }) })
    expect(answer.status).toBe(500)
    expect(answer.body).toEqual({ error: 'internal error' })
    expect(warned.join('\n')).toContain('/secret/state.json')
  })

  it('a refusal of the service keeps its words for the caller', async () => {
    const owner = 'duke@datanalysis.re'
    const service = new WorkbenchService({ store: new MemoryStore() })
    const api = createMndtApi({
      service,
      runner: { run: async () => ({ title: 't', markdown: 'm', sources: [] }) },
      identity: { tokens: { owner: { user: owner } } },
      grants: { grants: async () => ({ ok: true, grants: [{ subject: owner, role: 'owner' }] }) },
    })
    const card = await service.requestApproval({ kind: 'spend', title: 'Achat', payload: {}, requestedBy: owner })
    const refused = await api({ method: 'POST', path: `/approvals/${card.id}/decide`, authorization: 'Bearer owner', body: JSON.stringify({ decision: 'rejected' }) })
    expect(refused.body).toMatchObject({ error: 'a rejection needs a reason' })
  })
})
