import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import { NEVER_READABLE, READ_ROOTS_ENV, bwrapProfileArgs, landlockProfileArgs, readRoots } from '../src/profiles.ts'

const WW = { mode: 'workspace-write' as const, workspaceRoot: '/ws' }

describe('the read allow-list (DSH_SANDBOX_READ_ROOTS)', () => {
  it('changes nothing when it is not set: Landlock reads /, bwrap binds /', () => {
    expect(readRoots({})).toBeUndefined()
    expect(landlockProfileArgs(WW, null)).toEqual(['--ro', '/', '--rw', '/dev/null', '--rw', '/tmp', '--rw', '/ws'])
    expect(bwrapProfileArgs(WW, null)[0]).toBe('--ro-bind')
  })

  it('gives Landlock exactly the listed roots to read, the private temp instead of /tmp, and drops a root missing on this host', () => {
    const present = mkdtempSync(join(tmpdir(), 'root-'))
    const roots = readRoots({ [READ_ROOTS_ENV]: `/usr:${present}/:/no/such/dir` })
    expect(roots).toEqual(['/usr', present])
    expect(landlockProfileArgs(WW, roots ?? null, '/tmp/dsh-run-a')).toEqual(['--ro', '/usr', '--ro', present, '--rw', '/dev/null', '--rw', '/tmp/dsh-run-a', '--rw', '/ws'])
    // / is never among the readable roots once an allow-list is set, nor the shared /tmp.
    expect(landlockProfileArgs(WW, roots ?? null, '/tmp/dsh-run-a')).not.toContain('/')
    expect(landlockProfileArgs(WW, roots ?? null, '/tmp/dsh-run-a')).not.toContain('/tmp')
  })

  it('never grants the shared /tmp under an allow-list: without a private temp, workspace-write is refused', () => {
    expect(() => landlockProfileArgs(WW, ['/usr'])).toThrow(SandboxUnavailableError)
    expect(() => landlockProfileArgs(WW, ['/usr'])).toThrow(/no private temp directory/)
    // read-only writes nothing but /dev/null: no temp at all.
    expect(landlockProfileArgs({ mode: 'read-only', workspaceRoot: '/ws' }, ['/usr'])).toEqual(['--ro', '/usr', '--rw', '/dev/null'])
  })

  it('fails closed on a value that could reopen /, or that names nothing present', () => {
    // Set but blank restricts nothing: refused, never « inactive ».
    for (const value of ['', '  ', ':', '/', '//', 'usr', './etc', '/usr/../', '/state/..', '/no/such/dir:/neither', '/proc', '/run', '/root/x']) {
      expect(() => readRoots({ [READ_ROOTS_ENV]: value }), value).toThrow(SandboxUnavailableError)
    }
  })

  it('refuses the bwrap runner once an allow-list is set: it would bind all of / read-only', () => {
    expect(() => bwrapProfileArgs(WW, ['/usr'])).toThrow(SandboxUnavailableError)
    expect(() => bwrapProfileArgs(WW, ['/usr'])).toThrow(/does not apply a read allow-list/)
  })

  it('follows a link as the launcher does: a root leading to / or into a guarded path is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'links-'))
    symlinkSync('/', join(dir, 'everything'))
    symlinkSync('/proc', join(dir, 'processes'))
    symlinkSync('/usr', join(dir, 'system'))
    expect(() => readRoots({ [READ_ROOTS_ENV]: join(dir, 'everything') })).toThrow(/never readable/)
    expect(() => readRoots({ [READ_ROOTS_ENV]: join(dir, 'processes') })).toThrow(/never readable/)
    expect(readRoots({ [READ_ROOTS_ENV]: `${join(dir, 'system')}:/usr` })).toEqual(['/usr'])
  })

  it('takes single files, as /dev/null, and never the rest of /dev', () => {
    expect(readRoots({ [READ_ROOTS_ENV]: '/usr:/dev/null:/dev/urandom' })).toEqual(['/usr', '/dev/null', '/dev/urandom'])
    expect(NEVER_READABLE).toEqual(['/state', '/data', '/run', '/root', '/proc'])
  })
})
