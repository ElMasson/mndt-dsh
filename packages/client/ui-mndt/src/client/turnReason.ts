/**
 * Why a failed turn ended. Since #157 a turn that carries `reasonKind` carries a sentence of the host
 * in `reason` (guaranteed and tested by the core): it is shown as written, the category's word
 * standing in only when the sentence is empty. A turn without `reasonKind` is older: its `reason` may
 * be the runtime's raw text (a provider's message can carry an internal detail), so it is never shown
 * and the turn reads « fin inattendue ». No hover anywhere.
 */
import type { ChatTranslate } from './chatLocales.ts'

/** The core's categories of a turn's ending (#157): their word, used only when the host's sentence is empty. */
type EndWord = 'endNoAnswer' | 'endMaxTokens' | 'endCancelled' | 'endTools' | 'endError' | 'endBudget' | 'endBlocked'
  | 'endAborted' | 'endInterrupted' | 'endRefused' | 'endStale' | 'endRestart'
const KINDS: ReadonlyMap<string, EndWord> = new Map<string, EndWord>([
  ['no-answer', 'endNoAnswer'],
  ['cut', 'endMaxTokens'],
  ['cancelled', 'endCancelled'],
  ['tools', 'endTools'],
  ['failed', 'endError'],
  ['budget', 'endBudget'],
  ['blocked', 'endBlocked'],
  ['aborted', 'endAborted'],
  ['interrupted', 'endInterrupted'],
  ['refused', 'endRefused'],
  ['stale', 'endStale'],
  ['restart', 'endRestart'],
])

/**
 * @param kind - a served category. @param t - the copy.
 * @returns its word, or undefined when this screen does not know it (looked up in own keys only).
 */
export function endWordOf(kind: unknown, t: ChatTranslate): string | undefined {
  const key = typeof kind === 'string' ? KINDS.get(kind) : undefined
  return key === undefined ? undefined : t(key)
}

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
  const kind = typeof turn.reasonKind === 'string' && turn.reasonKind !== '' ? turn.reasonKind : undefined
  const sentence = turn.reason?.trim() ?? ''
  // With a category, the reason is the host's sentence (any category, an unknown one included).
  if (kind !== undefined) return sentence !== '' ? sentence : t(KINDS.get(kind) ?? 'endUnknown')
  // Without one, a refused or cancelled turn keeps the host's sentence it always carried;
  // a failed one is older, its reason possibly raw: never shown.
  if (turn.status !== 'failed') return turn.reason
  return t('endUnknown')
}
