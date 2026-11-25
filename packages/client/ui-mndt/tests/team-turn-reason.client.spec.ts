import { describe, expect, it } from 'vitest'
import { chatFrench } from '../src/client/chatLocales.ts'
import { turnEndWords } from '../src/client/turnReason.ts'

describe('why a failed turn ended, from the core\'s category', () => {
  const failed = (reasonKind?: unknown, reason = 'Réponse coupée (limite de longueur atteinte).') =>
    turnEndWords({ status: 'failed', reason, ...(reasonKind === undefined ? {} : { reasonKind }) }, chatFrench)

  it('each category in words', () => {
    expect(failed('no-answer')).toBe('le modèle n\'a rien répondu')
    expect(failed('cut')).toBe('réponse coupée : limite de longueur atteinte')
    expect(failed('cancelled')).toBe('annulé')
    expect(failed('tools')).toBe('un outil nécessaire était indisponible')
    expect(failed('failed')).toBe('le modèle a renvoyé une erreur')
  })

  it('an older turn without a category never shows its reason (it may be the engine\'s raw text)', () => {
    expect(failed(undefined, 'the agent turn failed: 500 upstream sk-live-123')).toBe('fin inattendue')
  })

  it('an unknown category, or one named like an inherited member, reads « fin inattendue »', () => {
    for (const kind of ['paused', 'constructor', 'toString', 42]) expect(failed(kind)).toBe('fin inattendue')
  })

  it('a refused or cancelled turn keeps the host\'s own sentence', () => {
    expect(turnEndWords({ status: 'refused', reason: 'plafond mensuel atteint' }, chatFrench)).toBe('plafond mensuel atteint')
    expect(turnEndWords({ status: 'cancelled' }, chatFrench)).toBeUndefined()
  })
})
