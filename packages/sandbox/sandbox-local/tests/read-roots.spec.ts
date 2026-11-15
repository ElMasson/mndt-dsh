import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import { READ_ROOTS_ENV, bwrapProfileArgs, landlockProfileArgs, readRoots } from '../src/profiles.ts'

const WW = { mode: 'workspace-write' as const, workspaceRoot: '/ws' }

describe('the read allow-list (DSH_SANDBOX_READ_ROOTS)', () => {
  it('changes nothing when it is not set: Landlock reads /, bwrap binds /', () => {
    expect(readRoots({})).toBeUndefined()
    expect(readRoots({ [READ_ROOTS_ENV]: '  ' })).toBeUndefined()
    expect(landlockProfileArgs(WW, null)).toEqual(['--ro', '/', '--rw', '/dev/null', '--rw', '/tmp', '--rw', '/ws'])
    expect(bwrapProfileArgs(WW, null)[0]).toBe('--ro-bind')
  })

  it('gives Landlock exactly the listed roots to read, writes unchanged, and drops a root missing on this host', () => {
    const present = mkdtempSync(join(tmpdir(), 'root-'))
    const roots = readRoots({ [READ_ROOTS_ENV]: `/usr:${present}/:/no/such/dir` })
    expect(roots).toEqual(['/usr', present])
    expect(landlockProfileArgs(WW, roots ?? null)).toEqual(['--ro', '/usr', '--ro', present, '--rw', '/dev/null', '--rw', '/tmp', '--rw', '/ws'])
    // / is never among the readable roots once an allow-list is set.
    expect(landlockProfileArgs(WW, roots ?? null)).not.toContain('/')
  })

  it('fails closed on a value that could reopen /, or that names nothing present', () => {
    for (const value of ['/', '//', 'usr', './etc', '/usr/../', '/state/..', '/no/such/dir:/neither']) {
      expect(() => readRoots({ [READ_ROOTS_ENV]: value }), value).toThrow(SandboxUnavailableError)
    }
  })

  it('refuses the bwrap runner once an allow-list is set: it would bind all of / read-only', () => {
    expect(() => bwrapProfileArgs(WW, ['/usr'])).toThrow(SandboxUnavailableError)
    expect(() => bwrapProfileArgs(WW, ['/usr'])).toThrow(/does not apply a read allow-list/)
  })
})
