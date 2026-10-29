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
  Approval,
  ApprovalAction,
  ApprovalPayload,
  ApprovalState,
  Brief,
  BriefSource,
  MemoryKind,
  MemoryNote,
  MemoryScope,
  Mission,
  MissionKind,
  MissionStatus,
  Visibility,
  WorkbenchEvent,
  WorkbenchState,
} from './types.ts'
import type { WorkbenchStore } from './store.ts'
import type { Mandate } from './types.ts'
import type { MandateDraft } from '../mandates.ts'
import { draftRefusal, signRefusal } from '../mandates.ts'
import type { Role } from '@deepseek-ai/dsh-client-ui-governance/src/rbac.ts'

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
  readonly requestedBy: string
}

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
        state: { ...state, missions: state.missions.map(candidate => (candidate.id === id ? next : candidate)) },
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

  /** @returns the whole state, for a page that wants one read. */
  async snapshot(): Promise<WorkbenchState> {
    return this.#ready()
  }
}
