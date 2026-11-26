/**
 * The rules of the workbench.
 *
 * One service owns every transition, so a page, an HTTP route and a test cannot
 * disagree about what a mission may become. Two rules carry the honesty the
 * product needs: a mission never reaches `done` without a brief that has content,
 * and an action that leaves the building never happens without a recorded human
 * decision.
 */
import { Refusal } from './refusal.ts'
import { ScheduleRefusal } from './schedule.ts'
import type { Schedule, ScheduleProposal } from './schedule.ts'
import { randomUUID } from 'node:crypto'
import { coordinationAgents, emptyState, isMissionKind, needsApproval } from './types.ts'
import type {
  Agent,
  AgentProposal,
  Coordination,
  Approval,
  ApprovalAction,
  ApprovalPayload,
  ApprovalState,
  Brief,
  BriefSource,
  Channel,
  ChannelContext,
  Skill,
  HelpEscalation,
  HelpRequest,
  TurnHelp,
  ContextProposal,
  MemoryKind,
  MemoryNote,
  MemoryScope,
  Mission,
  MissionKind,
  MissionStatus,
  Message,
  MessageAuthor,
  Turn,
  Visibility,
  WorkbenchEvent,
  WorkbenchState,
} from './types.ts'
import type { WorkbenchStore } from './store.ts'
import type { Mandate, MissionFailureKind, TurnFailureKind } from './types.ts'
import type { MandateDraft } from '../mandates.ts'
import { draftRefusal, signRefusal } from '../mandates.ts'
import type { Role } from '@deepseek-ai/dsh-client-ui-governance/src/rbac.ts'
import { SLUG, freeSlug, mentionsOf, slugOf } from './conversation.ts'
import { isPlainAscii } from './address.ts'

/**
 * @param members - the e-mails a person adds to a channel.
 * @returns them, once each is checked to be plain ASCII (address.ts): a lookalike
 * spelling would be lower-cased onto another person's address.
 */
/**
 * @param channel - a channel.
 * @param email - a person.
 * @returns whether it is that person's lane, the address compared without case:
 * a capital letter never makes a second lane.
 */
export function isLaneOf(channel: Channel, email: string): boolean {
  return channel.kind === 'solo' && channel.members[0]?.toLowerCase() === email.toLowerCase()
}

function plainMembers(members: readonly string[]): readonly string[] {
  const refused = members.filter(email => !isPlainAscii(email))
  if (refused.length > 0) throw new Refusal(`a member is a plain ASCII e-mail address: ${refused.length} refused`)
  return members
}

/** What a caller must say to ask for work. */
export interface MissionRequest {
  readonly kind: MissionKind
  readonly prompt: string
  readonly createdBy: string
  readonly visibility?: Visibility
  readonly mandateId?: string
  /** The automation's name, when an automation runs it. */
  readonly title?: string
  /** The automation that starts it: its result is published in its person's lane. */
  readonly automationId?: string
}

/** What a runtime reports when a run finishes. */
export interface MissionResult {
  readonly title: string
  readonly markdown: string
  readonly sources?: readonly BriefSource[]
  readonly tokens?: { readonly input: number; readonly output: number }
  /** Servers the mission ran without (a briefing on a space with no facts server). */
  readonly toolsUnavailable?: readonly string[]
  /** What the run cost, in euros, when the model's price is known. */
  readonly eur?: number
}

/** What a caller must say to ask for a decision. */
export interface ApprovalRequest {
  readonly kind: ApprovalAction
  readonly title: string
  readonly payload?: ApprovalPayload
  readonly missionId?: string
  /** The channel and the mentioning message of the agent turn that asks it. */
  readonly channelId?: string
  readonly messageId?: string
  readonly requestedBy: string
  /** A propose_agent card's agent, checked as POST /agents checks it. */
  readonly proposal?: AgentProposal
  /** A propose_context card's new context; the card must be asked from a channel turn (channelId). */
  readonly contextProposal?: ContextProposal
  /** The agent whose turn asked it: set by the server from the running turn, never from a request. */
  readonly requestedByAgent?: { readonly id: string; readonly handle: string }
  /** A propose_schedule card's task, checked by checkedScheduleProposal (its agent and destination the host's). */
  readonly scheduleProposal?: ScheduleProposal
}

/** What creating an agent needs. */
export interface AgentDraft {
  readonly handle: string
  readonly name: string
  readonly provider: string
  readonly model: string
  readonly instructions?: string
  readonly connectors?: readonly string[]
  readonly eurPerMonth?: number
  /** Slugs of the library's skills. */
  readonly skills?: readonly string[]
}

/** What changing an agent may touch. */
export type AgentPatch = Partial<Pick<Agent, 'name' | 'provider' | 'model' | 'instructions' | 'connectors' | 'eurPerMonth' | 'skills'>>

/** What creating a channel needs. */
export interface ChannelDraft {
  /** A slug; absent, it is derived from the title (a channel is created from one field). */
  readonly name?: string
  readonly title?: string
  readonly members?: readonly string[]
  readonly agents?: readonly string[]
  readonly connectors?: readonly string[]
}

/** The default monthly ceiling of an agent, in euros. */
export const DEFAULT_EUR_PER_MONTH = 5
/** The highest monthly ceiling of an agent, whoever sets it (21/11, rule of C on #81). */
export const MAX_EUR_PER_MONTH = 50
/** The longest framing of an agent, in characters: it is added to every turn. */
export const MAX_INSTRUCTIONS = 2000
/** The longest name of an agent: it enters the turn prompt of every agent of its channels. */
export const MAX_AGENT_NAME = 60
/**
 * The propose_agent cards that may wait at once, per person who asked and,
 * for a card asked during a turn, per agent too: an agent mentioned by several
 * members must not file three cards for each of them.
 */
export const MAX_PENDING_PROPOSALS = 3
/**
 * @param turn - a turn.
 * @returns its help's or its council's escalation, when one waits for an answer.
 */
function openEscalationOf(turn: Turn): { kind: 'help' | 'council'; escalation: HelpEscalation } | undefined {
  if (turn.help?.escalation !== undefined && turn.help.escalation.answeredAt === undefined) return { kind: 'help', escalation: turn.help.escalation }
  if (turn.council?.escalation !== undefined && turn.council.escalation.answeredAt === undefined) return { kind: 'council', escalation: turn.council.escalation }
  return undefined
}

/** An open escalation, as the « À traiter » queue reads it. */
export interface OpenEscalation {
  /** What escalated: a help (the asker gets the hand again) or a council (the answer is the decision). */
  readonly kind: 'help' | 'council'
  readonly channelId: string
  readonly turnId: string
  /** The mentioning message of the turn that asked. */
  readonly messageId: string
  /** The asker's message that publishes the question: a reply to it answers. */
  readonly questionMessageId?: string
  readonly question: string
  readonly summary: string
  readonly at: string
}

/** The longest body of a skill, in characters once trimmed: it enters the prompt of every agent that uses it. */
export const MAX_SKILL_BODY = 6000
/** The skills one agent may use. */
export const MAX_SKILLS_PER_AGENT = 3
/** The longest name of a skill. */
export const MAX_SKILL_NAME = 60

/** Why a skill is refused, by a code the screen reads. */
export type SkillRefusalCode = 'missing-fields' | 'skill-too-long' | 'skill-changed' | 'skill-exists' | 'unknown-skill' | 'too-many-skills'
/** A refused skill: 409 for skill-changed and skill-exists, 404 for unknown-skill on its own route, 400 otherwise. */
export class SkillRefusal extends Refusal {
  readonly code: SkillRefusalCode
  constructor(code: SkillRefusalCode, message: string) {
    super(message)
    this.name = 'SkillRefusal'
    this.code = code
  }
}

/** The fields of a SKILL.md's front matter a skill keeps; any other is ignored, and said. */
const SKILL_FIELDS = ['name', 'description']

/**
 * Read a SKILL.md: its front matter (between two « --- » lines, « key: value »
 * per line) and its body. Format parsing only. Only name and description are
 * kept: a skill grants nothing, so allowed-tools, model and the like are
 * ignored, and returned for the person to see.
 * @param markdown - the file's text.
 * @returns the skill's fields and the front-matter keys ignored.
 * @throws SkillRefusal missing-fields (no front matter, no name), skill-too-long.
 */
