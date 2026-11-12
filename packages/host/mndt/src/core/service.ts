/**
 * The rules of the workbench.
 *
 * One service owns every transition, so a page, an HTTP route and a test cannot
 * disagree about what a mission may become. Two rules carry the honesty the
 * product needs: a mission never reaches `done` without a brief that has content,
 * and an action that leaves the building never happens without a recorded human
 * decision.
 */
import { randomUUID } from 'node:crypto'
import { emptyState, isMissionKind, needsApproval } from './types.ts'
import type {
  Agent,
  Approval,
  ApprovalAction,
  ApprovalPayload,
  ApprovalState,
  Brief,
  BriefSource,
  Channel,
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
import type { Mandate } from './types.ts'
import type { MandateDraft } from '../mandates.ts'
import { draftRefusal, signRefusal } from '../mandates.ts'
import type { Role } from '@deepseek-ai/dsh-client-ui-governance/src/rbac.ts'
import { SLUG, mentionsOf } from './conversation.ts'

/** What a caller must say to ask for work. */
export interface MissionRequest {
  readonly kind: MissionKind
  readonly prompt: string
  readonly createdBy: string
  readonly visibility?: Visibility
  readonly mandateId?: string
}

/** What a runtime reports when a run finishes. */
export interface MissionResult {
  readonly title: string
  readonly markdown: string
  readonly sources?: readonly BriefSource[]
  readonly tokens?: { readonly input: number; readonly output: number }
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
}

/** What changing an agent may touch. */
export type AgentPatch = Partial<Pick<Agent, 'name' | 'provider' | 'model' | 'instructions' | 'connectors' | 'eurPerMonth'>>

/** What creating a channel needs. */
export interface ChannelDraft {
  readonly name: string
  readonly title?: string
  readonly members?: readonly string[]
  readonly agents?: readonly string[]
  readonly connectors?: readonly string[]
}

/** The default monthly ceiling of an agent, in euros. */
export const DEFAULT_EUR_PER_MONTH = 5

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

/** What building one service needs. */
export interface ServiceOptions {
  readonly store: WorkbenchStore
  readonly now?: () => Date
  readonly nextId?: (prefix: string) => string
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

  /** @returns the loaded state, loading it once. */
  async #ready(): Promise<WorkbenchState> {
    if (!this.#loaded) {
      const loaded = await this.#options.store.load()
      // Older state files predate mandates; they read as no mandates, never as a crash.
      const mandates = (loaded as { mandates?: readonly Mandate[] }).mandates ?? []
      this.#state = { ...loaded, mandates }
      this.#loaded = true
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
      | { state: WorkbenchState; event: WorkbenchEvent; value: T }
      | Promise<{ state: WorkbenchState; event: WorkbenchEvent; value: T }>,
  ): Promise<T> {
    let result: T | undefined
    const run = this.#chain.then(async () => {
      const state = await this.#ready()
      const next = await work(state)
      const committed: WorkbenchState = { ...next.state, events: [...next.state.events, next.event].slice(-500) }
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
    if (!isMissionKind(request.kind)) return Promise.reject(new Error(`unknown mission kind: ${String(request.kind)}`))
    const prompt = request.prompt.trim()
    if (prompt === '') return Promise.reject(new Error('a mission needs an instruction'))
    if (request.createdBy.trim() === '') return Promise.reject(new Error('a mission needs a requester'))
    const mission: Mission = {
      id: this.#id('mis'),
      kind: request.kind,
      prompt,
      status: 'queued',
      createdBy: request.createdBy.trim(),
      visibility: request.visibility ?? 'team',
      createdAt: this.#at(),
      ...(request.mandateId === undefined ? {} : { mandateId: request.mandateId }),
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
    if (sessionId.trim() === '') return Promise.reject(new Error('a run needs a session'))
    return this.#write((state) => {
      const mission = state.missions.find(candidate => candidate.id === id)
      if (mission === undefined) throw new Error(`no mission ${id}`)
      if (mission.status !== 'queued' && mission.status !== 'needs-review') {
        throw new Error(`mission ${id} is ${mission.status}; only a queued mission can start`)
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
      throw new Error(`mission ${id} produced no usable content`)
    }
    return this.#write((state) => {
      const mission = state.missions.find(candidate => candidate.id === id)
      if (mission === undefined) throw new Error(`no mission ${id}`)
      if (mission.status !== 'running') throw new Error(`mission ${id} is ${mission.status}; only a running mission can finish`)
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
      }
      return {
        state: {
          ...state,
          missions: state.missions.map(candidate => (candidate.id === id ? next : candidate)),
          briefs: [brief, ...state.briefs],
        },
        event: {
          at,
          actor: mission.createdBy,
          action: 'mission.done',
          subject: id,
          detail: result.tokens === undefined ? brief.id : `${brief.id}, ${result.tokens.input} in / ${result.tokens.output} out`,
        },
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
    const detail = reason.trim()
    if (detail === '') return Promise.reject(new Error('a failure needs a reason'))
    return this.#write((state) => {
      const mission = state.missions.find(candidate => candidate.id === id)
      if (mission === undefined) throw new Error(`no mission ${id}`)
      if (mission.status === 'done' || mission.status === 'failed') throw new Error(`mission ${id} already ${mission.status}`)
      const at = this.#at()
      const next: Mission = { ...mission, status: 'failed', finishedAt: at, error: detail }
      return {
        state: { ...state, missions: state.missions.map(candidate => (candidate.id === id ? next : candidate)) },
        event: { at, actor: mission.createdBy, action: 'mission.failed', subject: id, detail },
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
      if (mission === undefined) throw new Error(`no mission ${id}`)
      if (!privileged && mission.createdBy !== actor) throw new Error(`mission ${id} belongs to ${mission.createdBy}`)
      if (mission.status !== 'queued' && mission.status !== 'running') {
        throw new Error(`mission ${id} is ${mission.status}; only a waiting mission can be cancelled`)
      }
      const at = this.#at()
      const next: Mission = { ...mission, status: 'failed', finishedAt: at, error: `cancelled by ${actor}` }
      return {
        state: { ...state, missions: state.missions.map(candidate => (candidate.id === id ? next : candidate)) },
        event: { at, actor, action: 'mission.cancelled', subject: id },
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
    if (mission === undefined) throw new Error(`no mission ${id}`)
    if (mission.status !== 'failed') throw new Error(`mission ${id} is ${mission.status}; only a failed mission can be retried`)
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
    if (actor.trim() === '') return Promise.reject(new Error('an approval needs an actor'))
    return this.#write((state) => {
      const brief = state.briefs.find(candidate => candidate.id === id)
      if (brief === undefined) throw new Error(`no brief ${id}`)
      if (brief.status !== 'draft') throw new Error(`brief ${id} is already ${brief.status}`)
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
    if (!needsApproval(request.kind)) return Promise.reject(new Error(`action ${String(request.kind)} does not need approval`))
    if (request.title.trim() === '') return Promise.reject(new Error('an approval needs a title'))
    if (request.requestedBy.trim() === '') return Promise.reject(new Error('an approval needs a requester'))
    const approval: Approval = {
      id: this.#id('apr'),
      kind: request.kind,
      title: request.title.trim(),
      payload: request.payload ?? {},
      requestedBy: request.requestedBy.trim(),
      requestedAt: this.#at(),
      state: 'pending',
      ...(request.missionId === undefined ? {} : { missionId: request.missionId }),
      ...(request.channelId === undefined ? {} : { channelId: request.channelId }),
      ...(request.messageId === undefined ? {} : { messageId: request.messageId }),
    }
    return this.#write(state => ({
      state: { ...state, approvals: [approval, ...state.approvals] },
      event: { at: approval.requestedAt, actor: approval.requestedBy, action: 'approval.requested', subject: approval.id, detail: approval.kind },
      value: approval,
    }))
  }

  /**
   * Decide a pending approval.
   * @param id - approval id.
   * @param actor - who decided.
   * @param decision - approved or rejected.
   * @param reason - why, when rejected.
   * @returns the decided approval.
   */
  decideApproval(id: string, actor: string, decision: ApprovalState, reason?: string): Promise<Approval> {
    if (actor.trim() === '') return Promise.reject(new Error('a decision needs an actor'))
    if (decision !== 'approved' && decision !== 'rejected') return Promise.reject(new Error('cannot decide that'))
    const rejection = reason?.trim()
    if (decision === 'rejected' && (rejection === undefined || rejection === '')) return Promise.reject(new Error('a rejection needs a reason'))
    return this.#write((state) => {
      const approval = state.approvals.find(candidate => candidate.id === id)
      if (approval === undefined) throw new Error(`no approval ${id}`)
      if (approval.state !== 'pending') throw new Error(`approval ${id} is already ${approval.state}`)
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
    if (text === '') return Promise.reject(new Error('a memory note needs text'))
    if (note.createdBy.trim() === '') return Promise.reject(new Error('a memory note needs an author'))
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
      if (mission === undefined) throw new Error(`no mission ${id}`)
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
      if (note === undefined) throw new Error(`no memory ${id}`)
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
    if (refusal !== undefined) return Promise.reject(new Error(refusal))
    const mandate: Mandate = {
      id: this.#id('mnd'),
      delegant: draft.delegant.trim(),
      delegataire: draft.delegataire.trim(),
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
      if (mandate === undefined) throw new Error(`no mandate ${id}`)
      const today = this.#at().slice(0, 10)
      const refusal = signRefusal(mandate, actor, role, today)
      if (refusal !== undefined) throw new Error(refusal)
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
      if (mandate === undefined) throw new Error(`no mandate ${id}`)
      if (mandate.state === 'retired') throw new Error('this mandate is already retired')
      if (actor !== mandate.delegant && role !== 'owner' && role !== 'admin') {
        throw new Error(`${actor} can neither retract this mandate nor administer mandates`)
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

  // ---------------------------------------------------------------- agents

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
   * @returns the agent.
   */
  createAgent(draft: AgentDraft, actor: string): Promise<Agent> {
    const refusal = agentRefusal(draft)
    if (refusal !== undefined) return Promise.reject(new Error(refusal))
    return this.#write((state) => {
      if ((state.agents ?? []).some(agent => agent.handle === draft.handle)) {
        throw new Error(`the handle @${draft.handle} is taken`)
      }
      const agent: Agent = {
        id: this.#id('agt'),
        handle: draft.handle,
        name: draft.name.trim(),
        provider: draft.provider.trim(),
        model: draft.model.trim(),
        ...(draft.instructions === undefined || draft.instructions.trim() === '' ? {} : { instructions: draft.instructions.trim() }),
        connectors: [...new Set(draft.connectors ?? [])].sort(),
        eurPerMonth: draft.eurPerMonth ?? DEFAULT_EUR_PER_MONTH,
        createdBy: actor,
        createdAt: this.#at(),
      }
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
      if (agent === undefined || agent.retiredAt !== undefined) throw new Error(`no agent ${id}`)
      const next: Agent = {
        ...agent,
        ...patch,
        ...(patch.connectors === undefined ? {} : { connectors: [...new Set(patch.connectors)].sort() }),
      }
      const refusal = agentRefusal(next)
      if (refusal !== undefined) throw new Error(refusal)
      if (next.eurPerMonth > agent.eurPerMonth && role !== 'owner') {
        throw new Error(`only the owner raises the ceiling of @${agent.handle}`)
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
    const existing = ((await this.#ready()).channels ?? []).find(c => c.kind === 'solo' && c.members[0] === email)
    if (existing !== undefined) return existing
    return this.#write((state) => {
      const again = (state.channels ?? []).find(c => c.kind === 'solo' && c.members[0] === email)
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
    if (!SLUG.test(draft.name)) return Promise.reject(new Error(`a channel name is a slug: ${draft.name}`))
    const connectorRefusal = serversRefusal(draft.connectors ?? [])
    if (connectorRefusal !== undefined) return Promise.reject(new Error(connectorRefusal))
    return this.#write((state) => {
      if ((state.channels ?? []).some(channel => channel.name === draft.name)) {
        throw new Error(`the channel #${draft.name} exists`)
      }
      const agents = draft.agents ?? []
      const unknown = agents.filter(id => !(state.agents ?? []).some(agent => agent.id === id && agent.retiredAt === undefined))
      if (unknown.length > 0) throw new Error(`no agent ${unknown.join(', ')}`)
      const channel: Channel = {
        id: this.#id('chn'),
        name: draft.name,
        title: draft.title?.trim() || draft.name,
        kind: 'team',
        members: [...new Set([actor, ...(draft.members ?? [])])],
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
    },
    actor: string,
  ): Promise<Channel> {
    if (change.connectors !== undefined) {
      const refusal = serversRefusal(change.connectors)
      if (refusal !== undefined) return Promise.reject(new Error(refusal))
    }
    return this.#write((state) => {
      const channel = (state.channels ?? []).find(candidate => candidate.id === id)
      if (channel === undefined || !channel.members.includes(actor)) throw new Error(`no channel ${id}`)
      if (channel.kind === 'solo' && ((change.addMembers ?? []).length > 0 || (change.removeMembers ?? []).length > 0)) {
        throw new Error('a solo lane has one person')
      }
      const added = change.addAgents ?? []
      const unknown = added.filter(agentId => !(state.agents ?? []).some(agent => agent.id === agentId && agent.retiredAt === undefined))
      if (unknown.length > 0) throw new Error(`no agent ${unknown.join(', ')}`)
      const members = [...new Set([...channel.members, ...(change.addMembers ?? [])])]
        .filter(email => !(change.removeMembers ?? []).includes(email))
      if (members.length === 0) throw new Error('a channel keeps at least one person')
      const next: Channel = {
        ...channel,
        members,
        agents: [...new Set([...channel.agents, ...added])].filter(agentId => !(change.removeAgents ?? []).includes(agentId)),
        ...(change.connectors === undefined ? {} : { connectors: [...new Set(change.connectors)].sort() }),
      }
      return {
        state: { ...state, channels: (state.channels ?? []).map(candidate => (candidate.id === id ? next : candidate)) },
        event: { at: this.#at(), actor, action: 'channel.updated', subject: id },
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
    if (body === '') return Promise.reject(new Error('a message needs text'))
    return this.#write((state) => {
      const channel = (state.channels ?? []).find(candidate => candidate.id === channelId)
      if (channel === undefined || !channel.members.includes(author)) throw new Error(`no channel ${channelId}`)
      const agents = (state.agents ?? []).filter(agent => channel.agents.includes(agent.id) && agent.retiredAt === undefined)
      const mentions = mentionsOf(body, agents)
      const turns: Turn[] = mentions.map(agentId => ({ id: this.#id('trn'), agentId, status: 'queued' }))
      const message: Message = {
        id: this.#id('msg'),
        channelId,
        author: { kind: 'human', email: author },
        text: body,
        mentions,
        ...(replyTo === undefined ? {} : { replyTo }),
        ...(turns.length === 0 ? {} : { turns }),
        createdAt: this.#at(),
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
      if (message === undefined) throw new Error(`no message ${id}`)
      if (message.author.kind !== 'human' || message.author.email !== actor) throw new Error('only its author deletes a message')
      const at = this.#at()
      const next: Message = {
        ...message,
        text: '',
        deletedAt: at,
        ...(message.turns === undefined
          ? {}
          : {
            turns: message.turns.map(turn => (turn.status === 'queued' || turn.status === 'running'
              ? { ...turn, status: 'cancelled' as const, reason: 'Message supprimé par son auteur.', finishedAt: at }
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
      if (message === undefined || turn === undefined) throw new Error(`no turn ${turnId}`)
      const settled = turn.status !== 'queued' && turn.status !== 'running'
      const next: Turn = settled ? turn : { ...turn, ...patch }
      const updated: Message = { ...message, turns: (message.turns ?? []).map(t => (t.id === turnId ? next : t)) }
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
      const message: Message = {
        id: this.#id('msg'),
        channelId,
        author,
        text,
        mentions: [],
        replyTo,
        createdAt: this.#at(),
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
function agentRefusal(agent: AgentDraft): string | undefined {
  if (!SLUG.test(agent.handle)) return `a handle is a slug of 2 to 32 characters: ${agent.handle}`
  if (agent.name.trim() === '') return 'an agent needs a name'
  if (agent.provider.trim() === '' || agent.model.trim() === '') return 'an agent needs a provider and a model'
  const ceiling = agent.eurPerMonth ?? DEFAULT_EUR_PER_MONTH
  if (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling <= 0) return 'a monthly ceiling is a positive number of euros'
  return serversRefusal(agent.connectors ?? [])
}

/** @param servers - MCP server names. @returns why one is not a server name, or undefined. */
function serversRefusal(servers: readonly string[]): string | undefined {
  const bad = servers.filter(server => typeof server !== 'string' || !SERVER.test(server))
  return bad.length === 0 ? undefined : `not an MCP server name: ${bad.join(', ')}`
}
