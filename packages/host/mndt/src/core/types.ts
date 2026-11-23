/**
 * The mndt workbench domain, expressed as plain values.
 *
 * A mission is a unit of work an agent executes, a brief is what it produced, an
 * approval is a decision a person still owes, and a memory note is a fact the
 * team wants carried forward. Everything is serialisable, so one shape travels
 * over HTTP, through a page, and into a file.
 */

/** The work a mission performs. */
export type MissionKind =
  | 'briefing'
  | 'meeting-prep'
  | 'account-review'
  | 'invoice-chase'
  | 'signal-watch'
  | 'weekly-synthesis'
  | 'custom'

/** Where a mission stands. */
export type MissionStatus = 'queued' | 'running' | 'done' | 'failed' | 'needs-review'

/** Who may read a mission and its brief. */
export type Visibility = 'team' | 'private'

/** One piece of evidence a brief rests on. */
export interface BriefSource {
  readonly connector: string
  readonly ref: string
  readonly label: string
}

/** A unit of agent work. */
export interface Mission {
  readonly id: string
  readonly kind: MissionKind
  readonly prompt: string
  readonly status: MissionStatus
  readonly createdBy: string
  readonly visibility: Visibility
  readonly createdAt: string
  readonly sessionId?: string
  readonly startedAt?: string
  readonly finishedAt?: string
  /** Why it failed, in the runtime's own words. Never a generic excuse. */
  readonly error?: string
  readonly tokens?: {
    readonly input: number
    readonly output: number
    /** Cached input tokens read back by the provider. */
    readonly cacheRead?: number
    /** Input tokens written to the provider cache. */
    readonly cacheWrite?: number
  }
  readonly briefId?: string
  /** The mandate this mission runs under, when it runs under one. */
  readonly mandateId?: string
}

/** What a mission produced, meant to be read by a person. */
export interface Brief {
  readonly id: string
  readonly missionId: string
  readonly title: string
  readonly markdown: string
  readonly sources: readonly BriefSource[]
  readonly status: 'draft' | 'approved' | 'shared'
  /** Inherited from the mission: a private mission yields a private brief. */
  readonly visibility?: Visibility
  readonly createdBy: string
  readonly createdAt: string
  readonly approvedBy?: string
  readonly approvedAt?: string
}

/** Who a memory note belongs to. */
export type MemoryScope = 'team' | 'user' | 'mission'

/** What kind of thing a memory note records. */
export type MemoryKind = 'fact' | 'decision' | 'preference'

/** One durable note the team wants to carry forward. */
export interface MemoryNote {
  readonly id: string
  readonly scope: MemoryScope
  readonly kind: MemoryKind
  readonly text: string
  readonly source?: BriefSource
  readonly createdAt: string
  readonly createdBy: string
}

/** An action that touches the outside world, so a person must decide it. */
export type ApprovalAction = 'send-email' | 'publish' | 'spend' | 'delete' | 'propose_agent' | 'propose_context'

/** Where an approval stands. */
export type ApprovalState = 'pending' | 'approved' | 'rejected'

/** What executing the approved action would mean. */
export interface ApprovalPayload {
  readonly to?: string
  readonly subject?: string
  readonly body?: string
  readonly amount?: number
  readonly note?: string
}

