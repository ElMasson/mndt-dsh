/**
 * A failed turn's reason in words. The core writes the runtime's ending as a fixed technical
 * string (runner.ts: « the agent turn ended <kind> », « the agent turn failed: <message> », joined by
 * « ; »); this reads that format, it judges nothing. An ending it does not know is not hidden: it
 * shows as « fin inattendue », its raw text on hover.
 */
import type { ChatTranslate } from './chatLocales.ts'

/** The runtime's endings (session TurnEndReason) the screen says in words. */
const ENDINGS: Readonly<Record<string, 'endMaxTokens' | 'endAborted' | 'endInterrupted' | 'endBlocked' | 'endForked'>> = {
  'max-tokens': 'endMaxTokens',
  aborted: 'endAborted',
  interrupted: 'endInterrupted',
  blocked: 'endBlocked',
  forked: 'endForked',
}

/** @param reason - a turn's reason as served. @param t - the copy. @returns its words, and the raw text for hover. */
export function turnReasonWords(reason: string, t: ChatTranslate): { readonly words: string; readonly raw: string } {
  const parts = reason.split('; ').map((part) => {
    const ended = /^the agent turn ended ([a-z-]+)$/u.exec(part)
    if (ended !== null) {
      const key = ENDINGS[ended[1] ?? '']
      return key === undefined ? t('endUnknown') : t(key)
    }
    // A model or provider error: said as one, its own message kept on hover.
    if (part.startsWith('the agent turn failed: ')) return t('endError')
    return undefined
  })
  // Anything that is not the runtime's format is the core's own sentence: shown as written.
  if (parts.every(part => part === undefined)) return { words: reason, raw: reason }
  return { words: [...new Set(parts.map(part => part ?? t('endUnknown')))].join(' ; '), raw: reason }
}
