/**
 * Why a failed turn ended. Since #157 a turn that carries `reasonKind` carries a sentence of the host
 * in `reason` (guaranteed and tested by the core): it is shown as written, the category's word
 * standing in only when the sentence is empty. A turn without `reasonKind` is older: its `reason` may
 * be the runtime's raw text (a provider's message can carry an internal detail), so it is never shown
 * and the turn reads « fin inattendue ». No hover anywhere.
 */
import type { ChatTranslate } from './chatLocales.ts'

/** The core's categories of a failed turn (#157), said in words. */
const KINDS: ReadonlyMap<string, 'endNoAnswer' | 'endMaxTokens' | 'endCancelled' | 'endTools' | 'endError'> = new Map([
  ['no-answer', 'endNoAnswer'],
  ['cut', 'endMaxTokens'],
  ['cancelled', 'endCancelled'],
  ['tools', 'endTools'],
  ['failed', 'endError'],
])

/**
 * @param turn - a turn as served (its status, its category).
 * @param t - the copy.
 * @returns the words after « n'a pas abouti : » for a failed turn; for a refused or cancelled one,
 * the host's own sentence; undefined when there is nothing to say.
 */
export function turnEndWords(
  turn: { readonly status: string; readonly reason?: string | undefined; readonly reasonKind?: unknown },
  t: ChatTranslate,
): string | undefined {
  if (turn.status !== 'failed') return turn.reason
  // An older turn, its reason possibly raw: never shown.
  if (typeof turn.reasonKind !== 'string' || turn.reasonKind === '') return t('endUnknown')
  const sentence = turn.reason?.trim() ?? ''
  if (sentence !== '') return sentence
  return t(KINDS.get(turn.reasonKind) ?? 'endUnknown')
}