/** One decision a person owes before anything leaves the building. */
export interface Approval {
  readonly id: string
  readonly missionId?: string
  /** The channel whose agent turn asked it: the card shows in that thread. */
  readonly channelId?: string
  /** The human message whose mention gave the turn that asked it. */
  readonly messageId?: string
  readonly kind: ApprovalAction
  readonly title: string
  readonly payload: ApprovalPayload
  /**
   * The person the card is asked for (rights and reading rest on them): for a
   * card an agent's turn asked, the person who mentioned the agent.
   */
  readonly requestedBy: string
  /** The agent whose turn asked the card, when a turn did; absent for a person or a mission. */
  readonly requestedByAgent?: { readonly id: string; readonly handle: string }
  readonly requestedAt: string
  readonly state: ApprovalState
  readonly decidedBy?: string
  readonly decidedAt?: string
  readonly reason?: string
  /**
   * A propose_agent card: the agent to create, exactly the body of POST /agents.
   * The server creates it from THIS proposal when an owner or an admin approves
   * the card, never from what a page sends.
   */
  readonly proposal?: AgentProposal
  /**
   * A propose_context card: the channel's new context, against the version it
   * was written from. Applied, when approved, only if the context is still at
   * that version (another change in between: 409, the card stays pending).
   */
  readonly contextProposal?: ContextProposal
  /** The agent the approval created. */
  readonly agentId?: string
}

/** An agent proposed on a card (lot 1b): the fields of POST /agents. */
export interface AgentProposal {
  readonly handle: string
  readonly name: string
  readonly provider: string
  readonly model: string
  readonly instructions?: string
  readonly connectors?: readonly string[]
  readonly eurPerMonth?: number
}

/** One line of the product's own history. */
export interface WorkbenchEvent {
  readonly at: string
  readonly actor: string
  readonly action: string
  readonly subject: string
  readonly detail?: string
}

/** Where a delegation mandate stands. `expired` is computed from its date. */
export type MandateState = 'proposed' | 'active' | 'expired' | 'retired'

/**
 * One bounded permission: this person lends these connectors, read only, for
 * this many missions a day, until this date, once somebody else signs it.
 */
export interface Mandate {
  readonly id: string
  readonly delegant: string
  readonly delegataire: string
  readonly purpose: string
  readonly connectors: readonly string[]
  readonly missionKinds: readonly MissionKind[]
  readonly dailyCap: number
  readonly expiresOn: string
  readonly state: MandateState
  readonly createdAt: string
  readonly signedBy?: string
  readonly signedAt?: string
  readonly retiredBy?: string
  readonly retiredAt?: string
}

/**
 * A named agent with its own LLM: it answers in the channels it belongs to,
 * when a person mentions it, and never decides anything.
 */
export interface Agent {
  readonly id: string
  /** Mentioned as `@handle`; unique, `[a-z0-9-]{2,32}`. */
  readonly handle: string
  readonly name: string
  /** The pi-ai route: `scaleway-genapi`, `vllm-qwen`, … */
  readonly provider: string
  readonly model: string
  /** Its own framing, prepended to every turn (the lot 1 preset). */
  readonly instructions?: string
  /** The MCP servers it may ever use; a turn gets those its channel also allows. */
  readonly connectors: readonly string[]
  /** Its monthly ceiling in euros; a turn is refused once the month reaches it. */
  readonly eurPerMonth: number
  readonly createdBy: string
  readonly createdAt: string
  readonly retiredAt?: string
  /** Who retired it. */
  readonly retiredBy?: string
}

/** A team channel, or one person's own lane. */
export type ChannelKind = 'team' | 'solo'

/** A conversation shared by its members, people and agents. */
export interface Channel {
  readonly id: string
  /** Unique slug. */
  readonly name: string
  readonly title: string
  readonly kind: ChannelKind
  /** E-mails; a solo lane has exactly one. */
  readonly members: readonly string[]
  /** Agent ids that may be mentioned here. */
  readonly agents: readonly string[]
  /** MCP servers usable in this channel. */
  readonly connectors: readonly string[]
  readonly createdBy: string
  readonly createdAt: string
  /** How a turn of this channel is coordinated; absent, each agent answers alone. */
  readonly coordination?: Coordination
  /**
   * What the channel's agents should know about it, written by its people: the
   * one source (no AGENTS.md mirror). Given to each turn as data, never as an
   * order: it changes neither the tools nor the agent's own framing.
   */
  readonly context?: ChannelContext
}

