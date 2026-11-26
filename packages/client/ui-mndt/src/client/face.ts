/**
 * The shapes the collaboration page reads from the Host face.
 *
 * This module carries only types: the page that used to live beside them was
 * replaced by `CollabPage`, and this file is what both the HTTP and the Remote
 * transports still share.
 */

/** A mission as the page reads it. */
/** One search hit returned by the Host. */
export interface SearchRow {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly detail: string
}

export interface MissionRow {
  readonly id: string
  readonly kind: string
  readonly prompt: string
  readonly status: string
  readonly createdBy: string
  readonly createdAt: string
  readonly visibility?: string
  readonly error?: string
  /** Servers the mission ran without (a briefing on a space with no facts server), as the core serves them. */
  readonly toolsUnavailable?: readonly string[]
}

/** A brief as the page reads it. */
export interface BriefRow {
  readonly id: string
  readonly title: string
  readonly markdown: string
  readonly status: string
  readonly createdAt: string
  readonly visibility?: string
  readonly createdBy?: string
}

/** An approval as the page reads it. */
export interface ApprovalRow {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly requestedBy: string
  readonly requestedAt: string
}

/** A memory note as the page reads it. */
export interface MemoryRow {
  readonly id: string
  readonly scope: string
  readonly kind: string
  readonly text: string
  readonly createdBy: string
}

/** What one machine capture returns. */
export interface MachineShot {
  readonly ok: boolean
  readonly bytes: number
  readonly seconds: number
  readonly png: string
}

/** What one browser or desktop action returns. */
export interface BrowserAnswer {
  readonly ok?: boolean
  readonly png?: string
  readonly text?: string
  readonly url?: string
  readonly title?: string
  readonly error?: string
}

/** The briefing schedule, as the page reads and writes it. */
export interface ScheduleRow {
  readonly at: string | null
}

/** One person's usage over the counted window. */
export interface UsageRow {
  readonly user: string
  readonly missions: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** Usage for the reader and, for an admin, the team. */
export interface UsageReport {
  readonly mine: UsageRow
  readonly team: readonly UsageRow[]
  readonly canAdmin: boolean
}

/** One member of the workspace. */
export interface MemberRow {
  readonly subject: string
  readonly role: string
}

/** What one read returns. */
export interface PageStateRow {
  readonly you: string
  readonly canWrite: boolean
  readonly role?: string
  /** Where the roles come from: `file` when they are kept in the role file by the owner (no grant route). */
  readonly rolesFrom?: unknown
  readonly canAdmin?: boolean
  readonly canShare?: boolean
  readonly missions: readonly MissionRow[]
  readonly briefs: readonly BriefRow[]
  readonly approvals: readonly ApprovalRow[]
  readonly memories: readonly MemoryRow[]
  readonly mandates?: readonly MandateRow[]
}

/** One delegation mandate as the page reads it. */
export interface MandateRow {
  readonly id: string
  readonly delegant: string
  readonly delegataire: string
  readonly purpose: string
  readonly connectors: readonly string[]
  readonly missionKinds: readonly string[]
  readonly dailyCap: number
  readonly expiresOn: string
  readonly state: string
  readonly signedBy?: string
}

/** What the journal export returns. */
export interface JournalAnswer {
  readonly format?: string
  readonly text?: string
  readonly entries?: readonly Record<string, unknown>[]
  readonly error?: string
}

/** One outcome as the Host reports it. */
export interface OutcomeRow<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: string
  /** The HTTP status of a refusal, when the Host answered one. */
  readonly status?: number
  /** The refusal's code, when the Host serves one (`no-authority`, …). */
  readonly code?: string
}

/** One mounted connector, as the page reads it. */
export interface ConnectorRow {
  readonly module: string
  readonly server: string
  readonly enabled: boolean
}

