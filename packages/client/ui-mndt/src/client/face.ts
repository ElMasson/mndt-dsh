/**
 * The shapes the collaboration page reads from the Host face.
 *
 * This module carries only types: the page that used to live beside them was
 * replaced by `CollabPage`, and this file is what both the HTTP and the Remote
 * transports still share.
 */

/** A mission as the page reads it. */
export interface MissionRow {
  readonly id: string
  readonly kind: string
  readonly prompt: string
  readonly status: string
  readonly createdBy: string
  readonly createdAt: string
  readonly visibility?: string
  readonly error?: string
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
}

/** One mounted connector, as the page reads it. */
export interface ConnectorRow {
  readonly module: string
  readonly server: string
  readonly enabled: boolean
}

/** The Host face this page needs. */
export interface MndtFace {
  state(): Promise<PageStateRow>
  runMission(kind: string, prompt: string): Promise<OutcomeRow<{ readonly mission: MissionRow; readonly brief?: BriefRow }>>
  decide(approvalId: string, decision: 'approved' | 'rejected', reason?: string): Promise<OutcomeRow<ApprovalRow>>
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
}