/**
 * A channel's context. `version` grows by one at every change, an erasure
 * included (the text is then empty): a page writes from the version it read,
 * and a change in between is refused (409 context-changed), never overwritten.
 */
export interface ChannelContext {
  readonly text: string
  readonly version: number
  readonly updatedBy: string
  readonly updatedAt: string
}

/** What a propose_context card proposes. */
export interface ContextProposal {
  /** The new text, trimmed; empty erases the context. */
  readonly text: string
  /** The context version it was written from (0: the channel had none). */
  readonly baseVersion: number
}

/**
 * « Auteur puis vérificateur » (lot 2): a turn of the author is checked by the
 * verifier, an agent of ANOTHER model, against the request; the author corrects
 * once if the verifier finds something. A host script, never an agent's choice.
 */
export type Coordination = AuthorVerifier | ParallelSynthesis | Council

/** « Auteur puis vérificateur ». */
export interface AuthorVerifier {
  readonly mode: 'author-verifier'
  readonly authorId: string
  readonly verifierId: string
}

/**
 * « En parallèle puis synthèse » (lot 2): a turn of the synthesizer has each
 * worker (2 to 4) answer the request on its own, with its own connectors, then
 * the synthesizer, with NO tool, assembles their parts and says where they
 * disagree. Bounded in agents, in calls (workers + 1) and in euros per turn.
 */
export interface ParallelSynthesis {
  readonly mode: 'parallel-synthesis'
  readonly workerIds: readonly string[]
  readonly synthesizerId: string
  /** The most one such turn may cost, all steps together, in euros. */
  readonly maxEurPerTurn: number
}

/**
 * « Conseil » (brief of 15/11): 2 to 4 members answer a question framed by the
 * first of them (the chair) on their own, then critique each other without
 * names, and decide by vote (on the option's index) or by a synthesizer who is
 * not a member. A tie, a lost quorum or « none of these options » escalates.
 */
export interface Council {
  readonly mode: 'council'
  /** The members; the first one, the chair, frames the question. */
  readonly memberIds: readonly string[]
  readonly decision: 'vote' | 'synthesis'
  /** For a synthesis: who decides, never a member. */
  readonly synthesizerId?: string
  /** The most one such turn may cost, all calls together, in euros. */
  readonly maxEurPerTurn: number
}

/** @param coordination - a channel's coordination. @returns the agents it engages. */
export function coordinationAgents(coordination: Coordination): readonly string[] {
  if (coordination.mode === 'council') {
    return [...coordination.memberIds, ...(coordination.synthesizerId === undefined ? [] : [coordination.synthesizerId])]
  }
  return coordination.mode === 'author-verifier'
    ? [coordination.authorId, coordination.verifierId]
    : [...coordination.workerIds, coordination.synthesizerId]
}

/** One step of a coordinated turn: who did what, at what cost. */
export interface TurnStep {
  readonly role: 'author' | 'verifier' | 'revision' | 'worker' | 'synthesis'
  readonly agentId: string
  readonly tokens?: Mission['tokens']
  readonly eur?: number
  /** The verifier's reading: nothing to fix, things to fix, or no usable verdict. */
  readonly verdict?: 'ok' | 'issues' | 'unreadable' | 'skipped'
  /** What the verifier asked to fix, or why the check did not happen. */
  readonly notes?: readonly string[]
  /**
   * A worker's part (« en parallèle puis synthèse »), kept apart from the
   * published text: the screen presents each part under its agent, so a part
   * cannot write a heading that passes for another agent's part.
   */
  readonly text?: string
  /**
   * On a revision step that ran: whether the published text is the revision
   * (true) or the draft kept because the correction came back empty (false,
   * with a note). The screen says « corrigé » only on true.
   */
  readonly replaced?: boolean
}

/** Who wrote a message. */
export type MessageAuthor =
  | { readonly kind: 'human'; readonly email: string }
  | { readonly kind: 'agent'; readonly agentId: string }
  | { readonly kind: 'system' }

