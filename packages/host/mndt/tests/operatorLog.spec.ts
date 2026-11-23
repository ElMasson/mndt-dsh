import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileGrants } from '../src/grants.ts'
import { MAX_OPERATOR_LINE, clearOperatorWarning, errorShape, operatorLine, warnOperator, warnOperatorOnce } from '../src/operator-log.ts'

describe('what the workbench tells its operator reaches standard error', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('writes the warning on one clean line to stderr and to the logger', () => {
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true })
    const logged: string[] = []
    warnOperator({ logger: { warn: (message: string) => { logged.push(message) } } } as never, 'mndt: two\nlines')
    expect(written).toEqual(['mndt: two lines\n'])
    // The logger gets the same clean line: a future exporter must not reopen the forgery.
    expect(logged).toEqual(['mndt: two lines'])
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

  it('a value cannot forge a line nor drive the terminal: control characters, escapes and separators become spaces, bounded', () => {
    const forged = 'mndt: mandate x\u2028mndt: no gateway secret\u001b[2J\u0000 by a\u2029b\u007f'
    expect(operatorLine(forged)).toBe('mndt: mandate x mndt: no gateway secret [2J  by a b ')
    expect(operatorLine(forged)).not.toMatch(/[\u0000-\u001f\u007f\u2028\u2029]/)
    const long = operatorLine(`mndt: ${'x'.repeat(5000)}`)
    expect(long).toHaveLength(MAX_OPERATOR_LINE)
    expect(long.endsWith('…')).toBe(true)
  })

  it('a check that runs every pass speaks once, and again only after it passed', () => {
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true })
    const ctx = { logger: { warn: () => undefined } } as never
    for (let i = 0; i < 10; i++) warnOperatorOnce(ctx, 'tick-test', 'mndt: automations skipped')
    expect(written).toHaveLength(1)
    warnOperatorOnce(ctx, 'tick-test', 'mndt: automations skipped, another reason')
    expect(written).toHaveLength(2)
    clearOperatorWarning('tick-test')
    warnOperatorOnce(ctx, 'tick-test', 'mndt: automations skipped')
    expect(written).toHaveLength(3)
  })

  it('an unreadable automations file is said by its shape, never by its text', () => {
    let caught: unknown
    try { JSON.parse('{"prompt": "Le brief confidentiel du client' ) } catch (error) { caught = error }
    const shape = errorShape(caught)
    expect(shape).toMatch(/^SyntaxError( at position \d+)?$/)
    expect(shape).not.toContain('confidentiel')
    expect(errorShape(Object.assign(new Error('ENOENT: no such file, open /state/automations.json'), { code: 'ENOENT' }))).toBe('Error ENOENT')
  })

  it('a closed standard error does not bring the process down', () => {
    expect(process.stderr.listenerCount('error')).toBeGreaterThan(0)
  })
})
