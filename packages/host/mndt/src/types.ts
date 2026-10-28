/**
 * The shapes that cross the Remote boundary.
 *
 * Typert requires every boundary type to live on a public non-root subpath, so
 * the page and the Host can be generated from the same declaration. The domain
 * entities are re-exported here for the same reason: a method signature must name
 * a type a consumer can resolve from the package's `./types` entry.
 */
export type {
  Approval,
  ApprovalAction,
  ApprovalPayload,
  ApprovalState,
  Brief,
  BriefSource,
  MemoryKind,
  MemoryNote,
  MemoryScope,
  Mandate,
  MandateState,
  Mission,
  MissionKind,
  MissionStatus,
  Visibility,
  WorkbenchEvent,
  WorkbenchState,
} from './core/types.ts'

/** One result the page can render without guessing. */
export interface Outcome<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: string
}

/** Everything the morning page reads in one call. */
export interface PageState {
  /** The role the authority resolved for this person, when it named one. */
  readonly role?: string
  /** Whether this person may change the member table. */
  readonly canAdmin: boolean
  /** Whether this person may share another person's work. */
  readonly canShare: boolean
  readonly you: string
  readonly canWrite: boolean
  readonly missions: readonly import('./core/types.ts').Mission[]
  readonly briefs: readonly import('./core/types.ts').Brief[]
  readonly approvals: readonly import('./core/types.ts').Approval[]
  readonly memories: readonly import('./core/types.ts').MemoryNote[]
  readonly events: readonly import('./core/types.ts').WorkbenchEvent[]
  readonly mandates: readonly import('./core/types.ts').Mandate[]
}

/** What a mission run produced. */
export interface RunOutcome {
  readonly mission: import('./core/types.ts').Mission
  readonly brief?: import('./core/types.ts').Brief
}

/** One mounted MCP connector, as the product shows it. */
export interface ConnectorRow {
  readonly module: string
  readonly server: string
  readonly enabled: boolean
}
