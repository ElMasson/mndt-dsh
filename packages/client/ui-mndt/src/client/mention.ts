/**
 * `@` completion in the composer: the handles of the agents this channel may mention.
 *
 * Only `channel.agents` start a turn, so only they are offered. Which agents a message mentions is
 * the Host's answer (`message.mentions`); the page only helps write a handle.
 */
import type { ChatAgent } from './chat.ts'

/** The word being written with `@` before the caret. */
export interface MentionQuery {
  /** Where the `@` is. */
  readonly start: number
  /** What follows it, up to the caret. */
  readonly prefix: string
}

const HANDLE_CHAR = /[A-Za-z0-9_-]/u

/**
 * The `@word` the caret is in, if any: an `@` at the start or after a space, then handle characters.
 * @param text - the composer's text.
 * @param caret - the caret position.
 * @returns the query, or null.
 */
export function mentionAt(text: string, caret: number): MentionQuery | null {
  let i = caret
  while (i > 0 && HANDLE_CHAR.test(text[i - 1] ?? '')) i -= 1
  if (i === 0 || text[i - 1] !== '@') return null
  const at = i - 1
  if (at > 0 && !/\s/u.test(text[at - 1] ?? '')) return null
  return { start: at, prefix: text.slice(i, caret) }
}

/**
 * The agents to offer for a query: this channel's, not retired, whose handle or name starts with it.
 * @param query - the word being written.
 * @param channelAgentIds - `channel.agents`.
 * @param agents - the declared agents.
 * @returns at most `limit` agents, by handle.
 */
export function mentionChoices(
  query: MentionQuery,
  channelAgentIds: readonly string[],
  agents: readonly ChatAgent[],
  limit = 6,
): ChatAgent[] {
  const wanted = query.prefix.toLowerCase()
  const allowed = new Set(channelAgentIds)
  return agents
    .filter(a => allowed.has(a.id) && !a.retiredAt)
    .filter(
      a =>
        a.handle.toLowerCase().startsWith(wanted) ||
        a.name.toLowerCase().startsWith(wanted),
    )
    .sort((a, b) => a.handle.localeCompare(b.handle))
    .slice(0, limit)
}

/**
 * Write a chosen handle in place of the query, followed by a space.
 * @param text - the composer's text.
 * @param query - the word being written.
 * @param caret - the caret position.
 * @param handle - the chosen handle.
 * @returns the new text and the caret after the handle.
 */
export function completeMention(
  text: string,
  query: MentionQuery,
  caret: number,
  handle: string,
): { readonly text: string; readonly caret: number } {
  const inserted = `@${handle} `
  return {
    text:
      text.slice(0, query.start) +
      inserted +
      text.slice(caret).replace(/^\s/u, ''),
    caret: query.start + inserted.length,
  }
}