export function parseSkill(markdown: string): { name: string; description: string; body: string; ignoredFields: string[] } {
  const text = markdown.replace(/\r\n/g, '\n').trim()
  if (!text.startsWith('---\n')) throw new SkillRefusal('missing-fields', 'a SKILL.md starts with its front matter: « --- », « name: … », « --- »')
  // The front matter ends at the first line that is exactly « --- » (trailing
  // blanks aside): « ---x » or « ----- » inside it is not its end.
  const lines = text.split('\n')
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === '---')
  if (end < 0) throw new SkillRefusal('missing-fields', 'the front matter of a SKILL.md ends with a « --- » line')
  const fields = new Map<string, string>()
  const ignored: string[] = []
  for (const line of lines.slice(1, end)) {
    const found = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (found === null) continue
    const key = (found[1] ?? '').toLowerCase()
    if (SKILL_FIELDS.includes(key)) fields.set(key, (found[2] ?? '').trim().replace(/^["']|["']$/g, ''))
    else if (!ignored.includes(key)) ignored.push(key)
  }
  const name = fields.get('name') ?? ''
  const body = lines.slice(end + 1).join('\n').trim()
  if (name === '') throw new SkillRefusal('missing-fields', 'a SKILL.md names its skill (« name: … » in its front matter)')
  if (name.length > MAX_SKILL_NAME) throw new SkillRefusal('missing-fields', `a skill's name is ${MAX_SKILL_NAME} characters at most`)
  if (body === '') throw new SkillRefusal('missing-fields', 'a SKILL.md has a body after its front matter')
  if (body.length > MAX_SKILL_BODY) throw new SkillRefusal('skill-too-long', `a skill's body is ${MAX_SKILL_BODY} characters at most (${body.length} given)`)
  return { name, description: fields.get('description') ?? '', body, ignoredFields: ignored }
}

/**
 * @param skills - the library.
 * @param slugs - the skills asked for an agent.
 * @returns them, deduplicated, each one in the library, three at most.
 * @throws SkillRefusal unknown-skill, too-many-skills.
 */
function checkedSkills(skills: readonly Skill[], slugs: readonly string[]): string[] {
  const asked = [...new Set(slugs)]
  if (asked.length > MAX_SKILLS_PER_AGENT) throw new SkillRefusal('too-many-skills', `an agent uses ${MAX_SKILLS_PER_AGENT} skills at most`)
  const unknown = asked.filter(slug => !skills.some(skill => skill.slug === slug))
  if (unknown.length > 0) throw new SkillRefusal('unknown-skill', `not in the library: ${unknown.join(', ')}`)
  return asked
}

/** The peers of one help request, at most. */
export const MAX_HELP_PEERS = 2
/** The help requests of one thread, at most: beyond, the asker puts its question to the people. */
export const MAX_HELPS_PER_THREAD = 2
/** What one help request may cost, advices and reading together, in euros (v1: a constant). */
export const HELP_CAP_EUR = 0.2

/** Why a help request is refused, by a code the agent and the screen read. */
export type HelpRefusalCode =
  | 'missing-fields' | 'not-running' | 'already-asked' | 'coordinated-channel'
  | 'no-peer' | 'too-many-peers' | 'self' | 'thread-limit' | 'pair-already-asked'
/** A refused help request. */
export class HelpRefusal extends Refusal {
  readonly code: HelpRefusalCode
  constructor(code: HelpRefusalCode, message: string) {
    super(message)
    this.name = 'HelpRefusal'
    this.code = code
  }
}

/** The longest context of a channel, in characters once trimmed: it enters every turn of the channel. */
export const MAX_CONTEXT_CHARS = 4000

/** Why a channel's context is refused, by a code the screen reads. */
export type ContextRefusalCode = 'context-too-long' | 'context-changed'
/** A refused change of a channel's context: 409 for context-changed, 400 otherwise. */
export class ContextRefusal extends Refusal {
  readonly code: ContextRefusalCode
  constructor(code: ContextRefusalCode, message: string) {
    super(message)
    this.name = 'ContextRefusal'
    this.code = code
  }
}

/**
 * @param channel - a channel.
 * @param text - the new context; trimmed, empty erases it.
 * @param baseVersion - the version it was written from (0: none).
 * @param actor - who changes it.
 * @param at - when.
 * @returns the channel with its new context.
 * @throws ContextRefusal when too long, or when the context moved since baseVersion.
 */
function withContext(channel: Channel, text: string, baseVersion: number, actor: string, at: string): Channel {
  const trimmed = text.trim()
  if (trimmed.length > MAX_CONTEXT_CHARS) {
    throw new ContextRefusal('context-too-long', `a channel's context is ${MAX_CONTEXT_CHARS} characters at most (${trimmed.length} given)`)
  }
  const current = channel.context?.version ?? 0
  if (baseVersion !== current) {
    throw new ContextRefusal('context-changed', `the context of #${channel.name} changed since version ${baseVersion} (now ${current}): read it again`)
  }
  const context: ChannelContext = { text: trimmed, version: current + 1, updatedBy: actor, updatedAt: at }
  return { ...channel, context }
}

/** Why a channel's coordination is refused, by a code the screen reads (not the English text). */
export type CoordinationRefusalCode =
  | 'not-member' | 'same-agent' | 'same-model' | 'too-few-workers' | 'too-many-workers'
  | 'synthesizer-is-worker' | 'budget-out-of-range' | 'unknown-mode' | 'missing-fields'
  | 'too-few-members' | 'too-many-members' | 'synthesizer-is-member' | 'unknown-decision'

/** A refused coordination: its message for people, its code for the screen. */
export class CoordinationRefusal extends Refusal {
  readonly code: CoordinationRefusalCode
  constructor(code: CoordinationRefusalCode, message: string) {
    super(message)
    this.name = 'CoordinationRefusal'
    this.code = code
  }
}
/** The members of a « conseil ». */
export const MIN_COUNCIL_MEMBERS = 2
export const MAX_COUNCIL_MEMBERS = 4
/** What a council turn costs at most when the channel says nothing, in euros. */
export const DEFAULT_EUR_PER_COUNCIL_TURN = 1
/** The workers of a « en parallèle puis synthèse » turn. */
export const MIN_WORKERS = 2
export const MAX_WORKERS = 4
/** The most a coordinated turn may be allowed to cost, in euros. */
export const MAX_EUR_PER_COORDINATED_TURN = 5
/** The default cost bound of a parallel turn, in euros. */
export const DEFAULT_EUR_PER_PARALLEL_TURN = 1

/** An MCP server name, as the MCP client accepts it. */
const SERVER = /^[A-Za-z0-9_-]{1,32}$/

/** How to narrow a listing. */
export interface MissionFilter {
  readonly createdBy?: string
  readonly status?: MissionStatus
  readonly limit?: number
}

/** How to narrow a memory read. */
export interface MemoryFilter {
  readonly scope?: MemoryScope
  readonly kind?: MemoryKind
  readonly limit?: number
}

/** A decision on a card its decider can no longer read, checked inside the write: answered as absent. */
export class UnreadableApproval extends Refusal {
  /** @param id - the card. */
  constructor(id: string) {
    super(`no approval ${id}`)
    this.name = 'UnreadableApproval'
  }
}

/**
/**
 * The kind of a mission's failure, read from the host's own wording of it (the
 * runner's and the service's messages, a technical format, not a judgment):
 * what is served instead of those words, which may carry a provider's detail.
 * @param reason - the failure's reason, as recorded on the mission.
 * @returns its kind.
 */
export function missionFailureKind(reason: string): MissionFailureKind {
  if (reason.startsWith('cancelled by ')) return 'cancelled'
  if (reason.startsWith('outils indisponibles')) return 'tools'
  if (/ended max-tokens|ended length/.test(reason)) return 'cut'
  if (/returned no text|no usable content/.test(reason)) return 'no-answer'
  return 'failed'
}

/**
 * The kind of a turn's failure, read as missionFailureKind does, plus the
 * engine's known ends.
 * @param reason - the failure's text, as the engine or the host gave it.
 * @returns its kind.
 */
export function turnFailureKind(reason: string): TurnFailureKind {
  if (reason.startsWith('le coût du tour a atteint sa borne')) return 'budget'
  if (/ended blocked/.test(reason)) return 'blocked'
  if (/ended aborted/.test(reason)) return 'aborted'
  if (/ended interrupted/.test(reason)) return 'interrupted'
  return missionFailureKind(reason)
}

/** The host's sentence for each kind of a turn's failure: all that is served of it. */
export const TURN_FAILURE_SENTENCE: Readonly<Record<TurnFailureKind, string>> = {
  'no-answer': 'Le modèle n’a pas répondu.',
  cut: 'Réponse coupée (limite de longueur atteinte).',
  cancelled: 'Tour annulé.',
  tools: 'Des outils n’étaient pas disponibles ; le tour n’a pas été lancé.',
  failed: 'Erreur pendant l’exécution.',
  budget: 'Le coût du tour a atteint sa borne.',
  blocked: 'Le tour a été bloqué.',
  aborted: 'Le tour a été abandonné.',
  interrupted: 'Le tour a été interrompu.',
  refused: 'Tour refusé.',
  stale: 'Tour sans objet.',
  restart: 'Interrompu par un redémarrage.',
}

/** The host's sentence for each kind: all that is served of a failure (the mission, its journal line, the lane). */
const FAILURE_SENTENCE: Readonly<Record<MissionFailureKind, string>> = {
  'no-answer': 'le modèle n’a pas répondu.',
  cut: 'réponse coupée (limite de longueur atteinte).',
  cancelled: 'annulé.',
  tools: 'des outils n’étaient pas disponibles ; il n’a pas été lancé.',
  failed: 'erreur pendant l’exécution.',
}

/**
 * @param kind - the failure's kind.
 * @param by - who cancelled it, for a cancellation.
 * @param restarted - whether a restart of the workbench interrupted it.
 * @returns the host's sentence for it, lower case: never the runtime's words.
 */
function failureSentence(kind: MissionFailureKind, by?: string, restarted = false): string {
  if (kind === 'cancelled' && by !== undefined) return `annulé par ${by}.`
  if (restarted) return 'interrompu par un redémarrage.'
  return FAILURE_SENTENCE[kind]
}

/** @param sentence - a failure sentence. @returns it as Mission.error: capitalized. */
function asError(sentence: string): string {
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`
}

/** @param sentence - a failure sentence. @returns the line published in the lane. */
function failedLine(sentence: string): string {
  return `Le briefing n’a pas abouti : ${sentence}`
}

/** What building one service needs. */
export interface ServiceOptions {
  readonly store: WorkbenchStore
  readonly now?: () => Date
  readonly nextId?: (prefix: string) => string
  /** Where the service says what it changed on its own at load (a mandate retired). */
  readonly warn?: (message: string) => void
  /**
   * A team instance: a finished briefing is published in the lane of the person
   * who ran it (decision of 24/11), the page having no other place where the
   * owner reads it. Off on a solo workstation, whose page shows its briefs.
   */
  readonly briefingsInLane?: boolean
}

/** The service. */
export class WorkbenchService {
  readonly #options: ServiceOptions
  #state: WorkbenchState = emptyState
  #loaded = false
  #chain: Promise<unknown> = Promise.resolve()

  /** @param options - store, clock and identifier seams. */
  constructor(options: ServiceOptions) {
    this.#options = options
  }

  /** @returns the clock as an ISO string. */
  #at(): string {
    return (this.#options.now ?? (() => new Date()))().toISOString()
  }

  /** @param prefix - entity prefix. @returns a fresh identifier. */
  #id(prefix: string): string {
    if (this.#options.nextId !== undefined) return this.#options.nextId(prefix)
    return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`
  }

  /**
   * A finished briefing, or the run of an automation (by the scheduler or by
   * hand, decision of 26/11: fewer clicks), published in the lane of the person
   * who ran it, as a system message carrying the mission (decision of 24/11; see
   * Message.mission), under the automation's name. Nothing on a solo
   * workstation, for another mission (one started in a channel), or for a run
   * recorded under no person (an automation before a team instance names its owner).
   * @param state - the state with the mission already finished.
   * @param mission - the finished mission.
   * @param text - the report, or the short line of a failure.
   * @param at - when.
   * @returns the state with the message (and the lane, created when absent), and their journal lines.
   */
  #inLane(
    state: WorkbenchState,
    mission: Mission,
    text: string,
    at: string,
    reasonKind?: MissionFailureKind,
  ): { state: WorkbenchState; events: WorkbenchEvent[] } {
    const owner = mission.createdBy
    const published = mission.kind === 'briefing' || mission.automationId !== undefined
    if (this.#options.briefingsInLane !== true || !published || !owner.includes('@')) return { state, events: [] }
    const events: WorkbenchEvent[] = []
    let lane = (state.channels ?? []).find(channel => isLaneOf(channel, owner))
    let channels = state.channels ?? []
    if (lane === undefined) {
      lane = {
        id: this.#id('chn'),
        name: `solo-${this.#id('l').slice(-8)}`,
        title: `Ma lane (${owner})`,
        kind: 'solo',
        members: [owner],
        agents: [],
        connectors: [],
        createdBy: owner,
        createdAt: at,
      }
      channels = [...channels, lane]
      events.push({ at, actor: owner, action: 'channel.lane', subject: lane.id })
    }
    const message: Message = {
      id: this.#id('msg'),
      channelId: lane.id,
      author: { kind: 'system' },
      text,
      mentions: [],
      mission: {
        id: mission.id,
        kind: mission.kind,
        title: mission.title ?? (mission.kind === 'briefing' ? 'Briefing' : 'Automatisation'),
        status: mission.status === 'done' ? 'done' : 'failed',
        ...(mission.eur === undefined ? {} : { eur: mission.eur }),
        ...((mission.toolsUnavailable ?? []).length === 0 ? {} : { toolsUnavailable: [...(mission.toolsUnavailable ?? [])] }),
        ...(reasonKind === undefined ? {} : { reasonKind }),
      },
      createdAt: at,
      updatedAt: at,
    }
    events.push({ at, actor: owner, action: 'message.posted', subject: message.id, detail: lane.id })
    return { state: { ...state, channels, messages: [...(state.messages ?? []), message] }, events }
  }

  /** @returns the loaded state, loading it once. */
  async #ready(): Promise<WorkbenchState> {
    if (!this.#loaded) {
      const loaded = await this.#options.store.load()
      // Older state files predate mandates; they read as no mandates, never as a crash.
      // Its parties read as the lower-case e-mail the proxy proves, as channel
      // members do: a mandate written with capitals before #60 keeps working.
      // A row without its parties, or one whose parties are the same person once
      // lower-cased (A@x and a@x, which the draft check now refuses), is kept for
      // the record but retired: it authorises nothing, and a load never crashes on it.
      let retiredOnLoad = 0
      const mandates = ((loaded as { mandates?: readonly Mandate[] }).mandates ?? []).map((mandate) => {
        const party = (value: unknown): string => (typeof value === 'string' ? value.trim().toLowerCase() : '')
        const delegant = party(mandate.delegant)
        const delegataire = party(mandate.delegataire)
        const why = delegant === '' || delegataire === '' ? 'a party is missing' : delegant === delegataire ? 'its two parties are the same person' : undefined
        if (why !== undefined && mandate.state !== 'retired') {
          // Said once per load, with what it was: the next write keeps only « retired ».
          this.#options.warn?.(`mndt: mandate ${String(mandate.id)} retired on load (${why}); it was ${String(mandate.state)}, ${delegant || '?'} to ${delegataire || '?'}`)
          retiredOnLoad += 1
        }
        return { ...mandate, delegant, delegataire, ...(why === undefined ? {} : { state: 'retired' as const }) }
      })
      // One spelling of a person: members written with capitals before identities were normalised
      // read as the lower-case e-mail the proxy proves, so nobody loses a channel.
      const channels = loaded.channels?.map(channel => ({
        ...channel,
        members: [...new Set(channel.members.map(email => email.trim().toLowerCase()))],
      }))
      this.#state = { ...loaded, mandates, ...(channels === undefined ? {} : { channels }) }
      this.#loaded = true
      // Recorded once: a mandate retired on load is said at this start only, not at every start.
      // Through the write chain, behind any write already queued: never a save
      // that races another one.
      // The state saved is the one current when this link runs, never the load's
      // snapshot: a write queued before it must not be overwritten on disk.
      if (retiredOnLoad > 0) {
        const save = this.#chain.then(() => this.#options.store.save(this.#state))
        this.#chain = save.catch(() => undefined)
      }
    }
    return this.#state
  }

  /**
   * Run one mutation under the write chain, so two concurrent missions cannot
   * overwrite each other.
   * @param work - the mutation, given the current state.
   * @returns whatever the mutation returns.
   */
  async #write<T>(
    work: (state: WorkbenchState) =>
      | { state: WorkbenchState; event: WorkbenchEvent | readonly WorkbenchEvent[]; value: T }
      | Promise<{ state: WorkbenchState; event: WorkbenchEvent | readonly WorkbenchEvent[]; value: T }>,
  ): Promise<T> {
    let result: T | undefined
    const run = this.#chain.then(async () => {
      const state = await this.#ready()
      const next = await work(state)
      // One change may journal several facts (a channel updated and a coordination ended).
      const recorded = Array.isArray(next.event) ? next.event : [next.event as WorkbenchEvent]
      const committed: WorkbenchState = { ...next.state, events: [...next.state.events, ...recorded].slice(-500) }
      await this.#options.store.save(committed)
      this.#state = committed
      result = next.value
    })
    this.#chain = run.catch(() => undefined)
    await run
    return result as T
  }

  /**
   * Ask for a mission.
   * @param request - kind, prompt and requester.
   * @returns the queued mission.
   */
  createMission(request: MissionRequest): Promise<Mission> {
    if (!isMissionKind(request.kind)) return Promise.reject(new Refusal(`unknown mission kind: ${String(request.kind)}`))
    const prompt = request.prompt.trim()
    if (prompt === '') return Promise.reject(new Refusal('a mission needs an instruction'))
    if (request.createdBy.trim() === '') return Promise.reject(new Refusal('a mission needs a requester'))
    const mission: Mission = {
      id: this.#id('mis'),
      kind: request.kind,
      prompt,
      status: 'queued',
      createdBy: request.createdBy.trim(),
      visibility: request.visibility ?? 'team',
      createdAt: this.#at(),
      ...(request.mandateId === undefined ? {} : { mandateId: request.mandateId }),
      ...(request.title === undefined || request.title.trim() === '' ? {} : { title: request.title.trim() }),
      ...(request.automationId === undefined || request.automationId.trim() === '' ? {} : { automationId: request.automationId.trim() }),
    }
    return this.#write(state => ({
      state: { ...state, missions: [mission, ...state.missions] },
      event: { at: mission.createdAt, actor: mission.createdBy, action: 'mission.queued', subject: mission.id },
      value: mission,
    }))
  }

  /**
   * Mark a mission as carried by a runtime session.
   * @param id - mission id.
   * @param sessionId - the session doing the work.
   * @returns the running mission.
   */
  startMission(id: string, sessionId: string): Promise<Mission> {
    if (sessionId.trim() === '') return Promise.reject(new Refusal('a run needs a session'))
    return this.#write((state) => {
      const mission = state.missions.find(candidate => candidate.id === id)
      if (mission === undefined) throw new Refusal(`no mission ${id}`)
      if (mission.status !== 'queued' && mission.status !== 'needs-review') {
        throw new Refusal(`mission ${id} is ${mission.status}; only a queued mission can start`)
      }
      const at = this.#at()
      const next: Mission = { ...mission, status: 'running', sessionId, startedAt: at }
      return {
        state: { ...state, missions: state.missions.map(candidate => (candidate.id === id ? next : candidate)) },
        event: { at, actor: mission.createdBy, action: 'mission.started', subject: id, detail: sessionId },
        value: next,
      }
    })
  }

  /**
   * Record a finished run. A run that produced nothing is a failure, not a done
   * mission with an empty brief: the page would otherwise show a success nobody
   * can read.
   * @param id - mission id.
   * @param result - what the runtime produced.
   * @returns the finished mission and its brief.
   */
  async completeMission(id: string, result: MissionResult): Promise<{ mission: Mission; brief: Brief }> {
    const title = result.title.trim()
    const markdown = result.markdown.trim()
    if (title === '' || markdown === '') {
      await this.failMission(id, 'the agent returned no usable content')
      throw new Refusal(`mission ${id} produced no usable content`)
    }
    return this.#write((state) => {
      const mission = state.missions.find(candidate => candidate.id === id)
      if (mission === undefined) throw new Refusal(`no mission ${id}`)
      if (mission.status !== 'running') throw new Refusal(`mission ${id} is ${mission.status}; only a running mission can finish`)
      const at = this.#at()
      const brief: Brief = {
        id: this.#id('brf'),
        missionId: id,
        title,
        markdown,
        sources: result.sources ?? [],
        status: 'draft',
        createdBy: mission.createdBy,
        createdAt: at,
        visibility: mission.visibility,
      }
      const next: Mission = {
        ...mission,
        status: 'done',
        finishedAt: at,
        briefId: brief.id,
        ...(result.tokens === undefined ? {} : { tokens: result.tokens }),
        ...((result.toolsUnavailable ?? []).length === 0 ? {} : { toolsUnavailable: [...(result.toolsUnavailable ?? [])] }),
        ...(result.eur === undefined || !Number.isFinite(result.eur) || result.eur < 0 ? {} : { eur: result.eur }),
      }
      const done = {
        ...state,
        missions: state.missions.map(candidate => (candidate.id === id ? next : candidate)),
        briefs: [brief, ...state.briefs],
      }
      const published = this.#inLane(done, next, markdown, at)
      return {
        state: published.state,
        event: [{
          at,
          actor: mission.createdBy,
          action: 'mission.done',
          subject: id,
          detail: result.tokens === undefined ? brief.id : `${brief.id}, ${result.tokens.input} in / ${result.tokens.output} out`,
        }, ...published.events],
        value: { mission: next, brief },
      }
    })
  }

  /**
   * Record a failure with the runtime's own reason.
   * @param id - mission id.
   * @param reason - why it failed; an empty reason is refused.
   * @returns the failed mission.
   */
  failMission(id: string, reason: string): Promise<Mission> {
    // An empty reason (an error thrown without a message) must not leave the
    // mission running: it fails with a reason of its own, said as « failed ».
    const detail = reason.trim() === '' ? 'the run failed without a reason' : reason.trim()
    return this.#write((state) => {
      const mission = state.missions.find(candidate => candidate.id === id)
      if (mission === undefined) throw new Refusal(`no mission ${id}`)
      if (mission.status === 'done' || mission.status === 'failed') throw new Refusal(`mission ${id} already ${mission.status}`)
      const at = this.#at()
      const kind = missionFailureKind(detail)
      const sentence = failureSentence(kind, undefined, detail.startsWith('interrupted by a workbench restart'))
      // The runtime's own words, for the operator only (web.log): never served.
      this.#options.warn?.(`mndt: mission ${id} (${mission.kind}) failed: ${detail}`)
      const next: Mission = { ...mission, status: 'failed', finishedAt: at, error: asError(sentence), reasonKind: kind }
      const missions = state.missions.map(candidate => (candidate.id === id ? next : candidate))
      const published = this.#inLane({ ...state, missions }, next, failedLine(sentence), at, kind)
      return {
        state: published.state,
        event: [{ at, actor: mission.createdBy, action: 'mission.failed', subject: id, detail: asError(sentence) }, ...published.events],
        value: next,
      }
    })
  }

  /**
   * List missions, newest first.
   * @param filter - optional narrowing.
   * @returns the matching missions.
   */
  /**
   * Stop a mission that has not finished yet.
   * @param id - mission id.
   * @param actor - who stops it.
   * @param privileged - whether the actor may stop anyone s mission.
   * @returns the cancelled mission.
   */
  cancelMission(id: string, actor: string, privileged: boolean): Promise<Mission> {
    return this.#write((state) => {
      const mission = state.missions.find(candidate => candidate.id === id)
      if (mission === undefined) throw new Refusal(`no mission ${id}`)
      if (!privileged && mission.createdBy !== actor) throw new Refusal(`mission ${id} belongs to someone else`)
      if (mission.status !== 'queued' && mission.status !== 'running') {
        throw new Refusal(`mission ${id} is ${mission.status}; only a waiting mission can be cancelled`)
      }
      const at = this.#at()
      const next: Mission = { ...mission, status: 'failed', finishedAt: at, error: `cancelled by ${actor}` }
      const missions = state.missions.map(candidate => (candidate.id === id ? next : candidate))
      const published = this.#inLane({ ...state, missions }, next, failedLine(failureSentence('cancelled', actor)), at, 'cancelled')
      return {
        state: published.state,
        event: [{ at, actor, action: 'mission.cancelled', subject: id }, ...published.events],
        value: next,
      }
    })
  }

  /**
   * Run a failed mission again as a new mission.
   * @param id - mission to repeat.
   * @param actor - who asks for the retry.
   * @returns the new mission, queued.
   */
  async retryMission(id: string, actor: string): Promise<Mission> {
    const mission = await this.getMission(id)
    if (mission === undefined) throw new Refusal(`no mission ${id}`)
    if (mission.status !== 'failed') throw new Refusal(`mission ${id} is ${mission.status}; only a failed mission can be retried`)
    return this.createMission({
      kind: mission.kind,
      prompt: mission.prompt,
      createdBy: actor,
      visibility: mission.visibility,
      ...(mission.mandateId === undefined ? {} : { mandateId: mission.mandateId }),
    })
  }
  async listMissions(filter: MissionFilter = {}): Promise<readonly Mission[]> {
    const state = await this.#ready()
    return state.missions
      .filter(mission => (filter.createdBy === undefined || mission.createdBy === filter.createdBy)
        && (filter.status === undefined || mission.status === filter.status))
      .slice(0, filter.limit ?? 50)
  }

  /** @param id - mission id. @returns the mission, or undefined. */
  async getMission(id: string): Promise<Mission | undefined> {
    return (await this.#ready()).missions.find(mission => mission.id === id)
  }

  /** @param limit - how many. @returns briefs, newest first. */
  async listBriefs(limit = 50): Promise<readonly Brief[]> {
    return (await this.#ready()).briefs.slice(0, limit)
  }

  /** @param id - brief id. @returns the brief, or undefined. */
  async getBrief(id: string): Promise<Brief | undefined> {
    return (await this.#ready()).briefs.find(brief => brief.id === id)
  }

  /**
   * Approve a brief.
   * @param id - brief id.
   * @param actor - who decided.
   * @returns the updated brief.
   */
  approveBrief(id: string, actor: string): Promise<Brief> {
    if (actor.trim() === '') return Promise.reject(new Refusal('an approval needs an actor'))
    return this.#write((state) => {
      const brief = state.briefs.find(candidate => candidate.id === id)
      if (brief === undefined) throw new Refusal(`no brief ${id}`)
      if (brief.status !== 'draft') throw new Refusal(`brief ${id} is already ${brief.status}`)
      const at = this.#at()
      const next: Brief = { ...brief, status: 'approved', approvedBy: actor.trim(), approvedAt: at }
      return {
        state: { ...state, briefs: state.briefs.map(candidate => (candidate.id === id ? next : candidate)) },
        event: { at, actor: actor.trim(), action: 'brief.approved', subject: id },
        value: next,
      }
    })
  }

  /**
   * Ask for a decision on an external action.
   * @param request - what would happen, and who asks.
   * @returns the pending approval.
   */
  requestApproval(request: ApprovalRequest): Promise<Approval> {
    if (!needsApproval(request.kind)) return Promise.reject(new Refusal(`action ${String(request.kind)} does not need approval`))
    if (request.title.trim() === '') return Promise.reject(new Refusal('an approval needs a title'))
    if (request.requestedBy.trim() === '') return Promise.reject(new Refusal('an approval needs a requester'))
    if (request.kind === 'propose_context') {
      // A context belongs to a channel: the card is asked from one of its turns.
      if (request.channelId === undefined) return Promise.reject(new Refusal('a propose_context card is asked from a channel turn'))
      if (request.contextProposal === undefined) return Promise.reject(new Refusal('a propose_context card needs a text and a baseVersion'))
      const length = request.contextProposal.text.trim().length
      if (length > MAX_CONTEXT_CHARS) {
        return Promise.reject(new ContextRefusal('context-too-long', `a channel's context is ${MAX_CONTEXT_CHARS} characters at most (${length} given)`))
      }
    }
    if (request.kind === 'propose_schedule') {
      // A task is asked from a channel turn, by its agent: the card says what approval creates.
      if (request.channelId === undefined || request.requestedByAgent === undefined) {
        return Promise.reject(new Refusal('a propose_schedule card is asked from a channel turn'))
      }
      if (request.scheduleProposal === undefined) return Promise.reject(new ScheduleRefusal('schedule-invalid', 'a propose_schedule card needs a schedule'))
    }
    if (request.kind === 'propose_agent') {
      // The proposal is checked when the card is made, with the rules of POST /agents.
      const refusal = request.proposal === undefined ? 'a propose_agent card needs a proposal' : agentRefusal(request.proposal)
      if (refusal !== undefined) return Promise.reject(new Refusal(refusal))
    }
    // A propose_agent card's title is the server's, built from the proposal: what an
    // agent writes never names what a person grants.
    const title = request.kind === 'propose_agent' && request.proposal !== undefined ? proposalTitle(request.proposal) : request.title.trim()
    const approval: Approval = {
      id: this.#id('apr'),
      kind: request.kind,
      title,
      payload: request.payload ?? {},
      requestedBy: request.requestedBy.trim(),
      requestedAt: this.#at(),
      state: 'pending',
      ...(request.missionId === undefined ? {} : { missionId: request.missionId }),
      ...(request.channelId === undefined ? {} : { channelId: request.channelId }),
      ...(request.messageId === undefined ? {} : { messageId: request.messageId }),
      ...(request.proposal === undefined || request.kind !== 'propose_agent' ? {} : { proposal: proposalOf(request.proposal) }),
      ...(request.contextProposal === undefined || request.kind !== 'propose_context'
        ? {}
        : { contextProposal: { text: request.contextProposal.text.trim(), baseVersion: request.contextProposal.baseVersion } }),
      ...(request.requestedByAgent === undefined
        ? {}
        : { requestedByAgent: { id: request.requestedByAgent.id, handle: request.requestedByAgent.handle } }),
      ...(request.scheduleProposal === undefined || request.kind !== 'propose_schedule' ? {} : { scheduleProposal: request.scheduleProposal }),
    }
    return this.#write((state) => {
      if (approval.kind === 'propose_schedule' && approval.scheduleProposal !== undefined) {
        // The title is the server's, from the task: « Tâche : <its title> ».
        const waiting = state.approvals.filter(card => card.kind === 'propose_schedule' && card.state === 'pending' && card.requestedBy === approval.requestedBy)
        if (waiting.length >= MAX_PENDING_PROPOSALS) {
          throw new Refusal(`${MAX_PENDING_PROPOSALS} task proposals already wait for a decision: decide them first`)
        }
        const titled: Approval = { ...approval, title: `Tâche : ${approval.scheduleProposal.title}` }
        return {
          state: { ...state, approvals: [titled, ...state.approvals] },
          event: { at: titled.requestedAt, actor: titled.requestedBy, action: 'approval.requested', subject: titled.id, detail: titled.kind },
          value: titled,
        }
      }
      if (approval.kind === 'propose_context') {
        // The title is the server's, from the channel and the change: an agent's
        // words never name what a person approves.
        const channel = (state.channels ?? []).find(candidate => candidate.id === approval.channelId)
        if (channel === undefined) throw new Refusal(`no channel ${String(approval.channelId)}`)
        const waiting = state.approvals.filter(card => card.kind === 'propose_context' && card.state === 'pending' && card.channelId === channel.id)
        if (waiting.length >= MAX_PENDING_PROPOSALS) {
          throw new Refusal(`${MAX_PENDING_PROPOSALS} context proposals already wait for a decision in #${channel.name}: decide them first`)
        }
        const text = approval.contextProposal?.text ?? ''
        const titled: Approval = { ...approval, title: text === '' ? `Effacer le contexte de #${channel.name}` : `Changer le contexte de #${channel.name} (${text.length} caractères)` }
        return {
          state: { ...state, approvals: [titled, ...state.approvals] },
          event: { at: titled.requestedAt, actor: titled.requestedBy, action: 'approval.requested', subject: titled.id, detail: titled.kind },
          value: titled,
        }
      }
      if (approval.kind === 'propose_agent') {
        const waiting = state.approvals.filter(card => card.kind === 'propose_agent' && card.state === 'pending')
        // Both limits hold together: per person who asked, and per agent when the
        // card was asked during a turn (requestedByAgent, set by the server).
        if (waiting.filter(card => card.requestedBy === approval.requestedBy).length >= MAX_PENDING_PROPOSALS) {
          throw new Refusal(`${MAX_PENDING_PROPOSALS} agent proposals already wait for a decision: decide them first`)
        }
        const agent = approval.requestedByAgent
        if (agent !== undefined && waiting.filter(card => card.requestedByAgent?.id === agent.id).length >= MAX_PENDING_PROPOSALS) {
          throw new Refusal(`@${agent.handle} already has ${MAX_PENDING_PROPOSALS} agent proposals waiting for a decision: decide them first`)
        }
      }
      return {
        state: { ...state, approvals: [approval, ...state.approvals] },
        event: { at: approval.requestedAt, actor: approval.requestedBy, action: 'approval.requested', subject: approval.id, detail: approval.kind },
        value: approval,
      }
    })
  }

  /**
   * Approve a propose_context card and apply its context, in ONE write: the card
   * is approved only if the context is still at the version the proposal was
   * written from. A refusal (context-changed, context-too-long, no channel)
   * leaves the card pending.
   * @param id - the card.
   * @param actor - who approves it (an owner or an admin, member of the channel).
   * @returns the approved card and the channel.
   */
  approveContextProposal(id: string, actor: string): Promise<{ approval: Approval; channel: Channel }> {
    return this.#write((state) => {
      const approval = state.approvals.find(candidate => candidate.id === id)
      if (approval === undefined) throw new Refusal(`no approval ${id}`)
      if (approval.kind !== 'propose_context' || approval.contextProposal === undefined) throw new Refusal(`approval ${id} proposes no context`)
      if (approval.state !== 'pending') throw new Refusal(`approval ${id} is already ${approval.state}`)
      const channel = (state.channels ?? []).find(candidate => candidate.id === approval.channelId)
      if (channel === undefined || !channel.members.includes(actor.trim())) throw new Refusal(`no channel ${String(approval.channelId)}`)
      const at = this.#at()
      const next = withContext(channel, approval.contextProposal.text, approval.contextProposal.baseVersion, actor.trim(), at)
      const decided: Approval = { ...approval, state: 'approved', decidedBy: actor.trim(), decidedAt: at }
      return {
        state: {
          ...state,
          channels: (state.channels ?? []).map(candidate => (candidate.id === channel.id ? next : candidate)),
          approvals: state.approvals.map(candidate => (candidate.id === id ? decided : candidate)),
        },
        event: { at, actor: actor.trim(), action: 'approval.approved', subject: id, detail: `context of #${channel.name} at version ${next.context?.version ?? 0}` },
        value: { approval: decided, channel: next },
      }
    })
  }

  /** @param draft - a checked draft. @param actor - its creator. @param at - when. @returns the agent. */
  #newAgent(draft: AgentDraft, actor: string, at: string): Agent {
    return {
      id: this.#id('agt'),
      handle: draft.handle,
      name: draft.name.trim(),
      provider: draft.provider.trim(),
      model: draft.model.trim(),
      ...(draft.instructions === undefined || draft.instructions.trim() === '' ? {} : { instructions: draft.instructions.trim() }),
      connectors: [...new Set(draft.connectors ?? [])].sort(),
      eurPerMonth: draft.eurPerMonth ?? DEFAULT_EUR_PER_MONTH,
      createdBy: actor,
      createdAt: at,
    }
  }

  /**
   * Approve a propose_agent card and create its agent, in ONE write: the card
   * is approved only if the agent is created, from the proposal recorded on the
   * card. The rules of POST /agents apply, with the approver's role: a ceiling
   * above the default is the owner's to give. A refusal leaves the card pending.
   * @param id - the card.
   * @param actor - who approves it (an owner or an admin).
   * @param role - their role.
   * @returns the approved card and the agent.
   */
  /**
   * Approve a propose_schedule card: the task it carries is created, active,
   * exactly as proposed. Its agent must still be active and in its destination.
   * @param id - the card.
   * @param actor - who approves it (rights.write, checked by the route).
   * @param readable - the decider's reading of the card, checked in the write.
   * @returns the approved card and the task.
   */
  approveScheduleProposal(
    id: string,
    actor: string,
    readable?: (state: WorkbenchState, approval: Approval) => boolean,
  ): Promise<{ approval: Approval; schedule: Schedule }> {
    return this.#write((state) => {
      const approval = state.approvals.find(candidate => candidate.id === id)
      if (approval === undefined) throw new Refusal(`no approval ${id}`)
      if (readable !== undefined && !readable(state, approval)) throw new UnreadableApproval(id)
      if (approval.kind !== 'propose_schedule' || approval.scheduleProposal === undefined) throw new Refusal(`approval ${id} proposes no task`)
      if (approval.state !== 'pending') throw new Refusal(`approval ${id} is already ${approval.state}`)
      const proposal = approval.scheduleProposal
      const agent = (state.agents ?? []).find(candidate => candidate.id === proposal.agentId)
      if (agent === undefined || agent.retiredAt !== undefined) throw new Refusal(`no agent ${proposal.agentId}`)
      const at = this.#at()
      const schedule: Schedule = {
        ...proposal,
        id: this.#id('sch'),
        state: 'active',
        requestedBy: approval.requestedBy,
        approvedBy: actor.trim(),
        approvedAt: at,
        approvalId: approval.id,
      }
      const next: Approval = { ...approval, state: 'approved', decidedBy: actor.trim(), decidedAt: at, scheduleId: schedule.id }
      return {
        state: {
          ...state,
          schedules: [...(state.schedules ?? []), schedule],
          approvals: state.approvals.map(candidate => (candidate.id === id ? next : candidate)),
        },
        event: [
          { at, actor: actor.trim(), action: 'approval.approved', subject: id, detail: `task ${schedule.id} created` },
          { at, actor: actor.trim(), action: 'schedule.created', subject: schedule.id, detail: schedule.title },
        ],
        value: { approval: next, schedule },
      }
    })
  }

  /** @returns every scheduled task (the routes keep those the reader may read). */
  async listSchedules(): Promise<readonly Schedule[]> {
    return ((await this.#ready()).schedules ?? []).filter(schedule => schedule.deletedAt === undefined)
  }

  /**
   * Pause, resume or delete a task. Who may is the route's to say (the
   * requester or a decider; a resume, a decider only): the service applies it.
   * @param id - the task.
   * @param change - what to do.
   * @param actor - who does it.
   * @returns the task as it now is (deleted: as it was).
   */
  changeSchedule(id: string, change: 'pause' | 'resume' | 'delete', actor: string): Promise<Schedule> {
    return this.#write((state) => {
      const schedule = (state.schedules ?? []).find(candidate => candidate.id === id && candidate.deletedAt === undefined)
      if (schedule === undefined) throw new Refusal(`no task ${id}`)
      const at = this.#at()
      if (change === 'delete') {
        // Kept, never served: its journal lines keep their readers.
        const gone: Schedule = { ...schedule, state: 'paused', deletedAt: at, deletedBy: actor.trim() }
        return {
          state: { ...state, schedules: (state.schedules ?? []).map(candidate => (candidate.id === id ? gone : candidate)) },
          event: { at, actor: actor.trim(), action: 'schedule.deleted', subject: id, detail: schedule.title },
          value: schedule,
        }
      }
      // A task already paused stays as it is: a person's pause never covers the
      // host's reason (three failures, an agent gone), nor repeats itself.
      if (change === 'pause' && schedule.state === 'paused') return { state, event: [], value: schedule }
      if (change === 'resume' && schedule.state === 'active') return { state, event: [], value: schedule }
      const { pausedBecause: _was, ...rest } = schedule
      const next: Schedule = change === 'pause'
        ? { ...rest, state: 'paused', pausedBecause: 'owner' }
        : { ...rest, state: 'active', failures: 0 }
      return {
        state: { ...state, schedules: (state.schedules ?? []).map(candidate => (candidate.id === id ? next : candidate)) },
        event: { at, actor: actor.trim(), action: change === 'pause' ? 'schedule.paused' : 'schedule.resumed', subject: id, detail: schedule.title },
        value: next,
      }
    })
  }

  approveAgentProposal(
    id: string,
    actor: string,
    role: Role | undefined,
    readable?: (state: WorkbenchState, approval: Approval) => boolean,
  ): Promise<{ approval: Approval; agent: Agent }> {
    return this.#write((state) => {
      const approval = state.approvals.find(candidate => candidate.id === id)
      if (approval === undefined) throw new Refusal(`no approval ${id}`)
      if (readable !== undefined && !readable(state, approval)) throw new UnreadableApproval(id)
      if (approval.kind !== 'propose_agent' || approval.proposal === undefined) throw new Refusal(`approval ${id} proposes no agent`)
      if (approval.state !== 'pending') throw new Refusal(`approval ${id} is already ${approval.state}`)
      const proposal = approval.proposal
      const refusal = agentRefusal(proposal)
      if (refusal !== undefined) throw new Refusal(refusal)
      if ((proposal.eurPerMonth ?? DEFAULT_EUR_PER_MONTH) > DEFAULT_EUR_PER_MONTH && role !== 'owner') {
        throw new Refusal(`only the owner gives an agent a ceiling above ${DEFAULT_EUR_PER_MONTH} € a month`)
      }
      if ((state.agents ?? []).some(agent => agent.handle === proposal.handle)) throw new Refusal(`the handle @${proposal.handle} is taken`)
      const at = this.#at()
      const agent = this.#newAgent(proposal, actor.trim(), at)
      const next: Approval = { ...approval, state: 'approved', decidedBy: actor.trim(), decidedAt: at, agentId: agent.id }
      return {
        state: {
          ...state,
          agents: [...(state.agents ?? []), agent],
          approvals: state.approvals.map(candidate => (candidate.id === id ? next : candidate)),
        },
        event: { at, actor: actor.trim(), action: 'approval.approved', subject: id, detail: `agent @${agent.handle} created (${agent.id})` },
        value: { approval: next, agent },
      }
    })
  }

  /**
   * Decide a pending approval.
   * @param id - approval id.
   * @param actor - who decided.
   * @param decision - approved or rejected.
   * @param reason - why, when rejected.
   * @returns the decided approval.
   */
  decideApproval(
    id: string,
    actor: string,
    decision: ApprovalState,
    reason?: string,
    readable?: (state: WorkbenchState, approval: Approval) => boolean,
  ): Promise<Approval> {
    if (actor.trim() === '') return Promise.reject(new Refusal('a decision needs an actor'))
    if (decision !== 'approved' && decision !== 'rejected') return Promise.reject(new Refusal('cannot decide that'))
    const rejection = reason?.trim()
    if (decision === 'rejected' && (rejection === undefined || rejection === '')) return Promise.reject(new Refusal('a rejection needs a reason'))
    return this.#write((state) => {
      const approval = state.approvals.find(candidate => candidate.id === id)
      if (approval === undefined) throw new Refusal(`no approval ${id}`)
      if (readable !== undefined && !readable(state, approval)) throw new UnreadableApproval(id)
      if (approval.state !== 'pending') throw new Refusal(`approval ${id} is already ${approval.state}`)
      const at = this.#at()
      const next: Approval = {
        ...approval,
        state: decision,
        decidedBy: actor.trim(),
        decidedAt: at,
        ...(rejection === undefined ? {} : { reason: rejection }),
      }
      return {
        state: { ...state, approvals: state.approvals.map(candidate => (candidate.id === id ? next : candidate)) },
        event: { at, actor: actor.trim(), action: `approval.${decision}`, subject: id, ...(rejection === undefined ? {} : { detail: rejection }) },
        value: next,
      }
    })
  }

  /**
   * List approvals, newest first.
   * @param state - the only state worth showing, by default pending ones.
   * @returns the approvals.
   */
  async listApprovals(state: ApprovalState | 'all' = 'pending'): Promise<readonly Approval[]> {
    return (await this.#ready()).approvals.filter(approval => state === 'all' || approval.state === state)
  }

  /**
   * Keep a note for later.
   * @param note - scope, kind and text.
   * @returns the stored note.
   */
  remember(note: Omit<MemoryNote, 'id' | 'createdAt'>): Promise<MemoryNote> {
    const text = note.text.trim()
    if (text === '') return Promise.reject(new Refusal('a memory note needs text'))
    if (note.createdBy.trim() === '') return Promise.reject(new Refusal('a memory note needs an author'))
    const stored: MemoryNote = { ...note, text, id: this.#id('mem'), createdAt: this.#at() }
    return this.#write(state => ({
      state: { ...state, memories: [stored, ...state.memories] },
      event: { at: stored.createdAt, actor: stored.createdBy, action: 'memory.remembered', subject: stored.id, detail: stored.kind },
      value: stored,
    }))
  }

  /**
   * Read notes, newest first.
   * @param filter - optional narrowing.
   * @returns the matching notes.
   */
  async recall(filter: MemoryFilter = {}): Promise<readonly MemoryNote[]> {
    const state = await this.#ready()
    return state.memories
      .filter(note => (filter.scope === undefined || note.scope === filter.scope)
        && (filter.kind === undefined || note.kind === filter.kind))
      .slice(0, filter.limit ?? 50)
  }

  /**
   * Move one mission between private and shared.
   * @param id - mission id.
   * @param visibility - where it should stand.
   * @returns the updated mission.
   */
  setMissionVisibility(id: string, visibility: Visibility): Promise<Mission> {
    return this.#write((state) => {
      const mission = state.missions.find(candidate => candidate.id === id)
      if (mission === undefined) throw new Refusal(`no mission ${id}`)
      const next: Mission = { ...mission, visibility }
      return {
        state: {
          ...state,
          missions: state.missions.map(candidate => (candidate.id === id ? next : candidate)),
          // A brief follows the mission it came from: sharing the work must show
          // its result, and making it private again must hide it.
          briefs: state.briefs.map(brief => (brief.missionId === id ? { ...brief, visibility } : brief)),
        },
        event: { at: this.#at(), actor: mission.createdBy, action: `mission.${visibility}`, subject: id },
        value: next,
      }
    })
  }

  /**
   * Move one note between personal and shared.
   * @param id - note id.
   * @param scope - 'user' keeps it personal, 'team' shares it.
   * @returns the updated note.
   */
  setMemoryScope(id: string, scope: 'user' | 'team'): Promise<MemoryNote> {
    return this.#write((state) => {
      const note = state.memories.find(candidate => candidate.id === id)
      if (note === undefined) throw new Refusal(`no memory ${id}`)
      const next: MemoryNote = { ...note, scope }
      return {
        state: { ...state, memories: state.memories.map(candidate => (candidate.id === id ? next : candidate)) },
        event: { at: this.#at(), actor: note.createdBy, action: `memory.${scope}`, subject: id },
        value: next,
      }
    })
  }

  /**
   * Read the product's own history.
   * @param limit - how many lines to keep.
   * @returns the events.
   */
  async events(limit = 100): Promise<readonly WorkbenchEvent[]> {
    return (await this.#ready()).events.slice(-limit)
  }

  /**
   * Read every mandate.
   * @returns the mandates, newest first.
   */
  async mandates(): Promise<readonly Mandate[]> {
    return (await this.#ready()).mandates
  }

  /**
   * Read one mandate.
   * @param id - mandate id.
   * @returns the mandate, or undefined.
   */
  async mandate(id: string): Promise<Mandate | undefined> {
    return (await this.#ready()).mandates.find(candidate => candidate.id === id)
  }

  /**
   * Propose a mandate. It authorises nothing until somebody else signs it.
   * @param draft - delegant, delegataire, perimeter, cap and expiry.
   * @returns the proposed mandate.
   */
  createMandate(draft: MandateDraft): Promise<Mandate> {
    const today = this.#at().slice(0, 10)
    const refusal = draftRefusal(draft, today)
    if (refusal !== undefined) return Promise.reject(new Refusal(refusal))
    const mandate: Mandate = {
      id: this.#id('mnd'),
      delegant: draft.delegant.trim().toLowerCase(),
      delegataire: draft.delegataire.trim().toLowerCase(),
      purpose: draft.purpose.trim(),
      connectors: [...draft.connectors],
      missionKinds: [...draft.missionKinds],
      dailyCap: draft.dailyCap,
      expiresOn: draft.expiresOn,
      state: 'proposed',
      createdAt: this.#at(),
    }
    return this.#write(state => ({
      state: { ...state, mandates: [mandate, ...state.mandates] },
      event: { at: mandate.createdAt, actor: mandate.delegant, action: 'mandate.proposed', subject: mandate.id, detail: mandate.delegataire },
      value: mandate,
    }))
  }

  /**
   * Countersign a mandate, which is what makes it take effect.
   * @param id - mandate id.
   * @param actor - the signer.
   * @param role - the signer's role.
   * @returns the active mandate.
   */
  signMandate(id: string, actor: string, role: Role | undefined): Promise<Mandate> {
    return this.#write((state) => {
      const mandate = state.mandates.find(candidate => candidate.id === id)
      if (mandate === undefined) throw new Refusal(`no mandate ${id}`)
      const today = this.#at().slice(0, 10)
      const refusal = signRefusal(mandate, actor, role, today)
      if (refusal !== undefined) throw new Refusal(refusal)
      const at = this.#at()
      const next: Mandate = { ...mandate, state: 'active', signedBy: actor, signedAt: at }
      return {
        state: { ...state, mandates: state.mandates.map(candidate => (candidate.id === id ? next : candidate)) },
        event: { at, actor, action: 'mandate.signed', subject: id, detail: mandate.delegataire },
        value: next,
      }
    })
  }

  /**
   * Retract a mandate. The delegant, an owner or an admin can do it.
   * @param id - mandate id.
   * @param actor - who retracts.
   * @param role - that person's role.
   * @returns the retired mandate.
   */
  retireMandate(id: string, actor: string, role: Role | undefined): Promise<Mandate> {
    return this.#write((state) => {
      const mandate = state.mandates.find(candidate => candidate.id === id)
      if (mandate === undefined) throw new Refusal(`no mandate ${id}`)
      if (mandate.state === 'retired') throw new Refusal('this mandate is already retired')
      if (actor !== mandate.delegant && role !== 'owner' && role !== 'admin') {
        throw new Refusal(`${actor} can neither retract this mandate nor administer mandates`)
      }
      const at = this.#at()
      const next: Mandate = { ...mandate, state: 'retired', retiredBy: actor, retiredAt: at }
      return {
        state: { ...state, mandates: state.mandates.map(candidate => (candidate.id === id ? next : candidate)) },
        event: { at, actor, action: 'mandate.retired', subject: id, detail: mandate.delegataire },
        value: next,
      }
    })
  }

  /**
   * Count the missions a mandate has already carried today.
   * @param mandateId - mandate id.
   * @param delegataire - the person the mandate belongs to.
   * @returns how many missions ran under it today.
   */
  async missionsToday(mandateId: string, delegataire: string): Promise<number> {
    const day = this.#at().slice(0, 10)
    const state = await this.#ready()
    return state.missions.filter(mission =>
      mission.mandateId === mandateId
      && mission.createdBy === delegataire
      && mission.createdAt.slice(0, 10) === day).length
  }

  /**
   * Write down a refusal, so the journal shows what did not happen and why.
   * @param actor - who was refused.
   * @param subject - what was attempted.
   * @param reason - the reason, in words.
   * @param mandateId - the mandate involved, when there is one.
   * @returns nothing.
   */
  async recordRefusal(actor: string, subject: string, reason: string, mandateId?: string): Promise<void> {
    const detail = mandateId === undefined ? reason : `${reason} (mandate ${mandateId})`
    await this.#write(state => ({
      state,
      event: { at: this.#at(), actor, action: 'mission.refused', subject, detail },
      value: undefined,
    }))
  }

  /**
   * Journal a role change asked through the members routes: who, for whom,
   * before, after, and whether it was applied.
   * @param actor - who asked.
   * @param subject - whose role.
   * @param change - the roles before and after (undefined: none), and the outcome.
   * @returns nothing.
   */
  async recordRoleChange(
    actor: string,
    subject: string,
    change: { readonly before: string | undefined; readonly after: string | undefined; readonly outcome: string },
  ): Promise<void> {
    const detail = `${change.before ?? 'none'} -> ${change.after ?? 'none'}: ${change.outcome}`
    await this.#write(state => ({
      state,
      event: { at: this.#at(), actor, action: 'member.role', subject, detail },
      value: undefined,
    }))
  }

  // ---------------------------------------------------------------- agents

  /**
   * Retire an agent: kept for the record (its messages, its spending), it no
   * longer answers, no longer appears among the agents, and cannot be added to
   * a channel again. Retiring twice is refused.
   * @param id - the agent.
   * @param actor - who retires it.
   * @returns the retired agent.
   */
  retireAgent(id: string, actor: string): Promise<Agent> {
    return this.#write((state) => {
      const agent = (state.agents ?? []).find(candidate => candidate.id === id)
      if (agent === undefined) throw new Refusal(`no agent ${id}`)
      if (agent.retiredAt !== undefined) throw new Refusal(`the agent @${agent.handle} is already retired`)
      const at = this.#at()
      const next: Agent = { ...agent, retiredAt: at, retiredBy: actor }
      return {
        state: { ...state, agents: (state.agents ?? []).map(candidate => (candidate.id === id ? next : candidate)) },
        event: { at, actor, action: 'agent.retired', subject: id, detail: agent.handle },
        value: next,
      }
    })
  }

  /** @param includeRetired - whether retired agents show. @returns the agents, oldest first. */
  async listAgents(includeRetired = false): Promise<readonly Agent[]> {
    const agents = (await this.#ready()).agents ?? []
    return agents.filter(agent => includeRetired || agent.retiredAt === undefined)
  }

  /** @param id - agent id. @returns the agent, retired or not. */
  async agent(id: string): Promise<Agent | undefined> {
    return ((await this.#ready()).agents ?? []).find(agent => agent.id === id)
  }

  /**
   * Declare an agent.
   * @param draft - handle, name, model and connectors.
   * @param actor - who declares it.
   * @param role - their role: only the owner gives a ceiling above the default.
   * @returns the agent.
   */
  createAgent(draft: AgentDraft, actor: string, role?: Role): Promise<Agent> {
    const refusal = agentRefusal(draft)
    if (refusal !== undefined) return Promise.reject(new Refusal(refusal))
    // A ceiling above the default is the owner's to give, at creation as at a
    // change: an admin cannot create an agent at 50 € a month, nor recreate under
    // another handle one the owner bounded.
    if ((draft.eurPerMonth ?? DEFAULT_EUR_PER_MONTH) > DEFAULT_EUR_PER_MONTH && role !== 'owner') {
      return Promise.reject(new Refusal(`only the owner gives an agent a ceiling above ${DEFAULT_EUR_PER_MONTH} € a month`))
    }
    return this.#write((state) => {
      if ((state.agents ?? []).some(agent => agent.handle === draft.handle)) {
        throw new Refusal(`the handle @${draft.handle} is taken`)
      }
      const skills = draft.skills === undefined ? [] : checkedSkills(state.skills ?? [], draft.skills)
      const made = this.#newAgent(draft, actor, this.#at())
      const agent: Agent = skills.length === 0 ? made : { ...made, skills }
      return {
        state: { ...state, agents: [...(state.agents ?? []), agent] },
        event: { at: agent.createdAt, actor, action: 'agent.created', subject: agent.id, detail: `@${agent.handle} ${agent.provider}/${agent.model}` },
        value: agent,
      }
    })
  }

  /**
   * Change an agent's model, framing, connectors or ceiling.
   * @param id - agent id.
   * @param patch - what changes.
   * @param actor - who changes it.
   * @param role - their role: only the owner raises a ceiling.
   * @returns the agent.
   */
  updateAgent(id: string, patch: AgentPatch, actor: string, role: Role | undefined): Promise<Agent> {
    return this.#write((state) => {
      const agent = (state.agents ?? []).find(candidate => candidate.id === id)
      if (agent === undefined || agent.retiredAt !== undefined) throw new Refusal(`no agent ${id}`)
      const { skills: asked, ...rest } = patch
      const skills = asked === undefined ? undefined : checkedSkills(state.skills ?? [], asked)
      const { skills: _previous, ...kept } = agent
      const base: Agent = skills === undefined ? agent : kept
      const next: Agent = {
        ...base,
        ...rest,
        ...(patch.connectors === undefined ? {} : { connectors: [...new Set(patch.connectors)].sort() }),
        ...(skills === undefined || skills.length === 0 ? {} : { skills }),
      }
      const refusal = agentRefusal(next)
      if (refusal !== undefined) throw new Refusal(refusal)
      if (next.eurPerMonth > agent.eurPerMonth && role !== 'owner') {
        throw new Refusal(`only the owner raises the ceiling of @${agent.handle}`)
      }
      return {
        state: { ...state, agents: (state.agents ?? []).map(candidate => (candidate.id === id ? next : candidate)) },
        event: { at: this.#at(), actor, action: 'agent.updated', subject: id, detail: Object.keys(patch).sort().join(',') },
        value: next,
      }
    })
  }

  // ---------------------------------------------------------------- channels

  /** @param id - channel id. @returns the channel. */
  async channel(id: string): Promise<Channel | undefined> {
    return ((await this.#ready()).channels ?? []).find(channel => channel.id === id)
  }

  /**
   * The channels of one person, their own lane first; the lane is created on
   * its first read.
   * @param email - the person.
   * @returns their channels.
   */
  async channelsOf(email: string): Promise<readonly Channel[]> {
    const lane = await this.laneOf(email)
    const channels = (await this.#ready()).channels ?? []
    return [lane, ...channels.filter(channel => channel.id !== lane.id && channel.members.includes(email))]
  }

  /** @param email - the person. @returns their solo lane, created when absent. */
  async laneOf(email: string): Promise<Channel> {
    const existing = ((await this.#ready()).channels ?? []).find(c => isLaneOf(c, email))
    if (existing !== undefined) return existing
    return this.#write((state) => {
      const again = (state.channels ?? []).find(c => isLaneOf(c, email))
      const at = this.#at()
      const lane: Channel = again ?? {
        id: this.#id('chn'),
        name: `solo-${this.#id('l').slice(-8)}`,
        title: `Ma lane (${email})`,
        kind: 'solo',
        members: [email],
        agents: [],
        connectors: [],
        createdBy: email,
        createdAt: at,
      }
      return {
        state: again === undefined ? { ...state, channels: [...(state.channels ?? []), lane] } : state,
        event: { at, actor: email, action: 'channel.lane', subject: lane.id },
        value: lane,
      }
    })
  }

  /**
   * Open a team channel; its creator is a member.
   * @param draft - name, members, agents and connectors.
   * @param actor - who opens it.
   * @returns the channel.
   */
  createChannel(draft: ChannelDraft, actor: string): Promise<Channel> {
    const title = draft.title?.trim() ?? ''
    if (draft.name === undefined && title === '') return Promise.reject(new Refusal('a channel needs a name or a title'))
    if (draft.name !== undefined && !SLUG.test(draft.name)) {
      return Promise.reject(new Refusal(`a channel name is a slug: ${draft.name}`))
    }
    const connectorRefusal = serversRefusal(draft.connectors ?? [])
    if (connectorRefusal !== undefined) return Promise.reject(new Refusal(connectorRefusal))
    return this.#write((state) => {
      const taken = new Set((state.channels ?? []).map(channel => channel.name))
      if (draft.name !== undefined && taken.has(draft.name)) {
        // Neutral: the name may be a private channel's the caller is not in.
        throw new Refusal(`the name #${draft.name} is not available`)
      }
      // A name the person chose is theirs; one derived from a title takes the
      // first free suffix instead of failing.
      const name = draft.name ?? freeSlug(slugOf(title), taken)
      const agents = draft.agents ?? []
      const unknown = agents.filter(id => !(state.agents ?? []).some(agent => agent.id === id && agent.retiredAt === undefined))
      if (unknown.length > 0) throw new Refusal(`no agent ${unknown.join(', ')}`)
      const channel: Channel = {
        id: this.#id('chn'),
        name,
        title: title || name,
        kind: 'team',
        members: [...new Set([actor, ...plainMembers(draft.members ?? [])].map(email => email.trim().toLowerCase()))],
        agents: [...new Set(agents)],
        connectors: [...new Set(draft.connectors ?? [])].sort(),
        createdBy: actor,
        createdAt: this.#at(),
      }
      return {
        state: { ...state, channels: [...(state.channels ?? []), channel] },
        event: { at: channel.createdAt, actor, action: 'channel.created', subject: channel.id, detail: `#${channel.name}` },
        value: channel,
      }
    })
  }

  /**
   * Change who is in a channel: people, agents, or the connectors it allows.
   * A solo lane keeps its single person.
   * @param id - channel id.
   * @param change - what to add, remove or set.
   * @param actor - a member.
   * @returns the channel.
   */
  updateChannel(
    id: string,
    change: {
      readonly addMembers?: readonly string[]
      readonly removeMembers?: readonly string[]
      readonly addAgents?: readonly string[]
      readonly removeAgents?: readonly string[]
      readonly connectors?: readonly string[]
      /** Connectors added and removed against the CURRENT list, in one atomic write. */
      readonly addConnectors?: readonly string[]
      readonly removeConnectors?: readonly string[]
    },
    actor: string,
  ): Promise<Channel> {
    for (const servers of [change.connectors, change.addConnectors, change.removeConnectors]) {
      if (servers === undefined) continue
      const refusal = serversRefusal(servers)
      if (refusal !== undefined) return Promise.reject(new Refusal(refusal))
    }
    return this.#write((state) => {
      const channel = (state.channels ?? []).find(candidate => candidate.id === id)
      if (channel === undefined || !channel.members.includes(actor)) throw new Refusal(`no channel ${id}`)
      if (channel.kind === 'solo' && ((change.addMembers ?? []).length > 0 || (change.removeMembers ?? []).length > 0)) {
        throw new Refusal('a solo lane has one person')
      }
      const added = change.addAgents ?? []
      const unknown = added.filter(agentId => !(state.agents ?? []).some(agent => agent.id === agentId && agent.retiredAt === undefined))
      if (unknown.length > 0) throw new Refusal(`no agent ${unknown.join(', ')}`)
      // One spelling of a person: an e-mail written Prenom.Nom@ is the same member as prenom.nom@.
      const removed = (change.removeMembers ?? []).map(email => email.trim().toLowerCase())
      const members = [...new Set([...channel.members, ...plainMembers(change.addMembers ?? [])].map(email => email.trim().toLowerCase()))]
        .filter(email => !removed.includes(email))
      if (members.length === 0) throw new Refusal('a channel keeps at least one person')
      // The connectors, applied on the list as it is NOW (inside the write chain):
      // two people toggling one connector each never undo each other.
      const before = [...(channel.connectors ?? [])].sort()
      const touched = change.connectors !== undefined || change.addConnectors !== undefined || change.removeConnectors !== undefined
      const removedConnectors = change.removeConnectors ?? []
      const connectors = change.connectors !== undefined
        ? [...new Set(change.connectors)].sort()
        : [...new Set([...before, ...(change.addConnectors ?? [])])].filter(server => !removedConnectors.includes(server)).sort()
      // A coordination whose author or verifier leaves the channel ends with it.
      const { coordination, ...base } = channel
      const ended = coordination !== undefined
        && coordinationAgents(coordination).some(agentId => (change.removeAgents ?? []).includes(agentId))
      const next: Channel = {
        ...base,
        ...(coordination === undefined || ended ? {} : { coordination }),
        members,
        agents: [...new Set([...channel.agents, ...added])].filter(agentId => !(change.removeAgents ?? []).includes(agentId)),
        ...(touched ? { connectors } : {}),
      }
      // A change of connectors grants or withdraws access to data: journalled as
      // such, with who, what was added and removed, and when.
      const gained = touched ? connectors.filter(server => !before.includes(server)) : []
      const lost = touched ? before.filter(server => !connectors.includes(server)) : []
      const event = gained.length > 0 || lost.length > 0
        ? { at: this.#at(), actor, action: 'channel.connectors', subject: id, detail: [...gained.map(s => `+${s}`), ...lost.map(s => `-${s}`)].join(' ') }
        : { at: this.#at(), actor, action: 'channel.updated', subject: id }
      // A coordination that ends because one of its agents left is said as such,
      // with the agent who left: the screen and the journal show why it stopped.
      const leaving = ended && coordination !== undefined
        ? coordinationAgents(coordination).filter(agentId => (change.removeAgents ?? []).includes(agentId))
        : []
      const events = leaving.length > 0
        ? [event, { at: this.#at(), actor, action: 'channel.coordination', subject: id, detail: `ended: ${leaving.join(' ')} left the channel` }]
        : event
      return {
        state: { ...state, channels: (state.channels ?? []).map(candidate => (candidate.id === id ? next : candidate)) },
        event: events,
        value: next,
      }
    })
  }

  /**
   * Record a help request on the running turn of its agent (ask_peers). It
   * runs nothing: the turn's host script asks the peers once the agent ends.
   * The peers are active agents of the channel, not the asker, two at most;
   * one request per turn, two per thread, a pair asked once per thread; never
   * in a coordinated channel (a turn there is already a host script).
   * @param messageId - the mentioning message of the turn.
   * @param turnId - the running turn.
   * @param askerId - its agent.
   * @param request - the request, its fields checked.
   * @param peerIds - the peers the agent chose.
   * @returns the help recorded.
   */
  askPeers(messageId: string, turnId: string, askerId: string, request: HelpRequest, peerIds: readonly string[]): Promise<TurnHelp> {
    const text = (value: unknown): boolean => typeof value === 'string' && value.trim() !== ''
    if (!text(request.task) || !text(request.tried) || !text(request.blocker)
      || !Array.isArray(request.options) || request.options.length === 0 || !request.options.every(text)
      || !['fact', 'opinion', 'check', 'choice'].includes(request.need)) {
      return Promise.reject(new HelpRefusal('missing-fields', 'a help request needs task, tried, blocker, options (one at least) and need (fact, opinion, check or choice)'))
    }
    const peers = [...new Set(peerIds)]
    if (peers.length === 0) return Promise.reject(new HelpRefusal('no-peer', 'name one or two peers among the agents of this channel'))
    if (peers.length > MAX_HELP_PEERS) return Promise.reject(new HelpRefusal('too-many-peers', `${MAX_HELP_PEERS} peers at most`))
    if (peers.includes(askerId)) return Promise.reject(new HelpRefusal('self', 'an agent does not ask itself'))
    return this.#write((state) => {
      const messages = state.messages ?? []
      const message = messages.find(candidate => candidate.id === messageId)
      const turn = message?.turns?.find(candidate => candidate.id === turnId)
      if (message === undefined || turn === undefined || turn.agentId !== askerId || turn.status !== 'running') {
        throw new HelpRefusal('not-running', 'a help is asked during the asking agent\'s own turn')
      }
      if (turn.help !== undefined) throw new HelpRefusal('already-asked', 'one help request per turn')
      const channel = (state.channels ?? []).find(candidate => candidate.id === message.channelId)
      if (channel === undefined) throw new Refusal(`no channel ${message.channelId}`)
      if (channel.coordination !== undefined) throw new HelpRefusal('coordinated-channel', 'this channel\'s turns are coordinated: no help request inside them')
      const active = (agentId: string): boolean =>
        (state.agents ?? []).some(agent => agent.id === agentId && agent.retiredAt === undefined && channel.agents.includes(agent.id))
      const unknown = peers.filter(peer => !active(peer))
      if (unknown.length > 0) throw new HelpRefusal('no-peer', `not an active agent of this channel: ${unknown.join(', ')}`)
      // The thread: the message's root, and every message under it.
      const rootOf = (id: string): string => {
        let current = messages.find(candidate => candidate.id === id)
        for (let depth = 0; current?.replyTo !== undefined && depth < 20; depth += 1) {
          const parent = messages.find(candidate => candidate.id === current?.replyTo)
          if (parent === undefined) break
          current = parent
        }
        return current?.id ?? id
      }
      const root = rootOf(message.id)
      const helps = messages.filter(candidate => rootOf(candidate.id) === root)
        .flatMap(candidate => (candidate.turns ?? []).flatMap(t => (t.help === undefined ? [] : [{ asker: t.agentId, help: t.help }])))
      if (helps.length >= MAX_HELPS_PER_THREAD) {
        throw new HelpRefusal('thread-limit', `${MAX_HELPS_PER_THREAD} help requests already in this thread: put your question to the people of the channel`)
      }
      const asked = peers.filter(peer => helps.some(previous => previous.asker === askerId && previous.help.peerIds.includes(peer)))
      if (asked.length > 0) throw new HelpRefusal('pair-already-asked', `already asked in this thread: ${asked.join(', ')}`)
      const help: TurnHelp = { state: 'asked', request: { ...request, options: [...request.options] }, peerIds: peers, advices: [], capEur: HELP_CAP_EUR, skipped: [], askedAt: this.#at() }
      const updated = { ...message, turns: (message.turns ?? []).map(t => (t.id === turnId ? { ...t, help } : t)), updatedAt: this.#at() }
      return {
        state: { ...state, messages: messages.map(candidate => (candidate.id === messageId ? updated : candidate)) },
        event: { at: help.askedAt, actor: 'mndt', action: 'turn.help-asked', subject: turnId, detail: `${peers.length} peer(s), need ${request.need}` },
        value: help,
      }
    })
  }

  /**
   * Cancel the turns a previous process left running or queued: nothing will
   * run them, and a request minutes old must not leave alone after an update.
   * A running turn says « interrompu par un redémarrage », a queued one « non
   * lancé : redémarrage »; each keeps what it already cost (its own eur, or
   * what its recorded steps and help spent). No message in the thread: the
   * screen shows the status and the reason, the person asks again if they want.
   * Only what predates this process: a mention posted since it started is never touched.
   * @param before - when this process started (ISO).
   * @returns how many running and queued turns were cancelled.
   */
  async cancelInterruptedTurns(before: string): Promise<{ running: number; queued: number }> {
    const old = (message: Message, turn: Turn): boolean =>
      message.createdAt < before && (turn.startedAt === undefined || turn.startedAt < before)
    const unsettledIn = (message: Message) => (turn: Turn): boolean => (turn.status === 'running' || turn.status === 'queued') && old(message, turn)
    const any = ((await this.snapshot()).messages ?? []).some(message => (message.turns ?? []).some(unsettledIn(message)))
    if (!any) return { running: 0, queued: 0 }
    return this.#write((state) => {
      const at = this.#at()
      let running = 0
      let queued = 0
      const messages = (state.messages ?? []).map((message) => {
        const unsettled = unsettledIn(message)
        if (!(message.turns ?? []).some(unsettled)) return message
        return {
          ...message,
          updatedAt: at,
          turns: (message.turns ?? []).map((turn): Turn => {
            if (!unsettled(turn)) return turn
            if (turn.status === 'running') running += 1
            else queued += 1
            const spent = turn.eur
              ?? ((turn.steps ?? []).reduce((total, step) => total + (step.eur ?? 0), 0)
                + (turn.help?.advices ?? []).reduce((total, advice) => total + (advice.eur ?? 0), 0))
            return {
              ...turn,
              status: 'cancelled',
              reason: turn.status === 'running' ? 'interrompu par un redémarrage' : 'non lancé : redémarrage',
              reasonKind: 'restart' as const,
              finishedAt: at,
              ...(spent > 0 ? { eur: Math.round(spent * 1_000_000) / 1_000_000 } : {}),
            }
          }),
        }
      })
      return {
        state: { ...state, messages },
        event: { at, actor: 'mndt', action: 'turn.cancelled', subject: 'restart', detail: `${running} running, ${queued} queued, left by a previous process` },
        value: { running, queued },
      }
    })
  }

  /**
   * Close the councils a previous process left open (deliberating, critiquing,
   * deciding): nothing will ever run them. Each is done, with a skipped entry
   * « redémarrage », and no decision, so no member is ever named for it.
   * Only what predates this process: a council started since is never touched.
   * @param before - when this process started (ISO).
   * @returns how many were closed.
   */
  async closeInterruptedCouncils(before: string): Promise<number> {
    const stale = (turn: Turn): boolean => turn.council !== undefined && turn.council.state !== 'done' && turn.council.startedAt < before
    if (!((await this.snapshot()).messages ?? []).some(message => (message.turns ?? []).some(stale))) return 0
    return this.#write((state) => {
      let closed = 0
      const at = this.#at()
      const messages = (state.messages ?? []).map((message) => {
        if (!(message.turns ?? []).some(stale)) return message
        return {
          ...message,
          updatedAt: at,
          turns: (message.turns ?? []).map((turn) => {
            if (turn.council === undefined || !stale(turn)) return turn
            closed += 1
            // Done without a decision: what is served keeps its members withheld.
            const { decision: _none, ...council } = turn.council
            return { ...turn, council: { ...council, state: 'done' as const, skipped: [...council.skipped, { reason: 'redémarrage' }] } }
          }),
        }
      })
      return {
        state: { ...state, messages },
        event: { at, actor: 'mndt', action: 'turn.council-closed', subject: 'restart', detail: `${closed} council(s) left open by a previous process` },
        value: closed,
      }
    })
  }

  /**
   * Close the helps a previous process left open (asked, advising, reading):
   * nothing will ever run them. Each is done, with a skipped entry
   * « redémarrage », and no reading, so no peer is ever named for it.
   * Only what predates this process: a help asked since it started is never touched.
   * @param before - when this process started (ISO).
   * @returns how many were closed.
   */
  async closeInterruptedHelps(before: string): Promise<number> {
    const stale = (turn: Turn): boolean => turn.help !== undefined && turn.help.state !== 'done' && turn.help.askedAt < before
    const open = ((await this.snapshot()).messages ?? []).some(message => (message.turns ?? []).some(stale))
    if (!open) return 0
    return this.#write((state) => {
      let closed = 0
      const at = this.#at()
      const messages = (state.messages ?? []).map((message) => {
        if (!(message.turns ?? []).some(stale)) return message
        return {
          ...message,
          updatedAt: at,
          turns: (message.turns ?? []).map((turn) => {
            if (turn.help === undefined || !stale(turn)) return turn
            closed += 1
            return { ...turn, help: { ...turn.help, state: 'done' as const, skipped: [...turn.help.skipped, { reason: 'redémarrage' }] } }
          }),
        }
      })
      return {
        state: { ...state, messages },
        event: { at, actor: 'mndt', action: 'turn.help-closed', subject: 'restart', detail: `${closed} help(s) left open by a previous process` },
        value: closed,
      }
    })
  }

  /**
   * A person's reply to an agent's escalated question: answered, and the asker
   * gets a turn on that reply (it has the hand again).
   * @param reply - the person's message, replying to the agent's question.
   * @param actor - its author, a member who may write.
   * @returns the reply with the asker's turn, or undefined when it answers no open escalation.
   */
  async answerEscalation(reply: Message, actor: string): Promise<Message | undefined> {
    // Most replies answer no escalation: read first, write only when one does.
    const seen = await this.snapshot()
    const target = (seen.messages ?? []).find(candidate => candidate.id === reply.replyTo)
    if (target === undefined || target.author.kind !== 'agent') return undefined
    return this.#write((state) => {
      const messages = state.messages ?? []
      const question = messages.find(candidate => candidate.id === reply.replyTo)
      if (question === undefined || question.author.kind !== 'agent') return { state, event: [], value: undefined }
      const askerId = question.author.agentId
      // A question whose request was deleted is answered by nobody: its person withdrew it.
      const origin = messages.find(candidate => candidate.id === question.replyTo && candidate.deletedAt === undefined)
      // The escalation this reply answers: the one its question message names
      // (or, for a help recorded before messageId existed, the asker's open one).
      const turn = origin?.turns?.find((t) => {
        const open = openEscalationOf(t)
        return t.agentId === askerId && open !== undefined && (open.escalation.messageId ?? question.id) === question.id
      })
      const open = turn === undefined ? undefined : openEscalationOf(turn)
      if (origin === undefined || turn === undefined || open === undefined) return { state, event: [], value: undefined }
      const at = this.#at()
      const escalation = { ...open.escalation, answeredAt: at, answeredBy: actor }
      const answered = open.kind === 'help' && turn.help !== undefined
        ? { ...turn, help: { ...turn.help, escalation } }
        : turn.council === undefined ? turn : { ...turn, council: { ...turn.council, escalation } }
      const nextOrigin = { ...origin, turns: (origin.turns ?? []).map(t => (t.id === turn.id ? answered : t)), updatedAt: at }
      const current = messages.find(candidate => candidate.id === reply.id) ?? reply
      // A help gives the asker the hand again. A council does not convene again:
      // the person's answer is the decision.
      const relaunched = open.kind === 'council' || (current.turns ?? []).some(t => t.agentId === askerId)
        ? current
        : { ...current, turns: [...(current.turns ?? []), { id: this.#id('trn'), agentId: askerId, status: 'queued' as const }], updatedAt: at }
      return {
        state: {
          ...state,
          messages: messages.map(candidate => (candidate.id === origin.id
            ? nextOrigin
            : candidate.id === reply.id ? relaunched : candidate)),
        },
        event: { at, actor, action: open.kind === 'help' ? 'turn.help-answered' : 'turn.council-answered', subject: turn.id, detail: reply.id },
        value: relaunched,
      }
    })
  }

  /**
   * @param identity - who asks.
   * @returns the open escalations of the channels this person is a member of.
   */
  async openEscalations(identity: string): Promise<OpenEscalation[]> {
    const state = await this.snapshot()
    const mine = new Set((state.channels ?? []).filter(channel => channel.members.includes(identity)).map(channel => channel.id))
    // A deleted request withdraws its question: it leaves « À traiter » with it.
    const open = (state.messages ?? []).filter(message => mine.has(message.channelId) && message.deletedAt === undefined)
    return open.flatMap(message => (message.turns ?? [])
      .flatMap((turn) => {
        const open = openEscalationOf(turn)
        if (open === undefined) return []
        const { escalation } = open
        return [{
          kind: open.kind, channelId: message.channelId, turnId: turn.id, messageId: message.id,
          ...(escalation.messageId === undefined ? {} : { questionMessageId: escalation.messageId }),
          question: escalation.question, summary: escalation.summary, at: escalation.at,
        }]
      }))
  }

  /** @returns the space's library of skills, by name. */
  async listSkills(): Promise<readonly Skill[]> {
    return [...((await this.#ready()).skills ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Add a skill to the library, from a SKILL.md.
   * @param markdown - the file's text.
   * @param actor - an owner or an admin.
   * @returns the skill, and the front-matter fields it ignored (for the person to see).
   */
  createSkill(markdown: string, actor: string): Promise<{ skill: Skill; ignoredFields: string[] }> {
    let parsed: ReturnType<typeof parseSkill>
    try {
      parsed = parseSkill(markdown)
    } catch (error) {
      return Promise.reject(error)
    }
    return this.#write((state) => {
      const slug = slugOf(parsed.name)
      if (slug === '') throw new SkillRefusal('missing-fields', 'a skill\'s name needs letters or digits')
      if ((state.skills ?? []).some(skill => skill.slug === slug)) throw new SkillRefusal('skill-exists', `a skill « ${slug} » is already in the library`)
      const at = this.#at()
      const skill: Skill = {
        slug, name: parsed.name, description: parsed.description, body: parsed.body, version: 1, updatedBy: actor, updatedAt: at,
      }
      return {
        state: { ...state, skills: [...(state.skills ?? []), skill] },
        event: { at, actor, action: 'skill.created', subject: slug, detail: 'version 1' },
        value: { skill, ignoredFields: parsed.ignoredFields },
      }
    })
  }

  /**
   * Change a skill, from the version the writer read; its agents use the new
   * text at their next turn.
   * @param slug - the skill.
   * @param markdown - the new SKILL.md (its name may change; its slug does not).
   * @param version - the version read.
   * @param actor - an owner or an admin.
   * @returns the skill and the fields ignored.
   */
  updateSkill(slug: string, markdown: string, version: number, actor: string): Promise<{ skill: Skill; ignoredFields: string[] }> {
    let parsed: ReturnType<typeof parseSkill>
    try {
      parsed = parseSkill(markdown)
    } catch (error) {
      return Promise.reject(error)
    }
    return this.#write((state) => {
      const current = (state.skills ?? []).find(skill => skill.slug === slug)
      if (current === undefined) throw new SkillRefusal('unknown-skill', `no skill ${slug}`)
      if (current.version !== version) {
        throw new SkillRefusal('skill-changed', `the skill « ${slug} » changed since version ${version} (now ${current.version}): read it again`)
      }
      const at = this.#at()
      const skill: Skill = {
        ...current, name: parsed.name, description: parsed.description, body: parsed.body,
        version: current.version + 1, updatedBy: actor, updatedAt: at,
      }
      return {
        state: { ...state, skills: (state.skills ?? []).map(candidate => (candidate.slug === slug ? skill : candidate)) },
        event: { at, actor, action: 'skill.updated', subject: slug, detail: `version ${skill.version}` },
        value: { skill, ignoredFields: parsed.ignoredFields },
      }
    })
  }

  /**
   * Attach one skill to an agent, or detach one, inside the write chain: it is
   * applied to the agent as it stands at that moment, so two changes made at
   * the same time both count (a whole list sent without a version, by
   * contrast, could erase a skill attached in between). Attaching a skill
   * already attached, or detaching one that is not, changes nothing.
   * @param id - the agent.
   * @param change - exactly one of add or remove: a skill's slug.
   * @param actor - an owner or an admin.
   * @returns the agent, as written.
   * @throws SkillRefusal missing-fields (neither or both), unknown-skill, too-many-skills; an Error for an unknown or retired agent.
   */
  changeAgentSkill(id: string, change: { readonly add?: string; readonly remove?: string }, actor: string): Promise<Agent> {
    return this.#write((state) => {
      if ((change.add === undefined) === (change.remove === undefined)) {
        throw new SkillRefusal('missing-fields', 'one skill to add or to remove: { add: slug } or { remove: slug }')
      }
      const agent = (state.agents ?? []).find(candidate => candidate.id === id)
      if (agent === undefined || agent.retiredAt !== undefined) throw new Refusal(`no agent ${id}`)
      const current = agent.skills ?? []
      const slug = (change.add ?? change.remove) as string
      const wanted = change.add !== undefined
        ? (current.includes(slug) ? current : checkedSkills(state.skills ?? [], [...current, slug]))
        : current.filter(other => other !== slug)
      // Nothing to change (already attached, or not attached): no write is journaled.
      if (wanted.length === current.length) return { state, event: [], value: agent }
      const { skills: _previous, ...rest } = agent
      const next: Agent = wanted.length === 0 ? rest : { ...rest, skills: wanted }
      const at = this.#at()
      return {
        state: { ...state, agents: (state.agents ?? []).map(candidate => (candidate.id === id ? next : candidate)) },
        event: { at, actor, action: 'agent.updated', subject: id, detail: `skills ${change.add !== undefined ? '+' : '-'}${slug}` },
        value: next,
      }
    })
  }

  /**
   * Remove a skill from the library and from every agent that used it, in ONE
   * write: no slug is left pointing nowhere.
   * @param slug - the skill.
   * @param actor - an owner or an admin.
   * @returns the agents it was removed from.
   */
  deleteSkill(slug: string, actor: string): Promise<{ removedFrom: string[] }> {
    return this.#write((state) => {
      if (!(state.skills ?? []).some(skill => skill.slug === slug)) throw new SkillRefusal('unknown-skill', `no skill ${slug}`)
      const removedFrom: string[] = []
      const agents = (state.agents ?? []).map((agent) => {
        if (!(agent.skills ?? []).includes(slug)) return agent
        removedFrom.push(agent.id)
        const left = (agent.skills ?? []).filter(other => other !== slug)
        const { skills: _all, ...rest } = agent
        return left.length === 0 ? rest : { ...rest, skills: left }
      })
      const at = this.#at()
      return {
        state: { ...state, agents, skills: (state.skills ?? []).filter(skill => skill.slug !== slug) },
        event: { at, actor, action: 'skill.deleted', subject: slug, detail: `removed from ${removedFrom.length} agent(s)` },
        value: { removedFrom },
      }
    })
  }

  /**
   * Write a channel's context, from the version the writer read.
   * @param id - the channel.
   * @param text - the new context; trimmed, at most MAX_CONTEXT_CHARS; empty erases it.
   * @param baseVersion - the version read (0: the channel had none).
   * @param actor - a member who writes it.
   * @returns the channel.
   * @throws ContextRefusal context-too-long, or context-changed when another change came in between.
   */
  setChannelContext(id: string, text: string, baseVersion: number, actor: string): Promise<Channel> {
    return this.#write((state) => {
      const channel = (state.channels ?? []).find(candidate => candidate.id === id)
      if (channel === undefined || !channel.members.includes(actor)) throw new Refusal(`no channel ${id}`)
      const next = withContext(channel, text, baseVersion, actor, this.#at())
      return {
        state: { ...state, channels: (state.channels ?? []).map(candidate => (candidate.id === id ? next : candidate)) },
        event: { at: this.#at(), actor, action: 'channel.context', subject: id, detail: `version ${next.context?.version ?? 0}` },
        value: next,
      }
    })
  }

  /**
   * Set how a channel's turns are coordinated, or go back to each agent alone.
   * « Auteur puis vérificateur »: both agents are on the channel, active, distinct,
   * and of DIFFERENT models (a model rarely catches its own mistakes).
   * @param id - the channel.
   * @param coordination - the mode, or undefined for each agent alone.
   * @param actor - a member who sets it.
   * @returns the channel.
   */
  setCoordination(id: string, coordination: Coordination | undefined, actor: string): Promise<Channel> {
    return this.#write((state) => {
      const channel = (state.channels ?? []).find(candidate => candidate.id === id)
      if (channel === undefined || !channel.members.includes(actor)) throw new Refusal(`no channel ${id}`)
      const active = (agentId: string): Agent | undefined =>
        (state.agents ?? []).find(agent => agent.id === agentId && agent.retiredAt === undefined && channel.agents.includes(agent.id))
      let recorded: Coordination | undefined
      if (coordination?.mode === 'author-verifier') {
        const author = active(coordination.authorId)
        const verifier = active(coordination.verifierId)
        if (author === undefined || verifier === undefined) throw new CoordinationRefusal('not-member', 'the author and the verifier must both be active agents of this channel')
        if (author.id === verifier.id) throw new CoordinationRefusal('same-agent', 'the author and the verifier must be two agents')
        if (author.provider === verifier.provider && author.model === verifier.model) {
          throw new CoordinationRefusal('same-model', `the verifier must run another model than the author (both are ${author.provider}/${author.model})`)
        }
        recorded = { mode: 'author-verifier', authorId: author.id, verifierId: verifier.id }
      } else if (coordination?.mode === 'parallel-synthesis') {
        const workers = [...new Set(coordination.workerIds)]
        if (workers.length < MIN_WORKERS || workers.length > MAX_WORKERS) {
          throw new CoordinationRefusal(workers.length < MIN_WORKERS ? 'too-few-workers' : 'too-many-workers', `a parallel turn has ${MIN_WORKERS} to ${MAX_WORKERS} distinct workers`)
        }
        if (workers.some(agentId => active(agentId) === undefined) || active(coordination.synthesizerId) === undefined) {
          throw new CoordinationRefusal('not-member', 'the workers and the synthesizer must all be active agents of this channel')
        }
        if (workers.includes(coordination.synthesizerId)) throw new CoordinationRefusal('synthesizer-is-worker', 'the synthesizer is not one of the workers')
        const cap = coordination.maxEurPerTurn
        if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0 || cap > MAX_EUR_PER_COORDINATED_TURN) {
          throw new CoordinationRefusal('budget-out-of-range', `a parallel turn costs ${MAX_EUR_PER_COORDINATED_TURN} € at most (maxEurPerTurn)`)
        }
        recorded = { mode: 'parallel-synthesis', workerIds: workers, synthesizerId: coordination.synthesizerId, maxEurPerTurn: cap }
      } else if (coordination?.mode === 'council') {
        const members = [...new Set(coordination.memberIds)]
        if (members.length < MIN_COUNCIL_MEMBERS || members.length > MAX_COUNCIL_MEMBERS) {
          throw new CoordinationRefusal(members.length < MIN_COUNCIL_MEMBERS ? 'too-few-members' : 'too-many-members',
            `a council has ${MIN_COUNCIL_MEMBERS} to ${MAX_COUNCIL_MEMBERS} distinct members`)
        }
        if (members.some(agentId => active(agentId) === undefined)) throw new CoordinationRefusal('not-member', 'the members must all be active agents of this channel')
        if (coordination.decision !== 'vote' && coordination.decision !== 'synthesis') {
          throw new CoordinationRefusal('unknown-decision', 'a council decides by vote or by synthesis')
        }
        if (coordination.decision === 'synthesis') {
          if (coordination.synthesizerId === undefined) throw new CoordinationRefusal('missing-fields', 'a council decided by synthesis needs a synthesizer')
          if (members.includes(coordination.synthesizerId)) throw new CoordinationRefusal('synthesizer-is-member', 'the synthesizer is not one of the members')
          if (active(coordination.synthesizerId) === undefined) throw new CoordinationRefusal('not-member', 'the synthesizer must be an active agent of this channel')
        }
        const cap = coordination.maxEurPerTurn
        if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0 || cap > MAX_EUR_PER_COORDINATED_TURN) {
          throw new CoordinationRefusal('budget-out-of-range', `a council turn costs ${MAX_EUR_PER_COORDINATED_TURN} € at most (maxEurPerTurn)`)
        }
        recorded = {
          mode: 'council', memberIds: members, decision: coordination.decision, maxEurPerTurn: cap,
          ...(coordination.decision === 'synthesis' && coordination.synthesizerId !== undefined ? { synthesizerId: coordination.synthesizerId } : {}),
        }
      } else if (coordination !== undefined) {
        throw new CoordinationRefusal('unknown-mode', `unknown coordination mode: ${String((coordination as { mode?: unknown }).mode)}`)
      }
      const { coordination: _previous, ...rest } = channel
      const next: Channel = recorded === undefined ? rest : { ...rest, coordination: recorded }
      return {
        state: { ...state, channels: (state.channels ?? []).map(candidate => (candidate.id === id ? next : candidate)) },
        event: {
          at: this.#at(), actor, action: 'channel.coordination', subject: id,
          detail: recorded === undefined ? 'solo' : `${recorded.mode} ${coordinationAgents(recorded).join(' ')}`,
        },
        value: next,
      }
    })
  }

  // ---------------------------------------------------------------- messages

  /**
   * The messages of a channel, oldest first.
   * @param channelId - the channel.
   * @param after - only those after this message id.
   * @param limit - at most this many, the latest ones.
   * @returns the messages.
   */
  async messages(channelId: string, after?: string, limit = 200): Promise<readonly Message[]> {
    const all = ((await this.#ready()).messages ?? []).filter(message => message.channelId === channelId)
    const from = after === undefined ? 0 : all.findIndex(message => message.id === after) + 1
    return all.slice(from).slice(-limit)
  }

  /**
   * @param channelId - the channel.
   * @returns the instant of its last change, the epoch when it has none: the first `since`.
   */
  async lastChange(channelId: string): Promise<string> {
    let last = new Date(0).toISOString()
    for (const message of (await this.#ready()).messages ?? []) {
      const at = message.updatedAt ?? message.createdAt
      if (message.channelId === channelId && at > last) last = at
    }
    return last
  }

  /**
   * The messages of a channel created or changed at or after an instant: new
   * messages, turns that moved on, deletions. One request per poll.
   * @param channelId - the channel.
   * @param since - an ISO instant, inclusive: the screen keeps the latest copy of each id.
   * @param limit - at most this many, the latest changes.
   * @returns the messages, oldest change first, and the cursor of the next poll.
   */
  async changedSince(channelId: string, since: string, limit = 200): Promise<{ messages: readonly Message[]; cursor: string }> {
    const changed = ((await this.#ready()).messages ?? [])
      .filter(message => message.channelId === channelId && (message.updatedAt ?? message.createdAt) >= since)
      .sort((a, b) => (a.updatedAt ?? a.createdAt).localeCompare(b.updatedAt ?? b.createdAt))
      .slice(-limit)
    const last = changed.at(-1)
    return { messages: changed, cursor: last === undefined ? since : (last.updatedAt ?? last.createdAt) }
  }

  /** @param id - message id. @returns the message. */
  async message(id: string): Promise<Message | undefined> {
    return ((await this.#ready()).messages ?? []).find(message => message.id === id)
  }

  /**
   * Post a person's message; each agent of the channel it mentions gets a
   * queued turn. The text is stored, never applied: it decides nothing.
   * @param channelId - the channel.
   * @param author - a member.
   * @param text - what they wrote.
   * @param replyTo - the message it answers, if any.
   * @returns the message and its queued turns.
   */
  postMessage(channelId: string, author: string, text: string, replyTo?: string): Promise<Message> {
    const body = text.trim()
    if (body === '') return Promise.reject(new Refusal('a message needs text'))
    return this.#write((state) => {
      const channel = (state.channels ?? []).find(candidate => candidate.id === channelId)
      if (channel === undefined || !channel.members.includes(author)) throw new Refusal(`no channel ${channelId}`)
      const agents = (state.agents ?? []).filter(agent => channel.agents.includes(agent.id) && agent.retiredAt === undefined)
      const mentions = mentionsOf(body, agents)
      const turns: Turn[] = mentions.map(agentId => ({ id: this.#id('trn'), agentId, status: 'queued' }))
      const at = this.#at()
      const message: Message = {
        id: this.#id('msg'),
        channelId,
        author: { kind: 'human', email: author },
        text: body,
        mentions,
        ...(replyTo === undefined ? {} : { replyTo }),
        ...(turns.length === 0 ? {} : { turns }),
        createdAt: at,
        updatedAt: at,
      }
      return {
        state: { ...state, messages: [...(state.messages ?? []), message] },
        event: { at: message.createdAt, actor: author, action: 'message.posted', subject: message.id, detail: channelId },
        value: message,
      }
    })
  }

  /**
   * Delete a person's own message: its place stays, its text goes, and its
   * turns that have not finished are cancelled.
   * @param channelId - the channel.
   * @param id - the message.
   * @param actor - its author.
   * @returns the message.
   */
  deleteMessage(channelId: string, id: string, actor: string): Promise<Message> {
    return this.#write((state) => {
      const message = (state.messages ?? []).find(candidate => candidate.id === id && candidate.channelId === channelId)
      if (message === undefined) throw new Refusal(`no message ${id}`)
      if (message.author.kind !== 'human' || message.author.email !== actor) throw new Refusal('only its author deletes a message')
      const at = this.#at()
      const next: Message = {
        ...message,
        text: '',
        deletedAt: at,
        updatedAt: at,
        ...(message.turns === undefined
          ? {}
          : {
            turns: message.turns.map(turn => (turn.status === 'queued' || turn.status === 'running'
              ? { ...turn, status: 'cancelled' as const, reason: 'Message supprimé par son auteur.', reasonKind: 'stale' as const, finishedAt: at }
              : turn)),
          }),
      }
      return {
        state: { ...state, messages: (state.messages ?? []).map(candidate => (candidate.id === id ? next : candidate)) },
        event: { at, actor, action: 'message.deleted', subject: id, detail: channelId },
        value: next,
      }
    })
  }

  /**
   * Move a turn on, unless it already settled (a cancelled turn stays so).
   * @param messageId - the mentioning message.
   * @param turnId - the turn.
   * @param patch - its new status and figures.
   * @returns the turn as it now stands.
   */
  updateTurn(messageId: string, turnId: string, patch: Partial<Omit<Turn, 'id' | 'agentId'>>): Promise<Turn> {
    return this.#write((state) => {
      const message = (state.messages ?? []).find(candidate => candidate.id === messageId)
      const turn = message?.turns?.find(candidate => candidate.id === turnId)
      if (message === undefined || turn === undefined) throw new Refusal(`no turn ${turnId}`)
      const settled = turn.status !== 'queued' && turn.status !== 'running'
      const next: Turn = settled ? turn : { ...turn, ...patch }
      const updated: Message = {
        ...message,
        turns: (message.turns ?? []).map(t => (t.id === turnId ? next : t)),
        ...(settled ? {} : { updatedAt: this.#at() }),
      }
      return {
        state: { ...state, messages: (state.messages ?? []).map(candidate => (candidate.id === messageId ? updated : candidate)) },
        event: { at: this.#at(), actor: 'mndt', action: `turn.${next.status}`, subject: turnId, ...(next.reason === undefined ? {} : { detail: next.reason }) },
        value: next,
      }
    })
  }

  /**
   * Write an agent's answer, or a system notice, in the thread of a message.
   * @param channelId - the channel.
   * @param replyTo - the mentioning message.
   * @param author - the agent, or the system.
   * @param text - the answer.
   * @returns the message.
   */
  reply(channelId: string, replyTo: string, author: Exclude<MessageAuthor, { kind: 'human' }>, text: string): Promise<Message> {
    return this.#write((state) => {
      const at = this.#at()
      const message: Message = {
        id: this.#id('msg'),
        channelId,
        author,
        text,
        mentions: [],
        replyTo,
        createdAt: at,
        updatedAt: at,
      }
      return {
        state: { ...state, messages: [...(state.messages ?? []), message] },
        event: { at: message.createdAt, actor: author.kind === 'agent' ? author.agentId : 'mndt', action: 'message.reply', subject: message.id, detail: channelId },
        value: message,
      }
    })
  }

  /** @returns the whole state, for a page that wants one read. */
  async snapshot(): Promise<WorkbenchState> {
    return this.#ready()
  }
}

/**
 * @param agent - an agent as drafted or patched.
 * @returns why it cannot be kept, or undefined.
 */
/**
 * The title of a propose_agent card, built from what it grants: name, handle,
 * model, connectors, ceiling. Never the requester's words.
 * @param proposal - the agent proposed.
 * @returns the title.
 */
function proposalTitle(proposal: AgentProposal): string {
  const connectors = (proposal.connectors ?? []).length === 0 ? 'aucun connecteur' : `connecteurs ${[...new Set(proposal.connectors)].sort().join(', ')}`
  return `Créer l'agent ${proposal.name.trim()} (@${proposal.handle}) : ${proposal.provider}/${proposal.model}, ${connectors}, plafond ${proposal.eurPerMonth ?? DEFAULT_EUR_PER_MONTH} €/mois`
}

/** @param draft - a proposal as asked. @returns it with only the fields of POST /agents. */
function proposalOf(draft: AgentProposal): AgentProposal {
  return {
    handle: draft.handle,
    name: draft.name,
    provider: draft.provider,
    model: draft.model,
    ...(draft.instructions === undefined ? {} : { instructions: draft.instructions }),
    ...(draft.connectors === undefined ? {} : { connectors: [...draft.connectors] }),
    ...(draft.eurPerMonth === undefined ? {} : { eurPerMonth: draft.eurPerMonth }),
  }
}

function agentRefusal(agent: AgentDraft): string | undefined {
  if (!SLUG.test(agent.handle)) return `a handle is a slug of 2 to 32 characters: ${agent.handle}`
  if (agent.name.trim() === '') return 'an agent needs a name'
  // The name enters the turn prompt of every agent of the channel (speaker()): one
  // line, no control character nor line separator, 60 characters at most.
  if (agent.name.trim().length > MAX_AGENT_NAME || /[\u0000-\u001f\u007f\u2028\u2029]/.test(agent.name)) {
    return `an agent's name is one line of ${MAX_AGENT_NAME} characters at most`
  }
  if (agent.provider.trim() === '' || agent.model.trim() === '') return 'an agent needs a provider and a model'
  // Even when the host lists no models: one line each, no control character, bounded.
  for (const [field, value] of [['provider', agent.provider], ['model', agent.model]] as const) {
    if (value.trim().length > 128 || /[\u0000-\u001f\u007f\u2028\u2029]/.test(value)) return `an agent's ${field} is one line of 128 characters at most`
  }
  const ceiling = agent.eurPerMonth ?? DEFAULT_EUR_PER_MONTH
  if (typeof ceiling === 'number' && ceiling > MAX_EUR_PER_MONTH) return `a monthly ceiling is ${MAX_EUR_PER_MONTH} € at most: ${ceiling}`
  // The framing is added to every turn, so to its cost.
  if (agent.instructions !== undefined && agent.instructions.trim().length > MAX_INSTRUCTIONS) {
    return `the instructions are ${MAX_INSTRUCTIONS} characters at most (${agent.instructions.trim().length})`
  }
  if (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling <= 0) return 'a monthly ceiling is a positive number of euros'
  return serversRefusal(agent.connectors ?? [])
}

/** @param servers - MCP server names. @returns why one is not a server name, or undefined. */
function serversRefusal(servers: readonly string[]): string | undefined {
  const bad = servers.filter(server => typeof server !== 'string' || !SERVER.test(server))
  return bad.length === 0 ? undefined : `not an MCP server name: ${bad.join(', ')}`
}
