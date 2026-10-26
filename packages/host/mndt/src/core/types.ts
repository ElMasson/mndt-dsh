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
  readonly tokens?: { readonly input: number; readonly output: number }
  readonly briefId?: string
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
export type ApprovalAction = 'send-email' | 'publish' | 'spend' | 'delete'

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
  readonly kind: ApprovalAction
  readonly title: string
  readonly payload: ApprovalPayload
  readonly requestedBy: string
  readonly requestedAt: string
  readonly state: ApprovalState
  readonly decidedBy?: string
  readonly decidedAt?: string
  readonly reason?: string
}

/** One line of the product's own history. */
export interface WorkbenchEvent {
  readonly at: string
  readonly actor: string
  readonly action: string
  readonly subject: string
  readonly detail?: string
}

/** Everything the product persists. */
export interface WorkbenchState {
  readonly version: 1
  readonly missions: readonly Mission[]
  readonly briefs: readonly Brief[]
  readonly memories: readonly MemoryNote[]
  readonly approvals: readonly Approval[]
  readonly events: readonly WorkbenchEvent[]
}

/** A state with nothing in it. */
export const emptyState: WorkbenchState = {
  version: 1,
  missions: [],
  briefs: [],
  memories: [],
  approvals: [],
  events: [],
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
  return value === 'send-email' || value === 'publish' || value === 'spend' || value === 'delete'
}
