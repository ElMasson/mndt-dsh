import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isPlainAscii } from '../src/core/address.ts'

/**
 * The plain-ASCII rule for a person's e-mail exists in three places: the API
 * (src/core/address.ts) and twice in the gateway (deploy/gateway/server.mjs:
 * the OWNER warning and isOwner), which runs as plain Node outside the
 * package. The copies must give the same verdicts, or a spelling admitted by
 * one would be refused by the other (#75 review).
 */
describe('the three copies of the plain-ASCII rule', () => {
  const gateway = readFileSync(join(import.meta.dirname, '..', 'deploy', 'gateway', 'server.mjs'), 'utf8')
  const copies = [...gateway.matchAll(/\/\^\[\\x21-\\x7e\]\+\$\/\.test\(/g)]

  it('finds both gateway copies, written as the API writes it', () => {
    expect(copies).toHaveLength(2)
    const api = readFileSync(join(import.meta.dirname, '..', 'src', 'core', 'address.ts'), 'utf8')
    expect(api).toContain('/^[\\x21-\\x7e]+$/.test(value.trim())')
  })

  it('gives the same verdict as the API for lookalikes, spaces and controls', () => {
    const rule = /^[\x21-\x7e]+$/
    for (const value of ['duke@datanalysis.re', ' Duke@Datanalysis.re ', 'duKe@datanalysis.re', 'duke@datanalysis.re​',
      'a b@c.d', 'a\tb@c.d', '', '   ', 'é@datanalysis.re', 'x\u0000@y.z', 'DUKE@DATANALYSIS.RE']) {
      // The gateway tests the trimmed value, as isPlainAscii does.
      expect(rule.test(value.trim()), JSON.stringify(value)).toBe(isPlainAscii(value))
    }
  })
})
