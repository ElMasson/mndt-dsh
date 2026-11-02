import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('host half', () => {
  it('boots the browser row without doing anything on the Host', () => {
    expect(() => { apply() }).not.toThrow()
  })
})
