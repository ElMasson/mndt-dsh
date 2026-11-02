// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CSS } from '../src/client/styles.ts'
import { en, translate, zh } from '../src/client/locales.ts'
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

  it('fills the placeholders of a message, or keeps them when a value is missing', () => {
    expect(translate('title')).toBe(en.title)
    expect(translate('ui.caracteres', { count: 3 })).toBe('3 caracteres')
    expect(translate('ui.role-de-personne', { name: 'duke@datanalysis.re' })).toBe('role de duke@datanalysis.re')
    expect(translate('ui.role-de-personne', {})).toBe('role de {name}')
  })

  it('draws the sidebar icon', () => {
    const { container } = render(<MndtIcon />)
    expect(container.querySelector('svg')).toBeTruthy()
  })
})
