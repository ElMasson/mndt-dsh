import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = join(import.meta.dirname, '..', 'deploy', 'tenant', 'render-authenticated-emails.py')

/** @param grants - the role table. @param previous - an earlier list, if any. @returns the run and the list it leaves. */
function render(grants: unknown, previous?: string): { status: number | null; stderr: string; list: string | undefined; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'emails-'))
  const output = join(dir, 'authenticated_emails')
  if (previous !== undefined) writeFileSync(output, previous)
  writeFileSync(join(dir, 'grants.json'), typeof grants === 'string' ? grants : JSON.stringify(grants))
  const run = spawnSync('python3', [script, join(dir, 'grants.json'), output, 'datanalysis.re,duke-analytics.com'], { encoding: 'utf8' })
  return { status: run.status, stderr: run.stderr, list: existsSync(output) ? readFileSync(output, 'utf8') : undefined, output }
}

describe('the sign-in list, from the role table', { timeout: 30_000 }, () => {
  it('admits every subject, lowercase, once, within the allowed domains', () => {
    const run = render({ grants: [
      { subject: 'Duke@Datanalysis.re', role: 'owner' },
      { subject: 'smarion@datanalysis.re', role: 'viewer' },
      { subject: 'duke@datanalysis.re', role: 'admin' },
      { subject: 'stephane@duke-analytics.com', role: 'operator' },
      { subject: 'someone@gmail.com', role: 'viewer' },
    ] })
    expect(run.status).toBe(0)
    expect(run.list).toBe('duke@datanalysis.re\nsmarion@datanalysis.re\nstephane@duke-analytics.com\n')
    expect(run.stderr).toContain('someone@gmail.com is outside')
    expect(statSync(run.output).mode & 0o777).toBe(0o644)
  })

  it('never admits an address that is not plain ASCII (the Kelvin sign folds onto k)', () => {
    const run = render({ grants: [{ subject: 'duke@datanalysis.re', role: 'owner' }, { subject: 'du\u212Ae@datanalysis.re', role: 'viewer' }] })
    expect(run.list).toBe('duke@datanalysis.re\n')
    expect(run.stderr).toContain('not a plain ASCII address')
  })

  it('changes nothing when the table cannot be read or would leave nobody', () => {
    for (const grants of ['{ broken', { other: [] }, { grants: [{ subject: 'x@gmail.com', role: 'owner' }] }]) {
      const run = render(grants, 'duke@datanalysis.re\n')
      expect(run.status, JSON.stringify(grants)).toBe(1)
      expect(run.list).toBe('duke@datanalysis.re\n')
    }
  })
})