/** Where one agent turn stands. */
export type TurnStatus = 'queued' | 'running' | 'done' | 'failed' | 'refused' | 'cancelled'

/** One agent's turn, asked by a mention. */
export interface Turn {
  readonly id: string
  readonly agentId: string
  readonly status: TurnStatus
  /** The DSH session of the turn: its trace. */
  readonly sessionId?: string
  readonly tokens?: Mission['tokens']
  /** What it cost, from the configured price of its model. */
  readonly eur?: number
  /** Why it failed, was refused or cancelled, in plain words. */
  readonly reason?: string
  /** A coordinated turn's steps, in order; each step's cost counts for its own agent. */
  readonly steps?: readonly TurnStep[]
  /**
   * A help its agent asked its peers during this turn (ask_peers): the peers'
   * advices, then its reading. Its cost counts in this turn's eur, for the
   * agent that asked. Served without the peers' identities until `reading`.
   */
  readonly help?: TurnHelp
  /**
   * A council this turn ran (its chair's turn in a « conseil » channel): the
   * framing, the positions, the critiques and the decision. Each call counts
   * for the member who made it. Served without the members' identities until
   * the decision.
   */
  readonly council?: TurnCouncil
  readonly startedAt?: string
  readonly finishedAt?: string
}

/** What a blocked agent needs from its peers. */
export type HelpNeed = 'fact' | 'opinion' | 'check' | 'choice'

/** A help request, structured: refused when a field is missing. */
export interface HelpRequest {
  readonly task: string
  readonly tried: string
  readonly blocker: string
  readonly options: readonly string[]
  readonly need: HelpNeed
}

/** One peer's advice. `agentId` and `model` are served only once the asker has read them. */
export interface HelpAdvice {
  readonly slot: 'A' | 'B'
  readonly round: 1 | 2
  readonly text: string
  readonly eur?: number
  readonly tokens?: Mission['tokens']
  readonly agentId?: string
  readonly model?: string
}

/** What the asker made of the advices. */
export interface HelpReading {
  /** The slots retained (« A », « B », « A+B ») or « aucun ». */
  readonly retained: string
  readonly why: string
  readonly verdict: 'unblocked' | 'card' | 'escalate'
}

/** A question put to the channel's people when the peers did not unblock the asker. */
export interface HelpEscalation {
  readonly question: string
  readonly summary: string
  readonly at: string
  /** The asker's message that publishes the question: a person answers it by replying to it. */
  readonly messageId?: string
  readonly answeredAt?: string
  readonly answeredBy?: string
}

/** A help asked during a turn, and where it stands. */
export interface TurnHelp {
  readonly state: 'asked' | 'advising' | 'reading' | 'done'
  readonly request: HelpRequest
  /** The peers asked, slot A first: served only once `reading` is set. */
  readonly peerIds: readonly string[]
  readonly advices: readonly HelpAdvice[]
  readonly reading?: HelpReading
  readonly escalation?: HelpEscalation
  /** A person who answered in the thread while the help ran: it ended there, without reading. */
  readonly closedBy?: { readonly by: string; readonly at: string }
  /** What the help cost (advices and reading), counted for the asker. */
  readonly eur?: number
  readonly capEur: number
  readonly skipped: readonly { readonly slot?: 'A' | 'B'; readonly agentId?: string; readonly reason: string }[]
  readonly askedAt: string
}

/** A council's slot: one per member, drawn. */
export type CouncilSlot = 'A' | 'B' | 'C' | 'D'

/** What a council's call cost, and who made it: withheld from what is served until the decision. */
export interface CouncilCost {
  readonly agentId?: string
  readonly model?: string
  readonly eur?: number
  readonly tokens?: Mission['tokens']
}

/** One member's position. `choice` is the option's index (1-based), never its label. */
export interface CouncilPosition extends CouncilCost {
  readonly slot: CouncilSlot
  readonly choice?: number
  readonly text: string
}

