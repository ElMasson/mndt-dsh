/**
 * Why a failed turn ended, in words. The core serves its own category (`turn.reasonKind`) and a
 * sentence of the host; the runtime's raw text is never served, and never shown, not even on hover
 * (a provider's message may carry an internal detail). A turn without a known category — an older
 * one, or a category this screen does not know — reads « fin inattendue ».
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
  const key = typeof turn.reasonKind === 'string' ? KINDS.get(turn.reasonKind) : undefined
  return t(key ?? 'endUnknown')
}
