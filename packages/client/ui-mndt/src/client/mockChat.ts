/**
 * An in-memory channel face that plays the Host's part of the lot 1 contract, for developing the
 * screen and for tests before the routes are served. It is a test double, never the product: the
 * page reads the Host through `httpChat.ts`.
 *
 * It answers a post at once with its turns queued; `tick()` moves every open turn one step
 * (queued, running, then done with the agent's answer, or refused past the monthly ceiling with a
 * system message), as the Host would between two reads.
 */
import type {
  ChannelCreate,
  ChatAgent,
  ChatChannel,
  ChatChanges,
  ChatFace,
  ChatMessage,
  ChatTurn,
} from './chat.ts'

/**
 * A promise of what `work` returns, or of the error it throws: the double answers like the Host,
 * asynchronously, without any I/O of its own.
 * @param work - the double's step.
 * @returns its outcome.
 */
function settle<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work())
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

/** What the double starts from. */
export interface MockSeed {
  readonly you: string
  readonly agents: readonly ChatAgent[]
  readonly channels: readonly ChatChannel[]
  readonly messages?: readonly ChatMessage[]
}

/** The double, with its clock step. */
export interface MockChat extends ChatFace {
  /** Move every open turn one step. */
  tick(): void
}

/**
 * Build the double.
 * @param seed - its agents, channels and first messages.
 * @param clock - the instant to stamp (tests pass a fixed one).
 * @returns the face.
 */
