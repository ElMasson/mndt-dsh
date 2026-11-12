// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CSS } from '../src/client/styles.ts'
import { en, fr, translate, zh } from '../src/client/locales.ts'
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
    // The French pack covers every key, none left empty.
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort())
    for (const value of Object.values(fr)) expect(value.length).toBeGreaterThan(0)
  })

  it('fills the placeholders of a message, or keeps them when a value is missing', () => {
    // The page's own translate speaks French, the language of the pack.
    expect(translate('title')).toBe(fr.title)
    expect(translate('ui.caracteres', { count: 3 })).toBe('3 caractères')
    expect(translate('ui.role-de-personne', { name: 'duke@datanalysis.re' })).toBe('rôle de duke@datanalysis.re')
    expect(translate('ui.role-de-personne', {})).toBe('rôle de {name}')
  })

  it('draws the sidebar icon', () => {
    const { container } = render(<MndtIcon />)
    expect(container.querySelector('svg')).toBeTruthy()
  })
})
