import { describe, expect, it } from 'vitest'
import { chatFrench } from '../src/client/chatLocales.ts'
import { turnReasonWords } from '../src/client/turnReason.ts'

describe('a failed turn\'s reason, in words', () => {
  const say = (reason: string): { words: string; raw: string } => turnReasonWords(reason, chatFrench)

  it('names the runtime\'s known endings, the raw text kept for hover', () => {
    expect(say('the agent turn ended max-tokens')).toEqual({
      words: 'réponse coupée : limite de longueur atteinte', raw: 'the agent turn ended max-tokens',
    })
    expect(say('the agent turn ended interrupted').words).toBe('le moteur s\'est arrêté pendant le tour')
    expect(say('the agent turn ended aborted').words).toBe('arrêté avant la fin')
    expect(say('the agent turn ended blocked').words).toBe('bloqué par une règle de l\'espace')
    expect(say('the agent turn ended forked').words).toBe('poursuivi dans une autre session')
  })

  it('a model error is said as one; its own message stays on hover', () => {
    const r = say('the agent turn failed: 429 rate limited')
    expect(r.words).toBe('le modèle a renvoyé une erreur')
    expect(r.raw).toBe('the agent turn failed: 429 rate limited')
  })

  it('an ending it does not know is never hidden: « fin inattendue », raw on hover', () => {
    expect(say('the agent turn ended paused')).toEqual({ words: 'fin inattendue', raw: 'the agent turn ended paused' })
  })

  it('several endings joined by the core are each said, once', () => {
    expect(say('the agent turn ended max-tokens; the agent turn ended max-tokens; the agent turn failed: x').words)
      .toBe('réponse coupée : limite de longueur atteinte ; le modèle a renvoyé une erreur')
  })

  it('a sentence of the core\'s own (not the runtime\'s format) is shown as written', () => {
    expect(say('agent retired').words).toBe('agent retired')
  })
})