/** One scheduled automation as the page reads it. */
export interface AutomationRow {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly prompt: string
  readonly at: string
  readonly days?: readonly number[]
  readonly enabled: boolean
  readonly createdBy: string
  readonly lastFiredDate?: string
  /** When it last ran, a manual run included (#166); preferred to lastFiredDate. */
  readonly lastRunAt?: string
  /** When it starts next, in the instance's zone (#166); absent on a suspended one. */
  readonly nextRunAt?: string
  readonly lastMissionId?: string
  readonly lastOutcome?: string
  readonly failures?: number
}

/** The registry, with the right to edit it. */
export interface AutomationsAnswer {
  readonly items: readonly AutomationRow[]
  readonly canAdmin: boolean
  /** The zone the scheduler counts hours in (IANA), when the host serves it. */
  readonly timeZone?: string
  /** The scheduler's last pass (#166); absent when no scheduler runs in this process. */
  readonly schedulerAt?: string
  /**
   * The server's clock when it answered (the response's HTTP `Date`), to age schedulerAt on one clock:
   * the browser's may be off by minutes. Absent when the header did not come through.
   */
  readonly serverAt?: string
}

/** The Host face this page needs. */
/** How a card is decided. */
export interface DecideOptions {
  /** The screen shows the whole proposal of a propose_agent card (sent as `x-mndt-shows-proposal`). */
  readonly showsProposal?: boolean
}

export interface MndtFace {
  state(): Promise<PageStateRow>
  runMission(kind: string, prompt: string): Promise<OutcomeRow<{ readonly mission: MissionRow; readonly brief?: BriefRow }>>
  cancelMission(id: string): Promise<OutcomeRow<MissionRow>>
  search(query: string): Promise<readonly SearchRow[]>
  retryMission(id: string): Promise<OutcomeRow<MissionRow>>
  /**
   * Decide a card. `showsProposal`: the screen shows the whole agent a propose_agent card would
   * create (the core refuses its approval otherwise, #82).
   */
  decide(approvalId: string, decision: 'approved' | 'rejected', reason?: string, options?: DecideOptions): Promise<OutcomeRow<ApprovalRow>>
  approveBrief(briefId: string): Promise<OutcomeRow<BriefRow>>
  remember(scope: 'team' | 'user' | 'mission', kind: 'fact' | 'decision' | 'preference', text: string): Promise<OutcomeRow<MemoryRow>>
  shareMission(missionId: string, visibility: 'team' | 'private'): Promise<OutcomeRow<MissionRow>>
  shareMemory(memoryId: string, scope: 'user' | 'team'): Promise<OutcomeRow<MemoryRow>>
  connectors(): Promise<readonly ConnectorRow[]>
  members(): Promise<readonly MemberRow[]>
  grantMember(subject: string, role: 'viewer' | 'operator' | 'admin' | 'owner'): Promise<OutcomeRow<MemberRow>>
  revokeMember(subject: string): Promise<OutcomeRow<MemberRow>>
  usage(): Promise<UsageReport>
  schedule(): Promise<ScheduleRow>
  setSchedule(at: string): Promise<ScheduleRow>
  machineCapture(url: string): Promise<MachineShot>
  browserAct(input: Record<string, unknown>): Promise<BrowserAnswer>
  desktopAct(input: Record<string, unknown>): Promise<BrowserAnswer>
  desktopStop(): Promise<BrowserAnswer>
  browserStop(): Promise<BrowserAnswer>
  createMandate(input: Record<string, unknown>): Promise<OutcomeRow<MandateRow>>
  signMandate(id: string): Promise<OutcomeRow<MandateRow>>
  retireMandate(id: string): Promise<OutcomeRow<MandateRow>>
  journal(format: 'csv' | 'json'): Promise<JournalAnswer>
  automations(): Promise<AutomationsAnswer>
  saveAutomation(input: Record<string, unknown>): Promise<OutcomeRow<AutomationRow>>
  toggleAutomation(id: string, enabled: boolean): Promise<OutcomeRow<AutomationRow>>
  runAutomationNow(id: string): Promise<OutcomeRow<{ readonly outcome: string; readonly mission?: MissionRow }>>
}
