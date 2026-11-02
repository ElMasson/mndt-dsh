// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CSS } from '../src/client/styles.ts'
import { en, zh } from '../src/client/locales.ts'
import { MndtIcon } from '../src/client/MndtIcon.tsx'

afterEach(() => { cleanup() })

describe('page shell assets', () => {
  it('carries the layout sheet the page mounts once', () => {
    expect(CSS).toContain('.mndt-collab')
    expect(CSS).toContain('--')
    expect(CSS.length).toBeGreaterThan(1000)
  })

  it('ships the two dictionaries with the same keys', () => {
    expect(Object.keys(en).length).toBeGreaterThan(0)
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const value of Object.values(zh)) expect(value.length).toBeGreaterThan(0)
  })

  it('draws the sidebar icon', () => {
    const { container } = render(<MndtIcon />)
    expect(container.querySelector('svg')).toBeTruthy()
  })
})
