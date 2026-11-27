import { describe, expect, it } from 'vitest'
import { withoutThought } from '../src/thought-text.ts'
import { textOf } from '../src/runner.ts'

describe('a model\'s thought, never served (the instance, 27/11: « @qwen bonjour » answered twice)', () => {
  it('keeps a text with no tag as it is, to the byte', () => {
    expect(withoutThought('  Bonjour.\n\n')).toBe('  Bonjour.\n\n')
  })

  it('removes every <think>…</think> block, across lines', () => {
    expect(withoutThought('<think>\nil dit bonjour\n</think>\n\nBonjour !')).toBe('Bonjour !')
    expect(withoutThought('<think>a</think>Un.<think>b\nc</think> Deux.')).toBe('Un. Deux.')
  })

  it('after an orphan </think>, keeps only what follows the last one: the instance\'s answer, the text twice', () => {
    const served = 'Bonjour ! Comment puis-je vous aider ?\n</think>\n\nBonjour ! Comment puis-je vous aider ?'
    expect(withoutThought(served)).toBe('Bonjour ! Comment puis-je vous aider ?')
    expect(withoutThought('un\n</think>\ndeux\n</think>\ntrois')).toBe('trois')
  })

  it('drops an unclosed <think> to the end (a thought cut off by the cap), and an answer all thought comes back empty', () => {
    expect(withoutThought('Réponse.\n<think>je continue')).toBe('Réponse.\n')
    expect(withoutThought('<think>rien que ça</think>')).toBe('')
    expect(withoutThought('pensée seule\n</think>\n')).toBe('')
  })

  it('is applied by textOf, whatever shape the engine settles with', () => {
    expect(textOf('pensée</think>Bonjour.')).toBe('Bonjour.')
    expect(textOf({ value: '<think>x</think>Mission.' })).toBe('Mission.')
    expect(textOf({ output: { content: [{ text: 'pen' }, { text: 'sée</think>Fin.' }] } })).toBe('Fin.')
  })
})
