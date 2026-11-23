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
  /** « Auteur puis vérificateur » (#84), read through `coordinationOf`, never trusted as is. */
  readonly coordination?: unknown
}

/** Who wrote a message. */
export type ChatAuthor =
  | { readonly kind: 'human'; readonly email: string }
  | { readonly kind: 'agent'; readonly agentId: string }
  | { readonly kind: 'system' }

/** What a channel's coordination is set to: alone, or an author then a verifier. */
export type CoordinationChange =
  | { readonly mode: 'solo' }
  | { readonly mode: 'author-verifier'; readonly author: string; readonly verifier: string }
  | {
    readonly mode: 'parallel-synthesis'
    readonly workers: readonly string[]
    readonly synthesizer: string
    readonly maxEurPerTurn?: number
  }

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
  /** The steps of a coordinated turn (#84), read through `stepsOf`, never trusted as is. */
  readonly steps?: unknown
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

/** A card a turn asked for, decided or not, as `GET /approvals?state=all` serves it. */
export interface ChatCard {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly requestedBy: string
  readonly requestedAt: string
  readonly channelId?: string
  readonly messageId?: string
  /** `pending` until a person decides it with its button. */
  readonly state: 'pending' | 'approved' | 'rejected'
  readonly decidedBy?: string
  readonly decidedAt?: string
  /** Why it was refused, kept in the log. */
  readonly reason?: string
  /** Whether the reader may decide it, as the API says for them (pending cards only). */
  readonly canDecide?: boolean
  /**
   * What the card proposes to declare, when an agent proposes an agent (`propose_agent`, lot 1b):
   * read through `proposalOf`, never trusted as is.
   */
  readonly proposal?: unknown
  /** The mission that asked for it, when one did (such a card belongs to no channel). */
  readonly missionId?: string
  /** The agent whose turn asked for it; `requestedBy` stays the person accountable for the turn. */
  readonly requestedByAgent?: { readonly id: string; readonly handle: string; readonly name?: string }
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

/** A call the Host refused: its reason as served, and the HTTP status that tells its kind. */
export class ChatRefusal extends Error {
  /**
   * @param message - the Host's `{ error }`.
   * @param status - the HTTP status.
   * @param code - the Host's `{ code }`, when it serves one.
   */
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = 'ChatRefusal'
  }
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
  /** Every card, the decided ones included: a decided card stays in its thread with who and when. */
  cards(): Promise<readonly ChatCard[]>
  /** The declared agents, with what they spent this month. */
  agents(): Promise<readonly ChatAgent[]>
  addAgents(
    channelId: string,
    agentIds: readonly string[],
  ): Promise<ChatChannel>
  /** Take agents out of a channel; they stop answering there. Optional: the team page only. */
  removeAgents?(channelId: string, agentIds: readonly string[]): Promise<ChatChannel>
  /** Set a channel's connectors, the whole list. Optional: the team page only. */
  setConnectors?(channelId: string, servers: readonly string[]): Promise<ChatChannel>
  /**
   * Set a channel's coordination (`POST /channels/:id/coordination`, #84): alone, or an author
   * then a verifier of another model. Optional: the team page only.
   */
  setCoordination?(channelId: string, change: CoordinationChange): Promise<ChatChannel>
  /** The connectors mounted on this workbench (`GET /connectors`). Optional: the team page only. */
  mounted?(): Promise<readonly MountedConnector[]>
  /** The models offered to agents (`GET /models`, #82). Optional: the team page only. */
  models?(): Promise<readonly OfferedModel[]>
  /** Declare an agent (`POST /agents`, agents.write). Optional: the team page only. */
  createAgent?(input: AgentInput): Promise<ChatAgent>
  /** Change an agent; its handle never changes (`POST /agents/:id`). Optional: the team page only. */
  updateAgent?(id: string, patch: Partial<Omit<AgentInput, 'handle'>>): Promise<ChatAgent>
}

/** What declares an agent: the API's fields, its handle written once. */
export interface AgentInput {
  readonly handle: string
  readonly name: string
  readonly provider: string
  readonly model: string
  /** What it is for, in a sentence: its standing instructions. */
  readonly instructions?: string
  readonly connectors?: readonly string[]
  /** The monthly ceiling, in euros (5 by default on the server). */
  readonly eurPerMonth?: number
}

/** A model the core offers to agents: one line of `GET /models`. */
export interface OfferedModel {
  readonly provider: string
  readonly model: string
}

/** A connector as the workbench reports it: an MCP server, and whether it is switched on. */
export interface MountedConnector {
  readonly module: string
  readonly server: string
  readonly enabled: boolean
}
