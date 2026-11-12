/**
 * Team channels, as the workbench serves them (lot 1 contract, `contrat_A1_lot1_routes_canaux.md`).
 *
 * The page renders what the Host returns and decides nothing: who is a member, which agents a
 * channel may mention, whether a turn runs or is refused, what an agent costs. A message never
 * decides anything; a card is decided only through its button.
 */

/** An agent declared on the workbench. */
export interface ChatAgent {
  readonly id: string
  /** Written `@handle` in a message. */
  readonly handle: string
  readonly name: string
  readonly provider: string
  readonly model: string
  readonly instructions?: string
  readonly connectors: readonly string[]
  /** The monthly ceiling, in euros. */
  readonly eurPerMonth: number
  /** Spent since the first of the month (UTC), served by `GET /agents`. */
  readonly eurThisMonth?: number
  readonly createdBy: string
  readonly createdAt: string
  readonly retiredAt?: string
}

/** A channel: a team one, or the person's own lane (`solo`). */
export interface ChatChannel {
  readonly id: string
  /** Unique identifier form. */
  readonly name: string
  readonly title: string
  readonly kind: 'team' | 'solo'
  /** Members' e-mails. */
  readonly members: readonly string[]
  /** Ids of the agents that may be mentioned here. */
  readonly agents: readonly string[]
  readonly connectors: readonly string[]
  readonly createdBy: string
  readonly createdAt: string
}

/** Who wrote a message. */
export type ChatAuthor =
  | { readonly kind: 'human'; readonly email: string }
  | { readonly kind: 'agent'; readonly agentId: string }
  | { readonly kind: 'system' }

/** One agent turn started by a mention. */
export interface ChatTurn {
  readonly id: string
  readonly agentId: string
  readonly status:
    'queued' | 'running' | 'done' | 'failed' | 'refused' | 'cancelled'
  /** The DSH session of the turn: its trace. */
  readonly sessionId?: string
  readonly tokens?: {
    readonly input: number
    readonly output: number
    readonly cacheRead?: number
    readonly cacheWrite?: number
  }
  readonly eur?: number
  /** In French: why it was refused, failed or stopped. */
  readonly reason?: string
  readonly startedAt?: string
  readonly finishedAt?: string
}

/** One message of a channel. */
export interface ChatMessage {
  readonly id: string
  readonly channelId: string
  readonly author: ChatAuthor
  /** Empty once deleted. */
  readonly text: string
  /** Ids of the agents mentioned. */
  readonly mentions: readonly string[]
  /** An agent's answer points to the message that mentioned it. */
  readonly replyTo?: string
  /** On a human message: one turn per agent mentioned. */
  readonly turns?: readonly ChatTurn[]
  readonly createdAt: string
  /** Moves at the creation, at each step of a turn and at the deletion. */
  readonly updatedAt: string
  readonly deletedAt?: string
}

/** A page of changes: every message created or changed since an instant, and the next instant. */
export interface ChatChanges {
  readonly messages: readonly ChatMessage[]
  readonly cursor: string
}

/**
 * A channel to create: its title is enough; the Host derives the identifier from it (lowercase,
 * accents dropped, hyphens) and takes the first free `-n` suffix. A `name` given stays the person's.
 */
export interface ChannelCreate {
  readonly title: string
  readonly name?: string
  readonly members?: readonly string[]
  readonly agents?: readonly string[]
  readonly connectors?: readonly string[]
}

/** The channel routes the page uses. Each call throws with the Host's reason when refused. */
export interface ChatFace {
  /** The reader's channels, the solo lane first. */
  channels(): Promise<readonly ChatChannel[]>
  createChannel(input: ChannelCreate): Promise<ChatChannel>
  /** The first page of a channel, oldest first, with the cursor to read changes from. */
  messages(channelId: string): Promise<ChatChanges>
  /** Every message created or changed since `since` (inclusive), and the next cursor. */
  changes(channelId: string, since: string): Promise<ChatChanges>
  /** Answers at once; its turns start queued. */
  post(channelId: string, text: string, replyTo?: string): Promise<ChatMessage>
  remove(channelId: string, messageId: string): Promise<ChatMessage>
  /** The declared agents, with what they spent this month. */
  agents(): Promise<readonly ChatAgent[]>
  addAgents(
    channelId: string,
    agentIds: readonly string[],
  ): Promise<ChatChannel>
}
