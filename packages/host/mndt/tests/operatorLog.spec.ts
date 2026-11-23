import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileGrants } from '../src/grants.ts'
import { warnOperator } from '../src/operator-log.ts'

describe('what the workbench tells its operator reaches standard error', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('writes the warning on one line to stderr, and to the logger', () => {
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true })
    const logged: string[] = []
    warnOperator({ logger: { warn: (message: string) => { logged.push(message) } } } as never, 'mndt: two\nlines')
    expect(written).toEqual(['mndt: two lines\n'])
    expect(logged).toEqual(['mndt: two\nlines'])
  })

  it('a role-file row set aside is said on stderr, once per change of the file', async () => {
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true })
    const dir = mkdtempSync(join(tmpdir(), 'operator-log-'))
    const file = join(dir, 'grants.json')
    writeFileSync(file, JSON.stringify({ grants: [{ subject: 'a@datanalysis.re', role: 'owner' }, { subject: 'b@datanalysis.re', role: 'viewr' }] }))
    const source = fileGrants(file, (message) => { warnOperator({ logger: { warn: () => undefined } } as never, message) })
    for (let i = 0; i < 5; i++) await source.grants()
    const said = written.filter(line => line.includes('is set aside and grants nothing'))
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('row 2')
  })
})