/** One member's critique of the others, and its final choice (the one counted). */
export interface CouncilCritique extends CouncilCost {
  readonly slot: CouncilSlot
  /** The slots it critiques. */
  readonly about: readonly CouncilSlot[]
  readonly text: string
  readonly choice?: number
}

/** How a council decided. */
export type CouncilDecision =
  | { readonly kind: 'vote'; readonly tally: Readonly<Record<string, number>>; readonly chosen?: number }
  | ({ readonly kind: 'synthesis'; readonly text: string; readonly chosen?: number } & CouncilCost)

/** A council a chair's turn ran, and where it stands. */
export interface TurnCouncil {
  readonly state: 'deliberating' | 'critiquing' | 'deciding' | 'done'
  /** The chair's framing (the chair is the turn's agent). */
  readonly framing?: { readonly text: string } & CouncilCost
  readonly question: string
  /** The options, numbered from 1 by their position; the last is always « aucune de ces options ». */
  readonly options: readonly string[]
  readonly positions: readonly CouncilPosition[]
  readonly critiques: readonly CouncilCritique[]
  readonly decision?: CouncilDecision
  /** Who did not follow the decision. */
  readonly dissent: readonly { readonly slot: CouncilSlot; readonly why?: string }[]
  readonly escalation?: HelpEscalation
  /** What the council cost, every call together. */
  readonly eur?: number
  readonly capEur: number
  readonly skipped: readonly { readonly slot?: CouncilSlot; readonly agentId?: string; readonly reason: string }[]
  readonly startedAt: string
}

/** One message of a channel. */
export interface Message {
  readonly id: string
  readonly channelId: string
  readonly author: MessageAuthor
  readonly text: string
  /** Agent ids the text mentions among the channel's agents. */
  readonly mentions: readonly string[]
  /** An agent's answer points at the message that mentioned it. */
  readonly replyTo?: string
  /** On a human message: one turn per agent it mentions. */
  readonly turns?: readonly Turn[]
  readonly createdAt: string
  /** Last change: its creation, a turn moving on, its deletion. The screen polls on it. */
  readonly updatedAt?: string
  /** A deleted message keeps its place, without its text. */
  readonly deletedAt?: string
}

/** Everything the product persists. */
export interface WorkbenchState {
  readonly version: 1
  readonly missions: readonly Mission[]
  readonly briefs: readonly Brief[]
  readonly memories: readonly MemoryNote[]
  readonly approvals: readonly Approval[]
  readonly events: readonly WorkbenchEvent[]
  readonly mandates: readonly Mandate[]
  /** Absent in a state written before the channels: read as empty. */
  readonly agents?: readonly Agent[]
  readonly channels?: readonly Channel[]
  readonly messages?: readonly Message[]
}

/** A state with nothing in it. */
export const emptyState: WorkbenchState = {
  version: 1,
  missions: [],
  briefs: [],
  memories: [],
  approvals: [],
  events: [],
  mandates: [],
}

const missionKinds: readonly MissionKind[] = [
  'briefing', 'meeting-prep', 'account-review', 'invoice-chase', 'signal-watch', 'weekly-synthesis', 'custom',
]

/** @param value - the candidate. @returns true when it names a mission kind. */
export function isMissionKind(value: unknown): value is MissionKind {
  return typeof value === 'string' && (missionKinds as readonly string[]).includes(value)
}

/** @param value - the candidate. @returns true when it names a mission status. */
export function isMissionStatus(value: unknown): value is MissionStatus {
  return value === 'queued' || value === 'running' || value === 'done' || value === 'failed' || value === 'needs-review'
}

/** @param value - the candidate action. @returns true when it leaves the building. */
export function needsApproval(value: string): value is ApprovalAction {
  return value === 'send-email' || value === 'publish' || value === 'spend' || value === 'delete' || value === 'propose_agent' || value === 'propose_context'
}
