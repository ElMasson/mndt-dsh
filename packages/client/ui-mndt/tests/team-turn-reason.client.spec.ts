import { describe, expect, it } from 'vitest'
import { chatFrench } from '../src/client/chatLocales.ts'
import { turnEndWords } from '../src/client/turnReason.ts'

describe('why a failed turn ended', () => {
  const failed = (reasonKind: unknown, reason?: string) =>
    turnEndWords({ status: 'failed', ...(reason === undefined ? {} : { reason }), ...(reasonKind === undefined ? {} : { reasonKind }) }, chatFrench)

  it('with a category, the host\'s sentence as written (a useful one is kept)', () => {
    expect(failed('tools', 'outils indisponibles : approvals (démarrage en cours ou connecteur en panne) ; le tour n’a pas été lancé'))
      .toBe('outils indisponibles : approvals (démarrage en cours ou connecteur en panne) ; le tour n’a pas été lancé')
  })

  it('with a category and an empty sentence, the category\'s word', () => {
    expect(failed('no-answer', '')).toBe('le modèle n\'a rien répondu')
    expect(failed('cut', '   ')).toBe('réponse coupée : limite de longueur atteinte')
    expect(failed('cancelled')).toBe('annulé')
    expect(failed('tools')).toBe('un outil nécessaire était indisponible')
    expect(failed('failed')).toBe('le modèle a renvoyé une erreur')
  })

  it('A1\'s other categories: the sentence as written, their word when it is empty', () => {
    expect(failed('budget', 'le coût du tour a atteint sa borne pendant l’appel')).toBe('le coût du tour a atteint sa borne pendant l’appel')
    expect(failed('budget', '')).toBe('le coût du tour a atteint sa borne')
    expect(failed('blocked', '')).toBe('le tour a été bloqué')
    expect(failed('aborted', '')).toBe('le tour a été abandonné')
    expect(failed('interrupted', '')).toBe('le tour a été interrompu')
    expect(turnEndWords({ status: 'cancelled', reasonKind: 'stale', reason: 'L’agent a quitté le canal.' }, chatFrench)).toBe('L’agent a quitté le canal.')
    expect(turnEndWords({ status: 'cancelled', reasonKind: 'restart', reason: '' }, chatFrench)).toBe('interrompu par un redémarrage')
    expect(turnEndWords({ status: 'refused', reasonKind: 'refused', reason: 'Plafond mensuel atteint pour @x' }, chatFrench)).toBe('Plafond mensuel atteint pour @x')
  })

  it('an unknown category keeps the host\'s sentence (it is always one)', () => {
    expect(failed('new-kind', 'Une phrase de l’hôte.')).toBe('Une phrase de l’hôte.')
  })

  it('an unknown category with an empty sentence, or one named like an inherited member, reads « fin inattendue »', () => {
    for (const kind of ['paused', 'constructor', 'toString']) expect(failed(kind, '')).toBe('fin inattendue')
  })

  it('without a category (an older turn), never its reason: it may be the engine\'s raw text', () => {
    expect(failed(undefined, 'the agent turn failed: 500 upstream sk-live-123')).toBe('fin inattendue')
    expect(failed(42, 'llm-pi-ai: no credential for provider route')).toBe('fin inattendue')
    expect(failed('', 'raw')).toBe('fin inattendue')
  })

  it('a refused or cancelled turn keeps the host\'s own sentence', () => {
    expect(turnEndWords({ status: 'refused', reason: 'plafond mensuel atteint' }, chatFrench)).toBe('plafond mensuel atteint')
    expect(turnEndWords({ status: 'cancelled' }, chatFrench)).toBeUndefined()
  })
})