export function createMockChat(
  seed: MockSeed,
  clock: () => number = Date.now,
): MockChat {
  let seq = 0
  const now = (): string => new Date(clock() + seq++).toISOString()
  const agents = new Map(
    seed.agents.map(a => [a.id, { ...a, eurThisMonth: a.eurThisMonth ?? 0 }]),
  )
  const channels = new Map(seed.channels.map(c => [c.id, c]))
  const messages = new Map((seed.messages ?? []).map(m => [m.id, m]))
  const nextId = (prefix: string): string =>
    `${prefix}_${(seq += 1).toString(36)}`

  const inChannel = (channelId: string): ChatMessage[] =>
    [...messages.values()]
      .filter(m => m.channelId === channelId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const channelOf = (channelId: string): ChatChannel => {
    const c = channels.get(channelId)
    if (!c || !c.members.includes(seed.you))
      throw new Error('channel_not_found')
    return c
  }

  const face: MockChat = {
    channels() {
      return settle(() => {
        return [...channels.values()]
          .filter(c => c.members.includes(seed.you))
          .sort((a, b) =>
            a.kind === b.kind
              ? a.createdAt.localeCompare(b.createdAt)
              : a.kind === 'solo'
                ? -1
                : 1,
          )
      })
    },
    createChannel(input: ChannelCreate) {
      return settle(() => {
        if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(input.name))
          throw new Error('name_invalid')
        if ([...channels.values()].some(c => c.name === input.name))
          throw new Error('name_taken')
        const c: ChatChannel = {
          id: nextId('chn'),
          name: input.name,
          title: input.title ?? input.name,
          kind: 'team',
          members: [...new Set([seed.you, ...(input.members ?? [])])],
          agents: [...(input.agents ?? [])],
          connectors: [...(input.connectors ?? [])],
          createdBy: seed.you,
          createdAt: now(),
        }
        channels.set(c.id, c)
        return c
      })
    },
    messages(channelId) {
      return settle(() => {
        channelOf(channelId)
        const page = inChannel(channelId)
        return { messages: page, cursor: now() }
      })
    },
    changes(channelId, since): Promise<ChatChanges> {
      return settle(() => {
        channelOf(channelId)
        const changed = inChannel(channelId)
          .filter(m => m.updatedAt >= since)
          .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
        return { messages: changed, cursor: now() }
      })
    },
    post(channelId, text, replyTo) {
      return settle(() => {
        const c = channelOf(channelId)
        if (!text.trim()) throw new Error('text_empty')
        // The Host's part: which of this channel's agents the text mentions.
        const mentioned = c.agents.filter((id) => {
          const a = agents.get(id)
          return a && new RegExp(`(^|\\s)@${a.handle}(?![\\w-])`, 'u').test(text)
        })
        const at = now()
        const m: ChatMessage = {
          id: nextId('msg'),
          channelId,
          author: { kind: 'human', email: seed.you },
          text,
          mentions: mentioned,
          ...(replyTo ? { replyTo } : {}),
          turns: mentioned.map(agentId => ({
            id: nextId('trn'),
            agentId,
            status: 'queued' as const,
          })),
          createdAt: at,
          updatedAt: at,
        }
        messages.set(m.id, m)
        return m
      })
    },
    remove(channelId, messageId) {
      return settle(() => {
        channelOf(channelId)
        const m = messages.get(messageId)
        if (!m) throw new Error('message_not_found')
        if (m.author.kind !== 'human' || m.author.email !== seed.you)
          throw new Error('not_the_author')
        const at = now()
        const removed: ChatMessage = {
          ...m,
          text: '',
          deletedAt: at,
          updatedAt: at,
          ...(m.turns
            ? {
              turns: m.turns.map(t =>
                t.status === 'queued' || t.status === 'running'
                  ? { ...t, status: 'cancelled' as const }
                  : t,
              ),
            }
            : {}),
        }
        messages.set(m.id, removed)
        return removed
      })
    },
    agents() {
      return settle(() => {
        return [...agents.values()]
      })
    },
    addAgents(channelId, agentIds) {
      return settle(() => {
        const c = channelOf(channelId)
        for (const id of agentIds)
          if (!agents.has(id)) throw new Error('agent_not_found')
        const next = { ...c, agents: [...new Set([...c.agents, ...agentIds])] }
        channels.set(c.id, next)
        return next
      })
    },
    tick() {
      for (const m of [...messages.values()]) {
        if (
          !m.turns?.some(t => t.status === 'queued' || t.status === 'running')
        )
          continue
        const turns: ChatTurn[] = m.turns.map((t) => {
          const a = agents.get(t.agentId)
          if (t.status === 'queued') {
            if (a && a.eurThisMonth >= a.eurPerMonth) {
              const at = now()
              messages.set(`msg_sys_${t.id}`, {
                id: `msg_sys_${t.id}`,
                channelId: m.channelId,
                author: { kind: 'system' },
                text: `Plafond mensuel atteint pour @${a.handle} : ${a.eurPerMonth.toFixed(2).replace('.', ',')} € sur ${a.eurPerMonth.toFixed(2).replace('.', ',')} €`,
                mentions: [],
                createdAt: at,
                updatedAt: at,
              })
              return {
                ...t,
                status: 'refused' as const,
                reason: 'Plafond mensuel atteint',
              }
            }
            return {
              ...t,
              status: 'running' as const,
              sessionId: `ses_${t.id}`,
              startedAt: now(),
            }
          }
          if (t.status === 'running') {
            const at = now()
            const answer: ChatMessage = {
              id: `msg_ans_${t.id}`,
              channelId: m.channelId,
              author: { kind: 'agent', agentId: t.agentId },
              text: `Réponse de @${a?.handle ?? t.agentId} [S1].`,
              mentions: [],
              replyTo: m.id,
              createdAt: at,
              updatedAt: at,
            }
            messages.set(answer.id, answer)
            if (a)
              agents.set(a.id, {
                ...a,
                eurThisMonth: a.eurThisMonth + 0.01,
              })
            return {
              ...t,
              status: 'done' as const,
              tokens: { input: 1200, output: 300 },
              eur: 0.01,
              finishedAt: at,
            }
          }
          return t
        })
        messages.set(m.id, { ...m, turns, updatedAt: now() })
      }
    },
  }
  return face
}
