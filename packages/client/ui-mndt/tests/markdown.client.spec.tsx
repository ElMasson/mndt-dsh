// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderBrief } from '../src/client/markdown.tsx'

afterEach(() => { cleanup() })

/** @param markdown - what an agent wrote. @returns the rendered container. */
function shown(markdown: string): HTMLElement {
  return render(<div>{renderBrief(markdown)}</div>).container
}

describe('fenced code blocks in what an agent writes', () => {
  it('the case seen on the instance: a ```text block is framed, its marks never shown', () => {
    // As an agent answered on equipe.datanalysis.re (17/11): a fence with a language, then text.
    const box = shown('Voici le brouillon :\n\n```text\nObjet : Relance FA2610-031\n  Bonjour,\n```\n\nÀ valider.')
    const code = box.querySelector('pre.md-code code')
    expect(code?.textContent).toBe('Objet : Relance FA2610-031\n  Bonjour,')
    expect(code?.getAttribute('data-lang')).toBe('text')
    expect(box.textContent).not.toContain('`')
    expect([...box.querySelectorAll('p')].map(p => p.textContent)).toEqual(['Voici le brouillon :', 'À valider.'])
  })

  it('a fence without a language, and one with tildes', () => {
    expect(shown('```\na\n```').querySelector('pre code')?.textContent).toBe('a')
    expect(shown('~~~\nb\n~~~').querySelector('pre code')?.textContent).toBe('b')
    expect(shown('```\na\n```').querySelector('pre code')?.hasAttribute('data-lang')).toBe(false)
  })

  it('a block the agent never closed runs to the end of the text, with no stray mark', () => {
    const box = shown('Début\n```json\n{ "a": 1 }\n# pas un titre')
    expect(box.querySelector('pre code')?.textContent).toBe('{ "a": 1 }\n# pas un titre')
    expect(box.querySelector('h3, h4')).toBeNull()
    expect(box.textContent).not.toContain('`')
  })

  it('its content stays text: no markup, no table, no list is read in it', () => {
    const box = shown('```html\n<b>gras</b> **pas gras**\n| a | b |\n- pas une liste\n```')
    const code = box.querySelector('pre code')
    expect(code?.textContent).toBe('<b>gras</b> **pas gras**\n| a | b |\n- pas une liste')
    expect(box.querySelector('b, strong, table, ul')).toBeNull()
  })

  it('a line that opens and closes with backticks is inline code, not a block swallowing the rest', () => {
    // From the review of #80: « ```npm install``` puis relancer » must not open a block in « npm ».
    const box = shown('```npm install``` puis relancer.\n\nEnsuite, vérifiez.')
    expect(box.querySelector('pre')).toBeNull()
    const paragraphs = [...box.querySelectorAll('p')].map(p => p.textContent)
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0]).toContain('npm install')
    expect(paragraphs[1]).toBe('Ensuite, vérifiez.')
    // Tildes are not concerned: a tilde fence may carry a backtick in its rest.
    expect(shown('~~~ a`b\nx\n~~~').querySelector('pre code')?.textContent).toBe('x')
  })

  it('a longer fence closes only on a fence at least as long; a shorter one is content', () => {
    expect(shown('````\n```\nin\n```\n````').querySelector('pre code')?.textContent).toBe('```\nin\n```')
  })

  it('a fence indented in a list keeps its lines relative to it, and the list around it', () => {
    const box = shown('- étape\n  ```sh\n  echo ok\n    suite\n  ```\n- fin')
    expect(box.querySelector('pre code')?.textContent).toBe('echo ok\n  suite')
    expect([...box.querySelectorAll('li')].map(li => li.textContent)).toEqual(['étape', 'fin'])
  })
})
