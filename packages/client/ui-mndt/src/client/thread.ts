/**
 * A channel's thread as the page holds it: what the Host served, merged.
 *
 * `since` is inclusive and returns every message created or changed since the cursor: the page
 * keeps the last copy of each id and orders by creation. Nothing here decides; it only merges.
 */
import type { ChatAgent, ChatMessage, ChatTurn } from './chat.ts'

/**
 * Merge a page of changes into the thread: the newer copy of a message replaces the older.
 * @param held - the thread held so far.
 * @param changed - the messages the Host just served.
 * @returns the thread, oldest first.
 */
export function mergeThread(
  held: readonly ChatMessage[],
  changed: readonly ChatMessage[],
): ChatMessage[] {
  const byId = new Map<string, ChatMessage>()
  for (const m of held) byId.set(m.id, m)
  for (const m of changed) {
    const old = byId.get(m.id)
    if (!old || old.updatedAt <= m.updatedAt) byId.set(m.id, m)
  }
  return [...byId.values()].sort((a, b) =>
    a.createdAt === b.createdAt
      ? a.id.localeCompare(b.id)
      : a.createdAt.localeCompare(b.createdAt),
  )
}

/** A turn still on its way: the page keeps reading while one is. */
export function isOpen(turn: ChatTurn): boolean {
  return turn.status === 'queued' || turn.status === 'running'
}

/**
 * The agents' answers to a message.
 * @param thread - the thread.
 * @param messageId - the message that mentioned them.
 * @returns the answers, oldest first.
 */
export function answersTo(
  thread: readonly ChatMessage[],
  messageId: string,
): ChatMessage[] {
  return thread.filter(m => m.replyTo === messageId)
}

/**
 * How a person is named while the Host serves only the e-mail (lot 1): the part before the @.
 * @param email - the e-mail.
 * @returns the name shown.
 */
export function personName(email: string): string {
  const at = email.indexOf('@')
  return at > 0 ? email.slice(0, at) : email
}

/**
 * An author's name, as shown in the thread.
 * @param m - the message.
 * @param agents - the declared agents, by id.
 * @returns the name, or null for a system message.
 */
export function authorName(
  m: ChatMessage,
  agents: ReadonlyMap<string, ChatAgent>,
): string | null {
  if (m.author.kind === 'human') return personName(m.author.email)
  if (m.author.kind === 'agent') {
    const a = agents.get(m.author.agentId)
    return a ? `@${a.handle}` : m.author.agentId
  }
  return null
}
